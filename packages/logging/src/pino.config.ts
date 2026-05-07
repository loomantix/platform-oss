/** @format */
import pino, { LoggerOptions } from 'pino';
import { trace, context as otelContext } from '@opentelemetry/api';
import { isProductionLike, isDevelopment, getEnvironment } from './environment';

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
    },

    // Use shorter field names for cleaner logs
    messageKey: 'msg',
    errorKey: 'err',
    redact: {
      // pino / fast-redact path semantics:
      //   - `foo`       → matches `foo` at the top level of the merging object
      //   - `*.foo`     → matches `foo` nested one level deep (parent.foo)
      //   - `a.b.c`     → matches exactly that path
      //
      // Each sensitive field is listed in BOTH forms so it's redacted whether
      // the caller logs `{ssn: 'x'}` directly or nested under a parent object
      // like `{patient: {ssn: 'x'}}`. Dropping either form creates a bypass.
      paths: [
        // Authentication & authorization headers (exact paths)
        'req.headers.authorization',
        'req.headers.cookie',
        'req.headers["x-api-key"]',
        'res.headers["set-cookie"]',
        // Auth / credentials — root and depth-1
        'password',
        '*.password',
        'token',
        '*.token',
        'secret',
        '*.secret',
        'apiKey',
        '*.apiKey',
        'api_key',
        '*.api_key',
        'sessionId',
        '*.sessionId',
        'session_id',
        '*.session_id',
        // PHI / PII — root and depth-1
        'ssn',
        '*.ssn',
        'dob',
        '*.dob',
        'dateOfBirth',
        '*.dateOfBirth',
        'date_of_birth',
        '*.date_of_birth',
        'medicalRecordNumber',
        '*.medicalRecordNumber',
        'mrn',
        '*.mrn',
        'patientId',
        '*.patientId',
        'patient_id',
        '*.patient_id',
        'healthInsuranceNumber',
        '*.healthInsuranceNumber',
        'insuranceId',
        '*.insuranceId',
        'email', // Email can be PHI if associated with health info
        '*.email',
        'phone',
        '*.phone',
        'phoneNumber',
        '*.phoneNumber',
        'address',
        '*.address',
        'creditCard',
        '*.creditCard',
        'credit_card',
        '*.credit_card',
        'bankAccount',
        '*.bankAccount',
        'bank_account',
        '*.bank_account',
      ],
      censor: '[REDACTED]',
    },
    serializers: {
      req: (req: any) => {
        if (!req) return {};
        return {
          id: req.id,
          method: req.method,
          url: req.url,
          query: req.query,
          params: req.params,
          headers: req.headers
            ? {
                'content-type': req.headers['content-type'],
                'user-agent': req.headers['user-agent'],
                'x-forwarded-for': req.headers['x-forwarded-for'],
                'x-real-ip': req.headers['x-real-ip'],
                referer: req.headers.referer,
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
