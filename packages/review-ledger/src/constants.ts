import type {
  SupportedClassification,
  SupportedEngine,
  SupportedOutcome,
  SupportedSeverity,
  SupportedSide,
  SupportedStatus,
} from './types.js';

export const PROTOCOL_VERSION = 3;

/**
 * Version of this package, injected at build time by tsup's `define`.
 *
 * It cannot be read from `package.json` at runtime: the single-file build is
 * vendored into consumer repos on its own, with no package around it. The
 * `typeof` guard keeps the source runnable under vitest and `tsx`, where no
 * define is applied; a published build that somehow reached a consumer with
 * this fallback would be a build bug, so the publish workflow asserts the
 * built bundle reports the real version before it ships.
 */
export const PACKAGE_VERSION: string =
  typeof __PACKAGE_VERSION__ === 'string' ? __PACKAGE_VERSION__ : '0.0.0-dev';

/**
 * Output ceiling for every `gh` and `git` subprocess.
 *
 * Node caps `execFileSync` output at 1 MiB by default and fails the call with
 * `ENOBUFS` and an empty stderr once the child exceeds it. A pull request that
 * has accumulated a real ledger crosses that in review comments alone, so the
 * default turns a routine read into an undiagnosable GitHub failure exactly on
 * the pull requests this protocol exists to serve. The Python implementation
 * this package ports uses `subprocess.run`, which applies no such limit.
 */
export const SUBPROCESS_MAX_BUFFER = 256 * 1024 * 1024;

/** Pins the authenticated GitHub actor for the lifetime of a review relay. */
export const EXPECTED_ACTOR_ENV = 'AGENT_LOOP_REVIEW_ACTOR';
/** Seals a review-thread snapshot so it cannot be edited after capture. */
export const EXPECTED_THREADS_SHA256_ENV = 'AGENT_LOOP_REVIEW_THREADS_SHA256';
/** Bounds the pseudo-v3 history a pass is allowed to treat as pre-existing. */
export const HISTORICAL_COMMENT_IDS_ENV =
  'AGENT_LOOP_REVIEW_HISTORICAL_COMMENT_IDS_FILE';

export const SUPPORTED_ENGINES: readonly SupportedEngine[] = [
  'codex',
  'claude',
  'gemini',
  'antigravity',
] as const;

export const SUPPORTED_SEVERITIES: readonly SupportedSeverity[] = [
  'blocking',
  'major',
  'minor',
  'nit',
] as const;

export const SUPPORTED_OUTCOMES: readonly SupportedOutcome[] = [
  'fixed',
  'dismissed',
  'deferred',
] as const;

export const SUPPORTED_STATUSES: readonly SupportedStatus[] = [
  'clean',
  'changed',
  'blocked',
] as const;

export const SUPPORTED_CLASSIFICATIONS: readonly SupportedClassification[] = [
  'minor',
  'material',
] as const;

export const SUPPORTED_SIDES: readonly SupportedSide[] = [
  'RIGHT',
  'LEFT',
] as const;

export const HUNK_WITH_LEFT_RE =
  /^@@ -(?<left>\d+)(?:,\d+)? \+(?<right>\d+)(?:,\d+)? @@/;

export const SHA_RE = /^[0-9a-f]{40}$/;
export const SHA_64_RE = /^[0-9a-f]{64}$/;
export const TOKEN_RE = /^[A-Za-z0-9._:/-]+$/;

/**
 * Matches the first line of any comment that presents itself as a local-review
 * record. Used to reject markers that are malformed or from an unsupported
 * protocol version rather than silently ignoring them.
 */
export const PROTOCOL_THREAD_MARKER_RE = /^<!--[ \t]*local-review(?=[: \t-])/;
export const LEGACY_THREAD_MARKER_RE =
  /^<!--[ \t]*local-review(?:-disposition)?:v1(?=[ \t]|-->)/;

