/**
 * Integration tests for `createPinoConfig`'s redaction.
 *
 * Builds a real pino instance backed by an in-memory destination, logs
 * sample objects, and asserts that sensitive fields come out as
 * `[REDACTED]`.
 *
 * **Two layers.** `formatters.log` walks the entry and censors sensitive
 * field names at any depth; `redact.paths` (fast-redact) is a backstop that
 * covers the root and depth 1. The walker is what these tests exercise —
 * `redact.paths` alone could not satisfy the depth cases below, because
 * fast-redact wildcards consume exactly one level each and a payload can
 * always nest one level deeper than any enumerated path.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import http from 'node:http';
import pino, { Logger } from 'pino';
import { createPinoConfig } from './pino.config';
import { redactTree } from './redaction';

/** Minimal pino destination that captures emitted log lines in memory. */
function bufferDestination(): {
  logger: Logger;
  lines: Array<Record<string, unknown>>;
} {
  const lines: Array<Record<string, unknown>> = [];
  // Force LOG_FORMAT=json so tests don't spawn a pino-pretty worker
  // (which would swallow the buffer destination).
  const previous = process.env['LOG_FORMAT'];
  process.env['LOG_FORMAT'] = 'json';
  const config = createPinoConfig('test-service');
  if (previous === undefined) {
    delete process.env['LOG_FORMAT'];
  } else {
    process.env['LOG_FORMAT'] = previous;
  }
  const logger = pino(
    { ...config, transport: undefined, level: 'trace' },
    {
      write(chunk: string) {
        for (const line of chunk.split('\n').filter(Boolean)) {
          try {
            lines.push(JSON.parse(line));
          } catch {
            // Ignore malformed lines (pino occasionally writes empty ones).
          }
        }
      },
    },
  );
  return { logger, lines };
}

describe('pino.config — redact.paths', () => {
  let captured: { logger: Logger; lines: Array<Record<string, unknown>> };

  beforeEach(() => {
    captured = bufferDestination();
  });

  it('redacts depth-1 auth fields (password, token, secret, apiKey, sessionId)', () => {
    captured.logger.info(
      {
        user: {
          password: 'hunter2',
          token: 'ghp_x',
          secret: 'abc',
          apiKey: 'sk_test',
          sessionId: 'sid_1',
        },
      },
      'login',
    );
    const user = captured.lines[0]!['user'] as Record<string, unknown>;
    expect(user['password']).toBe('[REDACTED]');
    expect(user['token']).toBe('[REDACTED]');
    expect(user['secret']).toBe('[REDACTED]');
    expect(user['apiKey']).toBe('[REDACTED]');
    expect(user['sessionId']).toBe('[REDACTED]');
  });

  it('redacts depth-1 PII fields (ssn, dob, dateOfBirth, email, phone, address, creditCard, bankAccount)', () => {
    // `record` is deliberately NOT a sensitive field name, so this asserts the
    // inner fields are censored on their own merit rather than because the
    // container was censored wholesale.
    captured.logger.info(
      {
        record: {
          ssn: '123-45-6789',
          dob: '1990-01-01',
          dateOfBirth: '1990-01-01',
          email: 'a@b.com',
          phone: '555-1212',
          phoneNumber: '555-1212',
          address: '1 Main St',
          creditCard: '4111-1111-1111-1111',
          bankAccount: '000123456',
        },
      },
      'enrol',
    );
    const record = captured.lines[0]!['record'] as Record<string, unknown>;
    expect(record['ssn']).toBe('[REDACTED]');
    expect(record['dob']).toBe('[REDACTED]');
    expect(record['dateOfBirth']).toBe('[REDACTED]');
    expect(record['email']).toBe('[REDACTED]');
    expect(record['phone']).toBe('[REDACTED]');
    expect(record['phoneNumber']).toBe('[REDACTED]');
    expect(record['address']).toBe('[REDACTED]');
    expect(record['creditCard']).toBe('[REDACTED]');
    expect(record['bankAccount']).toBe('[REDACTED]');
  });

  it('redacts depth-1 medical identifiers (mrn, patientId, medicalRecordNumber)', () => {
    captured.logger.info(
      {
        record: {
          mrn: 'MRN-123',
          patientId: 'P-123',
          medicalRecordNumber: 'MRN-123',
          healthInsuranceNumber: 'HIN-9',
          insuranceId: 'INS-1',
        },
      },
      'lookup',
    );
    const record = captured.lines[0]!['record'] as Record<string, unknown>;
    expect(record['mrn']).toBe('[REDACTED]');
    expect(record['patientId']).toBe('[REDACTED]');
    expect(record['medicalRecordNumber']).toBe('[REDACTED]');
    expect(record['healthInsuranceNumber']).toBe('[REDACTED]');
    expect(record['insuranceId']).toBe('[REDACTED]');
  });

  it('censors a sensitive container wholesale rather than descending into it', () => {
    // `patient` is itself a PHI field name, so the whole subtree goes. This is
    // the same call the event sink already made (`logMetadata` reduces an
    // object-valued PHI field to `hasPatient: true`); before this change
    // stdout descended into it and published every unlisted key.
    captured.logger.info(
      { patient: { mrn: 'MRN-123', nickname: 'Bobby', freeText: 'has HIV' } },
      'lookup',
    );
    expect(captured.lines[0]!['patient']).toBe('[REDACTED]');
  });

  it('does not redact safe fields', () => {
    captured.logger.info(
      { user: { userId: 'usr_123', duration: 42, status: 'ok' } },
      'done',
    );
    const user = captured.lines[0]!['user'] as Record<string, unknown>;
    expect(user['userId']).toBe('usr_123');
    expect(user['duration']).toBe(42);
    expect(user['status']).toBe('ok');
  });

  it('redacts root-level sensitive fields (logger.info({ssn: ...}) pattern)', () => {
    // Covers the case where PinoLoggerService merges a plain-object primary
    // message into the merging arg via `resolvePayload` — those fields land
    // at the root of the log entry, so root-level redact paths are required.
    captured.logger.info(
      { password: 'x', ssn: '123', email: 'a@b.com', mrn: 'M-1' },
      'root',
    );
    const line = captured.lines[0]!;
    expect(line['password']).toBe('[REDACTED]');
    expect(line['ssn']).toBe('[REDACTED]');
    expect(line['email']).toBe('[REDACTED]');
    expect(line['mrn']).toBe('[REDACTED]');
  });
});

