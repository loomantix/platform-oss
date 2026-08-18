/** @format */

import { PHI_FIELD_NAMES } from './phi-detector';

/** Replacement written in place of a sensitive value. */
export const CENSOR = '[REDACTED]';

/**
 * Maximum object depth `redactTree` will walk before censoring a subtree
 * outright.
 *
 * Redaction that silently stops descending is a bypass: a caller only has to
 * nest one level deeper than the walker reaches. So the cap fails closed —
 * past this depth the whole subtree is replaced rather than passed through.
 * Twelve is far beyond any legitimate log payload (`req.body.encounter.
 * patient.contact.email` is five), so hitting it means something pathological
 * is being logged and dropping it is the safe answer.
 */
export const MAX_REDACT_DEPTH = 12;

const DEPTH_CENSOR = '[REDACTED: max depth]';

/**
 * Written in place of a back-reference.
 *
 * It has to be a marker, not the original object: returning the original hands
 * the serializer an *un-walked* subtree, which it then renders in full. A
 * payload shaped `{ record: { ssn }, self: <root> }` came out with `ssn`
 * censored under `record` and in cleartext under `self.record`.
 */
const CIRCULAR = '[Circular]';

/**
 * Field names that carry credentials or PHI/PII and must never reach a log
 * sink in cleartext.
 *
 * Built from {@link PHI_FIELD_NAMES} so the stdout path and the event-sink
 * path cannot drift: adding a name to that list now protects both channels.
 * The extras below are the request-header and `snake_case` spellings that
 * only ever appear in wire-shaped payloads, so they have no place in the
 * PHI list that `logMetadata` walks.
 */
export const REDACTED_FIELD_NAMES: ReadonlySet<string> = new Set<string>([
  ...PHI_FIELD_NAMES,
  // Request/response headers.
  'authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-auth-token',
  'proxy-authorization',
  // snake_case spellings of names already covered in camelCase.
  'api_key',
  'session_id',
  'date_of_birth',
  'patient_id',
  'credit_card',
  'bank_account',
  'medical_record_number',
  'health_insurance_number',
  'insurance_id',
  'phone_number',
  'access_token',
  'refresh_token',
  'id_token',
  'client_secret',
  'private_key',
  // Signing material that travels in query strings. A presigned S3 link is a
  // bearer credential: anyone holding the signature can fetch the object until
  // it expires, and those links point at recordings.
  'signature',
  'sig',
  'x-amz-signature',
  'x-amz-credential',
  'x-amz-security-token',
]);

/**
 * Query-string parameters whose *values* are censored by {@link sanitizeUrl}.
 * Matched case-insensitively against {@link REDACTED_FIELD_NAMES}.
 */
function isSensitiveName(name: string): boolean {
  return (
    REDACTED_FIELD_NAMES.has(name) ||
    REDACTED_FIELD_NAMES.has(name.toLowerCase())
  );
}

/**
 * Values that are objects but must be handed to the serializer untouched.
 *
 * Walking into them would either lose information (an `Error`'s non-enumerable
 * `stack`, a `Date`'s valueOf) or produce a nonsense clone (a `Buffer` becomes
 * `{0: 12, 1: 45, ...}`). None of them can carry a named field, so skipping
 * them costs no coverage.
 */
function isOpaque(value: object): boolean {
  return (
    value instanceof Error ||
    value instanceof Date ||
    value instanceof RegExp ||
    value instanceof Map ||
    value instanceof Set ||
    ArrayBuffer.isView(value) ||
    value instanceof ArrayBuffer
  );
}

/**
 * Assign without letting a `__proto__` key reparent the accumulator.
 *
 * `JSON.parse('{"__proto__":{...}}')` yields an object with an *own*
 * `__proto__` key; a plain `out[key] = value` on that key sets the prototype
 * instead of adding a property, handing an attacker influence over an object
 * the log pipeline is about to hand downstream.
 */
function safeAssign(
  out: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
    Object.defineProperty(out, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
    return;
  }
  out[key] = value;
}

/**
 * Recursively censor every {@link REDACTED_FIELD_NAMES} field at any depth.
 *
 * Pino's own `redact.paths` cannot express "this field name, wherever it
 * appears" — `fast-redact` wildcards match one level each, so a path list
 * protects the depths it enumerates and silently leaks the rest. This walks
 * instead of matching, which is what makes depth irrelevant.
 *
 * Never mutates its input: the caller still owns the object it logged, and a
 * logger that rewrites application state would be a far worse bug than the
 * one this fixes. Unchanged subtrees are returned by reference, so a clean
 * payload costs a walk and no allocation.
 */
export function redactTree(value: unknown): unknown {
  return redactNode(value, 0, new WeakSet<object>());
}

function redactNode(
  value: unknown,
  depth: number,
  seen: WeakSet<object>,
): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (isOpaque(value)) {
    return value;
  }
  if (seen.has(value)) {
    return CIRCULAR;
  }
  if (depth >= MAX_REDACT_DEPTH) {
    return DEPTH_CENSOR;
  }
  seen.add(value);

  try {
    if (Array.isArray(value)) {
      let changed = false;
      const out = value.map((item) => {
        const next = redactNode(item, depth + 1, seen);
        if (next !== item) changed = true;
        return next;
      });
      return changed ? out : value;
    }

    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (isSensitiveName(key)) {
        safeAssign(out, key, CENSOR);
        changed = true;
        continue;
      }
      const next = redactNode(item, depth + 1, seen);
      if (next !== item) changed = true;
      safeAssign(out, key, next);
    }
    return changed ? out : value;
  } finally {
    // Release on the way out so a value legitimately reachable by two
    // different paths (a shared config object, an interned string wrapper)
    // is redacted on both, not skipped on the second.
    seen.delete(value);
  }
}

/**
 * Strip credentials and identifiers out of a request URL while keeping the
 * path and the non-sensitive query shape.
 *
 * A raw `req.url` is the one field no path-based redaction can reach: the
 * secret is inside a string, not at a key. Tokens routinely ride in query
 * strings (password resets, presigned links, webhook callbacks), so the
 * string has to be rewritten rather than matched.
 */
export function sanitizeUrl(url: unknown): unknown {
  if (typeof url !== 'string' || url.length === 0) {
    return url;
  }
  const hashAt = url.indexOf('#');
  // Fragments never reach a server; if one is present it came from a
  // client-supplied string and its contents are unvetted. Drop it.
  const withoutHash = hashAt === -1 ? url : url.slice(0, hashAt);
  const queryAt = withoutHash.indexOf('?');
  if (queryAt === -1) {
    return withoutHash;
  }

  const path = withoutHash.slice(0, queryAt);
  const rawQuery = withoutHash.slice(queryAt + 1);
  if (rawQuery.length === 0) {
    return path;
  }

  const parts = rawQuery.split('&').map((pair) => {
    if (pair.length === 0) return pair;
    const eq = pair.indexOf('=');
    if (eq === -1) return pair;
    const name = pair.slice(0, eq);
    let decodedName: string;
    try {
      decodedName = decodeURIComponent(name);
    } catch {
      // Malformed percent-encoding — judge the raw name rather than throwing
      // and losing the whole URL.
      decodedName = name;
    }
    return isSensitiveName(decodedName) ? `${name}=${CENSOR}` : pair;
  });

  return `${path}?${parts.join('&')}`;
}
