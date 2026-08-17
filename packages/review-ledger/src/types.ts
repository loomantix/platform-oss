/**
 * Protocol version for deterministic review ledger entries.
 */
export const PROTOCOL_VERSION = 3 as const;

/**
 *
 */
export type SupportedEngine = 'codex' | 'claude' | 'gemini' | 'antigravity';
/**
 *
 */
export type SupportedSeverity = 'blocking' | 'major' | 'minor' | 'nit';
/**
 *
 */
export type SupportedOutcome = 'fixed' | 'dismissed' | 'deferred';
/**
 *
 */
export type SupportedStatus = 'clean' | 'changed' | 'blocked';
/**
 *
 */
export type SupportedClassification = 'minor' | 'material';
/**
 *
 */
export type SupportedSide = 'RIGHT' | 'LEFT';

/**
 *
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
 *
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
 *
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
 *
 */
export interface FindingV1Match {
  engine: SupportedEngine;
  round: number;
  head: string;
  fingerprint: string;
}

/**
 *
 */
export interface DispositionV1Match {
  engine: SupportedEngine;
  round: number;
  head: string;
  fingerprint: string;
  outcome: SupportedOutcome;
}

/**
 *
 */
export interface PseudoV3Match {
  fingerprint: string;
  outcome?: 'deferred' | undefined;
}

/**
 *
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
 *
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
 *
 */
export interface WriteResultParams extends BaseResultParams {
  repo?: string | undefined;
  pr?: number | undefined;
  threadsFile?: string | undefined;
  allowedHeadsFile?: string | undefined;
  actor?: string | undefined;
  historicalCommentIdsFile?: string | undefined;
  classification?: SupportedClassification | undefined;
}

/**
 *
 */
export interface WriteBlockedParams extends BaseResultParams {
  blockerFile?: string | undefined;
  blocker?: string | undefined;
}

/**
 *
 */
export interface ValidateResultParams extends BaseResultParams {
  resultHead?: string | undefined;
}

/**
 *
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
 *
 */
export interface PreflightAnchorResult {
  anchor: string;
  path: string;
  verified: true;
}

/**
 *
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
 *
 */
export interface PostFindingResult {
  comment_id: number;
  verified: true;
  replayed?: boolean | undefined;
}

/**
 *
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
 *
 */
export interface ReopenOccurrenceResult {
  comment_id: number;
  replayed: boolean;
  thread_replayed: boolean;
  resolved: false;
  verified: true;
}

/**
 *
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
 *
 */
export interface DisposeResult {
  comment_id: number;
  replayed: boolean;
  thread_replayed: boolean;
  resolved: true;
  verified: true;
}

/**
 *
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
 *
 */
export interface PostPrCommentParams {
  repo: string;
  pr: number;
  head: string;
  bodyFile?: string | undefined;
  body?: string | undefined;
}

/**
 *
 */
export interface AttestParams extends BaseResultParams {
  repo: string;
  pr: number;
  threadsFile?: string | undefined;
  allowedHeadsFile?: string | undefined;
  actor?: string | undefined;
  historicalCommentIdsFile?: string | undefined;
  expectedResultSha256?: string | undefined;
  expectedThreadsSha256?: string | undefined;
  contentFile?: string | undefined;
  content?: string | undefined;
}

/**
 *
 */
export interface AttestResult {
  comment_id: number;
  replayed: boolean;
  result_sha256: string;
  verified: true;
}

/**
 *
 */
export interface ResolveParams {
  repo: string;
  pr: number;
  head: string;
  threadId: string;
}

/**
 *
 */
export interface ResolveResult {
  thread_id: string;
  resolved: true;
}

/**
 *
 */
export interface ReconcileParams {
  repo: string;
  pr: number;
  head: string;
  fingerprint: string;
}

/**
 *
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
  verified: true;
}

/**
 *
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
 *
 */
export interface VerifyLedgerResult {
  resultStatus: SupportedStatus | null;
  threadsVerified: number;
  verified: true;
}

/**
 *
 */
export interface ThreadResolutionReport {
  verified: boolean;
  threadsVerified: number;
  resultStatus: SupportedStatus | null;
}

/**
 *
 */
export interface GitHubCommentAuthor {
  login: string;
}

/**
 *
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
 *
 */
export interface GitHubReviewThreadNode {
  id: string;
  isResolved: boolean;
  comments: {
    nodes: GitHubReviewCommentNode[];
    pageInfo: { hasNextPage: boolean; endCursor?: string | null | undefined };
  };
}

/**
 *
 */
export interface GitHubRunner {
  runGh(args: string[], payload?: unknown): string;
  currentActor?(): string;
  gitCompare?(repo: string, before: string, after: string): unknown;
  gitRevList?(before: string, head: string): string[];
}
