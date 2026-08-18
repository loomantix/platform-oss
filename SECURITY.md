# Security

This repo publishes infrastructure packages used in production:

- `@loomantix/mobile-crypto` — at-rest encryption for React Native (AES-256-GCM, expo-secure-store-backed master key).
- `@loomantix/web-crypto` — at-rest encryption for browsers (AES-256-GCM, non-extractable WebCrypto key in IndexedDB).
- `@loomantix/logging` — pino-based structured logging with PHI/PII redaction and an event sink for audit forwarding.

Security issues in these packages may affect downstream applications handling user data, credentials, and PHI.

## Reporting a vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Email **security@loomantix.com** with:

1. Description of the vulnerability
2. Steps to reproduce (or proof-of-concept)
3. Affected packages/versions
4. Your name and contact (for follow-up)

You will receive an acknowledgement within 3 business days. We aim to triage within 7 business days and ship a fix or mitigation within 30 days for confirmed vulnerabilities.

## Scope

In scope:

- Vulnerabilities in any `@loomantix/*` package published from this repo.
- CI/build supply-chain vulnerabilities affecting this repo (e.g. compromised workflow, malicious dependency injection).
- Cryptographic weaknesses in `mobile-crypto` / `web-crypto` (e.g. nonce reuse, key exposure paths, AES-GCM misuse).
- Redaction bypasses in `@loomantix/logging` that could leak PHI/PII or auth tokens.

Out of scope:

- Vulnerabilities in upstream dependencies (please report to the upstream first).
- Vulnerabilities specific to consumer applications using these packages (report to that application's maintainers).
- DoS via resource exhaustion at the application layer (these packages don't define rate limits or memory bounds — that's a deployment concern).

## Disclosure policy

We follow coordinated disclosure:

- We will work with you to understand the issue and ship a fix.
- Once a fix is released, we publish a security advisory via GitHub Security Advisories crediting you (unless you prefer to remain anonymous).
- 90 days after the fix is published, the full technical details may be disclosed.

If a vulnerability is being actively exploited, we may shorten this timeline.

## Threat-model notes per package

**`@loomantix/mobile-crypto` and `@loomantix/web-crypto`:**

- Both packages assume the device or browser profile is the trust boundary. A user with full local access can decrypt ciphertext encrypted on that device — these packages defend against at-rest disk inspection, not against a compromised running app.
- Web-crypto's `CryptoKey` is non-extractable, but a script running in the same origin can call `decrypt`. Origin isolation (CSP, dependency hygiene) is the consumer's responsibility.
- Wire format (`LMX\x01` magic + 12-byte nonce + AES-GCM auth tag) is a stable format; format versioning is reserved via the magic byte's high bit.

**`@loomantix/logging`:**

- `PHI_FIELD_NAMES` is the single source of truth for redaction. Both the stdout path (`formatters.log` plus a derived `redact.paths`) and the event-sink path (`logMetadata`) are built from it, so a name added there protects both channels. Before v0.4.0 the two lists were maintained separately and had drifted: clinical fields such as `transcript` and `soapNote` were stripped from the sink but written to stdout in cleartext.
- Redaction is **name-based**, applied at every depth. It is still best-effort: a sensitive value logged under a name not in the list, or interpolated into the `msg` string, is passed through. Use `assertPHISafe` in tests to catch this.
- A field whose name is sensitive is censored together with its subtree, so `{ patient: {...} }` yields `[REDACTED]` rather than a walked object. Log correlation identifiers under non-sensitive names.
- The depth-independent walk covers the merging object you log and the `req` / `res` / `err` serializer output. It cannot cover `logger.child()` bindings: pino renders those once at `child()` time and resets any custom bindings formatter first, so only the derived `redact.paths` applies there and coverage stops at depth 1. Walk untrusted bindings with the exported `redactTree` before passing them to `child()`.
- `redactS3Url` keeps only the file extension. Object keys routinely carry patient names, MRNs, and dates of birth in the last path segment, so the filename is dropped rather than preserved.
- The event sink is fire-and-forget; sink errors are swallowed by design (logging must not affect the request path). If your audit pipeline requires guaranteed delivery, layer durability above the sink callback.
