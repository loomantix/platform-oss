/** @format */

/**
 * Valid Node.js environment values.
 * Using a union type ensures compile-time safety when checking environments.
 */
export type NodeEnvironment = 'development' | 'staging' | 'production' | 'test';

/**
 * Gets the current NODE_ENV value.
 * Returns 'development' if NODE_ENV is not set or is an unexpected value.
 */
export function getEnvironment(): NodeEnvironment {
  const env = process.env['NODE_ENV'];
  if (
    env === 'development' ||
    env === 'staging' ||
    env === 'production' ||
    env === 'test'
  ) {
    return env;
  }
  return 'development';
}

/**
 * Checks if the current environment should use production-like behavior.
 * Returns true for both 'production' and 'staging' environments.
 *
 * Use this for:
 * - Performance tuning (retry counts, timeouts)
 * - Graceful degradation behavior
 * - Log levels and verbosity
 * - Security-sensitive features
 *
 * @example
 * ```typescript
 * const maxRetries = isProductionLike() ? 5 : 30;
 * const logLevel = isProductionLike() ? 'info' : 'debug';
 * ```
 */
export function isProductionLike(): boolean {
  const env = getEnvironment();
  return env === 'production' || env === 'staging';
}

/**
 * Checks if the current environment is strictly production.
 * Returns true only for 'production' environment.
 *
 * Use this sparingly - prefer isProductionLike() in most cases.
 * Only use when behavior must differ between staging and production.
 *
 * @example
 * ```typescript
 * // Block test endpoints in production only
 * if (isProduction()) {
 *   throw new ForbiddenException('Not available in production');
 * }
 * ```
 */
export function isProduction(): boolean {
  return getEnvironment() === 'production';
}

/**
 * Checks if the current environment is development.
 * Returns true only for 'development' environment.
 *
 * Use this for development-only features like:
 * - Local database shortcuts
 * - Development-specific debug output
 * - Local file paths and configurations
 */
export function isDevelopment(): boolean {
  return getEnvironment() === 'development';
}

/**
 * Checks if the current environment is a test environment.
 * Returns true only for 'test' environment.
 */
export function isTest(): boolean {
  return getEnvironment() === 'test';
}
