/** Shared version-string invariant for the monitor and the Vite plugin. */
export const MAX_VERSION_LENGTH = 256;

/**
 *
 */
export function isValidVersion(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_VERSION_LENGTH &&
    value.trim() === value
  );
}

/**
 *
 */
export function assertVersion(
  value: unknown,
  name: string,
): asserts value is string {
  if (!isValidVersion(value)) {
    throw new TypeError(
      `${name} must be a non-empty string no longer than ${MAX_VERSION_LENGTH} characters`,
    );
  }
}
