/** @format */

/**
 * Returns a Promise that resolves after the specified number of milliseconds.
 * Useful for retry delays, backoff strategies, and rate limiting.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
