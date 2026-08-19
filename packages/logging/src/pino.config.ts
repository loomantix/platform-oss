/** @format */
import pino, { LoggerOptions } from 'pino';
import { trace, context as otelContext } from '@opentelemetry/api';
import { isProductionLike, isDevelopment, getEnvironment } from './environment';
import {
  CENSOR,
  REDACTED_FIELD_NAMES,
  redactTree,
  sanitizeUrl,
} from './redaction';

/**
 * Render one field name as the `fast-redact` paths that match it at the root
 * and at depth 1.
 *
 * Names that are not valid JS identifiers (`set-cookie`, `x-api-key`) have to
 * go through bracket syntax; `a.set-cookie` would be parsed as a subtraction.
 */
function redactPathsFor(name: string): string[] {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)
    ? [name, `*.${name}`]
    : [`["${name}"]`, `*["${name}"]`];
}

/**
 * Exact paths that name a location rather than a field, so they cannot be
 * derived from the field-name set.
 */
const EXACT_REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'res.headers["set-cookie"]',
];

/**
 * Root keys pino hands to a serializer.
 *
 * `formatters.log` must leave these alone: it runs *before* the serializers,
 * so it would otherwise walk the live `req` / `res` / `err` objects instead of
 * the plain shapes the serializers produce. Each serializer redacts its own
 * output instead — see `RedactOptions.skipRootKeys`.
 *
 * Kept in one place so the skip set and the serializer map cannot drift.
 */
const SERIALIZED_KEYS: ReadonlySet<string> = new Set(['req', 'res', 'err']);

/**
 * True when a value is safe to hand back from `formatters.log`.
 *
 * Arrays are excluded along with primitives: pino's `for…in` over an array
 * emits numeric keys, not the entry the caller meant to log.
 */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const REDACT_PATHS = [
  ...new Set([
    ...EXACT_REDACT_PATHS,
    ...[...REDACTED_FIELD_NAMES].flatMap(redactPathsFor),
  ]),
];

/**
 * Check if pretty logging should be enabled.
 * Pretty logging is enabled in development unless explicitly disabled via LOG_FORMAT=json
 */
function shouldUsePrettyLogs(): boolean {
  if (process.env['LOG_FORMAT'] === 'json') return false;
  if (process.env['LOG_FORMAT'] === 'pretty') return true;
  return isDevelopment();
}

/**
 * Mixin to inject OpenTelemetry trace context into every log entry
 */
function traceMixin() {
  const span = trace.getSpan(otelContext.active());
  if (!span) return {};

  const spanContext = span.spanContext();
  return {
    traceId: spanContext.traceId,
    spanId: spanContext.spanId,
    traceFlags: spanContext.traceFlags,
  };
}

/**
 * Create Pino logger configuration with optional service name override.
 *
 * Service-name resolution order:
 * 1. `serviceName` factory argument
 * 2. `SERVICE_NAME` environment variable
 * 3. `'unknown'` (loud default; consumers should set one of the above)
 */
