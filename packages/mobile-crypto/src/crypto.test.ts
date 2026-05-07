import { beforeEach, describe, expect, it, vi } from 'vitest';

const secureStore = new Map<string, string>();

vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn(async (k: string) => secureStore.get(k) ?? null),
  setItemAsync: vi.fn(async (k: string, v: string) => {
    secureStore.set(k, v);
  }),
  deleteItemAsync: vi.fn(async (k: string) => {
    secureStore.delete(k);
  }),
  AFTER_FIRST_UNLOCK: 'afu',
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'afu-device-only',
}));

vi.mock('expo-crypto', async () => {
  const node = await import('node:crypto');
  return {
    getRandomBytesAsync: vi.fn(
      async (n: number) => new Uint8Array(node.randomBytes(n)),
    ),
  };
});

// Node's crypto implements the same API quick-crypto exposes (that's the
// whole point of quick-crypto's design), so tests can run real AES-GCM
// without any device. Re-export Buffer so QuickCrypto.Buffer (used inside
// crypto.ts for type-compatible setAuthTag) resolves to Node's Buffer.
vi.mock('react-native-quick-crypto', async () => {
  const node = await import('node:crypto');
  return { default: { ...node, Buffer: (await import('node:buffer')).Buffer } };
});

import { createCrypto, hasMagic, MAGIC_VERSION } from './index';
import type { MobileCryptoInternal } from './crypto';

const TEST_ALIAS = 'loomantix-mobile-crypto.test-alias.v1';

// Cast to the internal surface so tests can call `_resetKeyCacheForTests()`.
// Consumers see only `MobileCrypto` (re-exported from index.ts); the helper
// is excluded from the published `.d.ts` by construction.
let instance = createCrypto({ keyAlias: TEST_ALIAS }) as MobileCryptoInternal;

beforeEach(() => {
  secureStore.clear();
  // Rebuild the instance so its internal cachedKey/keyPromise closures
  // start fresh per test. Constructor-level reset is sufficient; no need
  // to also call _resetKeyCacheForTests() since the new closure is
  // already empty.
  instance = createCrypto({ keyAlias: TEST_ALIAS }) as MobileCryptoInternal;
  // Simulate crypto-bootstrap having run. Tests that want to exercise the
  // bootstrap-missing guard clear this locally.
  globalThis.__LOOMANTIX_CRYPTO_BOOTSTRAPPED__ = true;
});

describe('createCrypto', () => {
  it('throws if keyAlias is missing', () => {
    expect(() =>
      createCrypto({ keyAlias: '' } as unknown as { keyAlias: string }),
    ).toThrow(/keyAlias/);
  });

  it('exposes MAGIC_VERSION as a numeric constant', () => {
    expect(MAGIC_VERSION).toBe(1);
  });
});

