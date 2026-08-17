import { lstatSync, readFileSync } from 'node:fs';
import { DISPOSITION_V3_RE, FINDING_V3_RE, PSEUDO_V3_RE } from './constants.js';
import { fail, LedgerError } from './errors.js';
import { requireToken, sha256Text } from './hash.js';
import type {
  DispositionV3Match,
  FindingV3Match,
  PseudoV3Match,
  SupportedEngine,
  SupportedOutcome,
  SupportedSeverity,
} from './types.js';

/**
 * Read legacy v1 comment body from file or stdin.
 */
export function readLegacyBody(
  path: string,
  marker: string | readonly string[],
  bodyText?: string,
): string {
  let body: string;
  if (bodyText !== undefined) {
    body = bodyText;
  } else if (path === '-') {
    body = readFileSync(0, 'utf8');
  } else {
    body = readFileSync(path, 'utf8');
  }
  if (!body.trim()) {
    fail('comment body is empty');
  }
  const markers = typeof marker === 'string' ? [marker] : marker;
  const matchesMarker = markers.some((candidate) => body.includes(candidate));
  if (!matchesMarker) {
    fail('comment body lacks the required local-review marker');
  }
  return body.trimEnd();
}

/**
 * Validate that a content string complies with protocol rules (no NUL, not empty, no markers).
 */
export function validateContentString(content: string): string {
  if (!content.trim()) {
    fail('comment content is empty');
  }
  if (content.includes('\x00')) {
    fail('comment content contains NUL');
  }
  if (content.includes('<!-- local-review')) {
    fail('comment content must not contain local-review markers');
  }
  return content;
}

/**
 * Read v3 comment content from a regular file.
 */
export function readContent(path: string): string {
  if (path === '-') {
    fail(
      'v3 content must be a regular file; stdin and heredocs are not accepted',
    );
  }
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      fail('content file must be a regular non-symlink file');
    }
  } catch (err) {
    if (err instanceof LedgerError) {
      throw err;
    }
    fail('content file must be a regular non-symlink file');
  }

  let content: string;
  try {
    content = readFileSync(path, 'utf8');
  } catch (error) {
    throw new LedgerError('content file must be valid UTF-8', { cause: error });
  }

  return validateContentString(content);
}

/**
 * Build finding marker and complete comment body.
 */
export function buildFindingBody(params: {
  engine: SupportedEngine;
  round: number;
  head: string;
  fingerprint: string;
  occurrence: number;
  severity: SupportedSeverity;
  lens: string;
  content: string;
}): { marker: string; body: string } {
  const marker =
    `<!-- local-review:v3 engine=${params.engine} round=${params.round} ` +
    `head=${params.head} fingerprint=${requireToken(params.fingerprint, 'fingerprint')} ` +
    `occurrence=${params.occurrence} severity=${params.severity} ` +
    `lens=${requireToken(params.lens, 'lens')} ` +
    `content-sha256=${sha256Text(params.content)} -->`;
  return { marker, body: `${marker}\n${params.content}` };
}

/**
 * Build disposition marker and complete comment body.
 */
export function buildDispositionBody(params: {
  engine: SupportedEngine;
  round: number;
  head: string;
  fingerprint: string;
  occurrence: number;
  outcome: SupportedOutcome;
  content: string;
}): { marker: string; body: string } {
  const marker =
    `<!-- local-review-disposition:v3 engine=${params.engine} round=${params.round} ` +
    `head=${params.head} fingerprint=${requireToken(params.fingerprint, 'fingerprint')} ` +
    `occurrence=${params.occurrence} outcome=${params.outcome} ` +
    `content-sha256=${sha256Text(params.content)} -->`;
  return { marker, body: `${marker}\n${params.content}` };
}

/**
 * Match a protocol marker at the start of a body string and verify its content hash.
 */
export function matchProtocol(
  body: string,
  pattern: RegExp,
  marker: string,
): RegExpExecArray | null {
  if (!body.includes(marker)) {
    return null;
  }
  const match = pattern.exec(body);
  if (!match || !match.groups) {
    fail(`authenticated ${marker} record is malformed`);
  }
  const matchEnd = match.index + match[0].length;
  if (!body.slice(matchEnd).startsWith('\n')) {
    fail(`authenticated ${marker} record is malformed`);
  }
  const content = body.slice(matchEnd + 1);
  if (sha256Text(content) !== match.groups['content_sha']) {
    fail(`authenticated ${marker} record has an invalid content hash`);
  }
  return match;
}

/**
 * Match historical pseudo v3 marker.
 */
export function matchPseudoV3(body: string): PseudoV3Match | null {
  const regex = new RegExp(PSEUDO_V3_RE.source, 'gm');
  const matches: RegExpExecArray[] = [];
  let m: RegExpExecArray | null;
  while ((m = regex.exec(body)) !== null) {
    matches.push(m);
  }
  if (matches.length === 0) {
    return null;
  }
  const markerCount = (body.match(/<!-- local-review/g) || []).length;
  const first = matches[0]!;
  if (
    matches.length !== 1 ||
    markerCount !== 1 ||
    first.index === 0 ||
    body[first.index - 1] !== '\n' ||
    first.index + first[0].length !== body.length ||
    !body.slice(0, first.index).trim()
  ) {
    fail('authenticated historical local-review:v3 record is malformed');
  }
  return {
    fingerprint: first.groups!['fingerprint']!,
    outcome: first[0].includes('outcome=deferred') ? 'deferred' : undefined,
  };
}

/**
 * Match finding v3 marker in comment body.
 */
export function matchFinding(body: string): FindingV3Match | null {
  if (matchPseudoV3(body) !== null) {
    return null;
  }
  const match = matchProtocol(body, FINDING_V3_RE, '<!-- local-review:v3');
  if (!match || !match.groups) {
    return null;
  }
  return {
    engine: match.groups['engine'] as SupportedEngine,
    round: parseInt(match.groups['round']!, 10),
    head: match.groups['head']!,
    fingerprint: match.groups['fingerprint']!,
    occurrence: parseInt(match.groups['occurrence']!, 10),
    severity: match.groups['severity'] as SupportedSeverity,
    lens: match.groups['lens']!,
    contentSha: match.groups['content_sha']!,
  };
}

/**
 * Match disposition v3 marker in comment body.
 */
export function matchDisposition(body: string): DispositionV3Match | null {
  const match = matchProtocol(
    body,
    DISPOSITION_V3_RE,
    '<!-- local-review-disposition:v3',
  );
  if (!match || !match.groups) {
    return null;
  }
  return {
    engine: match.groups['engine'] as SupportedEngine,
    round: parseInt(match.groups['round']!, 10),
    head: match.groups['head']!,
    fingerprint: match.groups['fingerprint']!,
    occurrence: parseInt(match.groups['occurrence']!, 10),
    outcome: match.groups['outcome'] as SupportedOutcome,
    contentSha: match.groups['content_sha']!,
  };
}
