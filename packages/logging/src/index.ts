/** @format */

export { PinoLoggerService } from './pino-logger.service';
export { pinoConfig, createPinoConfig } from './pino.config';
export {
  detectPHI,
  extractPHIFields,
  logMetadata,
  assertPHISafe,
  hasPHIFields,
} from './phi-detector';
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
