/** @format */

import {
  SENSITIVE_FIELD_NAMES,
  isSensitiveFieldName,
  normalizePHIName,
} from './phi-detector';

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
 * Maximum number of object nodes a single {@link redactTree} call will visit.
 *
 * The visited set is scoped to the *current path* (see the `finally` in
 * `redactNode`) so that a node reachable by two different paths is censored on
 * both. The cost of that correctness is that a shared subtree is re-walked
 * once per path reaching it, which is `fan^depth` work for a payload holding
 * only `depth` distinct objects — twelve objects fanning out eight ways reach
 * ~7e10 visits and pin the event loop. The depth cap bounds how *deep* the
 * walk goes, not how *much* work it does; this bounds the work.
 *
 * Ten thousand nodes is far past any legitimate log payload, so hitting it
 * means the same thing hitting the depth cap does, and it fails closed the
 * same way.
 */
export const MAX_REDACT_NODES = 10_000;

const BUDGET_CENSOR = '[REDACTED: too large]';

/**
 * Written in place of a node whose properties could not be read.
 *
 * `Object.entries` invokes getters, and `formatters.log` runs outside any of
 * pino's error handling — an accessor that throws would otherwise escape the
 * `logger.info()` call and crash the caller. pino on its own tolerates such a
 * payload, so the walker must too.
 */
const UNREADABLE_CENSOR = '[REDACTED: unreadable]';

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
 * Built from {@link SENSITIVE_FIELD_NAMES} so the stdout path and the
 * event-sink path cannot drift: adding a name to `PHI_FIELD_NAMES` or
 * `CREDENTIAL_FIELD_NAMES` protects both channels. Both lists live in
 * `phi-detector.ts` because the sink matches against the same union; keeping
 * the credential names here instead made them stdout-only, which is the
 * original defect with the channels swapped.
 *
 * Exported because `pino.config.ts` derives its `redact.paths` backstop from
 * it.
 */
export const REDACTED_FIELD_NAMES: ReadonlySet<string> = new Set<string>([
  ...SENSITIVE_FIELD_NAMES,
  // `snake_case` spellings of names already covered in camelCase above.
  //
  // The walk does not need these — `isSensitiveName` normalizes separators, so
  // `patient_id` already matches `patientId`. The `redact.paths` backstop does:
  // `fast-redact` matches a path literally and never normalizes, and it is the
  // only layer covering `logger.child()` bindings. Dropping these spellings
  // would silently narrow that layer.
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
]);

/**
 * True when `name` names a field whose value must never be logged.
 *
 * Delegates to `phi-detector.ts` so the stdout walk, the event sink, and
 * `assertPHISafe` all match names by one rule against one set. Splitting
 * either the rule or the set is how the two channels drifted apart.
 */
function isSensitiveName(name: string): boolean {
  return isSensitiveFieldName(name);
}

/**
 * Field names whose string value is a URL and must be rewritten, not censored.
 *
 * {@link sanitizeUrl} was applied only at the two request call sites, so a URL
 * reaching a log any other way kept its query string intact. The common case is
 * an error: an HTTP client hangs the whole failed request off the error it
 * throws, so `err.config.url` — token and all — is an ordinary payload, and it
 * is logged at `error` level at exactly the moment the request failed.
 *
 * These are rewritten rather than replaced with {@link CENSOR} because the URL
 * is most of what makes the entry diagnostic; the value inside it is the only
 * part that has to go. A secret inside a string is unreachable by any
 * name-matching rule, which is why the string has to be parsed at all.
 */
const URL_FIELD_NAMES: ReadonlySet<string> = new Set(
  [
    'url',
    'uri',
    'path',
    'originalUrl',
    'requestUrl',
    'baseURL',
    'location',
    'referer',
    'referrer',
  ].map(normalizePHIName),
);

/** True when `name` names a field whose string value should be sanitized. */
function isUrlName(name: string): boolean {
  return URL_FIELD_NAMES.has(normalizePHIName(name));
}

/**
 * Values that are objects but must be handed to the serializer untouched.
 *
 * Walking into them would either lose information (a `Date`'s valueOf) or
 * produce a nonsense clone (a `Buffer` becomes `{0: 12, 1: 45, ...}`).
 *
 * Being on this list is necessary but not sufficient: one of these values can
 * still serialize a named field if a property was assigned to it directly, so
 * {@link carriesOwnData} decides whether the early return is actually safe.
 *
 * `Error` is deliberately *not* here. An error is a bag of arbitrary
 * application data in practice — an HTTP client attaches the whole failed
 * request to it — and skipping it published `config.headers.Authorization`
 * and `response.data.transcript` in cleartext. See {@link redactError}.
 */
function isOpaque(value: object): boolean {
  return (
    value instanceof Date ||
    value instanceof RegExp ||
    value instanceof Map ||
    value instanceof Set ||
    ArrayBuffer.isView(value) ||
    value instanceof ArrayBuffer
  );
}

