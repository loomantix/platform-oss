import * as ExpoCrypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import QuickCrypto from 'react-native-quick-crypto';

const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const AUTH_TAG_BYTES = 16;

export const MAGIC_VERSION = 1 as const;

// Magic prefix: 'L','M','X',0x01 — Loomantix mobile-crypto, format version 1.
// Stored at the head of every ciphertext blob so readers can distinguish our
// encrypted format from legacy plaintext JSON without guessing or
// speculatively attempting decryption. The trailing byte is a format version
// reserved for future key-rotation work.
const MAGIC = Uint8Array.from([0x4c, 0x4d, 0x58, MAGIC_VERSION]);

declare global {
  var __LOOMANTIX_CRYPTO_BOOTSTRAPPED__: true | undefined;
}

function assertBootstrapped(): void {
  if (!globalThis.__LOOMANTIX_CRYPTO_BOOTSTRAPPED__) {
    throw new Error(
      'crypto-bootstrap did not run before an encryption call. ' +
        "Check that the host app's entry file imports its crypto-bootstrap " +
        'module as its first statement — install() must polyfill global.crypto ' +
        'before any module that touches encryption loads.',
    );
  }
}

/**
 * Options passed to {@link createCrypto}.
 */
export interface CreateCryptoOptions {
  /**
   * SecureStore keychain alias for the per-device symmetric key. Must be
   * unique per product + purpose so two apps don't collide on a shared
   * device (e.g. `com.example.storage-key.v1`). The `.vN` suffix is
   * reserved for future key-rotation work.
   */
  keyAlias: string;
}

/**
 * The public surface returned by {@link createCrypto}. All methods are
 * bound to the factory instance and can be passed by reference (e.g.
 * re-exported from a host-app shim) without losing their closure.
 */
export interface MobileCrypto {
  encryptString(plaintext: string): Promise<Uint8Array>;
  decryptString(payload: Uint8Array): Promise<string | null>;
  getOrCreateKey(): Promise<Uint8Array>;
  deleteKey(): Promise<void>;
  hasMagic(bytes: Uint8Array): boolean;
}

/**
 * Internal surface including test-only helpers. Intentionally NOT
 * re-exported from `index.ts`, so it does not appear in the published
 * `.d.ts`. In-package tests cast the factory result to this type when
 * they need to reset the key cache between cases.
 *
 * @internal
 */
export interface MobileCryptoInternal extends MobileCrypto {
  /** @internal — test-only reset of the in-memory key cache. */
  _resetKeyCacheForTests(): void;
}

/**
 * Create a mobile-crypto client. Encryption state (the per-device key
 * cache and in-flight key-load promise) is kept inside the returned
 * instance's closure, so two calls with different `keyAlias` values yield
 * fully isolated crypto contexts — that's the primary reason this is a
 * factory rather than a module-level singleton.
 *
 * @param opts - See {@link CreateCryptoOptions}.
 * @returns a {@link MobileCrypto} instance bound to `opts.keyAlias`.
 * @throws If `opts` is not an object or `opts.keyAlias` is missing/empty.
 */