export const FINDING_V1 = '<!-- local-review:v1 ';
export const DISPOSITION_V1 = '<!-- local-review-disposition:v1 ';

/** Opening token of a v3 finding marker, used to spot malformed v3 records. */
export const FINDING_V3_OPENER = '<!-- local-review:v3';
export const PR_V1_MARKERS: readonly string[] = [
  '<!-- local-review-refactor:v1 ',
  '<!-- local-review-pass:v1 ',
  '<!-- local-review-complete:v1 ',
] as const;

export const FINDING_V3_RE =
  /^<!-- local-review:v3 engine=(?<engine>codex|claude|gemini|antigravity) round=(?<round>[1-9][0-9]*) head=(?<head>[0-9a-f]{40}) fingerprint=(?<fingerprint>[A-Za-z0-9._:/-]+) occurrence=(?<occurrence>[1-9][0-9]*) severity=(?<severity>blocking|major|minor|nit) lens=(?<lens>[A-Za-z0-9._:/-]+) content-sha256=(?<content_sha>[0-9a-f]{64}) -->$/m;

export const PSEUDO_V3_RE =
  /^<!-- local-review:v3 engine=(?:claude|gemini|antigravity) fingerprint=(?<fingerprint>[A-Za-z0-9._:/-]+)(?: outcome=deferred)? -->$/m;

export const DISPOSITION_V3_RE =
  /^<!-- local-review-disposition:v3 engine=(?<engine>codex|claude|gemini|antigravity) round=(?<round>[1-9][0-9]*) head=(?<head>[0-9a-f]{40}) fingerprint=(?<fingerprint>[A-Za-z0-9._:/-]+) occurrence=(?<occurrence>[1-9][0-9]*) outcome=(?<outcome>fixed|dismissed|deferred) content-sha256=(?<content_sha>[0-9a-f]{64}) -->$/m;

export const ROSTER_V1_MARKER = '<!-- local-review-roster:v1';

export const ROSTER_V1_RE =
  /^<!-- local-review-roster:v1 author=(?<author>codex|claude|gemini|antigravity) reviewers=(?<reviewers>none|(?:codex|claude|gemini|antigravity)(?:,(?:codex|claude|gemini|antigravity))*) content-sha256=(?<content_sha>[0-9a-f]{64}) -->$/m;

export const PASS_V3_RE =
  /^<!-- local-review-pass:v3 engine=(?<engine>codex|claude|gemini|antigravity) round=(?<round>[1-9][0-9]*) base=(?<base>[0-9a-f]{40}) head=(?<head>[0-9a-f]{40}) result-sha256=(?<result_sha>[0-9a-f]{64}) -->$/m;

export const COMPLETE_V3_RE =
  /^<!-- local-review-complete:v3 engine=(?<engine>codex|claude|gemini|antigravity) round=(?<round>[1-9][0-9]*) base=(?<base>[0-9a-f]{40}) before=(?<before>[0-9a-f]{40}) head=(?<head>[0-9a-f]{40}) classification=(?<classification>minor|material) fingerprints=(?<fingerprints>[A-Za-z0-9._:/,-]*) result-sha256=(?<result_sha>[0-9a-f]{64}) -->$/m;

export const FINDING_V1_RE =
  /^<!-- local-review:v1 engine=(?<engine>codex|claude|gemini|antigravity) round=(?<round>[1-9][0-9]*) head=(?<head>[0-9a-f]{40}) fingerprint=(?<fingerprint>[A-Za-z0-9._:/-]+) -->$/m;

export const DISPOSITION_V1_RE =
  /^<!-- local-review-disposition:v1 engine=(?<engine>codex|claude|gemini|antigravity) round=(?<round>[1-9][0-9]*) head=(?<head>[0-9a-f]{40}) fingerprint=(?<fingerprint>[A-Za-z0-9._:/-]+) outcome=(?<outcome>fixed|dismissed|deferred) -->$/m;
