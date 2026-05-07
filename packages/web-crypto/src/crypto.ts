const KEY_BITS = 256;
const NONCE_BYTES = 12;
const AUTH_TAG_BYTES = 16;

// Hoisted module-scope decoder — the one shared instance is safe to reuse
// across parallel decrypt calls (TextDecoder's decode() is stateless
// when called without { stream: true }). Saves a few microseconds and
// one allocation per decrypt on hot paths like the segment retry buffer.
const UTF8_DECODER_FATAL = new TextDecoder('utf-8', { fatal: true });

export const MAGIC_VERSION = 1 as const;

// Magic prefix: 'L','M','X',0x01 — Loomantix crypto, format version 1.
// IDENTICAL to @loomantix/mobile-crypto. Having one wire format across
// mobile and web means a single fix in this package or its mobile twin
// covers both, and downstream tooling that detects the format by its
// 4-byte prefix sees the same bytes everywhere. The trailing byte is
// reserved for future key-rotation.
const MAGIC = Uint8Array.from([0x4c, 0x4d, 0x58, MAGIC_VERSION]);

// IndexedDB layout. Every `createCrypto({ keyAlias })` instance writes to
// this same DB+store, keyed by its `keyAlias`. The store holds opaque
// `CryptoKey` objects (non-extractable AES-GCM) — the browser preserves
// them across structured-clone round-trips without ever exposing the
// raw key material to JavaScript.
const DB_NAME = '__loomantix_web_crypto__';
const DB_VERSION = 1;
const STORE_NAME = 'keys';

/**
 * Options passed to {@link createCrypto}.
 */
export interface CreateCryptoOptions {
  /**
   * IndexedDB record key for the per-browser-profile AES-GCM key. Must
   * be unique per product + purpose (e.g. `com.example.web-buffer.v1`,
   * `com.example.web-queue.v1`). The `.vN` suffix is reserved for future
   * key-rotation work. Do NOT reuse the same alias across unrelated
   * features — different aliases give isolated keys, so a decrypt failure
   * in one buffer can't compromise a different buffer's ciphertext.
   */
  keyAlias: string;
}

/**
 * The public surface returned by {@link createCrypto}.
 *
 * The consumer-facing methods (`encryptString`, `decryptString`,
 * `hasMagic`, `deleteKey`) are API-compatible with
 * `@loomantix/mobile-crypto`'s `MobileCrypto` — same argument shapes,
 * same return types, same null-vs-throw contract — so a shared caller
 * can dispatch at build time between the two packages without changing
 * call sites.
 *
 * `getOrCreateKey` **diverges intentionally**: web returns an opaque,
 * non-extractable `CryptoKey` (the WebCrypto primitive) while mobile
 * returns `Uint8Array` raw key bytes (what SecureStore + quick-crypto
 * round-trip). Treat `getOrCreateKey` as a lifecycle / priming hook
 * that is NOT safe to use from shared call sites — reach for
 * `encryptString` / `decryptString` instead.
 */
