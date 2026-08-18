# @loomantix/review-ledger

Deterministic local-review ledger protocol, verification, and CLI for multi-engine code review relays (`codex`, `claude`, `gemini`, `antigravity`).

## Overview

The review ledger uses an open draft pull request as a durable ledger of actor-owned, content-integrity-checked records for local adversarial code reviews and cleanup passes. `@loomantix/review-ledger` provides:

- **Strict Protocol Validation**: Deterministic v3 marker serialization, SHA-256 content hashing, sequential occurrence verification, and blocker resolution enforcement.
- **Multi-Engine Support**: Unified contract for `codex`, `claude`, `gemini`, and `antigravity` reviewer engines.
- **Standalone CLI & TypeScript API**: Zero npm runtime dependencies, dual ESM/CJS distribution, and CLI executable (`review-ledger`).

## Installation

```bash
# Package install
pnpm add @loomantix/review-ledger

# Or invoke directly via npx
npx @loomantix/review-ledger --protocol-version
```

Most GitHub-backed commands require Node.js 18 or later, Git with the reviewed
history available locally, and an authenticated [GitHub CLI](https://cli.github.com/)
session. File-only result validation and `--protocol-version` do not use GitHub.

## CLI Usage

The `review-ledger` binary exposes all subcommands:

### Check Protocol Version

```bash
review-ledger --protocol-version
# 3
```

### Preflight Diff Anchor

Verify that an inline review comment targets an exact diff line in GitHub's patch:

```bash
review-ledger preflight-anchor \
  --repo owner/repo \
  --pr 123 \
  --head 0123456789abcdef0123456789abcdef01234567 \
  --path src/utils.ts \
  --line 42 \
  --side RIGHT
```

### Post Inline Finding

Post an inline finding with an actor-owned v3 protocol marker and content hash:

```bash
review-ledger post-finding \
  --repo owner/repo \
  --pr 123 \
  --head 0123456789abcdef0123456789abcdef01234567 \
  --path src/utils.ts \
  --line 42 \
  --engine gemini \
  --round 1 \
  --fingerprint auth-token-leak \
  --occurrence 1 \
  --severity blocking \
  --lens security-reviewer \
  --content-file ./finding-notes.txt
```

### Dispose Finding

Post a disposition reply and resolve the review thread:

```bash
review-ledger dispose \
  --repo owner/repo \
  --pr 123 \
  --head 0123456789abcdef0123456789abcdef01234567 \
  --engine gemini \
  --round 1 \
  --fingerprint auth-token-leak \
  --occurrence 1 \
  --outcome fixed \
  --comment-id 1001 \
  --thread-id PRRT_kwDO123 \
  --content-file ./fix-rationale.txt
```

### Write & Validate Structured Results

Write pass result file:

```bash
review-ledger write-result \
  --repo owner/repo \
  --pr 123 \
  --head 0123456789abcdef0123456789abcdef01234567 \
  --engine gemini \
  --round 1 \
  --base 0000000000000000000000000000000000000000 \
  --before 1111111111111111111111111111111111111111 \
  --result-file ./review-result.json \
  --classification minor
```

Write blocked result:

```bash
review-ledger write-blocked-result \
  --head 0123456789abcdef0123456789abcdef01234567 \
  --engine gemini \
  --round 1 \
  --base 0000000000000000000000000000000000000000 \
  --before 1111111111111111111111111111111111111111 \
  --result-file ./review-result.json \
  --blocker-file ./blocked-reason.txt
```

### Reconcile & Verify Ledger

```bash
# Reconcile finding state
review-ledger reconcile --repo owner/repo --pr 123 --head <sha> --fingerprint auth-token-leak

# Verify the complete thread ledger against live GitHub state
review-ledger verify-ledger --repo owner/repo --pr 123 --head <sha>

# ...or against a snapshot captured through a trusted channel. The digest
# detects later byte changes; it does not prove that the file came from GitHub.
review-ledger verify-ledger --repo owner/repo --pr 123 --head <sha> \
  --threads-file ./threads.json \
  --expected-threads-sha256 "$(sha256sum ./threads.json | cut -d' ' -f1)"
```

### Trust model

Three inputs are assertions the ledger checks, never values it takes on trust:

- `--actor` asserts who the authenticated GitHub session belongs to. It is
  compared against the live `gh api user` login and fails on mismatch; it cannot
  select whose comments count as actor-owned. `AGENT_LOOP_REVIEW_ACTOR` pins the
  same identity for a whole relay.
- `--threads-file` is offline input, not independently authenticated evidence.
  Capture it through a trusted channel and pass `--expected-threads-sha256` (or
  set `AGENT_LOOP_REVIEW_THREADS_SHA256`) from that channel. The digest detects
  changes after capture; a digest computed from the same untrusted file proves
  no GitHub provenance. Prefer a live fetch whenever provenance is required.
- Every thread must carry the repository and PR number it came from, and must
  match the `--repo` / `--pr` under review.

## Programmatic API

```typescript
import {
  writeResult,
  writeBlockedResult,
  readResult,
  formatFindings,
  verifyLedger,
  reconcile,
} from '@loomantix/review-ledger';

// Format findings table
const markdown = formatFindings([
  {
    path: 'packages/logging/src/index.ts',
    line: 15,
    severity: 'blocking',
    lens: 'security-reviewer',
    rootCause: 'Missing redaction on tenant ID',
  },
]);
```

## Migration from `review-ledger.py`

The subcommands and flags mirror `review-ledger.py`. Implementations with the
same protocol version and shared engine support use the same marker layout,
content hashing, and verification rules; parity tests keep those shared records
interoperable.

1. **Execution**: replace `python3 <skill>/scripts/review-ledger.py ...` with
   `review-ledger ...` or `npx @loomantix/review-ledger ...`. No Python runtime
   is needed; the external Git and GitHub CLI prerequisites above still apply.
2. **Fingerprints are supplied, not derived.** As in the Python, a fingerprint
   is a caller-chosen stable token for one root cause, passed as
   `--fingerprint`. This package deliberately ships no fingerprint generator: an
   engine-local hashing scheme would drift from the tokens already recorded on
   open PRs and would not agree across engines.
3. **Engine set.** This package accepts `codex`, `claude`, `gemini`, and
   `antigravity`. Before exchanging records with another implementation,
   confirm that it supports the selected engine and protocol version.
4. **`formatFindings` is additive**, with no counterpart in the Python. It is a
   presentation helper and no verification path depends on its output.

## License

Apache-2.0. Copyright 2026 Loomantix Inc.
