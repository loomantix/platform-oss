import type {
  SupportedClassification,
  SupportedEngine,
  SupportedOutcome,
  SupportedSeverity,
  SupportedSide,
  SupportedStatus,
} from './types.js';

export const PROTOCOL_VERSION = 3;

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

export const FINDING_V1 = '<!-- local-review:v1 ';
export const DISPOSITION_V1 = '<!-- local-review-disposition:v1 ';
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

export const FINDING_V1_RE =
  /^<!-- local-review:v1 engine=(?<engine>codex|claude|gemini|antigravity) round=(?<round>[1-9][0-9]*) head=(?<head>[0-9a-f]{40}) fingerprint=(?<fingerprint>[A-Za-z0-9._:/-]+) -->$/m;

export const DISPOSITION_V1_RE =
  /^<!-- local-review-disposition:v1 engine=(?<engine>codex|claude|gemini|antigravity) round=(?<round>[1-9][0-9]*) head=(?<head>[0-9a-f]{40}) fingerprint=(?<fingerprint>[A-Za-z0-9._:/-]+) outcome=(?<outcome>fixed|dismissed|deferred) -->$/m;