export interface WebCrypto {
  encryptString(plaintext: string): Promise<Uint8Array>;
  decryptString(payload: Uint8Array): Promise<string | null>;
  /**
   * Materializes the per-browser-profile key (loading from IndexedDB or
   * generating + storing on first call). Return type is `CryptoKey`, not
   * `Uint8Array` — see the interface-level comment on divergence from
   * mobile-crypto. Callers who only need to force-warm the cache before
   * a known-hot encrypt/decrypt path can call this and discard the
   * result; callers who want the raw key bytes cannot have them, by
   * design.
   */
  getOrCreateKey(): Promise<CryptoKey>;
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
export interface WebCryptoInternal extends WebCrypto {
  /** @internal — test-only reset of the in-memory key cache. */
  _resetKeyCacheForTests(): void;
}

/**
 * Create a web-crypto client. Encryption state (per-instance cached
 * CryptoKey + in-flight load promise) is kept inside the returned
 * instance's closure, so two calls with different `keyAlias` values yield
 * fully isolated crypto contexts — that's the primary reason this is a
 * factory rather than a module-level singleton.
 *
 * @param opts - See {@link CreateCryptoOptions}.
 * @returns a {@link WebCrypto} instance bound to `opts.keyAlias`.
 * @throws If `opts` is not an object or `opts.keyAlias` is missing/empty.
 */
export function createCrypto(opts: CreateCryptoOptions): WebCrypto {
  if (!opts || typeof opts !== 'object') {
    throw new Error(
      '@loomantix/web-crypto: createCrypto(opts) requires an options object.',
    );
  }
  if (!opts.keyAlias || typeof opts.keyAlias !== 'string') {
    throw new Error(
      '@loomantix/web-crypto: createCrypto({ keyAlias }) is required.',
    );
  }
  const keyAlias = opts.keyAlias;

  let cachedKey: CryptoKey | null = null;
  let keyPromise: Promise<CryptoKey> | null = null;

  async function loadOrGenerateKey(): Promise<CryptoKey> {
    return withCrossTabLock(keyAlias, async () => {
      // Re-check under the lock — another tab may have generated and
      // stored the key between our lock-request and lock-acquisition.
      // Without this re-check the lock would only serialize writes, not
      // prevent duplicate generation.
      const existing = await idbGet(keyAlias);
      if (existing) return existing;
      // Non-extractable: `globalThis.crypto.subtle.exportKey('raw', key)`
      // rejects after this, and structured-clone preserves that
      // restriction — so a future attacker with scripting access to the
      // origin cannot read the raw key bytes. They can still call
      // `encrypt`/`decrypt`, but that's the same power the application
      // itself has and is not mitigable at the crypto layer. See README
      // threat model.
      const fresh = await globalThis.crypto.subtle.generateKey(
        { name: 'AES-GCM', length: KEY_BITS },
        false,
        ['encrypt', 'decrypt'],
      );
      await idbPut(keyAlias, fresh);
      return fresh;
    });
  }

  async function getOrCreateKey(): Promise<CryptoKey> {
    if (cachedKey) return cachedKey;
    // Fail fast with a descriptive error in environments where WebCrypto
    // is unavailable: SSR / Node without a polyfill, insecure HTTP origins
    // on older browsers, restricted webviews. Without this check, the
    // eventual `crypto.subtle.generateKey` (or `crypto.getRandomValues`
    // in encryptString) throws a cryptic
    // `TypeError: Cannot read properties of undefined (reading 'subtle')`
    // far from the call site. Mirrors the IndexedDB guard in `openDB`.
    if (
      typeof globalThis.crypto === 'undefined' ||
      typeof globalThis.crypto.subtle === 'undefined' ||
      typeof globalThis.crypto.getRandomValues !== 'function'
    ) {
      throw new Error(
        '@loomantix/web-crypto: WebCrypto is not available in this environment ' +
          '(SSR/Node without polyfill, insecure HTTP origin, or restricted runtime). ' +
          'This package requires globalThis.crypto.subtle and crypto.getRandomValues.',
      );
    }
    // In-flight singleton — two racing getOrCreateKey() calls on a cold
    // page load would otherwise each generate their own key and race on
    // idbPut, leaving ciphertext encrypted with a key that was
    // overwritten. Same guard mobile-crypto uses.
    if (!keyPromise) {
      // Wrap so a rejection (transient IndexedDB error) doesn't stick
      // the rejected promise into the cache and lock out every
      // subsequent call until the page is reloaded. On failure, clear
      // keyPromise and re-throw so the next caller gets a fresh attempt.
      keyPromise = loadOrGenerateKey().catch((err) => {
        keyPromise = null;
        throw err;
      });
    }
    const key = await keyPromise;
    cachedKey = key;
    return key;
  }

  /**
   * Destroys the per-browser-profile key. Any ciphertext still on disk
   * encrypted under this key becomes permanently unrecoverable — there
   * is no second chance, no rotation mechanism, no backup.
   *
   * Callers that persist encrypted data (retry buffers, offline queues)
   * MUST NOT call this without first draining or warning the user. See
   * the "Lifecycle on logout" section of the README for the contract.
   *
   * web-crypto has no visibility into consumer storage, so this
   * obligation is enforced by convention, not code.
   */
  async function deleteKey(): Promise<void> {
    cachedKey = null;
    keyPromise = null;
    await idbDelete(keyAlias);
  }

  async function encryptString(plaintext: string): Promise<Uint8Array> {
    const key = await getOrCreateKey();
    const nonce = globalThis.crypto.getRandomValues(
      new Uint8Array(NONCE_BYTES),
    );
    const plaintextBytes = new TextEncoder().encode(plaintext);
    const sealed = await globalThis.crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce },
      key,
      plaintextBytes,
    );
    // WebCrypto's AES-GCM output is `[ciphertext][tag]` concatenated.
    // Prepend MAGIC + nonce to match the mobile-crypto wire format.
    return concat(MAGIC, nonce, new Uint8Array(sealed));
  }

  /**
   * Decrypt a ciphertext blob. Contract matches `@loomantix/mobile-crypto`
   * exactly — deliberately, so callers can share handler logic:
   * - Returns the plaintext string on success.
   * - Returns `null` only for *terminal* failures: missing magic,
   *   truncated payload, or auth-tag rejection during decipher. Callers
   *   may treat `null` as "record is unrecoverable, delete it".
   * - **Throws** on *transient* failures: IndexedDB load error, etc.
   *   Callers should not delete the record in that case — the data is
   *   likely fine and will decrypt on a later retry.
   *
   * Splitting those two cases is deliberate: conflating a transient
   * IDB hiccup with terminal corruption lets a caller "clean up"
   * still-recoverable data.
   */
  async function decryptString(payload: Uint8Array): Promise<string | null> {
    if (!hasMagic(payload)) return null;
    if (payload.length < MAGIC.length + NONCE_BYTES + AUTH_TAG_BYTES)
      return null;
    // Key load errors propagate — see doc comment above.
    const key = await getOrCreateKey();
    const nonce = payload.slice(MAGIC.length, MAGIC.length + NONCE_BYTES);
    // WebCrypto's AES-GCM decrypt wants `[ciphertext][tag]` concatenated,
    // which is exactly what lives at `payload[MAGIC.length + NONCE_BYTES:]`.
    const sealed = payload.slice(MAGIC.length + NONCE_BYTES);
    try {
      const plaintextBytes = await globalThis.crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: nonce },
        key,
        sealed,
      );
      // `fatal: true` decoder (module-scoped UTF8_DECODER_FATAL) throws
      // if the decrypted payload is not valid UTF-8 — e.g. a different
      // binary blob that somehow passed auth-tag verification, or
      // storage corruption that affects only the ciphertext — instead
      // of silently substituting U+FFFD replacement characters. The
      // surrounding catch turns that into the terminal-null result,
      // matching the spec contract ("string return == trustworthy
      // plaintext").
      return UTF8_DECODER_FATAL.decode(plaintextBytes);
    } catch {
      // OperationError from subtle.decrypt (auth-tag mismatch,
      // tampering, key rotation), or TypeError from TextDecoder
      // (decrypt-passed-but-bytes-aren't-UTF-8 — should not happen with
      // an honest encryptString producer, but if it does the ciphertext
      // is unrecoverable). Terminal: caller may delete the record.
      return null;
    }
  }

  function _resetKeyCacheForTests(): void {
    cachedKey = null;
    keyPromise = null;
  }

  // Typed as the internal surface so the `_resetKeyCacheForTests` property
  // passes excess-property checks; the declared return type narrows it back
  // to `WebCrypto` for callers outside this package.
  const instance: WebCryptoInternal = {
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
 * ciphertext format from unrelated bytes (legacy plaintext, other
 * formats) without attempting a decrypt that could throw.
 *
 * Matches the full 4-byte prefix **including** the `MAGIC_VERSION`
 * byte, so payloads written by a hypothetical future format version
 * (v2+) will be rejected here rather than fall through to a mismatched
 * decoder. Use `MAGIC_VERSION` to branch if you need multi-version
 * read support.
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

// --- IndexedDB helpers ---------------------------------------------------
//
// Keeping these inline (no `idb` dep) so the package has zero runtime
// dependencies. The surface is tiny: one key per alias, three ops.
//
// Open connections are closed after every op. Holding an open `IDBDatabase`
// across operations would block any subsequent `deleteDatabase` (e.g. a
// user clearing site data while the tab is open, or a version upgrade in
// another tab) and deadlock callers. One-shot open-use-close is slightly
// more overhead per call but safe against that class of hang.

async function withDB<T>(fn: (db: IDBDatabase) => Promise<T>): Promise<T> {
  const db = await openDB();
  try {
    return await fn(db);
  } finally {
    db.close();
  }
}

function openDB(): Promise<IDBDatabase> {
  // Fail fast with a descriptive error in environments where IndexedDB
  // is unavailable: insecure HTTP origins, some private-browsing modes
  // (older Firefox), or service workers that haven't imported the API.
  // Without this early check, `indexedDB.open` throws a cryptic
  // `ReferenceError: indexedDB is not defined` far from the call site.
  if (typeof globalThis.indexedDB === 'undefined') {
    return Promise.reject(
      new Error(
        '@loomantix/web-crypto: IndexedDB is not available in this environment ' +
          '(insecure origin, private browsing, or unsupported runtime). ' +
          'This package requires IndexedDB for key persistence.',
      ),
    );
  }
  return new Promise((resolve, reject) => {
    const req = globalThis.indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
    req.onblocked = () =>
      reject(
        new Error(
          'IndexedDB open blocked — another tab holds an older version',
        ),
      );
  });
}

function idbGet(alias: string): Promise<CryptoKey | null> {
  return withDB(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const req = tx.objectStore(STORE_NAME).get(alias);
        req.onsuccess = () => {
          // `undefined` means "no record". Cast through unknown because
          // structured-cloned CryptoKey is typed as `any` in lib.dom.
          const val = req.result as unknown;
          resolve(val === undefined ? null : (val as CryptoKey));
        };
        req.onerror = () =>
          reject(req.error ?? new Error('IndexedDB get failed'));
        // Guard against the transaction aborting/erroring without firing
        // the request's own onerror (e.g., quota errors, engine-level
        // abort). Without these, the promise could hang forever and
        // deadlock `getOrCreateKey()`.
        tx.onerror = () =>
          reject(tx.error ?? new Error('IndexedDB get tx failed'));
        tx.onabort = () =>
          reject(tx.error ?? new Error('IndexedDB get tx aborted'));
      }),
  );
}

