/**
 * A review engine that may own ledger records.
 */
export type SupportedEngine = 'codex' | 'claude' | 'gemini' | 'antigravity';
/**
 * How serious a finding is.
 */
export type SupportedSeverity = 'blocking' | 'major' | 'minor' | 'nit';
/**
 * How a finding was closed.
 */
export type SupportedOutcome = 'fixed' | 'dismissed' | 'deferred';
/**
 * The overall outcome of a review round.
 */
export type SupportedStatus = 'clean' | 'changed' | 'blocked';
/**
 * Whether a changed round counts as a material change.
 */
export type SupportedClassification = 'minor' | 'material';
/**
 * Which side of the diff an anchor refers to.
 */
export type SupportedSide = 'RIGHT' | 'LEFT';

/**
 * A finding as callers describe it, before it becomes a ledger record.
 */
export interface ReviewFinding {
  path: string;
  line?: number | undefined;
  fileLevel?: boolean | undefined;
  side?: SupportedSide | undefined;
  engine?: SupportedEngine | undefined;
  round?: number | undefined;
  fingerprint?: string | undefined;
  occurrence?: number | undefined;
  severity?: SupportedSeverity | undefined;
  lens?: string | undefined;
  rootCause?: string | undefined;
  message?: string | undefined;
  rule?: string | undefined;
  content?: string | undefined;
  contentFile?: string | undefined;
  bodyFile?: string | undefined;
}

/**
 * The fields parsed out of a v3 finding marker.
 */
export interface FindingV3Match {
  engine: SupportedEngine;
  round: number;
  head: string;
  fingerprint: string;
  occurrence: number;
  severity: SupportedSeverity;
  lens: string;
  contentSha: string;
}

/**
 * The fields parsed out of a v3 disposition marker.
 */
export interface DispositionV3Match {
  engine: SupportedEngine;
  round: number;
  head: string;
  fingerprint: string;
  occurrence: number;
  outcome: SupportedOutcome;
  contentSha: string;
}

/**
 * The fields parsed out of a legacy v1 finding marker.
 */
export interface FindingV1Match {
  engine: SupportedEngine;
  round: number;
  head: string;
  fingerprint: string;
}

/**
 * The fields parsed out of a legacy v1 disposition marker.
 */
export interface DispositionV1Match {
  engine: SupportedEngine;
  round: number;
  head: string;
  fingerprint: string;
  outcome: SupportedOutcome;
}

/**
 * The fields parsed out of a historical pseudo-v3 marker.
 */
export interface PseudoV3Match {
  fingerprint: string;
  outcome?: 'deferred' | undefined;
}

/**
 * The serialised outcome of one review round.
 */
export interface LedgerResult {
  version: number;
  status: SupportedStatus;
  engine: SupportedEngine;
  round: number;
  baseSha: string;
  beforeSha: string;
  afterSha: string;
  classification: SupportedClassification | null;
  findingFingerprints: string[];
  finalLaneComplete: boolean;
  blocker?: string | undefined;
  resultSha256?: string | undefined;
  verified?: boolean | undefined;
}

/**
 * The identity every result-producing command shares.
 */
export interface BaseResultParams {
  head: string;
  engine: SupportedEngine;
  round: number;
  base: string;
  before: string;
  resultFile: string;
}

/**
 * Parameters for `writeResult`.
 */
export interface WriteResultParams extends BaseResultParams {
  repo: string;
  pr: number;
  allowedHeadsFile?: string | undefined;
  actor?: string | undefined;
  historicalCommentIdsFile?: string | undefined;
  classification?: SupportedClassification | undefined;
}

/**
 * Parameters for `writeBlockedResult`.
 */
export interface WriteBlockedParams extends BaseResultParams {
  blockerFile?: string | undefined;
  blocker?: string | undefined;
}

/**
 * Parameters for `validateResult`.
 */
export interface ValidateResultParams extends BaseResultParams {
  resultHead?: string | undefined;
}

/**
 * Parameters for `preflightAnchor`.
 */
export interface PreflightAnchorParams {
  repo: string;
  pr: number;
  head: string;
  path: string;
  line?: number | undefined;
  fileLevel?: boolean | undefined;
  side?: SupportedSide | undefined;
}

/**
 * The result of `preflightAnchor`.
 */
export interface PreflightAnchorResult {
  anchor: string;
  path: string;
  verified: true;
}

/**
 * Parameters for `postFinding`.
 */
export interface PostFindingParams {
  repo: string;
  pr: number;
  head: string;
  path: string;
  line?: number | undefined;
  fileLevel?: boolean | undefined;
  side?: SupportedSide | undefined;
  contentFile?: string | undefined;
  content?: string | undefined;
  bodyFile?: string | undefined;
  engine?: SupportedEngine | undefined;
  round?: number | undefined;
  fingerprint?: string | undefined;
  occurrence?: number | undefined;
  severity?: SupportedSeverity | undefined;
  lens?: string | undefined;
}

/**
 * The result of `postFinding`.
 */
export interface PostFindingResult {
  comment_id: number;
  verified: true;
  replayed?: boolean | undefined;
}

/**
 * Parameters for `reopenOccurrence`.
 */
export interface ReopenOccurrenceParams {
  repo: string;
  pr: number;
  head: string;
  engine: SupportedEngine;
  round: number;
  fingerprint: string;
  occurrence: number;
  severity: SupportedSeverity;
  lens: string;
  commentId: number;
  threadId: string;
  contentFile?: string | undefined;
  content?: string | undefined;
}