/**
 * Regression tests for the four redaction gaps found in the August 2026
 * security review. Each `it` below reproduces the exact payload that leaked
 * before the fix, so a revert fails here rather than in production.
 */
describe('pino.config — security regressions', () => {
  let captured: { logger: Logger; lines: Array<Record<string, unknown>> };

  beforeEach(() => {
    captured = bufferDestination();
  });

  it('censors clinical PHI fields on the stdout path', () => {
    // These names were in PHI_FIELD_NAMES (so the event sink stripped them)
    // but absent from redact.paths, so they went to stdout — and stdout is
    // what ships to log aggregation.
    captured.logger.info({
      transcript: 'Patient reports chest pain since Tuesday.',
      soapNote: 'S: 54yo M c/o dyspnea. A: suspected CHF.',
      clinicalNote: 'assessment',
      patientNote: 'note',
      text: 'my SSN is 123-45-6789',
      notes: 'HIV positive, on ART',
      words: ['chest', 'pain'],
      segments: [{ speaker: 'A' }],
      voiceprint: 'vp-data',
      diarization: 'd',
      fullData: { a: 1 },
      rawData: { b: 2 },
    });
    const line = captured.lines[0]!;
    for (const field of [
      'transcript',
      'soapNote',
      'clinicalNote',
      'patientNote',
      'text',
      'notes',
      'words',
      'segments',
      'voiceprint',
      'diarization',
      'fullData',
      'rawData',
    ]) {
      expect(line[field], `${field} must be censored`).toBe('[REDACTED]');
    }
  });

  it('censors S3 URL and key fields, including the presigned signature', () => {
    captured.logger.info({
      audioFileUrl:
        'https://bkt.s3.amazonaws.com/e/PT-99213/a.wav?X-Amz-Signature=deadbeef',
      audioFileKey: 'encounters/123/audio.wav',
      recordingUrl: 'https://x/y.wav',
      downloadUrl: 'https://x/y.wav',
      uploadUrl: 'https://x/y.wav',
      completeAudioFileKey: 'k',
      inputKey: 'k',
      outputKey: 'k',
      compressedKey: 'k',
      oggKey: 'k',
    });
    const line = captured.lines[0]!;
    for (const field of [
      'audioFileUrl',
      'audioFileKey',
      'recordingUrl',
      'downloadUrl',
      'uploadUrl',
      'completeAudioFileKey',
      'inputKey',
      'outputKey',
      'compressedKey',
      'oggKey',
    ]) {
      expect(line[field], `${field} must be censored`).toBe('[REDACTED]');
    }
    expect(JSON.stringify(line)).not.toContain('deadbeef');
  });

  it('censors sensitive fields below depth 1, where path wildcards stop', () => {
    captured.logger.info({
      d2: { a: { ssn: '111-22-3333' } },
      d3: { a: { b: { email: 'a@b.com' } } },
      d5: { a: { b: { c: { d: { token: 'ghp_secret' } } } } },
    });
    const line = captured.lines[0]!;
    const d2 = line['d2'] as any;
    const d3 = line['d3'] as any;
    const d5 = line['d5'] as any;
    expect(d2.a.ssn).toBe('[REDACTED]');
    expect(d3.a.b.email).toBe('[REDACTED]');
    expect(d5.a.b.c.d.token).toBe('[REDACTED]');
    expect(JSON.stringify(line)).not.toContain('111-22-3333');
    expect(JSON.stringify(line)).not.toContain('ghp_secret');
  });

  it('censors sensitive fields inside arrays at any depth', () => {
    captured.logger.info({ users: [{ profile: { ssn: '111-22-3333' } }] });
    expect(JSON.stringify(captured.lines[0]!)).not.toContain('111-22-3333');
  });

  it('strips credentials from req.url and req.query', () => {
    captured.logger.info({
      req: {
        method: 'GET',
        url: '/api/v1/enc?token=SECRET_BEARER_abc123&mrn=MRN-4471&page=2',
        query: { token: 'SECRET_BEARER_abc123', mrn: 'MRN-4471', page: '2' },
        params: { patientId: 'P-1' },
        headers: {},
      },
    });
    const req = captured.lines[0]!['req'] as any;
    expect(req.url).toBe('/api/v1/enc?token=[REDACTED]&mrn=[REDACTED]&page=2');
    expect(req.query.token).toBe('[REDACTED]');
    expect(req.query.mrn).toBe('[REDACTED]');
    // Non-sensitive params survive — a request log with no shape is useless.
    expect(req.query.page).toBe('2');
    expect(req.params.patientId).toBe('[REDACTED]');
    expect(JSON.stringify(req)).not.toContain('SECRET_BEARER_abc123');
    expect(JSON.stringify(req)).not.toContain('MRN-4471');
  });

  it('leaves non-sensitive payloads untouched', () => {
    captured.logger.info({
      encounterId: 'e-1',
      durationMs: 42,
      nested: { status: 'ok', counts: [1, 2, 3] },
    });
    const line = captured.lines[0]!;
    expect(line['encounterId']).toBe('e-1');
    expect(line['durationMs']).toBe(42);
    expect(line['nested']).toEqual({ status: 'ok', counts: [1, 2, 3] });
  });

  it('does not mutate the object the caller logged', () => {
    const payload = { record: { ssn: '111-22-3333' } };
    captured.logger.info(payload);
    expect(payload.record.ssn).toBe('111-22-3333');
  });

  it('survives circular references', () => {
    const cyclic: any = { record: { ssn: '111-22-3333' } };
    cyclic.self = cyclic;
    expect(() => captured.logger.info(cyclic)).not.toThrow();
    expect(JSON.stringify(captured.lines[0]!)).not.toContain('111-22-3333');
  });
});