/**
 * True when an otherwise-opaque value would still serialize named fields.
 *
 * "None of them can carry a named field" is not quite right: an own enumerable
 * property assigned to a `Map`, `Set`, `RegExp`, or plain typed array is what
 * `JSON.stringify` emits for it, since those have no `toJSON` to override the
 * result. Returning such a value early handed the serializer an unwalked
 * object, and `redact.paths` only reaches depth 1 — so `{a:{b:{m}}}` with an
 * `ssn` hung off `m` published it in cleartext.
 *
 * A value whose `toJSON` governs the output (`Date`, `Buffer`) is unaffected:
 * `JSON.stringify` calls the method and ignores own properties entirely, so it
 * stays opaque and keeps rendering as a timestamp rather than its fields.
 *
 * `Object.keys` reads key names without invoking getters, so this cannot throw
 * on a value the walk was about to pass through.
 */
function carriesOwnData(value: object): boolean {
  if (typeof (value as { toJSON?: unknown }).toJSON === 'function') {
    return false;
  }
  return Object.keys(value).length > 0;
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

/** Mutable state threaded through one {@link redactTree} walk. */
interface WalkState {
  /**
   * Objects on the *current path*, released on the way out so a value
   * legitimately reachable by two different paths (a shared config object) is
   * redacted on both, not skipped on the second.
   */
  seen: WeakSet<object>;
  /** Remaining node visits; see {@link MAX_REDACT_NODES}. */
  budget: number;
  /** Root-level keys to pass through untouched; see {@link RedactOptions}. */
  skipRootKeys?: ReadonlySet<string> | undefined;
}

/** Options accepted by {@link redactTree}. */
export interface RedactOptions {
  /**
   * Root-level keys handed through by reference instead of being walked.
   *
   * This exists for pino's serializers. `formatters.log` runs *before* them
   * (pino `lib/tools.js`: `obj = formatters.log(obj)`, then the per-key
   * `serializers[key](value)` loop), so without this the walker receives the
   * live `req` / `res` / `err` objects rather than the plain shapes their
   * serializers produce — and walking a live framework object destroys it.
   *
   * The walk builds its output with `Object.entries` and plain assignment, so
   * it keeps only *own enumerable* properties. Methods and getters live on the
   * prototype and do not survive. Because a real `req` / `res` graph is deeper
   * than {@link MAX_REDACT_DEPTH}, the fail-closed depth marker always makes
   * the walk report a change, which always forces that lossy clone: `res`
   * arrived at its serializer without `getHeaders` (a `TypeError` on every
   * response log) and `req` without its `headers` / `ip` / `query` accessors
   * (empty headers and no client address in every request log).
   *
   * Serializers redact their own output instead — plain objects, walked with
   * no live prototype to lose.
   */
  skipRootKeys?: ReadonlySet<string> | undefined;
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
export function redactTree(value: unknown, options?: RedactOptions): unknown {
  return redactNode(value, 0, {
    seen: new WeakSet<object>(),
    budget: MAX_REDACT_NODES,
    skipRootKeys: options?.skipRootKeys,
  });
}

/**
 * Rebuild an `Error` as a plain, redacted object.
 *
 * Errors carry arbitrary application data: an HTTP client hangs the entire
 * failed request off one, so `err.config.headers.Authorization` and
 * `err.response.data.transcript` are ordinary contents, not exotic ones.
 * Passing errors through untouched published both in cleartext.
 *
 * `name` / `message` / `stack` are non-enumerable, so they have to be copied
 * across explicitly or the result is the `{}` that `JSON.stringify` gives for
 * a bare error. The shape matches `pino.stdSerializers.err` so a nested error
 * reads the same as a top-level one.
 */
function redactError(
  error: Error,
  depth: number,
  state: WalkState,
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    type: error.name,
    message: error.message,
    stack: error.stack,
  };
  for (const [key, item] of Object.entries(error)) {
    if (isSensitiveName(key)) {
      safeAssign(out, key, CENSOR);
      continue;
    }
    if (typeof item === 'string' && isUrlName(key)) {
      safeAssign(out, key, sanitizeUrl(item));
      continue;
    }
    safeAssign(out, key, redactNode(item, depth + 1, state));
  }
  return out;
}

function redactNode(value: unknown, depth: number, state: WalkState): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (isOpaque(value) && !carriesOwnData(value)) {
    return value;
  }
  if (state.seen.has(value)) {
    return CIRCULAR;
  }
  if (depth >= MAX_REDACT_DEPTH) {
    return DEPTH_CENSOR;
  }
  if (state.budget <= 0) {
    return BUDGET_CENSOR;
  }
  state.budget -= 1;
  state.seen.add(value);

  try {
    if (value instanceof Error) {
      return redactError(value, depth, state);
    }

    // `toJSON` is what actually reaches the sink: `JSON.stringify` calls it
    // and serializes its return value, so judging this node by its own
    // properties inspects a shape that is never written. The method usually
    // lives on a prototype, so `Object.entries` does not see it, and a class
    // may hold its data under a private name (`#ssn`, `_ssn`) while the
    // projection exposes `ssn` — an ORM document or a `class-transformer` DTO
    // does exactly this. `redact.paths` cannot cover it either: fast-redact
    // also matches the live object rather than the projection.
    //
    // Walking the projection returns an object that is never the original, so
    // the serializer stringifies the walked shape and cannot re-invoke
    // `toJSON`. A `toJSON` returning `this` lands on the `seen` guard above
    // and censors as `[Circular]`, which is the fail-closed answer.
    const toJson: unknown = (value as { toJSON?: unknown }).toJSON;
    if (typeof toJson === 'function') {
      return redactNode(
        (toJson as (this: unknown) => unknown).call(value),
        depth,
        state,
      );
    }

    if (Array.isArray(value)) {
      let changed = false;
      const out = value.map((item) => {
        const next = redactNode(item, depth + 1, state);
        if (next !== item) changed = true;
        return next;
      });
      return changed ? out : value;
    }

    let changed = false;
    const out: Record<string, unknown> = {};
    // `Object.entries` invokes getters, so this whole block is inside the
    // `catch` below: an accessor that throws must not escape `logger.info()`.
    for (const [key, item] of Object.entries(value)) {
      if (depth === 0 && state.skipRootKeys?.has(key)) {
        safeAssign(out, key, item);
        continue;
      }
      if (isSensitiveName(key)) {
        safeAssign(out, key, CENSOR);
        changed = true;
        continue;
      }
      if (typeof item === 'string' && isUrlName(key)) {
        const sanitized = sanitizeUrl(item);
        if (sanitized !== item) changed = true;
        safeAssign(out, key, sanitized);
        continue;
      }
      const next = redactNode(item, depth + 1, state);
      if (next !== item) changed = true;
      safeAssign(out, key, next);
    }
    return changed ? out : value;
  } catch {
    return UNREADABLE_CENSOR;
  } finally {
    state.seen.delete(value);
  }
}

