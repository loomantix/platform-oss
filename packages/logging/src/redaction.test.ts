/** @format */

import { describe, it, expect } from 'vitest';
import {
  CENSOR,
  MAX_REDACT_DEPTH,
  REDACTED_FIELD_NAMES,
  redactTree,
  sanitizeUrl,
} from './redaction';
import { PHI_FIELD_NAMES } from './phi-detector';

describe('REDACTED_FIELD_NAMES', () => {
  it('covers every PHI field name', () => {
    // The stdout path and the event-sink path are derived from one list
    // precisely so they cannot drift apart again.
    for (const name of PHI_FIELD_NAMES) {
      expect(REDACTED_FIELD_NAMES.has(name), `${name} missing`).toBe(true);
    }
  });

  it('covers auth headers and snake_case spellings', () => {
    for (const name of [
      'authorization',
      'cookie',
      'set-cookie',
      'x-api-key',
      'api_key',
      'patient_id',
      'date_of_birth',
      'access_token',
    ]) {
      expect(REDACTED_FIELD_NAMES.has(name), `${name} missing`).toBe(true);
    }
  });
});

describe('redactTree', () => {
  it('censors a sensitive field at the root', () => {
    expect(redactTree({ ssn: 'x', ok: 1 })).toEqual({ ssn: CENSOR, ok: 1 });
  });

  it('censors at arbitrary depth', () => {
    const deep = { a: { b: { c: { d: { e: { token: 'secret' } } } } } };
    expect(redactTree(deep)).toEqual({
      a: { b: { c: { d: { e: { token: CENSOR } } } } },
    });
  });

  it('censors inside arrays', () => {
    expect(redactTree({ users: [{ email: 'a@b.com' }, { id: 1 }] })).toEqual({
      users: [{ email: CENSOR }, { id: 1 }],
    });
  });

  it('matches field names case-insensitively', () => {
    expect(redactTree({ Authorization: 'Bearer t' })).toEqual({
      Authorization: CENSOR,
    });
  });

  it('returns the same reference when nothing is sensitive', () => {
    // Keeps the clean path allocation-free — this runs on every log line.
    const clean = { a: { b: [1, 2, 3] } };
    expect(redactTree(clean)).toBe(clean);
  });

  it('does not mutate its input', () => {
    const input = { record: { ssn: 'keep-me' } };
    redactTree(input);
    expect(input.record.ssn).toBe('keep-me');
  });

  it('replaces a back-reference with a marker rather than the raw object', () => {
    // Returning the original would hand the serializer an un-walked subtree,
    // which it renders in full — a redaction bypass.
    const cyclic: any = { record: { ssn: 'secret' } };
    cyclic.self = cyclic;
    expect(JSON.stringify(redactTree(cyclic))).not.toContain('secret');
  });

  it('redacts a shared object on every path it appears under', () => {
    // A DAG is not a cycle: marking `shared` as visited forever would leave
    // the second occurrence uncensored.
    const shared = { ssn: 'secret' };
    const out: any = redactTree({ a: shared, b: shared });
    expect(out.a.ssn).toBe(CENSOR);
    expect(out.b.ssn).toBe(CENSOR);
  });

  it('censors a subtree past the depth cap instead of passing it through', () => {
    let node: any = { ssn: 'secret' };
    for (let i = 0; i < MAX_REDACT_DEPTH + 3; i++) node = { nest: node };
    expect(JSON.stringify(redactTree(node))).not.toContain('secret');
  });

  it('leaves opaque values intact', () => {
    const date = new Date(0);
    const buf = Buffer.from('abc');
    const re = /x/g;
    const out: any = redactTree({ date, buf, re });
    expect(out.date).toBe(date);
    expect(out.buf).toBe(buf);
    expect(out.re).toBe(re);
  });

  it('redacts an error instead of passing it through', () => {
    // An error is not opaque: HTTP clients hang the entire failed request off
    // one, so skipping it published the bearer token and the transcript.
    const err: any = new Error('Request failed');
    err.config = { headers: { Authorization: 'Bearer SECRET_BEARER_abc123' } };
    err.response = { data: { transcript: 'Patient reports chest pain.' } };

    const out: any = (redactTree({ err }) as any).err;
    expect(out.type).toBe('Error');
    expect(out.message).toBe('Request failed');
    expect(out.stack).toContain('Request failed');
    expect(out.config.headers.Authorization).toBe(CENSOR);
    expect(out.response.data.transcript).toBe(CENSOR);
    expect(JSON.stringify(out)).not.toContain('SECRET_BEARER_abc123');
    expect(JSON.stringify(out)).not.toContain('chest pain');
  });

  it('matches a field name in any case or separator style', () => {
    // PascalCase is what .NET and most EMR vendor APIs emit. Matching only the
    // exact spelling and its all-lowercase form covered `ssn` but missed every
    // camelCase entry, because `'PatientId'.toLowerCase()` is not `patientId`.
    const out: any = redactTree({
      PatientId: 'P-1',
      SoapNote: 'note body',
      ApiKey: 'k-1',
      DateOfBirth: '1975-01-01',
      AudioFileUrl: 's3://bucket/key.wav',
      'MEDICAL-RECORD-NUMBER': 'MRN-1',
      encounterId: 'e-1',
    });
    for (const key of [
      'PatientId',
      'SoapNote',
      'ApiKey',
      'DateOfBirth',
      'AudioFileUrl',
      'MEDICAL-RECORD-NUMBER',
    ]) {
      expect(out[key], key).toBe(CENSOR);
    }
    // A name that is not on the list still survives — the correlation id a
    // caller is told to log instead of `patientId`.
    expect(out.encounterId).toBe('e-1');
  });

  it('bounds total work on a shared-reference graph', () => {
    // Twelve objects, each fanning out eight ways to the next. The visited set
    // is path-scoped (so a DAG node is censored on every path), which means
    // this is 8^12 visits without a budget — enough to pin the event loop.
    let node: any = { leaf: 1 };
    for (let i = 0; i < 12; i++) {
      const parent: any = {};
      for (let k = 0; k < 8; k++) parent['k' + k] = node;
      node = parent;
    }
    const started = Date.now();
    redactTree({ payload: node });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('censors a node whose getter throws instead of propagating', () => {
    // `Object.entries` invokes getters and `formatters.log` runs outside
    // pino's error handling, so a throwing accessor would escape the
    // `logger.info()` call and crash the caller.
    const evil: Record<string, unknown> = { sibling: 'kept' };
    Object.defineProperty(evil, 'boom', {
      enumerable: true,
      get() {
        throw new Error('getter blew up');
      },
    });
    const out: any = redactTree({ evil, other: 'kept' });
    expect(out.evil).toBe('[REDACTED: unreadable]');
    // Failure is contained to the unreadable node.
    expect(out.other).toBe('kept');
  });

  it('passes root keys named in skipRootKeys through by reference', () => {
    // pino runs `formatters.log` before its serializers, so the walker would
    // otherwise clone the live `req`/`res` and strip the prototype methods and
    // getters those serializers call.
    class Live {
      deep: unknown;
      constructor(deep: unknown) {
        this.deep = deep;
      }
      getHeaders() {
        return { 'content-type': 'application/json' };
      }
    }
    let deep: any = { end: 1 };
    for (let i = 0; i < MAX_REDACT_DEPTH + 2; i++) deep = { nest: deep };
    const res = new Live(deep);

    const out: any = redactTree(
      { res, ssn: '111-22-3333' },
      { skipRootKeys: new Set(['res']) },
    );
    expect(out.res).toBe(res);
    expect(typeof out.res.getHeaders).toBe('function');
    // Skipping is scoped to the named root keys, not the whole entry.
    expect(out.ssn).toBe(CENSOR);
  });

  it('does not let a __proto__ key reparent the result', () => {
    const untrusted = JSON.parse('{"__proto__":{"isAdmin":true},"id":"e1"}');
    const out: any = redactTree(untrusted);
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(out.isAdmin).toBeUndefined();
    expect(({} as any).isAdmin).toBeUndefined();
  });

  it('passes primitives through unchanged', () => {
    expect(redactTree('hello')).toBe('hello');
    expect(redactTree(42)).toBe(42);
    expect(redactTree(null)).toBe(null);
    expect(redactTree(undefined)).toBe(undefined);
  });
});

describe('redactTree and toJSON', () => {
  it('walks what toJSON produces, not the object that defines it', () => {
    // `JSON.stringify` serializes the projection, so judging the node by its
    // own properties inspects a shape that is never written. The class holds
    // its data under a name that is not on the list and exposes one that is.
    class Doc {
      constructor(
        public id: string,
        private secretSsn: string,
      ) {}
      toJSON() {
        return { id: this.id, ssn: this.secretSsn, patient: 'Jane' };
      }
    }
    expect(redactTree({ doc: new Doc('d1', '111-22-3333') })).toEqual({
      doc: { id: 'd1', ssn: CENSOR, patient: CENSOR },
    });
  });

  it('never returns the original object, so toJSON cannot run again', () => {
    class Doc {
      toJSON() {
        return { ssn: '111-22-3333' };
      }
    }
    const doc = new Doc();
    expect(redactTree(doc)).not.toBe(doc);
  });

  it('censors a toJSON that returns its own receiver', () => {
    class Self {
      toJSON(): unknown {
        return this;
      }
    }
    expect(redactTree({ s: new Self() })).toEqual({ s: '[Circular]' });
  });

  it('does not let a throwing toJSON escape the walk', () => {
    class Boom {
      toJSON(): unknown {
        throw new Error('toJSON blew up');
      }
    }
    expect(() => redactTree({ b: new Boom() })).not.toThrow();
    expect(redactTree({ b: new Boom() })).toEqual({
      b: '[REDACTED: unreadable]',
    });
  });

  it('leaves opaque values with a toJSON alone', () => {
    // `Date` is opaque, so it must reach the serializer intact rather than
    // being replaced by the string its own toJSON returns.
    const when = new Date('2020-01-02T03:04:05Z');
    expect(redactTree({ when })).toEqual({ when });
  });
});

describe('sanitizeUrl', () => {
  it('censors sensitive query parameters and keeps the rest', () => {
    expect(sanitizeUrl('/api/e?token=abc&page=2')).toBe(
      `/api/e?token=${CENSOR}&page=2`,
    );
  });

  it('censors every sensitive parameter in one URL', () => {
    expect(sanitizeUrl('/x?mrn=M1&ssn=S1&email=a@b.com&ok=1')).toBe(
      `/x?mrn=${CENSOR}&ssn=${CENSOR}&email=${CENSOR}&ok=1`,
    );
  });

  it('strips presigned signatures from absolute URLs', () => {
    const out = sanitizeUrl(
      'https://b.s3.amazonaws.com/a.wav?X-Amz-Signature=deadbeef&access_token=tok_abc',
    );
    expect(out).not.toContain('deadbeef');
    expect(out).not.toContain('tok_abc');
    expect(out).toContain(`X-Amz-Signature=${CENSOR}`);
    expect(out).toContain(`access_token=${CENSOR}`);
    // The object path itself is not a secret and stays readable.
    expect(out).toContain('https://b.s3.amazonaws.com/a.wav');
  });

  it('drops the fragment', () => {
    expect(sanitizeUrl('/api/e?page=2#token=abc')).toBe('/api/e?page=2');
  });

  it('leaves a URL with no query string alone', () => {
    expect(sanitizeUrl('/api/encounters/1')).toBe('/api/encounters/1');
  });

  it('handles a trailing question mark', () => {
    expect(sanitizeUrl('/api/e?')).toBe('/api/e');
  });

  it('matches percent-encoded parameter names', () => {
    expect(sanitizeUrl('/x?%74oken=abc')).toBe(`/x?%74oken=${CENSOR}`);
  });

  it('survives malformed percent-encoding', () => {
    expect(() => sanitizeUrl('/x?%E0%A4%A=1&token=t')).not.toThrow();
    expect(sanitizeUrl('/x?%E0%A4%A=1&token=t')).toContain(`token=${CENSOR}`);
  });

  it('passes non-string values through', () => {
    expect(sanitizeUrl(undefined)).toBe(undefined);
    expect(sanitizeUrl(42)).toBe(42);
  });

  it('censors an indexed parameter, where the name is the base segment', () => {
    // `qs` emits this for a repeated parameter under its default
    // arrayFormat, so it is the standard spelling of `?token=a&token=b`.
    expect(sanitizeUrl('/x?token[0]=abc&page=2')).toBe(
      `/x?token[0]=${CENSOR}&page=2`,
    );
  });

  it('censors a sensitive segment at any bracket depth', () => {
    expect(sanitizeUrl('/x?filters[auth][token]=abc')).toBe(
      `/x?filters[auth][token]=${CENSOR}`,
    );
  });

  it('still censors the single-bracket and empty-bracket spellings', () => {
    expect(sanitizeUrl('/x?token[]=abc')).toBe(`/x?token[]=${CENSOR}`);
    expect(sanitizeUrl('/x?filters[token]=abc')).toBe(
      `/x?filters[token]=${CENSOR}`,
    );
  });

  it('leaves a bracketed benign parameter alone', () => {
    expect(sanitizeUrl('/x?filters[status]=open&page=2')).toBe(
      '/x?filters[status]=open&page=2',
    );
  });
});

describe('redactTree — opaque built-ins carrying own properties', () => {
  // An own enumerable property assigned to a Map/Set/RegExp is what
  // JSON.stringify emits for it, since none of them has a `toJSON` to
  // override the result. The early return used to hand such a value to the
  // serializer unwalked, and `redact.paths` only reaches depth 1.
  it('censors a sensitive property hung off a nested Map', () => {
    const map = new Map<string, string>() as Map<string, string> & {
      ssn?: string;
    };
    map.ssn = '111-22-3333';
    const out = redactTree({ a: { b: { c: { map } } } }) as Record<
      string,
      Record<string, Record<string, Record<string, unknown>>>
    >;
    expect(out['a']!['b']!['c']!['map']).toEqual({ ssn: CENSOR });
  });

  it('censors a sensitive property on a Set and a RegExp', () => {
    const set = new Set<string>() as Set<string> & { transcript?: string };
    set.transcript = 'Patient reports chest pain.';
    const pattern = /x/ as RegExp & { patientId?: string };
    pattern.patientId = 'P-1';
    expect(redactTree({ deep: { set, pattern } })).toEqual({
      deep: { set: { transcript: CENSOR }, pattern: { patientId: CENSOR } },
    });
  });

  it('leaves a built-in without own properties untouched, by reference', () => {
    // The ordinary case: a Map with entries has no own enumerable keys, so it
    // serializes to `{}` either way and must not be cloned.
    const input = { map: new Map([['k', 'v']]), set: new Set(['v']) };
    expect(redactTree(input)).toBe(input);
  });

  it('keeps values whose toJSON governs the output opaque', () => {
    // JSON.stringify calls toJSON and ignores own properties entirely, so a
    // Date must still render as a timestamp rather than being flattened.
    const date = new Date('2020-01-02T03:04:05.000Z') as Date & {
      ssn?: string;
    };
    date.ssn = '111-22-3333';
    const out = redactTree({ date }) as Record<string, unknown>;
    expect(out['date']).toBe(date);
    expect(JSON.stringify(out)).toBe('{"date":"2020-01-02T03:04:05.000Z"}');
  });
});

describe('redactTree — URL-bearing fields', () => {
  // sanitizeUrl was applied only at the two request call sites, so a URL
  // reaching a log any other way kept its query string intact.
  it('sanitizes a URL nested under an ordinary name', () => {
    expect(
      redactTree({ ctx: { config: { url: '/api/x?token=abc&page=2' } } }),
    ).toEqual({ ctx: { config: { url: `/api/x?token=${CENSOR}&page=2` } } });
  });

  it('sanitizes every URL-shaped field name', () => {
    const out = redactTree({
      uri: '/a?apiKey=k',
      path: '/b?sig=s',
      originalUrl: '/c?password=p',
      referer: 'https://h.test/d?token=t',
    });
    expect(out).toEqual({
      uri: `/a?apiKey=${CENSOR}`,
      path: `/b?sig=${CENSOR}`,
      originalUrl: `/c?password=${CENSOR}`,
      referer: `https://h.test/d?token=${CENSOR}`,
    });
  });

  it('is idempotent, so the request serializer may sanitize first', () => {
    const once = sanitizeUrl('/api/x?token=abc&page=2') as string;
    expect(redactTree({ url: once })).toEqual({ url: once });
  });

  it('leaves a URL with no sensitive parameter by reference', () => {
    const input = { url: '/api/x?page=2' };
    expect(redactTree(input)).toBe(input);
  });

  it('does not sanitize a non-string value at a URL name', () => {
    const input = { url: { nested: 'value' } };
    expect(redactTree(input)).toBe(input);
  });
});