describe('pino.config — live framework objects', () => {
  let captured: { logger: Logger; lines: Array<Record<string, unknown>> };

  beforeEach(() => {
    captured = bufferDestination();
  });

  /**
   * `formatters.log` runs *before* pino's serializers, so anything it walks is
   * the caller's live object rather than a serialized shape. The walk keeps
   * only own enumerable properties, and a real `req`/`res` graph is deeper
   * than the depth cap — which made the walk always report a change and always
   * return a plain clone with the prototype stripped off.
   *
   * These run against a real Node server so the objects have the accessors a
   * plain test fixture does not.
   */
  function withLiveExchange(
    assert: (req: http.IncomingMessage, res: http.ServerResponse) => void,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const server = http.createServer((req, res) => {
        try {
          assert(req, res);
        } catch (error) {
          reject(error);
        } finally {
          res.end('ok');
          server.close(() => resolve());
        }
      });
      server.listen(0, () => {
        const port = (server.address() as { port: number }).port;
        http
          .get(
            {
              port,
              path: '/api/v1/enc?token=SECRET_BEARER_abc123&page=2',
              headers: {
                cookie: 'session=abc',
                authorization: 'Bearer SECRET_BEARER_abc123',
                'user-agent': 'vitest',
                'x-forwarded-for': '203.0.113.7',
              },
            },
            (response) => response.resume(),
          )
          .on('error', reject);
      });
    });
  }

  it('logs a live response without throwing', async () => {
    // `res.getHeaders` lives on the prototype, so a cloned `res` arrived at
    // the serializer without it: `TypeError: res.getHeaders is not a function`
    // on every response log.
    await withLiveExchange((_req, res) => {
      res.setHeader('content-type', 'application/json');
      expect(() => captured.logger.info({ res }, 'responded')).not.toThrow();
      const logged = captured.lines[0]!['res'] as any;
      expect(logged.headers['content-type']).toBe('application/json');
    });
  });

  it('keeps request headers and address on a live request', async () => {
    // `IncomingMessage.headers` is a prototype getter built lazily from
    // `rawHeaders`, so the clone dropped it and every request log came out
    // with `headers: {}` and no client address — an audit-trail gap.
    await withLiveExchange((req) => {
      captured.logger.info({ req }, 'received');
      const logged = captured.lines[0]!['req'] as any;
      expect(logged.headers['user-agent']).toBe('vitest');
      expect(logged.headers['x-forwarded-for']).toBe('203.0.113.7');
      expect(logged.remotePort).toEqual(expect.any(Number));
      // The credential in the query string is still rewritten out.
      expect(logged.url).toBe('/api/v1/enc?token=[REDACTED]&page=2');
      expect(JSON.stringify(logged)).not.toContain('SECRET_BEARER_abc123');
    });
  });

  it('redacts credentials and PHI hung off an error', () => {
    // `stdSerializers.err` flattens an error's own properties into the entry,
    // and it runs after `formatters.log` — so nothing walked them.
    const err: any = new Error('Request failed');
    err.config = { headers: { Authorization: 'Bearer SECRET_BEARER_abc123' } };
    err.response = { data: { transcript: 'Patient reports chest pain.' } };

    captured.logger.error({ err }, 'upstream failed');
    const line = JSON.stringify(captured.lines[0]!);
    expect(line).not.toContain('SECRET_BEARER_abc123');
    expect(line).not.toContain('chest pain');
    // The error is still diagnostically useful.
    expect((captured.lines[0]!['err'] as any).message).toBe('Request failed');
  });

  it('covers child bindings only as deep as redact.paths reaches', () => {
    // pino renders child bindings once at `child()` time and resets any custom
    // `formatters.bindings` to its own first, so the depth-independent walk
    // cannot reach this channel at all — `redact.paths` is the only layer, and
    // it stops at depth 1. Pinned so the boundary is a decision, not a
    // surprise; consumers binding untrusted data should walk it themselves
    // with the exported `redactTree`.
    const covered = captured.logger.child({ ctx: { ssn: '111-22-3333' } });
    covered.info('scoped');
    expect(JSON.stringify(captured.lines[0]!)).not.toContain('111-22-3333');

    const walked = captured.logger.child(
      redactTree({ ctx: { inner: { ssn: '111-22-3333' } } }) as object,
    );
    walked.info('scoped');
    expect(JSON.stringify(captured.lines[1]!)).not.toContain('111-22-3333');
  });

  it('redacts what toJSON produces on the way to stdout', () => {
    // A plain-object fixture cannot catch this: the projection only exists
    // because `JSON.stringify` calls the method, downstream of the walk.
    class Doc {
      constructor(
        public id: string,
        private secretSsn: string,
      ) {}
      toJSON() {
        return { id: this.id, ssn: this.secretSsn };
      }
    }
    captured.logger.info({ doc: new Doc('d1', '111-22-3333') }, 'm');
    const line = JSON.stringify(captured.lines[0]!);
    expect(line).not.toContain('111-22-3333');
    expect(captured.lines[0]!['doc']).toEqual({ id: 'd1', ssn: '[REDACTED]' });
  });

  it('does not let a throwing getter escape the log call', () => {
    const payload: Record<string, unknown> = {};
    Object.defineProperty(payload, 'boom', {
      enumerable: true,
      get() {
        throw new Error('getter blew up');
      },
    });
    expect(() => captured.logger.info({ payload }, 'm')).not.toThrow();
  });
});