/**
 * The result of `reopenOccurrence`.
 */
export interface ReopenOccurrenceResult {
  comment_id: number;
  replayed: boolean;
  thread_replayed: boolean;
  resolved: false;
  verified: true;
}

/**
 * Parameters for `dispose`.
 */
export interface DisposeParams {
  repo: string;
  pr: number;
  head: string;
  engine: SupportedEngine;
  round: number;
  fingerprint: string;
  occurrence?: number | undefined;
  outcome: SupportedOutcome;
  commentId: number;
  threadId: string;
  contentFile?: string | undefined;
  content?: string | undefined;
}

/**
 * The result of `dispose`.
 */
export interface DisposeResult {
  comment_id: number;
  replayed: boolean;
  thread_replayed: boolean;
  resolved: true;
  verified: true;
}

/**
 * Parameters for `reply`.
 */
export interface ReplyParams {
  repo: string;
  pr: number;
  head: string;
  commentId: number;
  bodyFile?: string | undefined;
  body?: string | undefined;
}

/**
 * Parameters for `postPrComment`.
 */
export interface PostPrCommentParams {
  repo: string;
  pr: number;
  head: string;
  bodyFile?: string | undefined;
  body?: string | undefined;
}

/**
 * Parameters for `attest`.
 */
export interface AttestParams extends BaseResultParams {
  repo: string;
  pr: number;
  threadsFile?: string | undefined;
  allowedHeadsFile?: string | undefined;
  actor?: string | undefined;
  historicalCommentIdsFile?: string | undefined;
  expectedResultSha256: string;
  expectedThreadsSha256?: string | undefined;
  contentFile?: string | undefined;
  content?: string | undefined;
}

/**
 * The result of `attest`.
 */
export interface AttestResult {
  comment_id: number;
  replayed: boolean;
  result_sha256: string;
  verified: true;
}

/**
 * Parameters for `resolve`.
 */
export interface ResolveParams {
  repo: string;
  pr: number;
  head: string;
  threadId: string;
}

/**
 * The result of `resolve`.
 */
export interface ResolveResult {
  thread_id: string;
  resolved: true;
}

/**
 * Parameters for `reconcile`.
 */
export interface ReconcileParams {
  repo: string;
  pr: number;
  head: string;
  fingerprint: string;
}

/**
 * The result of `reconcile`.
 */
export interface ReconcileResult {
  findings: Array<Record<string, unknown>>;
  dispositions: Array<Record<string, unknown>>;
  sequenceValid: boolean;
  ledgerValid: boolean;
  nextOccurrence: number | null;
  undisposedOccurrences: number[];
  nextAction:
    | 'repair-sequence'
    | 'dispose'
    | 'reopen-occurrence'
    | 'post-finding';
  /**
   * The review thread holding occurrence 1, when the ledger is valid and
   * exactly one root comment identifies it. `null` when the fingerprint has no
   * occurrence-1 comment to anchor to, which is what an unposted finding looks
   * like.
   */
  threadId: string | null;
  threadResolved: boolean | null;
  verified: true;
}

/**
 * Parameters for `verifyLedger`.
 */
export interface VerifyLedgerParams {
  repo: string;
  pr: number;
  head: string;
  threadsFile?: string | undefined;
  actor?: string | undefined;
  historicalCommentIdsFile?: string | undefined;
  engine?: SupportedEngine | undefined;
  round?: number | undefined;
  base?: string | undefined;
  before?: string | undefined;
  resultHead?: string | undefined;
  resultFile?: string | undefined;
  allowedHeadsFile?: string | undefined;
  expectedThreadsSha256?: string | undefined;
}

/**
 * The result of `verifyLedger`.
 */
export interface VerifyLedgerResult {
  actor: string;
  dispositions: number;
  verified: true;
}

/**
 * The report returned by `threadResolution`.
 */
export interface ThreadResolutionReport {
  verified: boolean;
  threadsVerified: number;
  resultStatus: SupportedStatus | null;
}

/**
 * The author identity GitHub returns on a comment.
 */
export interface GitHubCommentAuthor {
  login: string;
}

/**
 * One comment inside a review thread.
 */
export interface GitHubReviewCommentNode extends Record<string, unknown> {
  databaseId?: number | undefined;
  id?: number | undefined;
  body?: string | undefined;
  author?: GitHubCommentAuthor | undefined;
  user?: GitHubCommentAuthor | undefined;
  path?: string | undefined;
  line?: number | undefined;
  side?: string | undefined;
  commit_id?: string | undefined;
}

/**
 * One review thread, with its PR scope and full comment list.
 */
export interface GitHubReviewThreadNode {
  id: string;
  isResolved: boolean;
  repository?: { nameWithOwner?: string } | null | undefined;
  pullRequest?: { number?: number } | null | undefined;
  comments: {
    nodes: GitHubReviewCommentNode[];
    pageInfo: { hasNextPage: boolean; endCursor?: string | null | undefined };
  };
}

/**
 * The seam all GitHub and git access flows through.
 */
export interface GitHubRunner {
  runGh(args: string[], payload?: unknown): string;
  currentActor?(): string;
  gitCompare?(repo: string, before: string, after: string): unknown;
  gitRevList?(before: string, head: string): string[];
  runGit?(args: string[]): string;
  isAncestor?(ancestor: string, descendant: string): boolean;
}
