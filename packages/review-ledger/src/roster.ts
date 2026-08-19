import {
  COMPLETE_V3_RE,
  PASS_V3_RE,
  ROSTER_V1_MARKER,
  ROSTER_V1_RE,
  SUPPORTED_ENGINES,
} from './constants.js';
import { fail, LedgerError } from './errors.js';
import {
  deleteIssueComment,
  findMatchingBody,
  getIssueComments,
  getPostedCommentId,
  jsonOutput,
  verifyHead,
  verifyIssueComment,
} from './github.js';
import { sha256Text } from './hash.js';
import { matchProtocol } from './protocol.js';
import type {
  AttestationAtHead,
  CoverageParams,
  CoverageResult,
  CoverageTier,
  PostRosterParams,
  PostRosterResult,
  RosterReport,
  RosterV1Match,
  SupportedEngine,
} from './types.js';

/**
 * Parse the `reviewers=` field into a validated engine list.
 *
 * `none` is the explicit declaration that this pull request is being reviewed
 * by its author engine alone. It is spelled out rather than represented by an
 * empty value so a truncated or malformed marker cannot read as a deliberate
 * solo review.
 */
export function parseReviewers(
  raw: string,
  author: SupportedEngine,
): SupportedEngine[] {
  if (raw === 'none') {
    return [];
  }
  return validateReviewers(raw.split(','), author);
}

/**
 * Apply the three roster rules to a reviewer list: every entry is a supported
 * engine, none of them is the author, and no engine appears twice.
 *
 * The builder and the parser share this so a roster this package writes is one
 * this package will read back. A rule enforced on only one side would let a
 * marker exist that its own reader rejects.
 */
function validateReviewers(
  reviewers: readonly string[],
  author: SupportedEngine,
): SupportedEngine[] {
  const validated: SupportedEngine[] = [];
  for (const candidate of reviewers) {
    if (!SUPPORTED_ENGINES.includes(candidate as SupportedEngine)) {
      fail(`reviewer must be one of: ${SUPPORTED_ENGINES.join(', ')}`);
    }
    const engine = candidate as SupportedEngine;
    if (engine === author) {
      fail('the author engine cannot also be listed as a reviewer');
    }
    if (validated.includes(engine)) {
      fail('reviewers must be distinct');
    }
    validated.push(engine);
  }
  return validated;
}

/**
 * Match the roster marker in a comment body and verify its content hash.
 */
export function matchRoster(body: string): RosterV1Match | null {
  const match = matchProtocol(body, ROSTER_V1_RE, ROSTER_V1_MARKER);
  if (!match || !match.groups) {
    return null;
  }
  const author = match.groups['author'] as SupportedEngine;
  return {
    author,
    reviewers: parseReviewers(match.groups['reviewers']!, author),
    contentSha: match.groups['content_sha']!,
  };
}

/**
 * Build the roster marker and its complete comment body.
 *
 * The declared reason travels in hashed content for the same reason a finding's
 * prose does: a solo review is a deliberate, attributable choice, and the
 * justification for it must not be silently editable after the fact.
 */
export function buildRosterBody(params: {
  author: SupportedEngine;
  reviewers: readonly SupportedEngine[];
  content: string;
}): { marker: string; body: string } {
  if (!SUPPORTED_ENGINES.includes(params.author)) {
    fail(`author must be one of: ${SUPPORTED_ENGINES.join(', ')}`);
  }
  validateReviewers(params.reviewers, params.author);
  const reviewers =
    params.reviewers.length === 0 ? 'none' : params.reviewers.join(',');
  const marker =
    `${ROSTER_V1_MARKER} author=${params.author} reviewers=${reviewers} ` +
    `content-sha256=${sha256Text(params.content)} -->`;
  return { marker, body: `${marker}\n${params.content}` };
}

/**
 * Read the actor-owned roster declared on a pull request.
 *
 * A pull request carries at most one roster. Two conflicting declarations are a
 * contradiction to reject rather than a history to reconcile: every downstream
 * completeness answer depends on which one is authoritative.
 */
export function readRoster(params: {
  repo: string;
  pr: number;
  rows?: Array<Record<string, unknown>> | undefined;
}): RosterReport {
  const rows = params.rows ?? getIssueComments(params.repo, params.pr);
  const candidates = rows.filter((row) =>
    String(row['body'] ?? '').includes(ROSTER_V1_MARKER),
  );
  if (candidates.length === 0) {
    return { present: false, author: null, reviewers: [], commentId: null };
  }
  if (candidates.length !== 1) {
    fail('local-review roster is declared more than once');
  }
  const row = candidates[0]!;
  const parsed = matchRoster(String(row['body'] ?? ''));
  if (parsed === null || typeof row['id'] !== 'number') {
    fail('local-review roster record is malformed');
  }
  return {
    present: true,
    author: parsed.author,
    reviewers: parsed.reviewers,
    commentId: row['id'] as number,
  };
}

/**
 * Declare the engines participating in this pull request's review relay.
 *
 * Participation must be declared rather than inferred. An engine that has not
 * posted an attestation is indistinguishable from an engine that was never
 * going to, so without a declared roster no reader can decide whether a round
 * is complete or merely unfinished.
 */
