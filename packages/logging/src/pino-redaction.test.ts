/**
 * Integration tests for `createPinoConfig`'s `redact.paths`.
 *
 * Builds a real pino instance backed by an in-memory destination, logs
 * sample objects, and asserts that sensitive fields come out as
 * `[REDACTED]`.
 *
 * **Important:** pino's `redact.paths` entries use `fast-redact` wildcard
 * semantics. The config's `*.foo` pattern matches `foo` at depth 1
 * (i.e., `{parent: {foo: 'x'}}`), NOT at the root level. The tests below
 * reflect that by nesting sensitive fields under a parent key — this is
 * how backend callers log them in practice (`req.user.ssn`, etc.).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import pino, { Logger } from 'pino';
import { createPinoConfig } from './pino.config';

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
    captured.logger.info(
      {
        patient: {
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
    const patient = captured.lines[0]!['patient'] as Record<string, unknown>;
    expect(patient['ssn']).toBe('[REDACTED]');
    expect(patient['dob']).toBe('[REDACTED]');
    expect(patient['dateOfBirth']).toBe('[REDACTED]');
    expect(patient['email']).toBe('[REDACTED]');
    expect(patient['phone']).toBe('[REDACTED]');
    expect(patient['phoneNumber']).toBe('[REDACTED]');
    expect(patient['address']).toBe('[REDACTED]');
    expect(patient['creditCard']).toBe('[REDACTED]');
    expect(patient['bankAccount']).toBe('[REDACTED]');
  });

  it('redacts depth-1 medical identifiers (mrn, patientId, medicalRecordNumber)', () => {
    captured.logger.info(
      {
        patient: {
          mrn: 'MRN-123',
          patientId: 'P-123',
          medicalRecordNumber: 'MRN-123',
          healthInsuranceNumber: 'HIN-9',
          insuranceId: 'INS-1',
        },
      },
      'lookup',
    );
    const patient = captured.lines[0]!['patient'] as Record<string, unknown>;
    expect(patient['mrn']).toBe('[REDACTED]');
    expect(patient['patientId']).toBe('[REDACTED]');
    expect(patient['medicalRecordNumber']).toBe('[REDACTED]');
    expect(patient['healthInsuranceNumber']).toBe('[REDACTED]');
    expect(patient['insuranceId']).toBe('[REDACTED]');
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
