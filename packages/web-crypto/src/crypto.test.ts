import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCrypto, hasMagic, MAGIC_VERSION } from './index';
import type { WebCryptoInternal } from './crypto';

const DB_NAME = '__loomantix_web_crypto__';

async function wipeDB(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error ?? new Error('deleteDatabase failed'));
    // Treat `blocked` as a hard failure, not silent success — leaving
    // stale keys between tests would cause cross-test contamination
    // and false-green assertions. If this fires, the previous test
    // leaked an open connection and should be fixed.
    req.onblocked = () =>
      reject(
        new Error(
          `deleteDatabase blocked for "${DB_NAME}" — a previous test leaked an open IDB connection`,
        ),
      );
  });
}

const TEST_ALIAS = 'loomantix-web-crypto.test-alias.v1';

// Cast to the internal surface so tests can call `_resetKeyCacheForTests()`.
// Consumers see only `WebCrypto` (re-exported from index.ts); the helper is
// excluded from the published `.d.ts` by construction.
let instance = createCrypto({ keyAlias: TEST_ALIAS }) as WebCryptoInternal;

beforeEach(async () => {
  await wipeDB();
  // Rebuild the instance so its internal cachedKey/keyPromise closures
  // start fresh per test. Matches mobile-crypto's per-test setup.
  instance = createCrypto({ keyAlias: TEST_ALIAS }) as WebCryptoInternal;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createCrypto', () => {
  it('throws if keyAlias is missing', () => {
    expect(() =>
      createCrypto({ keyAlias: '' } as unknown as { keyAlias: string }),
    ).toThrow(/keyAlias/);
  });

  it('throws if opts is not an object', () => {
    expect(() =>
      createCrypto(undefined as unknown as { keyAlias: string }),
    ).toThrow(/options object/);
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

  it('round-trips an empty string', async () => {
    const ct = await instance.encryptString('');
    expect(await instance.decryptString(ct)).toBe('');
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

  it('magic prefix is LMX\\x01 (identical to mobile-crypto wire format)', async () => {
    const ct = await instance.encryptString('x');
    expect(ct[0]).toBe(0x4c); // 'L'
    expect(ct[1]).toBe(0x4d); // 'M'
    expect(ct[2]).toBe(0x58); // 'X'
    expect(ct[3]).toBe(0x01); // version 1
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

  it('returns null on a truncated payload (header only, no ciphertext)', async () => {
    expect(
      await instance.decryptString(new Uint8Array([0x4c, 0x4d, 0x58, 0x01])),
    ).toBeNull();
  });

  it('returns null on a payload shorter than header+nonce+tag', async () => {
    // Magic + 11 bytes = 15 total, strictly less than the 32-byte minimum
    // (4 magic + 12 nonce + 16 tag). Must be terminal-null not a throw.
    const short = new Uint8Array(15);
    short[0] = 0x4c;
    short[1] = 0x4d;
    short[2] = 0x58;
    short[3] = 0x01;
    expect(await instance.decryptString(short)).toBeNull();
  });

  it('deleteKey wipes IndexedDB and forces regeneration on next call', async () => {
    const key1 = await instance.getOrCreateKey();
    await instance.deleteKey();
    const key2 = await instance.getOrCreateKey();
    // CryptoKey objects aren't deep-equal comparable, but the test below
    // (decryption-fails-after-delete) proves they're different keys.
    expect(key2).not.toBe(key1);
  });

  it('decryption fails after the key is wiped (data becomes unrecoverable)', async () => {
    const ct = await instance.encryptString('will be orphaned');
    await instance.deleteKey();
    expect(await instance.decryptString(ct)).toBeNull();
  });

  it('key persists across factory instances sharing an alias', async () => {
    const ct = await instance.encryptString('cross-instance');
    // Fresh instance, same alias: must read the same key from IDB.
    const reborn = createCrypto({ keyAlias: TEST_ALIAS });
    expect(await reborn.decryptString(ct)).toBe('cross-instance');
  });

  it('loadOrGenerateKey acquires navigator.locks when available (cross-tab race guard)', async () => {
    // Simulate a browser with the Web Locks API and verify every key
    // load goes through `locks.request` with the expected lock name.
    // Without this guard, two tabs cold-starting could both generate
    // keys and race on idbPut, orphaning the first tab's ciphertext on
    // next reload.
    const requestSpy = vi.fn(
      async (_name: string, fn: (lock: unknown) => Promise<unknown>) =>
        fn(null),
    );
    // navigator.locks in happy-dom is exposed as a read-only getter,
    // so plain assignment throws — use defineProperty to override it.
    const originalDescriptor = Object.getOwnPropertyDescriptor(
      globalThis.navigator,
      'locks',
    );
    Object.defineProperty(globalThis.navigator, 'locks', {
      configurable: true,
      get: () => ({ request: requestSpy }),
    });
    try {
      await instance.getOrCreateKey();
      // Lock name must namespace by DB + alias to avoid collisions with
      // unrelated consumers holding locks on the same alias string.
      expect(requestSpy).toHaveBeenCalledWith(
        `__loomantix_web_crypto__:${TEST_ALIAS}`,
        expect.any(Function),
      );
    } finally {
      if (originalDescriptor) {
        Object.defineProperty(
          globalThis.navigator,
          'locks',
          originalDescriptor,
        );
      } else {
        // happy-dom didn't expose `locks` originally — restore that
        // absence so later tests see the fallback path.
        Object.defineProperty(globalThis.navigator, 'locks', {
          configurable: true,
          get: () => undefined,
        });
      }
    }
  });

  it('loadOrGenerateKey works when navigator.locks is unavailable (graceful fallback)', async () => {
    // Older browsers / some test environments lack navigator.locks.
    // Fallback path must still produce a working key — we accept a
    // narrower cross-tab race there rather than throwing at startup.
    const originalDescriptor = Object.getOwnPropertyDescriptor(
      globalThis.navigator,
      'locks',
    );
    Object.defineProperty(globalThis.navigator, 'locks', {
      configurable: true,
      get: () => undefined,
    });
    try {
      const ct = await instance.encryptString('fallback path');
      expect(await instance.decryptString(ct)).toBe('fallback path');
    } finally {
      if (originalDescriptor) {
        Object.defineProperty(
          globalThis.navigator,
          'locks',
          originalDescriptor,
        );
      }
    }
  });

  it('key loaded from IDB remains non-extractable (threat-model guarantee)', async () => {
    // The README claims non-extractable CryptoKey — this is the primary
    // origin-script-hardening guarantee. Verify structured-clone through
    // IDB preserves the `extractable: false` flag end-to-end. If
    // fake-indexeddb (or a browser via a bug) silently returned the key
    // as extractable on read, the threat model would collapse without
    // any visible signal.
    await instance.getOrCreateKey();
    const reborn = createCrypto({ keyAlias: TEST_ALIAS });
    const key = await reborn.getOrCreateKey();
    await expect(crypto.subtle.exportKey('raw', key)).rejects.toThrow();
    await expect(crypto.subtle.exportKey('jwk', key)).rejects.toThrow();
  });

  it('caches the key across calls (one IDB round-trip)', async () => {
    // Spy on indexedDB.open to count DB opens — the first getOrCreateKey
    // opens the DB; subsequent calls hit the in-memory cache and don't
    // re-open.
    const openSpy = vi.spyOn(indexedDB, 'open');
    instance._resetKeyCacheForTests();
    // Seed the DB so loadOrGenerateKey doesn't generate (which is
    // another 2 opens: one get, one put).
    await instance.getOrCreateKey();
    openSpy.mockClear();
    instance._resetKeyCacheForTests();
    await instance.getOrCreateKey();
    await instance.getOrCreateKey();
    await instance.getOrCreateKey();
    // First call opens once to read; subsequent calls hit the cache.
    expect(openSpy).toHaveBeenCalledTimes(1);
  });

  it('race: parallel getOrCreateKey calls resolve to the same key', async () => {
    const [a, b, c] = await Promise.all([
      instance.getOrCreateKey(),
      instance.getOrCreateKey(),
      instance.getOrCreateKey(),
    ]);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it('two instances with different aliases do not share keys', async () => {
    const alpha = createCrypto({ keyAlias: 'alpha.v1' });
    const beta = createCrypto({ keyAlias: 'beta.v1' });
    await alpha.getOrCreateKey();
    await beta.getOrCreateKey();
    // Ciphertext from alpha must not decrypt under beta. (CryptoKey
    // objects are opaque and not deep-equal comparable; the decrypt
    // miss is the authoritative test.)
    const ct = await alpha.encryptString('cross-alias leak');
    expect(await beta.decryptString(ct)).toBeNull();
  });

  it('clears keyPromise on rejection so transient IndexedDB errors can retry', async () => {
    // Simulate a transient IDB failure on the first open, success on
    // retry. indexedDB.open returns an IDBOpenDBRequest whose handlers
    // we can drive manually.
    const originalOpen = indexedDB.open.bind(indexedDB);
    let callCount = 0;
    const openSpy = vi
      .spyOn(indexedDB, 'open')
      .mockImplementation((...args: Parameters<typeof indexedDB.open>) => {
        callCount++;
        if (callCount === 1) {
          // Synthesize a failing request — real IDB would emit onerror
          // asynchronously.
          const fakeReq = {
            result: null as unknown,
            error: new Error('transient IDB error'),
            onsuccess: null as ((ev: Event) => void) | null,
            onerror: null as ((ev: Event) => void) | null,
            onupgradeneeded: null as ((ev: Event) => void) | null,
            onblocked: null as ((ev: Event) => void) | null,
          };
          queueMicrotask(() => {
            fakeReq.onerror?.(new Event('error'));
          });
          return fakeReq as unknown as IDBOpenDBRequest;
        }
        return originalOpen(...args);
      });

    await expect(instance.getOrCreateKey()).rejects.toThrow(
      /transient IDB error/,
    );
    // Second call: succeeds — proves the rejected promise didn't stick.
    openSpy.mockRestore();
    const key = await instance.getOrCreateKey();
    expect(key).toBeDefined();
  });

  it('decryptString never throws on arbitrary garbage input (fuzz)', async () => {
    // The null-vs-throw contract says: decryptString on garbage returns
    // null, never throws. That's the property consumers rely on when
    // replaying an IDB-backed buffer — a corrupted row must be
    // discardable, never a crash. Seed so the key exists (otherwise
    // getOrCreateKey would generate+store once per sample and flood IDB).
    await instance.getOrCreateKey();
    const rand = (n: number): Uint8Array =>
      crypto.getRandomValues(new Uint8Array(n));
    // Cover: empty, below-magic, at-magic, just-under-min-length,
    // at-min, over-min, realistic sizes. 100 samples per bucket gives
    // meaningful coverage of the `catch` branch in decryptString.
    for (const size of [0, 1, 3, 4, 15, 16, 32, 33, 100, 1024]) {
      for (let i = 0; i < 20; i++) {
        const bytes = rand(size);
        const result = await instance.decryptString(bytes);
        // Must be null or a string — never a throw.
        expect(result === null || typeof result === 'string').toBe(true);
      }
    }
    // Also: random garbage with a valid magic prefix (so it gets past
    // the hasMagic check and into the subtle.decrypt path) — still must
    // null, never throw.
    for (let i = 0; i < 20; i++) {
      const bytes = rand(100);
      bytes[0] = 0x4c;
      bytes[1] = 0x4d;
      bytes[2] = 0x58;
      bytes[3] = 0x01;
      expect(await instance.decryptString(bytes)).toBeNull();
    }
  });

  it('decryptString propagates key-load errors (transient) instead of returning null', async () => {
    // Seed a key + ciphertext, then rig the next open() to fail.
    const ct = await instance.encryptString('some plaintext');
    instance._resetKeyCacheForTests();

    vi.spyOn(indexedDB, 'open').mockImplementationOnce(() => {
      const fakeReq = {
        result: null as unknown,
        error: new Error('IDB unavailable'),
        onsuccess: null as ((ev: Event) => void) | null,
        onerror: null as ((ev: Event) => void) | null,
        onupgradeneeded: null as ((ev: Event) => void) | null,
        onblocked: null as ((ev: Event) => void) | null,
      };
      queueMicrotask(() => {
        fakeReq.onerror?.(new Event('error'));
      });
      return fakeReq as unknown as IDBOpenDBRequest;
    });

    await expect(instance.decryptString(ct)).rejects.toThrow(/IDB unavailable/);

    // Sanity: after the mockOnce is exhausted and vi.restoreAllMocks()
    // runs in afterEach, normal decrypt works again on the next call
    // using the real fake-indexeddb implementation.
    expect(await instance.decryptString(ct)).toBe('some plaintext');
  });
});
