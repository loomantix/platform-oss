# platform-oss — Agent Guide

Public source for reusable `@loomantix/*` infrastructure packages. Apache 2.0 + DCO. See [README.md](README.md) for package overview, [CONTRIBUTING.md](CONTRIBUTING.md) for contribution workflow, and [SECURITY.md](SECURITY.md) for vulnerability reporting.

## Public-Repo Policy

Keep all issues, PRs, comments, and docs suitable for public readers:

- Do not reference non-public repositories, systems, incidents, trackers, or customer-specific details.
- Do not document deployment-specific wiring, secret names, internal escalation paths, or private package consumers.
- Keep compliance and security rationale generic and package-focused.
- Put consumer-specific integration details in that consumer's repository, not here.

If work needs non-public context, discuss that context outside this public repository and keep the public PR focused on the reusable package change.

## Working Rules

- Start each session by reading this file and checking `git status --short --branch`.
- Use `rg` / `rg --files` for search and file discovery.
- Use `apply_patch` for manual file edits where practical.
- Do not revert user changes or unrelated dirty worktree state.
- Keep changes scoped to the package or docs surface in the request.
- Run the smallest meaningful validation command after edits and report anything that could not be run.

## Package Rules

- `@loomantix/mobile-crypto` and `@loomantix/web-crypto` share an API and wire format; avoid breaking either without an explicit major-version plan.
- Crypto changes require tests for fail-closed behavior and stable ciphertext framing.
- `@loomantix/logging` changes require PHI/PII redaction tests when redaction, sink, or serializer behavior changes.
- Do not add `any`; this workspace is strict TypeScript.
- Release tags are package-specific: `<package>-v<semver>`.
- Publish workflows use npm Trusted Publishing with provenance. Do not add long-lived npm tokens.

## Commands

```bash
pnpm install
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

## Cross-References

- [README.md](README.md) — package list, install commands, release model.
- [CONTRIBUTING.md](CONTRIBUTING.md) — DCO, scope, workflow.
- [SECURITY.md](SECURITY.md) — responsible disclosure and package threat-model notes.
