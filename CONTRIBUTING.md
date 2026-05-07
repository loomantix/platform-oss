# Contributing to platform-oss

Thank you for considering a contribution. `loomantix/platform-oss` is the public home of three infrastructure packages we run in production:

- [`@loomantix/mobile-crypto`](./packages/mobile-crypto) — at-rest AES-256-GCM helpers for React Native + Expo.
- [`@loomantix/web-crypto`](./packages/web-crypto) — at-rest AES-256-GCM helpers for browsers (WebCrypto + IndexedDB).
- [`@loomantix/logging`](./packages/logging) — pino + OpenTelemetry NestJS logging with PHI-safe redaction.

The bar on contract clarity, security review, and contributor friction is deliberately high — these packages handle credentials, encryption keys, and PHI. Read this whole file before opening a PR.

## License

This project is licensed under [Apache 2.0](./LICENSE). All contributions are licensed under the same terms.

## Developer Certificate of Origin (DCO)

We use the [Developer Certificate of Origin](https://developercertificate.org/) instead of a Contributor License Agreement. By signing off on your commits, you certify the contribution is your own work or you have the right to submit it under the project's open-source license.

**Every commit must be signed off**, with the trailer:

```
Signed-off-by: Your Real Name <your.email@example.com>
```

Use `git commit -s` to add the trailer automatically. CI rejects PRs with unsigned commits.

## What we accept

**In scope:**

- Bug fixes in any of the three packages.
- Performance improvements with measurable benchmarks.
- Documentation, examples, threat-model clarifications.
- CI, build, type-system, or testing improvements.
- Cross-platform compatibility (e.g. additional React Native versions, browser engines).

**Out of scope (please open an issue first to discuss):**

- New crypto primitives or algorithm choices. AES-256-GCM is the chosen primitive across mobile + web; alternatives need a written threat-model justification before code.
- Changes to the wire format (`LMX\x01` magic + 12-byte nonce + AES-GCM auth tag). This is a stable on-disk format consumed by ciphertext at rest; format changes are breaking.
- Coupling between packages. Each is independently versioned and consumable.

## Workflow

1. **Open an issue** describing the change. For non-trivial changes, get rough alignment before opening a PR.
2. **Fork the repo and create a feature branch**. Branch names: `feat/<short-description>`, `fix/<short-description>`, `docs/<short-description>`.
3. **Make your changes**, with `git commit -s` (DCO sign-off) on every commit.
4. **Run CI locally**:
   ```bash
   pnpm install
   pnpm typecheck
   pnpm lint
   pnpm test
   ```
5. **Open a PR** against `main`. CI must pass. We aim to review within a week.

## Code review expectations

- **Crypto code is reviewed for fail-closed semantics.** We'd rather a decrypt return `null` than silently produce garbage; we'd rather a write throw than silently lose data.
- **No `any`.** Strict TypeScript everywhere.
- **Tests are non-negotiable** for any logic change. Property-based tests via `fast-check` are the preferred pattern for crypto packages.
- **PHI-safety**: `@loomantix/logging` has explicit redaction logic. Any contribution to that package must include tests that confirm sensitive fields are stripped before sink emit and stdout pino output.

## Code of Conduct

By participating you agree to abide by the [Code of Conduct](./CODE_OF_CONDUCT.md).

## Security

If you discover a security issue, do **not** open a public issue. See [`SECURITY.md`](./SECURITY.md) for the responsible-disclosure process.

## Questions

Open an issue with the `question` label.
