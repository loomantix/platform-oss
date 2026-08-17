import { createHash } from 'node:crypto';
import { SHA_RE, TOKEN_RE } from './constants.js';
import { fail } from './errors.js';

/**
 * Return the hex-encoded SHA-256 digest of a UTF-8 string.
 */
export function sha256Text(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Return the hex-encoded SHA-256 digest of binary bytes.
 */
export function sha256Bytes(value: Uint8Array | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Ensure a string matches the protocol token regex: [A-Za-z0-9._:/-]+
 */
export function requireToken(value: string, label: string): string {
  if (!TOKEN_RE.test(value)) {
    fail(`${label} must match [A-Za-z0-9._:/-]+`);
  }
  return value;
}

/**
 * Ensure a string is a 40-character lowercase commit SHA.
 */
export function requireSha(value: string, name: string): string {
  if (!SHA_RE.test(value)) {
    fail(`--${name} must be a full 40-character lowercase commit SHA`);
  }
  return value;
}

/**
 * Compute a deterministic SHA-256 finding fingerprint from normalized path and root cause / message.
 *
 * Normalizes repository-relative path (forward slashes, no leading/trailing slashes)
 * and defect description, excluding round, engine, line number, or commit SHA.
 */
export function computeFindingFingerprint(params: {
  path: string;
  rootCause?: string | undefined;
  message?: string | undefined;
  lens?: string | undefined;
  rule?: string | undefined;
}): string {
  const normalizedPath = params.path
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\/+/, '');
  const description = (params.rootCause ?? params.message ?? params.rule ?? '')
    .trim()
    .replace(/\s+/g, ' ');
  const lens = params.lens ? params.lens.trim() : '';
  const payload = [normalizedPath, lens, description].filter(Boolean).join(':');
  return sha256Text(payload);
}
