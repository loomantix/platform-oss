/** @format */
import { LoggerService, LogLevel } from '@nestjs/common';
import pino, { Logger as PinoLogger } from 'pino';
import { createPinoConfig } from './pino.config';
import { emitToEventSink } from './event-sink';
import { detectPHI, hasPHIFields } from './phi-detector';

/**
 * Coerce a value to a safe string, never throwing. Used for:
 * - the `msg` argument to pino (second arg must be a string; passing an
 *   object there would stringify via util.format, bypassing redaction)
 * - the `msg` argument to the event sink
 *
 * Objects are JSON-stringified in a try/catch so circular references (common
 * in request/response payloads) cannot crash the logging path.
 */
function toSafeString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return undefined;
  if (value instanceof Error) return value.message;
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return '[unstringifiable]';
    }
  }
  return String(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !(value instanceof Error) &&
    !Array.isArray(value)
  );
}

/**
 * Singleton root pino logger — shares transport across every child logger
 * to prevent EventEmitter memory leaks from creating multiple pino-pretty
 * transports. The root's `service` comes from `SERVICE_NAME` env (or
 * 'unknown'); per-instance `serviceName` is applied via child bindings
 * in the constructor so each logger can override independently.
 */
let rootLogger: PinoLogger | null = null;

function getRootLogger(): PinoLogger {
  if (!rootLogger) {
    // Pull serviceName from env only — per-instance overrides go through
    // child bindings on the constructor so a later `new PinoLoggerService(
    // ctx, 'foo')` isn't silently ignored by the singleton cache.
    rootLogger = pino(createPinoConfig());
  }
  return rootLogger;
}

/**
 * NestJS Logger implementation using Pino for structured JSON logging.
 * This ensures all application logs (not just HTTP) are in JSON format.
 */
export class PinoLoggerService implements LoggerService {
  private readonly logger: PinoLogger;

  constructor(context?: string, serviceName?: string) {
    const bindings: Record<string, string> = {
      context: context || 'Application',
    };
    // Per-instance `serviceName` override lives on the child binding so
    // subsequent constructor calls with a different serviceName are honored
    // (the singleton root is shared for transport reuse, but child bindings
    // are per-instance). If serviceName is omitted here, the root's `base`
    // field (resolved from SERVICE_NAME env) is used.
    if (serviceName) {
      bindings['service'] = serviceName;
    }
    this.logger = getRootLogger().child(bindings);
  }

  log(message: any, ...optionalParams: any[]) {
    this.emit('info', message, optionalParams);
  }

  error(message: any, ...optionalParams: any[]) {
    // Pull an Error out of optionalParams (common NestJS pattern:
    // `logger.error('Operation failed', err)`). If the primary message
    // is itself an Error, `resolvePayload` handles it.
    let errFromParams: Error | undefined;
    const contextualParams = optionalParams.filter((param) => {
      if (!errFromParams && param instanceof Error) {
        errFromParams = param;
        return false;
      }
      return true;
    });

    const formatted = this.formatMessage(message, contextualParams);
    const msg = this.resolvePayload(message, formatted);

    if (errFromParams && !formatted['err']) {
      formatted['err'] = errFromParams;
      if (errFromParams.stack) formatted['stack'] = errFromParams.stack;
    } else if (!formatted['stack']) {
      // Fallback: a multi-line string in optionalParams is likely a stack.
      const stackArg = contextualParams.find(
        (p): p is string => typeof p === 'string' && p.includes('\n'),
      );
      if (stackArg) formatted['stack'] = stackArg;
    }

    this.logger.error(formatted, msg ?? '');
    emitToEventSink({ ...formatted, log_level: 'error' }, msg);
  }

  warn(message: any, ...optionalParams: any[]) {
    this.emit('warn', message, optionalParams);
  }

  debug(message: any, ...optionalParams: any[]) {
    this.emit('debug', message, optionalParams);
  }

  verbose(message: any, ...optionalParams: any[]) {
    // NestJS `verbose` maps to pino `trace` so the sink payload can be
    // distinguished from `debug` downstream.
    this.emit('trace', message, optionalParams, 'trace');
  }

  setLogLevels?(_levels: LogLevel[]): void {
    // Pino log level is configured at creation time, not dynamically.
  }

  /** Shared path for log/warn/debug/verbose. */
  private emit(
    pinoLevel: 'info' | 'warn' | 'debug' | 'trace',
    message: any,
    optionalParams: any[],
    sinkLevel: string = pinoLevel === 'info' ? 'info' : pinoLevel,
  ) {
    const formatted = this.formatMessage(message, optionalParams);
    const msg = this.resolvePayload(message, formatted);
    this.logger[pinoLevel](formatted, msg ?? '');
    emitToEventSink({ ...formatted, log_level: sinkLevel }, msg);
  }

  /**
   * Resolve the primary `message` argument into (a) structured fields merged
   * into `formatted` and (b) a safe string for pino's `msg` field.
   *
   * Why: pino's `redact.paths` config only applies to the first (merging
   * object) argument. If a caller passes an object as the primary message
   * (e.g. `logger.log({ ssn: '...' })`), naive `logger.info(formatted, obj)`
   * would util.format the object into `msg` and bypass redaction. Merging
   * plain-object messages into `formatted` routes them through redaction;
   * strings and primitives become the `msg` field directly.
   */
  private resolvePayload(
    message: unknown,
    formatted: Record<string, any>,
  ): string | undefined {
    if (typeof message === 'string') return message;
    if (message instanceof Error) {
      formatted['err'] = message;
      if (message.stack) formatted['stack'] = message.stack;
      return message.message;
    }
    if (isPlainObject(message)) {
      Object.assign(formatted, message);
      return undefined;
    }
    // Non-plain, non-Error, non-string message (array, class instance, etc).
    // toSafeString JSON-stringifies into `msg`, which pino.redact.paths does
    // NOT cover (redact only applies to the merge object). Scan for PHI
    // before stringifying so a caller logging e.g. `logger.info(someInstance)`
    // can't bypass redaction by carrying sensitive fields on a non-plain shape.
    if (hasPHIFields(message)) {
      return '[redacted: object containing PHI fields]';
    }
    const stringified = toSafeString(message);
    if (stringified !== undefined && detectPHI(stringified)) {
      return '[redacted: matches PHI pattern]';
    }
    return stringified;
  }

  /**
   * Extract context (first string optionalParam) and metadata (first
   * non-null object optionalParam) into a structured object. Pino will
   * merge this object with the base/child bindings on the log call.
   */
  private formatMessage(
    _message: any,
    optionalParams: any[],
  ): Record<string, any> {
    const context = optionalParams.find((param) => typeof param === 'string');
    const metadata = optionalParams.find(
      (param) => typeof param === 'object' && param !== null,
    );

    const result: Record<string, any> = {};
    if (context) {
      result['context'] = context;
    }
    if (metadata) {
      Object.assign(result, metadata);
    }
    return result;
  }
}