describe('crypto (factory)', () => {
  it('round-trips an ASCII string', async () => {
    const ct = await instance.encryptString('hello world');
    const pt = await instance.decryptString(ct);
    expect(pt).toBe('hello world');
  });

  it('round-trips unicode', async () => {
    const src = 'patient: Émile — visited 2026-04-22 · 11:30';
    const ct = await instance.encryptString(src);
    expect(await instance.decryptString(ct)).toBe(src);
  });

  it('round-trips a large payload (JSON-shaped, ~100KB)', async () => {
    const big = JSON.stringify({
      items: Array.from({ length: 2000 }, (_, i) => ({
        id: i,
        summary: `entry #${i}`,
      })),
    });
    const ct = await instance.encryptString(big);
    expect(await instance.decryptString(ct)).toBe(big);
  });

  it('ciphertext does not contain the plaintext verbatim', async () => {
    const secret = 'OHIP-1234567-AB patient bleeding';
    const ct = await instance.encryptString(secret);
    const view = new TextDecoder('utf-8', { fatal: false }).decode(ct);
    expect(view).not.toContain('OHIP-1234567-AB');
    expect(view).not.toContain('patient bleeding');
  });

  it('uses a fresh nonce per encryption (two encrypts of same plaintext differ)', async () => {
    const ct1 = await instance.encryptString('same');
    const ct2 = await instance.encryptString('same');
    expect(ct1).not.toEqual(ct2);
  });

  it('starts with the magic prefix', async () => {
    const ct = await instance.encryptString('x');
    expect(instance.hasMagic(ct)).toBe(true);
    expect(hasMagic(ct)).toBe(true);
  });

  it('returns null on a payload without the magic prefix', async () => {
    const plaintext = new TextEncoder().encode(JSON.stringify({ a: 1 }));
    expect(await instance.decryptString(plaintext)).toBeNull();
  });

  it('returns null on tampered ciphertext', async () => {
    const ct = await instance.encryptString('secret');
    // Flip a byte in the middle of the ciphertext body.
    const tampered = new Uint8Array(ct);
    const mid = Math.floor(ct.length / 2);
    tampered[mid] = (tampered[mid] ?? 0) ^ 0xff;
    expect(await instance.decryptString(tampered)).toBeNull();
  });

  it('returns null on truncated ciphertext (shorter than header+tag)', async () => {
    expect(
      await instance.decryptString(new Uint8Array([0x4c, 0x4d, 0x58, 0x01])),
    ).toBeNull();
  });

  it('deleteKey wipes SecureStore and forces regeneration on next call', async () => {
    const key1 = await instance.getOrCreateKey();
    await instance.deleteKey();
    const key2 = await instance.getOrCreateKey();
    expect(key2).not.toEqual(key1);
  });

  it('decryption fails after the key is wiped (data becomes unrecoverable)', async () => {
    const ct = await instance.encryptString('will be orphaned');
    await instance.deleteKey();
    expect(await instance.decryptString(ct)).toBeNull();
  });

  it('caches the key across calls (one SecureStore round-trip)', async () => {
    const mod = await import('expo-secure-store');
    const getSpy = mod.getItemAsync as ReturnType<typeof vi.fn>;
    getSpy.mockClear();
    await instance.getOrCreateKey();
    await instance.getOrCreateKey();
    await instance.getOrCreateKey();
    expect(getSpy).toHaveBeenCalledTimes(1);
  });

  it('race: parallel getOrCreateKey calls resolve to the same key', async () => {
    const [a, b, c] = await Promise.all([
      instance.getOrCreateKey(),
      instance.getOrCreateKey(),
      instance.getOrCreateKey(),
    ]);
    expect(a).toEqual(b);
    expect(b).toEqual(c);
  });

  it('encryptString throws a clear error if crypto-bootstrap did not run', async () => {
    globalThis.__LOOMANTIX_CRYPTO_BOOTSTRAPPED__ = undefined;
    await expect(instance.encryptString('x')).rejects.toThrow(
      /crypto-bootstrap did not run/,
    );
  });

  it('decryptString throws a clear error if crypto-bootstrap did not run', async () => {
    const ct = await instance.encryptString('x');
    globalThis.__LOOMANTIX_CRYPTO_BOOTSTRAPPED__ = undefined;
    await expect(instance.decryptString(ct)).rejects.toThrow(
      /crypto-bootstrap did not run/,
    );
  });

  it('stores the key with AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY accessibility', async () => {
    const mod = await import('expo-secure-store');
    const setSpy = mod.setItemAsync as ReturnType<typeof vi.fn>;
    setSpy.mockClear();
    instance._resetKeyCacheForTests();
    secureStore.clear();
    await instance.getOrCreateKey();
    expect(setSpy).toHaveBeenCalledTimes(1);
    const call = setSpy.mock.calls[0];
    expect(call?.[0]).toBe(TEST_ALIAS);
    expect(call?.[2]).toEqual(
      expect.objectContaining({ keychainAccessible: 'afu-device-only' }),
    );
  });

  it('uses the passed keyAlias for SecureStore reads', async () => {
    const mod = await import('expo-secure-store');
    const getSpy = mod.getItemAsync as ReturnType<typeof vi.fn>;
    getSpy.mockClear();
    await instance.getOrCreateKey();
    expect(getSpy).toHaveBeenCalledWith(TEST_ALIAS);
  });

  it('two instances with different aliases do not share keys', async () => {
    const alpha = createCrypto({ keyAlias: 'alpha.v1' });
    const beta = createCrypto({ keyAlias: 'beta.v1' });
    const keyAlpha = await alpha.getOrCreateKey();
    const keyBeta = await beta.getOrCreateKey();
    expect(keyAlpha).not.toEqual(keyBeta);
    // And: ciphertext from alpha must not decrypt under beta.
    const ct = await alpha.encryptString('cross-alias leak');
    expect(await beta.decryptString(ct)).toBeNull();
  });

  it('clears keyPromise on rejection so transient SecureStore errors can retry', async () => {
    const mod = await import('expo-secure-store');
    const getSpy = mod.getItemAsync as ReturnType<typeof vi.fn>;
    instance._resetKeyCacheForTests();
    secureStore.clear();
    // First call: SecureStore fails transiently.
    getSpy.mockRejectedValueOnce(new Error('transient SecureStore error'));
    await expect(instance.getOrCreateKey()).rejects.toThrow(
      /transient SecureStore error/,
    );
    // Second call: succeeds — proves the rejected promise didn't stick.
    const key = await instance.getOrCreateKey();
    expect(key).toBeInstanceOf(Uint8Array);
    expect(key.length).toBe(32);
  });

  it('decryptString propagates key-load errors (transient) instead of returning null', async () => {
    const ct = await instance.encryptString('some plaintext');
    const mod = await import('expo-secure-store');
    const getSpy = mod.getItemAsync as ReturnType<typeof vi.fn>;
    instance._resetKeyCacheForTests();
    getSpy.mockRejectedValueOnce(new Error('SecureStore unavailable'));
    await expect(instance.decryptString(ct)).rejects.toThrow(
      /SecureStore unavailable/,
    );
  });
});