describe('pino.config — URLs carried on an error', () => {
  let captured: { logger: Logger; lines: Array<Record<string, unknown>> };

  beforeEach(() => {
    captured = bufferDestination();
  });

  it('sanitizes URLs an HTTP client hangs off a failed request', () => {
    // stdSerializers.err flattens the error's own properties into the entry,
    // and the walk censors sensitive *names* — a URL sits under an ordinary
    // name like `url`, so its query string used to survive in cleartext.
    const error = new Error('Request failed') as Error & {
      config?: unknown;
      request?: unknown;
      response?: unknown;
    };
    error.config = {
      url: 'https://api.example.test/v1/enc?token=SECRET_A&page=2',
      method: 'get',
    };
    error.request = { path: '/v1/enc?token=SECRET_B' };
    error.response = {
      status: 500,
      config: { url: 'https://api.example.test/v1/e?apiKey=SECRET_C' },
    };

    captured.logger.error({ err: error }, 'request failed');
    const line = JSON.stringify(captured.lines[0]);

    expect(line).not.toContain('SECRET_A');
    expect(line).not.toContain('SECRET_B');
    expect(line).not.toContain('SECRET_C');
    // The path and benign parameters survive — a log with no shape is useless.
    expect(line).toContain('/v1/enc?token=[REDACTED]&page=2');
  });

  it('leaves the request serializer output stable when it sanitizes first', () => {
    captured.logger.info(
      {
        req: {
          method: 'GET',
          url: '/api/x?token=SECRET_D&page=2',
          headers: { referer: 'https://h.test/p?apiKey=SECRET_E' },
        },
      },
      'req',
    );
    const req = captured.lines[0]!['req'] as Record<string, unknown>;
    expect(req['url']).toBe('/api/x?token=[REDACTED]&page=2');
    const headers = req['headers'] as Record<string, unknown>;
    expect(headers['referer']).toBe('https://h.test/p?apiKey=[REDACTED]');
  });
});