export function createCrypto(opts: CreateCryptoOptions): MobileCrypto {
  if (!opts || typeof opts !== 'object') {
    throw new Error(
      '@loomantix/mobile-crypto: createCrypto(opts) requires an options object.',
    );
  }
  if (!opts.keyAlias || typeof opts.keyAlias !== 'string') {
    throw new Error(
      '@loomantix/mobile-crypto: createCrypto({ keyAlias }) is required.',
    );
  }
  const keyAlias = opts.keyAlias;

  let cachedKey: Uint8Array | null = null;
  let keyPromise: Promise<Uint8Array> | null = null;

  async function loadOrGenerateKey(): Promise<Uint8Array> {
    const stored = await SecureStore.getItemAsync(keyAlias);
    if (stored) {
      return base64ToBytes(stored);
    }
    const fresh = await ExpoCrypto.getRandomBytesAsync(KEY_BYTES);
    // THIS_DEVICE_ONLY: the Keychain key is NOT included in iCloud Keychain
    // backup. That means an iCloud backup of this device cannot decrypt the
    // ciphertext files on a different device, even if the ciphertext itself
    // is in the backup. Trade-off: a user restoring to a new device loses
    // their offline queue + RQ cache (both short-TTL, acceptable per threat
    // model in docs/security/mobile-encryption.md).
    await SecureStore.setItemAsync(keyAlias, bytesToBase64(fresh), {
      keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
    });
    return fresh;
  }

  async function getOrCreateKey(): Promise<Uint8Array> {
    if (cachedKey) return cachedKey;
    // In-flight singleton — two racing getOrCreateKey() calls on a cold start
    // (e.g. hydrateQueryClient + enqueueCreate both firing in the same tick)
    // would otherwise each generate their own key and race on setItemAsync,
    // leaving ciphertext encrypted with a key that was overwritten on disk.
    if (!keyPromise) {
      // Wrap so a rejection (transient SecureStore error, etc.) doesn't stick
      // the rejected promise into the cache and lock out every subsequent
      // call until process restart. On failure, clear keyPromise and re-throw
      // so the next caller gets a fresh attempt.
      keyPromise = loadOrGenerateKey().catch((err) => {
        keyPromise = null;
        throw err;
      });
    }
    const key = await keyPromise;
    cachedKey = key;
    return key;
  }

  async function deleteKey(): Promise<void> {
    cachedKey = null;
    keyPromise = null;
    await SecureStore.deleteItemAsync(keyAlias);
  }

  async function encryptString(plaintext: string): Promise<Uint8Array> {
    assertBootstrapped();
    const key = await getOrCreateKey();
    const nonce = await ExpoCrypto.getRandomBytesAsync(NONCE_BYTES);
    const cipher = QuickCrypto.createCipheriv('aes-256-gcm', key, nonce);
    const plaintextBytes = utf8Encode(plaintext);
    const part1 = cipher.update(plaintextBytes);
    const part2 = cipher.final();
    const tag = cipher.getAuthTag();
    return concat(MAGIC, nonce, asBytes(part1), asBytes(part2), asBytes(tag));
  }

  /**
   * Decrypt a ciphertext blob. Contract:
   * - Returns the plaintext string on success.
   * - Returns `null` only for *terminal* failures: missing magic, truncated
   *   payload, or auth-tag rejection during decipher. Callers may treat `null`
   *   as "file is unrecoverable, delete it".
   * - **Throws** on *transient* failures: key-load error (SecureStore
   *   unavailable, etc.). Callers should not delete the file in that case —
   *   the data is likely fine and will decrypt on a later retry.
   *
   * Splitting those two cases is deliberate: conflating them caused data
   * loss risk per Gemini's review on PR #556.
   */
  async function decryptString(payload: Uint8Array): Promise<string | null> {
    assertBootstrapped();
    if (!hasMagic(payload)) return null;
    if (payload.length < MAGIC.length + NONCE_BYTES + AUTH_TAG_BYTES)
      return null;
    // Key load errors propagate — see doc comment above.
    const key = await getOrCreateKey();
    const nonce = payload.slice(MAGIC.length, MAGIC.length + NONCE_BYTES);
    const tagStart = payload.length - AUTH_TAG_BYTES;
    const ciphertext = payload.slice(MAGIC.length + NONCE_BYTES, tagStart);
    const tag = payload.slice(tagStart);
    try {
      const decipher = QuickCrypto.createDecipheriv('aes-256-gcm', key, nonce);
      // quick-crypto's d.ts pulls Buffer from @craftzdog/react-native-buffer,
      // which is structurally identical to Node's Buffer but nominally
      // separate. Go through the library's own Buffer export so TS accepts
      // the call on both Node (vitest) and the RN runtime.
      decipher.setAuthTag(QuickCrypto.Buffer.from(tag));
      const part1 = decipher.update(ciphertext);
      const part2 = decipher.final();
      return utf8Decode(concat(asBytes(part1), asBytes(part2)));
    } catch {
      // Decipher step threw — auth-tag mismatch, tampering, or the key
      // was rotated out from under this ciphertext. Terminal: caller may
      // delete the file.
      return null;
    }
  }

  function _resetKeyCacheForTests(): void {
    cachedKey = null;
    keyPromise = null;
  }

  // Typed as the internal surface so the `_resetKeyCacheForTests` property
  // passes excess-property checks; the declared return type narrows it back
  // to `MobileCrypto` for callers outside this package.
  const instance: MobileCryptoInternal = {
    encryptString,
    decryptString,
    getOrCreateKey,
    deleteKey,
    hasMagic,
    _resetKeyCacheForTests,
  };
  return instance;
}

/**
 * Check whether `bytes` starts with the `LMX\x01` magic prefix that every
 * blob encrypted by this package carries. Use to distinguish our
 * ciphertext format from legacy plaintext files without attempting a
 * decrypt that could throw or drain battery.
 */
export function hasMagic(bytes: Uint8Array): boolean {
  if (bytes.length < MAGIC.length) return false;
  for (let i = 0; i < MAGIC.length; i++) {
    if (bytes[i] !== MAGIC[i]) return false;
  }
  return true;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

function asBytes(b: ArrayBufferView | ArrayBufferLike): Uint8Array {
  if (b instanceof Uint8Array) return b;
  if (ArrayBuffer.isView(b)) {
    return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  }
  return new Uint8Array(b);
}

// UTF-8 + base64 go through QuickCrypto.Buffer rather than global
// TextEncoder/btoa/atob. Hermes doesn't guarantee those globals, and
// quick-crypto's install() always provides Buffer. Same implementation
// on both RN runtime and the Node test env (where vitest mocks point
// Buffer at node:buffer's export).
function utf8Encode(s: string): Uint8Array {
  const buf = QuickCrypto.Buffer.from(s, 'utf8');
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

function utf8Decode(b: Uint8Array): string {
  return QuickCrypto.Buffer.from(b).toString('utf8');
}

function bytesToBase64(b: Uint8Array): string {
  return QuickCrypto.Buffer.from(b).toString('base64');
}

function base64ToBytes(s: string): Uint8Array {
  const buf = QuickCrypto.Buffer.from(s, 'base64');
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}
