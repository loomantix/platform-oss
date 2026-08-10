/** Shared version-string invariant for the monitor and the Vite plugin. */
export const MAX_VERSION_LENGTH = 256;

/**
 * Wire format of the deployed manifest the monitor polls. Exported so a build
 * that does not use the Vite plugin — webpack, a CI script, a server route —
 * has a typed contract for the file it must serve.
 */
export interface VersionManifest {
  /** Opaque identifier of the deployed artifact. */
  readonly version: string;
  /** Optional build timestamp. Ignored by the monitor. */
  readonly builtAt?: string;
}

/** Whether a value is an acceptable opaque version identifier. */
export function isValidVersion(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_VERSION_LENGTH &&
    value.trim() === value
  );
}

/** Throw a `TypeError` naming `name` when the value is not a valid version. */
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
