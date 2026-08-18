/** @format */

export { PinoLoggerService } from './pino-logger.service';
export { pinoConfig, createPinoConfig } from './pino.config';
export {
  detectPHI,
  extractPHIFields,
  logMetadata,
  assertPHISafe,
  hasPHIFields,
  PHI_FIELD_NAMES,
} from './phi-detector';
export {
  CENSOR,
  MAX_REDACT_DEPTH,
  MAX_REDACT_NODES,
  REDACTED_FIELD_NAMES,
  type RedactOptions,
  redactTree,
  sanitizeUrl,
} from './redaction';
export { createLogger } from './logger-factory';
export {
  type EventSinkFn,
  setEventSink,
  emitToEventSink,
  hasEventSink,
} from './event-sink';
export {
  type NodeEnvironment,
  getEnvironment,
  isProductionLike,
  isProduction,
  isDevelopment,
  isTest,
} from './environment';
export { sleep } from './sleep';