describe('pino.config — formatters.log return shape', () => {
  it('never hands pino a non-object, even without the mixin', () => {
    // pino iterates the return value with `for…in`, so a string would be
    // emitted one indexed key per character. redactTree can legitimately
    // return a non-object when a root `toJSON` projects to one; the shipped
    // `mixin` flattens the merge object before it gets here, but the guard
    // must not depend on an unrelated option staying set.
    class Projecting {
      id = 'ENC-1';
      toJSON(): string {
        return 'MRN-9987';
      }
    }
    const lines: Array<Record<string, unknown>> = [];
    const previous = process.env['LOG_FORMAT'];
    process.env['LOG_FORMAT'] = 'json';
    const config = createPinoConfig('test-service') as Record<string, unknown>;
    if (previous === undefined) {
      delete process.env['LOG_FORMAT'];
    } else {
      process.env['LOG_FORMAT'] = previous;
    }
    delete config['mixin'];
    const logger = pino({ ...config, transport: undefined, level: 'trace' }, {
      write(chunk: string) {
        for (const line of chunk.split('\n').filter(Boolean)) {
          try {
            lines.push(JSON.parse(line));
          } catch {
            // Ignore malformed lines.
          }
        }
      },
    } as never);

    logger.info(new Projecting() as unknown as Record<string, unknown>, 'm');
    const entry = lines[0]!;
    expect(entry['0']).toBeUndefined();
    expect(JSON.stringify(entry)).not.toContain('MRN-9987');
  });
});