function idbPut(alias: string, key: CryptoKey): Promise<void> {
  // Resolve on `tx.oncomplete`, not `req.onsuccess` — the request
  // success only means the put was accepted into IDB's in-memory state,
  // while oncomplete means the transaction committed. If the browser
  // crashes between the two, the key is lost from disk but
  // `loadOrGenerateKey()` already returned it to the caller — every
  // ciphertext written under that key is then unrecoverable on next
  // boot. A put-then-crash scenario during the first encryption of a
  // session is exactly the class of silent PHI loss this package is
  // supposed to prevent.
  return withDB(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).put(key, alias);
        tx.oncomplete = () => resolve();
        tx.onerror = () =>
          reject(tx.error ?? new Error('IndexedDB put failed'));
        tx.onabort = () =>
          reject(tx.error ?? new Error('IndexedDB put aborted'));
      }),
  );
}

function idbDelete(alias: string): Promise<void> {
  // Same `tx.oncomplete` vs `req.onsuccess` durability story as idbPut.
  // Delete failing to commit is less dangerous (stale key lingers;
  // worst case a future `getOrCreateKey` on the same alias returns the
  // not-really-deleted key), but the consistency is worth the symmetry.
  return withDB(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).delete(alias);
        tx.oncomplete = () => resolve();
        tx.onerror = () =>
          reject(tx.error ?? new Error('IndexedDB delete failed'));
        tx.onabort = () =>
          reject(tx.error ?? new Error('IndexedDB delete aborted'));
      }),
  );
}

