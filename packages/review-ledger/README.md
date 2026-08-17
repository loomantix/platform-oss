# @loomantix/review-ledger

Deterministic local-review ledger protocol, verification, and CLI for multi-engine code review relays (`codex`, `claude`, `gemini`, `antigravity`).

## Overview

The review ledger uses an open draft pull request as the durable, tamper-evident ledger for local adversarial code reviews and cleanup passes. `@loomantix/review-ledger` provides:

- **Strict Protocol Validation**: Deterministic v3 marker serialization, SHA-256 content hashing, sequential occurrence verification, and blocker resolution enforcement.
- **Multi-Engine Support**: Unified contract for `codex`, `claude`, `gemini`, and `antigravity` reviewer engines.
- **Standalone CLI & TypeScript API**: Zero runtime dependencies, dual ESM/CJS distribution, and CLI executable (`review-ledger`).

## Installation

```bash
# Package install
pnpm add @loomantix/review-ledger

# Or invoke directly via npx
npx @loomantix/review-ledger --protocol-version
```

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

Post an inline finding with an authenticated v3 protocol marker and content hash:

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

# Verify complete thread ledger
review-ledger verify-ledger --repo owner/repo --pr 123 --head <sha> --threads-file ./threads.json
```

## Programmatic API

```typescript
import {
  writeResult,
  writeBlockedResult,
  readResult,
  formatFindings,
  computeFindingFingerprint,
  reconcile,
} from '@loomantix/review-ledger';

// Generate a deterministic finding fingerprint
const fingerprint = computeFindingFingerprint({
  path: 'packages/logging/src/index.ts',
  rootCause: 'Missing redaction on tenant ID',
  lens: 'security-reviewer',
});

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

1. **Commands & Options**: All CLI flags match `review-ledger.py` exactly (`--repo`, `--pr`, `--head`, `--engine`, `--round`, `--fingerprint`, etc.).
2. **Execution**: Replace `python3 .agents/skills/critique/scripts/review-ledger.py ...` with `review-ledger ...` or `npx @loomantix/review-ledger ...`.
3. **No Python Runtime**: Node.js 18+ / 20+ / 22+ runtime is sufficient; zero external Python or pip dependencies required.

## License

Apache-2.0. Copyright 2026 Loomantix Inc.
