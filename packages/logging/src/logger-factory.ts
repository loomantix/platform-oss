/** @format */

import { PinoLoggerService } from './pino-logger.service';

/**
 * Factory function to create a standardized logger instance with OpenTelemetry integration.
 *
 * This ensures all application logs are:
 * - In JSON format (for Loki/Grafana parsing)
 * - Include OpenTelemetry trace context (traceId, spanId, traceFlags)
 * - Follow consistent naming conventions
 * - Apply the PHI/PII redaction configured in `pino.config`
 *
 * @param context - The context/component name for the logger (e.g., service name, class name)
 * @param serviceName - Optional service name override. Falls back to `SERVICE_NAME` env var, then `'unknown'`.
 * @returns A PinoLoggerService instance configured for JSON logging with OTel
 *
 * @example
 * ```typescript
 * // In a NestJS service
 * import { createLogger } from '@loomantix/logging';
 *
 * export class MyService {
 *   private readonly logger = createLogger(MyService.name);
 *
 *   someMethod() {
 *     this.logger.log('Processing request', { requestId: '123' });
 *     // Output: {"level":30,"time":"...","msg":"Processing request","context":"MyService","requestId":"123","traceId":"...","spanId":"..."}
 *   }
 * }
 * ```
 */
export function createLogger(
  context: string,
  serviceName?: string,
): PinoLoggerService {
  return new PinoLoggerService(context, serviceName);
}