// --- Cross-tab serialization --------------------------------------------
//
// The in-flight `keyPromise` singleton in `getOrCreateKey` serializes
// within a single tab/document. But two tabs of the same origin on a
// cold start can both miss the IDB key, each generate their own
// `CryptoKey`, and race on `idbPut` — the second write wins and the
// first tab's ciphertext becomes orphaned ciphertext on next reload.
//
// `navigator.locks.request` provides a cross-tab exclusive lock keyed
// by a name (we use the alias), which is exactly the primitive we need.
// It's widely supported (Chrome 69+, Firefox 96+, Safari 15.4+) and is
// the standard solution to this class of problem.
//
// Fallback: if `navigator.locks` is unavailable (ancient browser, some
// test environments), we run the critical section without serialization.
// The cross-tab race is a narrow, non-malicious scenario (both tabs
// would need to open on a cold profile with no prior encryption
// happening); we prefer "works everywhere, small race in very old
// browsers" over "throws on startup in old browsers."

interface LockManagerLike {
  request<T>(name: string, fn: (lock: unknown) => Promise<T>): Promise<T>;
}

function getLockManager(): LockManagerLike | null {
  const nav = globalThis.navigator as { locks?: LockManagerLike } | undefined;
  return nav?.locks ?? null;
}

const LOCK_PREFIX = '__loomantix_web_crypto__:';

async function withCrossTabLock<T>(
  keyAlias: string,
  fn: () => Promise<T>,
): Promise<T> {
  const locks = getLockManager();
  if (!locks) return fn();
  return locks.request(`${LOCK_PREFIX}${keyAlias}`, () => fn());
}
