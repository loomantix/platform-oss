import { describe, expect, it } from 'vitest';
import {
  computeFindingFingerprint,
  requireToken,
  sha256Bytes,
  sha256Text,
} from '../hash.js';
import { TOKEN_RE } from '../constants.js';

describe('fingerprint and hash utilities', () => {
  it('computes deterministic SHA-256 for strings and bytes', () => {
    const text = 'hello world';
    const hash = sha256Text(text);
    expect(hash).toBe(
      'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9',
    );
    expect(sha256Bytes(Buffer.from(text, 'utf8'))).toBe(hash);
  });

  it('validates tokens with requireToken', () => {
    expect(requireToken('valid_token.123', 'test')).toBe('valid_token.123');
    expect(() => requireToken('invalid token', 'test')).toThrowError(
      /must match/,
    );
  });

  it('computes deterministic finding fingerprint from path and root cause', () => {
    const fp1 = computeFindingFingerprint({
      path: '/src/utils.ts',
      rootCause: 'Uncaught promise rejection in error handler',
      lens: 'silent-failure-hunter',
    });
    const fp2 = computeFindingFingerprint({
      path: 'src/utils.ts',
      rootCause: 'Uncaught   promise rejection in error handler  ',
      lens: 'silent-failure-hunter',
    });

    expect(fp1).toBe(fp2);
    expect(TOKEN_RE.test(fp1)).toBe(true);
    expect(fp1).toHaveLength(64);
  });

  it('normalizes windows backslashes in paths', () => {
    const fp1 = computeFindingFingerprint({
      path: 'packages\\logging\\src\\index.ts',
      message: 'missing export',
    });
    const fp2 = computeFindingFingerprint({
      path: 'packages/logging/src/index.ts',
      message: 'missing export',
    });
    expect(fp1).toBe(fp2);
  });
});
