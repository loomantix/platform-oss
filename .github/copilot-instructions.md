# Copilot review instructions — platform-oss

Reusable @loomantix/* infrastructure packages, published to public npm
under Apache 2.0:

- @loomantix/mobile-crypto — at-rest AES-256-GCM helpers for React
  Native (expo-secure-store-backed master key).
- @loomantix/web-crypto — at-rest AES-256-GCM helpers for browsers
  (non-extractable WebCrypto key in IndexedDB).
- @loomantix/logging — pino + OpenTelemetry NestJS logging with
  PHI-safe redaction and a pluggable event sink.

This is a **library monorepo, not an application**. Design decisions
bind every downstream consumer forever, so API choices and back-compat
matter more than they would in app code.

Canonical docs: `README.md` (package overview + release model), `CONTRIBUTING.md` (in-scope/out-of-scope rules), `SECURITY.md` (responsible disclosure). Path-specific rules live in `.github/instructions/*.instructions.md` and apply in addition to this file.

## Stack (do not suggest wrong-framework idioms)

| Layer     | Tech                                                    |
| --------- | ------------------------------------------------------- |
| Language  | TypeScript 5.9 (strict, `noUncheckedIndexedAccess`)    |
| Workspace | pnpm 10.29 with catalog mode                            |
| Runtime   | Node.js (LTS pinned via `.nvmrc`)                       |
| Build     | tsup (ESM)                                              |
| Tests     | Vitest                                                  |
| Publish   | `publish-<pkg>.yml` per package, OIDC + provenance      |
| License   | Apache 2.0 + DCO sign-off                               |

Common mistakes to flag:

- Non-DCO-signed commits (CI rejects them, but flag in review).
- Wire-format changes to the `LMX\x01` magic + nonce + GCM-tag layout
  without a magic-byte version bump.
- Removing entries from `phi-detector.ts`'s redaction lists without
  a corresponding negative test.
- Squash or rebase merge — repo policy is merge commits only.

## Non-negotiable code rules (flag as blocking)

- **Strict TypeScript everywhere. No `any`.** Require explicit return
  types on exported package APIs.
- **DCO sign-off required** on every commit (`git commit -s`). CI rejects
  commits without a `Signed-off-by:` trailer.
- **Conventional commits** (`feat:`, `fix:`, `docs:`, `chore:`,
  `refactor:`). PR titles follow the same format.
- **No license headers in source files** — license coverage is at the
  repo level via `LICENSE` + `NOTICE`.
- **Annotated tags only** (`git tag -a -m`). Publish workflows verify
  the tag's package.json version matches and reject mismatches.

## Crypto package rules (mobile-crypto + web-crypto)

- **AES-256-GCM is the chosen primitive.** Don't propose alternatives
  without a written threat-model justification.
- **Wire format is stable.** `LMX\x01` magic + 12-byte nonce + AES-GCM
  auth tag. Format changes require a magic-byte version bump and a
  migration story.
- **Nonces must be random per encryption** (already implemented). Any
  deterministic-nonce change is a critical security regression.
- **Decrypt failures must distinguish terminal from transient.**
  Terminal (auth-tag mismatch, missing magic, truncation) returns
  `null`; transient (key load error) throws. Don't conflate.
- **API parity** between mobile and web for the consumer-facing
  surface (`encryptString`, `decryptString`, `hasMagic`, `deleteKey`).
  `getOrCreateKey` deliberately diverges and is not API-parity.
- **No key persistence outside the platform store.** Mobile uses
  expo-secure-store; web uses non-extractable CryptoKey in IndexedDB.
  Don't propose adding a "backup key" path.

## Logging package rules

- **PHI fields are stripped before sink emit.** Any change to
  `phi-detector.ts`'s redaction list or `pino-redaction.ts`'s paths
  must include matching tests (positive: detection works; negative:
  stripping happens before the sink fires).
- **Sink is fire-and-forget.** Sink errors must be swallowed so
  logging never affects the request path.
- **`detectPHI` patterns are conservative.** Adding new patterns is
  always safe; removing them requires explicit justification.

## Review focus (priority order)

1. **Cryptographic correctness** — nonce generation, key derivation,
   wire-format compatibility, fail-closed semantics on decrypt.
2. **PHI safety** — for logging changes, verify redaction happens
   before sink emit AND in stdout pino output.
3. **API stability** — these packages have public consumers; any
   breaking change requires a major version bump and migration notes.
4. **Test coverage** — property-based tests via fast-check for
   crypto packages; positive + negative redaction tests for logging.
5. **Security** — supply-chain hygiene (pinned action SHAs in
   workflows), no eval/Function constructors, no untrusted JSON.parse
   on cryptographic inputs.
6. **Convention adherence** — does new code follow patterns already
   in the package's `src/`?
7. **Maintainability** — dead code, premature abstractions,
   defensive error handling for scenarios that can't happen.

## What NOT to suggest

- **Don't suggest comments that explain WHAT** (identifiers already do that) or reference the current PR / commit / caller. Comments are warranted only for non-obvious WHY.
- **Don't suggest backwards-compat shims, deprecation aliases, `_unused` renames, or `// removed X` comments.** Delete instead.
- **Don't suggest adding defensive validation at internal boundaries.** Validate only at system edges (controllers, user input, external APIs). Internal calls trust their types.
- **Don't suggest splitting a tight bug-fix PR** to add surrounding refactors or test coverage for unrelated code.
- **Don't suggest feature flags** for changes that can simply be made. No "toggle" unless explicitly requested.
- **Don't suggest new abstractions, helper functions, or refactors** beyond what the PR requires. Three similar lines is better than a premature abstraction.
- **Don't suggest squash or rebase merge** — repos use merge commits exclusively.

- **Don't suggest alternative crypto primitives.** AES-256-GCM is
  chosen and consistent across mobile + web.
- **Don't suggest "backup" or "recovery" key paths.** The keys are
  device/profile-bound by design; recovery is a deployment concern.
- **Don't suggest making the event sink durable.** It's
  fire-and-forget by contract; layer durability above the sink
  callback if you need it.

---

_When in doubt, prefer citing a rule from `CLAUDE.md` or a path-specific file in `.github/instructions/` over inventing new guidance._

<!--
This file is generated from the upstream repo's
`.github/copilot-instructions.md.template` by the sync mechanism. Edits made
here in a consumer repo will be overwritten on the next sync.

To customize per-repo content, update `.platform-config.yml` in this repo with the
substitutions for: PROJECT_NAME, PROJECT_OVERVIEW, CANONICAL_DOCS, STACK_TABLE,
CODE_RULES, DOMAIN_RULES, REVIEW_FOCUS, WHAT_NOT_TO_SUGGEST_EXTRA.

To improve the shared skeleton (anything outside the placeholders), edit the
template upstream.
-->