/**
 * Censor `user:pass@` credentials embedded in an absolute URL.
 *
 * Matters because {@link sanitizeUrl} is applied to `referer`, which arrives
 * as a full absolute URL rather than a path.
 */
function stripUserinfo(path: string): string {
  return path.replace(/^([A-Za-z][\w+.-]*:\/\/)[^/@]*@/, `$1${CENSOR}@`);
}

/**
 * Judge a raw (still percent-encoded) query parameter name.
 *
 * Array and nested syntax (`token[]`, `filters[token]`) is what `qs`, Rails
 * and PHP emit, and it hides the name from a plain set lookup, so the
 * bracketed form is unwrapped and checked too.
 */
function isSensitiveParam(rawName: string): boolean {
  let name: string;
  try {
    name = decodeURIComponent(rawName);
  } catch {
    // Malformed percent-encoding — judge the raw name rather than throwing
    // and losing the whole URL.
    name = rawName;
  }
  if (isSensitiveName(name)) {
    return true;
  }
  const bracket = name.indexOf('[');
  if (bracket === -1) {
    return false;
  }
  // Check the base segment and every bracket segment. Reading only the last
  // bracket missed both `token[0]` — which is what `qs` emits by default for
  // a repeated parameter, so the sensitive name is the *base* — and
  // `filters[auth][token]`, which the previous single-group pattern could not
  // match at all.
  if (isSensitiveName(name.slice(0, bracket))) {
    return true;
  }
  for (const match of name.slice(bracket).matchAll(/\[([^\]]*)\]/g)) {
    const segment = match[1];
    if (
      segment !== undefined &&
      segment.length > 0 &&
      isSensitiveName(segment)
    ) {
      return true;
    }
  }
  return false;
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

  const path = stripUserinfo(
    queryAt === -1 ? withoutHash : withoutHash.slice(0, queryAt),
  );
  if (queryAt === -1) {
    return path;
  }

  const rawQuery = withoutHash.slice(queryAt + 1);
  if (rawQuery.length === 0) {
    return path;
  }

  // Capturing the separator keeps `;`-delimited pairs — legal, and still
  // emitted by older stacks — from being treated as one opaque parameter.
  const parts = rawQuery.split(/([&;])/).map((piece) => {
    if (piece.length === 0 || piece === '&' || piece === ';') return piece;
    const eq = piece.indexOf('=');
    if (eq === -1) return piece;
    const name = piece.slice(0, eq);
    return isSensitiveParam(name) ? `${name}=${CENSOR}` : piece;
  });

  return `${path}?${parts.join('')}`;
}