export function postRoster(params: PostRosterParams): PostRosterResult {
  const { marker, body } = buildRosterBody({
    author: params.author,
    reviewers: params.reviewers,
    content: params.content,
  });
  verifyHead(params.repo, params.pr, params.head);

  const rows = getIssueComments(params.repo, params.pr);
  const existing = findMatchingBody(rows, ROSTER_V1_MARKER, body);
  let commentId: number;
  let replayed = existing !== null;
  let created = existing === null;

  if (existing === null) {
    try {
      const response = jsonOutput(
        [
          'api',
          '-X',
          'POST',
          `repos/${params.repo}/issues/${params.pr}/comments`,
        ],
        { body },
      );
      commentId = getPostedCommentId(response);
    } catch (error) {
      if (error instanceof LedgerError) {
        const recovered = findMatchingBody(
          getIssueComments(params.repo, params.pr),
          marker,
          body,
        );
        if (recovered === null) throw error;
        commentId = recovered;
        replayed = true;
        created = false;
      } else {
        throw error;
      }
    }
  } else {
    commentId = existing;
  }

  try {
    verifyIssueComment(params.repo, commentId, body);
    verifyHead(params.repo, params.pr, params.head);
  } catch (error) {
    if (created) {
      try {
        deleteIssueComment(params.repo, params.pr, commentId);
      } catch (rollbackError) {
        throw new LedgerError(
          `roster verification failed and rollback could not be verified: ${
            (rollbackError as { message?: string }).message ??
            String(rollbackError)
          }`,
          { cause: error },
        );
      }
    }
    throw error;
  }

  return {
    comment_id: commentId,
    author: params.author,
    reviewers: [...params.reviewers],
    replayed,
    verified: true,
  };
}

/**
 * Collect the actor-owned pass and completion attestations naming an exact head.
 *
 * Attestation evidence is per-head by construction, so this is also the
 * invalidation rule: an engine whose newest attestation names an earlier commit
 * has not reviewed what the pull request currently contains, and an engine
 * whose attestation names this commit has, regardless of what moved the head or
 * how many rounds preceded it.
 */
export function attestationsAtHead(
  rows: Array<Record<string, unknown>>,
  head: string,
): AttestationAtHead[] {
  const found: AttestationAtHead[] = [];
  for (const row of rows) {
    const body = String(row['body'] ?? '');
    const pass = PASS_V3_RE.exec(body);
    if (pass?.groups) {
      if (pass.groups['head'] === head) {
        found.push({
          engine: pass.groups['engine'] as SupportedEngine,
          round: parseInt(pass.groups['round']!, 10),
          status: 'clean',
        });
      }
      continue;
    }
    const complete = COMPLETE_V3_RE.exec(body);
    if (complete?.groups && complete.groups['head'] === head) {
      found.push({
        engine: complete.groups['engine'] as SupportedEngine,
        round: parseInt(complete.groups['round']!, 10),
        status: 'changed',
      });
    }
  }
  return found;
}

/**
 * Classify how many distinct non-author engines reviewed the exact head.
 */
export function coverageTier(count: number): CoverageTier {
  if (count === 0) return 'solo';
  if (count === 1) return 'cross';
  return 'full';
}

/**
 * Report cross-model review coverage for the pull request's exact current head.
 *
 * The author engine's own pass is reported but never counted. It re-reads a
 * change while still holding the rationale that produced it, which is the
 * opposite of the cold read the relay exists to obtain.
 */
export function coverage(params: CoverageParams): CoverageResult {
  verifyHead(params.repo, params.pr, params.head);
  const rows = getIssueComments(params.repo, params.pr);
  const roster = readRoster({ repo: params.repo, pr: params.pr, rows });
  const attested = attestationsAtHead(rows, params.head);

  const attestedEngines = [
    ...new Set(attested.map((row) => row.engine)),
  ].sort();
  const nonAuthorAttested = attestedEngines.filter(
    (engine) => engine !== roster.author,
  );
  const missingReviewers = roster.reviewers.filter(
    (engine) => !attestedEngines.includes(engine),
  );

  return {
    head: params.head,
    rosterPresent: roster.present,
    author: roster.author,
    reviewers: [...roster.reviewers],
    attestedAtHead: attestedEngines,
    nonAuthorAttested,
    missingReviewers,
    authorAttested:
      roster.author !== null && attestedEngines.includes(roster.author),
    tier: coverageTier(nonAuthorAttested.length),
    soloAcknowledged: roster.present && roster.reviewers.length === 0,
    roundComplete: roster.present && missingReviewers.length === 0,
    verified: true,
  };
}

/**
 * Compute coverage and refuse an incomplete or unacknowledged relay.
 *
 * Solo review is permitted, but only when it was declared up front with a
 * recorded reason. That keeps the recommendation visible on the pull request
 * instead of resting on whoever remembered it.
 */
export function verifyCoverage(params: CoverageParams): CoverageResult {
  const report = coverage(params);
  if (!report.rosterPresent) {
    fail(
      'no local-review roster is declared on this pull request; run post-roster before claiming coverage',
    );
  }
  if (report.missingReviewers.length > 0) {
    fail(
      `declared reviewers have not attested this head: ${report.missingReviewers.join(', ')}`,
    );
  }
  return report;
}
