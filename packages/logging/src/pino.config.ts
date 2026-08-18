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
       * Runs after serializers and before `redact.paths` (pino applies
       * redaction to this function's return value), so it sees serialized
       * `req`/`res`/`err` shapes and the two layers compose.
       */
      log(object: Record<string, unknown>): Record<string, unknown> {
        return redactTree(object) as Record<string, unknown>;
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
      req: (req: any) => {
        if (!req) return {};
        return {
          id: req.id,
          method: req.method,
          // Credentials ride in query strings constantly (password resets,
          // presigned links, webhook callbacks). `url` is a single string, so
          // no path-based rule can reach inside it — it has to be rewritten.
          url: sanitizeUrl(req.url),
          // `query` and `params` are objects, so the depth-independent pass in
          // `formatters.log` censors sensitive names inside them. They are
          // deliberately not dropped wholesale: request shape is most of a
          // request log's diagnostic value.
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
        };
      },
      res: (res: any) => ({
        statusCode: res.statusCode,
        headers: {
          'content-type': res.getHeaders()['content-type'],
          'content-length': res.getHeaders()['content-length'],
        },
      }),
      err: pino.stdSerializers.err,
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
