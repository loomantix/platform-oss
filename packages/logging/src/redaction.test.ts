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
    const err = new Error('boom');
    const buf = Buffer.from('abc');
    const out: any = redactTree({ date, err, buf });
    expect(out.date).toBe(date);
    expect(out.err).toBe(err);
    expect(out.buf).toBe(buf);
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
});