export function createPinoConfig(serviceName?: string): LoggerOptions {
  const resolvedServiceName =
    serviceName || process.env['SERVICE_NAME'] || 'unknown';

  return {
    level: process.env['LOG_LEVEL'] || (isProductionLike() ? 'info' : 'debug'),
    timestamp: pino.stdTimeFunctions.isoTime,

    // Simplified base fields - less clutter in Loki
    base: {
      service: resolvedServiceName,
      environment: getEnvironment(),
      version: process.env['APP_VERSION'] || 'unknown',
      commit: process.env['GIT_COMMIT'] || 'unknown',
    },

    // Add trace context to every log
    mixin: traceMixin,

    // Add formatters to output only numeric level (parseable by Loki)
    formatters: {
      level(label: string, number: number) {
        return { level: number };
      },
      /**
       * Primary redaction pass: censor every sensitive field name at *any*
       * depth, before pino serializes the entry.
       *
       * `redact.paths` below is a path matcher, and `fast-redact` wildcards
       * consume exactly one level each — so a path list protects the depths
       * it happens to enumerate and silently passes everything deeper. A
       * payload shaped `{ data: { patient: { ssn } } }` sits one level below
       * `*.ssn` and reached stdout in cleartext. Walking the object makes
       * depth irrelevant, which a path list cannot do at any length.
       *
       * Runs *before* the serializers, not after — pino's `_asJson` calls
       * `formatters.log(obj)` and only then loops applying `serializers[key]`.
       * So this pass never sees a serialized shape, and the keys that have a
       * serializer are skipped here and redacted in the serializer instead.
       */
      log(object: Record<string, unknown>): Record<string, unknown> {
        const redacted = redactTree(object, { skipRootKeys: SERIALIZED_KEYS });
        // pino iterates this return value with `for…in`, so anything that is
        // not a plain object is emitted one indexed key per character or
        // element. `redactTree` can legitimately return a non-object — the
        // `toJSON` branch replaces a node with its projection, and projecting
        // to a string is ordinary — so the shape has to be checked here.
        //
        // The shipped config does not reach that case: `mixin` is always set,
        // and pino's `defaultMixinMergeStrategy` does
        // `Object.assign(mixinObject, mergeObject)`, so `object` is already a
        // plain object with no prototype `toJSON` to project. This guard exists
        // because that is an implementation detail of an unrelated option, and
        // a consumer spreading this config may not keep it.
        return isPlainRecord(redacted) ? redacted : {};
      },
    },

    // Use shorter field names for cleaner logs
    messageKey: 'msg',
    errorKey: 'err',
    redact: {
      // SECOND layer. `formatters.log` above is what actually guarantees
      // coverage; these paths are a cheap backstop that keeps working if a
      // consumer spreads this config and replaces `formatters`.
      //
      // They are also the *only* layer covering `logger.child()` bindings.
      // pino renders child bindings once at `child()` time and splices them in
      // as a pre-rendered string, and it resets any custom `formatters.bindings`
      // to its own before doing so (`lib/proto.js`) — so no config-level hook
      // can walk them and coverage there stops at depth 1. A consumer binding
      // untrusted data to a child logger should walk it first: the exported
      // `redactTree` is the same pass `formatters.log` runs.
      //
      //   logger.child(redactTree(bindings) as Bindings)
      //
      // pino / fast-redact path semantics:
      //   - `foo`       → matches `foo` at the top level of the merging object
      //   - `*.foo`     → matches `foo` nested one level deep (parent.foo)
      //   - `a.b.c`     → matches exactly that path
      //
      // Derived from `REDACTED_FIELD_NAMES` (root + depth-1 for every name)
      // rather than hand-maintained. The previous hand-written list had
      // drifted badly from `PHI_FIELD_NAMES`: every clinical field
      // (`transcript`, `soapNote`, `text`, `notes`, the S3 keys) was stripped
      // from the event sink and written to stdout in cleartext. Deriving both
      // from one set is what stops that from recurring.
      paths: REDACT_PATHS,
      censor: CENSOR,
    },
    serializers: {
      // Each serializer redacts its own return value. `formatters.log` cannot
      // do it for them: it runs before they do, so it would be handed the live
      // framework object rather than the plain shape below.
      req: (req: any) => {
        if (!req) return {};
        return redactTree({
          id: req.id,
          method: req.method,
          // Credentials ride in query strings constantly (password resets,
          // presigned links, webhook callbacks). `url` is a single string, so
          // no path-based rule can reach inside it — it has to be rewritten.
          url: sanitizeUrl(req.url),
          // `query` and `params` are objects, so the depth-independent walk
          // censors sensitive names inside them. They are deliberately not
          // dropped wholesale: request shape is most of a request log's
          // diagnostic value.
          query: req.query,
          params: req.params,
          headers: req.headers
            ? {
                'content-type': req.headers['content-type'],
                'user-agent': req.headers['user-agent'],
                'x-forwarded-for': req.headers['x-forwarded-for'],
                'x-real-ip': req.headers['x-real-ip'],
                referer: sanitizeUrl(req.headers.referer),
                origin: req.headers.origin,
              }
            : {},
          remoteAddress: req.ip,
          remotePort: req.socket?.remotePort,
        });
      },
      res: (res: any) => {
        if (!res) return {};
        const headers =
          typeof res.getHeaders === 'function' ? res.getHeaders() : {};
        return redactTree({
          statusCode: res.statusCode,
          headers: {
            'content-type': headers['content-type'],
            'content-length': headers['content-length'],
          },
        });
      },
      // `stdSerializers.err` flattens an error's own enumerable properties
      // into the output, and an HTTP client hangs the whole failed request off
      // one — `err.config.headers.Authorization` and `err.response.data`
      // reached stdout in cleartext until this walked the result.
      err: (error: unknown) =>
        redactTree(pino.stdSerializers.err(error as Error)),
    },
    // Use pretty logs in development for readability
    ...(shouldUsePrettyLogs()
      ? {
          transport: {
            target: 'pino-pretty',
            options: {
              colorize: true,
              translateTime: 'HH:MM:ss.l',
              ignore: 'pid,hostname,service,environment,version,commit',
              sync: true,
            },
          },
        }
      : {}),
  };
}

// Default config for backward compatibility
export const pinoConfig = createPinoConfig();
