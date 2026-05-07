# @loomantix/mobile-crypto

At-rest AES-256-GCM encryption helpers for React Native apps. Wraps
[`react-native-quick-crypto`](https://github.com/margelo/react-native-quick-crypto)
for the cipher and [`expo-secure-store`](https://docs.expo.dev/versions/latest/sdk/securestore/)
for the per-install master key.

## Install

```bash
pnpm add @loomantix/mobile-crypto
```

Published with [npm provenance](https://docs.npmjs.com/generating-provenance-statements) under Apache 2.0.

## Usage

```ts
import { createCrypto } from '@loomantix/mobile-crypto';

const crypto = createCrypto({
  // Product-scoped SecureStore alias for the per-device symmetric key.
  // Pick a unique value per app + purpose (e.g. `com.example.storage-key.v1`).
  keyAlias: 'com.example.storage-key.v1',
});

const ciphertext = await crypto.encryptString('plaintext'); // Uint8Array
const plaintext = await crypto.decryptString(ciphertext); // string | null
```

`decryptString` returns `null` for **terminal** read failures — callers
should treat the value as unreadable and move on (do NOT retry). Three
cases collapse to `null`:

- the payload doesn't carry the `LMX\x01` magic prefix (not our format),
- the payload is too short to contain nonce + tag (malformed), or
- the GCM auth-tag check fails (tampering, corruption, or the
  SecureStore key was rotated/deleted since the ciphertext was written).

`decryptString` **throws** only for transient / recoverable errors —
currently, that's `SecureStore` failing to load the per-device key and
the `assertBootstrapped()` guard firing before `crypto-bootstrap` has
run. Throws are safe to retry on a later read.

See `src/crypto.ts` for the full factory contract and the magic-byte
versioning scheme.

## Security

See the repository's [`SECURITY.md`](https://github.com/loomantix/platform-oss/blob/main/SECURITY.md) for the responsible-disclosure process.
