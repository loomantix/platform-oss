# @loomantix/web-crypto

At-rest AES-256-GCM encryption helpers for browser apps. Uses
native [WebCrypto](https://developer.mozilla.org/en-US/docs/Web/API/Web_Crypto_API)
for the cipher and stores a non-extractable `CryptoKey` in
[IndexedDB](https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API)
via structured clone. Zero runtime dependencies.

API shape mirrors `@loomantix/mobile-crypto` for **consumer ergonomic
consistency** — a caller dispatching at build time between the two
packages can share the encrypt/decrypt/hasMagic/deleteKey call sites.
The wire format (`LMX\x01` magic + 12-byte nonce + AES-GCM auth tag) is
also byte-identical, but this is a convention not a security boundary:
mobile and web have independent vulnerability surfaces (OpenSSL-via-
quick-crypto vs. browser WebCrypto) and CVEs are patched per-package.
`getOrCreateKey` deliberately diverges (web returns an opaque
`CryptoKey`; mobile returns raw `Uint8Array` bytes) — don't call it from
shared code paths.

## Install

```bash
pnpm add @loomantix/web-crypto
```

Published with [npm provenance](https://docs.npmjs.com/generating-provenance-statements) under Apache 2.0.

## Usage

```ts
import { createCrypto } from '@loomantix/web-crypto';

const crypto = createCrypto({
  // Product- and purpose-scoped IndexedDB record key for the per-browser-
  // profile AES-GCM key. Pick a unique value per app + purpose
  // (e.g. `com.example.web-buffer.v1`, `com.example.web-queue.v1`).
  keyAlias: 'com.example.web-buffer.v1',
});

const ciphertext = await crypto.encryptString('plaintext'); // Uint8Array
const plaintext = await crypto.decryptString(ciphertext); // string | null
```

`decryptString` returns `null` for payloads with a missing magic prefix,
truncation below the minimum length, or an auth-tag mismatch — callers
should treat that as "record is unrecoverable, delete it". Throws on
IndexedDB load errors (treat as transient; do **not** delete the record,
retry later). The split is deliberate: conflating the two cases lets a
transient IDB hiccup masquerade as terminal corruption, which a caller
will then "clean up" by deleting still-recoverable data.

See `src/crypto.ts` for the full factory contract.

## Lifecycle on logout

`deleteKey()` silently destroys the per-browser-profile key. Any
ciphertext still on disk encrypted under it becomes unrecoverable — there
is no second chance. web-crypto is a primitive and has no visibility
into what records depend on the key, so **consumers that persist
encrypted data are responsible** for:

1. Checking their own buffer/store for pending records before calling
   `deleteKey()`.
2. If records exist and are salvageable (e.g. just need the network /
   a fresh auth token to flush), surfacing a "we're still trying to
   save N items — [keep trying] / [give up and sign out]" UX to the
   user rather than silently orphaning their work.
3. Only calling `deleteKey()` after the buffer is empty OR the user
   has explicitly confirmed they accept the loss.

This contract exists because it's the only way to honor the user's
work while still giving them a clean escape hatch on sign-out.

## Threat model

- **Non-extractable CryptoKey.** The AES-GCM key is generated with
  `extractable: false`, so even scripts with origin-level access cannot
  call `crypto.subtle.exportKey` on it — they can only invoke
  `encrypt` / `decrypt` through this package's API, which is the same
  power the application itself has.
- **THIS_BROWSER_PROFILE_ONLY.** The key lives in the browser profile's
  IndexedDB. It is **not** synced across devices, **not** restored from
  a browser backup, and is wiped when the user clears site data. That
  matches `@loomantix/mobile-crypto`'s `THIS_DEVICE_ONLY` keychain
  semantics: a user restoring to a new browser profile loses the
  ciphertext's decryptability (acceptable trade-off for short-TTL
  offline buffers).
- **Structured clone preserves non-extractability.** Browsers (and
  `fake-indexeddb` in tests) serialize `CryptoKey` as an opaque handle,
  not raw bytes, so the key material never reaches IDB as plaintext on
  disk.
- **No defence against XSS.** A script that runs in the origin can
  invoke `encrypt` / `decrypt` directly; there is no mitigation at the
  crypto layer. CSP + dependency hygiene are the right tools for that.

## Security

See the repository's [`SECURITY.md`](https://github.com/loomantix/platform-oss/blob/main/SECURITY.md) for the responsible-disclosure process.
