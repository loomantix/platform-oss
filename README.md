# platform-oss

Reusable `@loomantix/*` infrastructure packages, published to public npm under Apache 2.0 with npm Trusted Publishing and provenance.

## Packages

| Package                                                      | Purpose                                                                                                                                           | Install                                |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| [`@loomantix/mobile-crypto`](./packages/mobile-crypto)       | At-rest AES-256-GCM helpers for React Native + Expo. Wraps `react-native-quick-crypto` (cipher) and `expo-secure-store` (per-install master key). | `pnpm add @loomantix/mobile-crypto`    |
| [`@loomantix/web-crypto`](./packages/web-crypto)             | At-rest AES-256-GCM helpers for browsers. Native WebCrypto (cipher) + non-extractable `CryptoKey` in IndexedDB. Zero runtime dependencies.        | `pnpm add @loomantix/web-crypto`       |
| [`@loomantix/logging`](./packages/logging)                   | Structured logging for NestJS backends. Pino + OpenTelemetry trace context, PHI-safe redaction + detector, pluggable event sink.                  | `pnpm add @loomantix/logging`          |
| [`@loomantix/web-update-check`](./packages/web-update-check) | Framework-neutral browser update detection plus a Vite build-manifest plugin.                                                                     | `pnpm add @loomantix/web-update-check` |
| [`@loomantix/review-ledger`](./packages/review-ledger)       | Deterministic local-review ledger protocol, verification, and CLI for multi-engine code review relays.                                            | `pnpm add @loomantix/review-ledger`    |

API-compatibility note: `@loomantix/mobile-crypto` and `@loomantix/web-crypto` share the same surface (`encryptString` / `decryptString` / `hasMagic` / `deleteKey`) and the same wire format, so consumers can dispatch between the two at build time without rewriting call sites.

## Install

```bash
pnpm add @loomantix/mobile-crypto
pnpm add @loomantix/web-crypto
pnpm add @loomantix/logging
pnpm add @loomantix/web-update-check
pnpm add @loomantix/review-ledger
```

Each package README documents package-specific peer dependencies and runtime assumptions.

## When to add a shared package

Create a shared module when the same generic behavior is needed by multiple
applications and independent implementations are beginning to diverge. Extract
the smallest stable, product-neutral contract; keep framework presentation,
product wording, deployment policy, and consumer-specific recovery behavior in
the consuming applications.

Public-safe reusable `@loomantix/*` contracts belong in this repository.
Product-private contracts and internal orchestration do not. A one-off helper or
behavior whose differences cannot be isolated behind consumer adapters has not
yet earned a shared package.

## Releases

Each package is independently versioned and tagged:

- `mobile-crypto-v<semver>` → publishes `@loomantix/mobile-crypto`
- `web-crypto-v<semver>` → publishes `@loomantix/web-crypto`
- `logging-v<semver>` → publishes `@loomantix/logging`
- `web-update-check-v<semver>` → publishes `@loomantix/web-update-check`
- `review-ledger-v<semver>` → publishes `@loomantix/review-ledger`

Tags trigger package-specific publish workflows. Publishing uses npm Trusted Publishing (OIDC), so there is no long-lived `NPM_TOKEN` secret. Publish commands include `--provenance` to attach SLSA build attestations.

## Development

```bash
pnpm install
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

Each package has its own `tsconfig.json`, `tsup.config.ts`, and `vitest.config.ts`. The root provides the workspace, the prettier/eslint/commitlint setup, and the shared `tsconfig.base.json`.

## Contributing

See [`CONTRIBUTING.md`](./CONTRIBUTING.md). Every commit must be signed off (DCO).

Agent sessions should also read [`AGENTS.md`](./AGENTS.md) before making changes.

## License

Apache 2.0 — see [`LICENSE`](./LICENSE) and [`NOTICE`](./NOTICE).

Reporting security vulnerabilities: see [`SECURITY.md`](./SECURITY.md).
