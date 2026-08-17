import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { fail, LedgerError } from './errors.js';
import { matchFinding, matchProtocol, matchPseudoV3 } from './protocol.js';
import { FINDING_V3_RE, PSEUDO_V3_RE, SHA_RE } from './constants.js';
import { requireToken } from './hash.js';
import type {
  GitHubReviewCommentNode,
  GitHubReviewThreadNode,
  GitHubRunner,
} from './types.js';

let defaultActor: string | null = null;

/**
 *
 */
export class DefaultGitHubRunner implements GitHubRunner {
  private actor: string | null = null;

  constructor(customActor?: string) {
    if (customActor) {
      this.actor = requireToken(customActor, 'actor');
    }
  }

  setActor(actor: string | null): void {
    this.actor = actor ? requireToken(actor, 'actor') : null;
  }

  runGh(args: string[], payload?: unknown): string {
    const command = 'gh';
    const finalArgs = [...args];
    let input: string | undefined;
    if (payload !== undefined) {
      finalArgs.push('--input', '-');
      input = JSON.stringify(payload);
    }
    try {
      const stdout = execFileSync(command, finalArgs, {
        input,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return stdout;
    } catch (error: unknown) {
      const execError = error as { stderr?: string; message?: string };
      const detail = execError.stderr?.trim() || 'no diagnostic returned';
      fail(`GitHub operation failed: ${detail}`);
    }
  }

  currentActor(): string {
    if (this.actor !== null) {
      return this.actor;
    }
    const output = this.runGh(['api', 'user', '--jq', '.login']).trim();
    if (!output) {
      fail('could not resolve the authenticated GitHub actor');
    }
    this.actor = output;
    return this.actor;
  }

  gitCompare(repo: string, before: string, after: string): unknown {
    const raw = this.runGh([
      'api',
      `repos/${repo}/compare/${before}...${after}`,
    ]);
    try {
      return JSON.parse(raw);
    } catch (error) {
      throw new LedgerError('GitHub returned invalid JSON', { cause: error });
    }
  }

  gitRevList(before: string, head: string): string[] {
    try {
      const stdout = execFileSync(
        'git',
        ['rev-list', '--reverse', '--ancestry-path', `${before}..${head}`],
        { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
      );
      return stdout.trim().split(/\r?\n/).filter(Boolean);
    } catch {
      fail('could not derive the forward review transition');
    }
  }
}

let activeRunner: GitHubRunner = new DefaultGitHubRunner();

/**
 *
 */
export function getGitHubRunner(): GitHubRunner {
  return activeRunner;
}

/**
 *
 */
export function setGitHubRunner(runner: GitHubRunner): void {
  activeRunner = runner;
}

/**
 *
 */
export function resetGitHubRunner(actor?: string): void {
  defaultActor = actor ?? null;
  activeRunner = new DefaultGitHubRunner(actor);
}

/**
 *
 */
export function runGh(args: string[], payload?: unknown): string {
  return activeRunner.runGh(args, payload);
}

/**
 *
 */
export function jsonOutput<T = unknown>(args: string[], payload?: unknown): T {
  const raw = runGh(args, payload);
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    throw new LedgerError('GitHub returned invalid JSON', { cause: error });
  }
}

/**
 *
 */
export function currentActor(): string {
  if (activeRunner.currentActor) {
    return activeRunner.currentActor();
  }
  if (defaultActor === null) {
    const actor = runGh(['api', 'user', '--jq', '.login']).trim();
    if (!actor) {
      fail('could not resolve the authenticated GitHub actor');
    }
    defaultActor = actor;
  }
  return defaultActor;
}

/**
 *
 */
export function setCurrentActor(actor: string | null): void {
  defaultActor = actor ? requireToken(actor, 'actor') : null;
  if (activeRunner instanceof DefaultGitHubRunner) {
    activeRunner.setActor(defaultActor);
  }
}

/**
 *
 */
export function authenticatedRows<T extends Record<string, unknown>>(
  rows: T[],
  options?: { graphql?: boolean },
): T[] {
  const actor = currentActor();
  return rows.filter((row) => {
    const user = row['user'] as { login?: string } | undefined;
    const author = row['author'] as { login?: string } | undefined;
    const identity = options?.graphql ? (author ?? user) : (user ?? author);
    return (
      typeof identity === 'object' &&
      identity !== null &&
      identity.login === actor
    );
  });
}

/**
 *
 */
export function verifyHead(
  repo: string,
  pr: number,
  expectedHead: string,
): void {
  const actual = runGh([
    'pr',
    'view',
    String(pr),
    '--repo',
    repo,
    '--json',
    'headRefOid',
    '--jq',
    '.headRefOid',
  ]).trim();
  if (actual !== expectedHead) {
    fail(
      `PR head mismatch: expected ${expectedHead}, found ${actual || '<empty>'}`,
    );
  }
}

function flattenPages<T>(value: unknown, label: string): T[] {
  if (!Array.isArray(value)) {
    fail(`GitHub ${label} response has an unexpected shape`);
  }
  const rows: T[] = [];
  for (const page of value) {
    if (!Array.isArray(page)) {
      fail(`GitHub ${label} page has an unexpected shape`);
    }
    for (const item of page) {
      if (typeof item !== 'object' || item === null) {
        fail(`GitHub ${label} item has an unexpected shape`);
      }
      rows.push(item as T);
    }
  }
  return rows;
}

/**
 *
 */
export function getPrFiles(
  repo: string,
  pr: number,
): Record<string, string | null> {
  const pages = jsonOutput<unknown[]>([
    'api',
    '--paginate',
    '--slurp',
    `repos/${repo}/pulls/${pr}/files?per_page=100`,
  ]);
  const rows = flattenPages<{ filename?: unknown; patch?: unknown }>(
    pages,
    'PR-files',
  );
  const files: Record<string, string | null> = {};
  for (const item of rows) {
    if (typeof item.filename !== 'string') {
      fail('GitHub PR-files item has an unexpected shape');
    }
    files[item.filename] = typeof item.patch === 'string' ? item.patch : null;
  }
  return files;
}

/**
 *
 */
export function getReviewComments(
  repo: string,
  pr: number,
): GitHubReviewCommentNode[] {
  const pages = jsonOutput<unknown[]>([
    'api',
    '--paginate',
    '--slurp',
    `repos/${repo}/pulls/${pr}/comments?per_page=100`,
  ]);
  const rows = flattenPages<GitHubReviewCommentNode>(pages, 'review-comments');
  return authenticatedRows(rows);
}

/**
 *
 */
export function getIssueComments(
  repo: string,
  pr: number,
): Array<Record<string, unknown>> {
  const pages = jsonOutput<unknown[]>([
    'api',
    '--paginate',
    '--slurp',
    `repos/${repo}/issues/${pr}/comments?per_page=100`,
  ]);
  const rows = flattenPages<Record<string, unknown>>(pages, 'PR-comments');
  return authenticatedRows(rows);
}

/**
 *
 */
export function verifyComment(
  repo: string,
  commentId: number,
  expectedBody: string,
): void {
  const response = jsonOutput<Record<string, unknown>>([
    'api',
    `repos/${repo}/pulls/comments/${commentId}`,
  ]);
  const user = (response['user'] ?? response['author']) as
    | { login?: string }
    | undefined;
  if (
    typeof response !== 'object' ||
    response === null ||
    response['body'] !== expectedBody ||
    typeof user !== 'object' ||
    user === null ||
    user.login !== currentActor()
  ) {
    fail(`could not verify review comment ${commentId} after posting`);
  }
}

/**
 *
 */
export function verifyIssueComment(
  repo: string,
  commentId: number,
  expectedBody: string,
): void {
  const response = jsonOutput<Record<string, unknown>>([
    'api',
    `repos/${repo}/issues/comments/${commentId}`,
  ]);
  const user = (response['user'] ?? response['author']) as
    | { login?: string }
    | undefined;
  if (
    typeof response !== 'object' ||
    response === null ||
    response['body'] !== expectedBody ||
    typeof user !== 'object' ||
    user === null ||
    user.login !== currentActor()
  ) {
    fail(`could not verify PR comment ${commentId} after posting`);
  }
}

/**
 *
 */
export function getPostedCommentId(response: unknown): number {
  if (
    typeof response !== 'object' ||
    response === null ||
    typeof (response as { id?: unknown }).id !== 'number'
  ) {
    fail('GitHub accepted the mutation but returned no comment ID');
  }
  return (response as { id: number }).id;
}

/**
 *
 */
export function findMatchingBody(
  rows: Array<Record<string, unknown>>,
  marker: string,
  body: string,
): number | null {
  const matches = rows.filter((row) =>
    String(row['body'] ?? '').includes(marker),
  );
  if (matches.length === 0) {
    return null;
  }
  if (matches.length !== 1) {
    fail('ledger idempotency key is duplicated');
  }
  const row = matches[0]!;
  if (row['body'] !== body || typeof row['id'] !== 'number') {
    fail('ledger idempotency key already exists with conflicting content');
  }
  return row['id'] as number;
}

/**
 *
 */
export function postReviewComment(
  repo: string,
  pr: number,
  head: string,
  marker: string,
  body: string,
  options: {
    path?: string | undefined;
    line?: number | undefined;
    side?: string | undefined;
    fileLevel?: boolean | undefined;
    replyTo?: number | undefined;
  },
): { commentId: number; replayed: boolean } {
  const existing = findMatchingBody(
    getReviewComments(repo, pr) as unknown as Array<Record<string, unknown>>,
    marker,
    body,
  );
  if (existing !== null) {
    verifyComment(repo, existing, body);
    verifyHead(repo, pr, head);
    return { commentId: existing, replayed: true };
  }

  let endpoint: string;
  let payload: Record<string, unknown>;
  if (options.replyTo === undefined) {
    payload = { body, commit_id: head, path: options.path };
    if (options.fileLevel) {
      payload['subject_type'] = 'file';
    } else {
      payload['line'] = options.line;
      payload['side'] = options.side;
    }
    endpoint = `repos/${repo}/pulls/${pr}/comments`;
  } else {
    payload = { body };
    endpoint = `repos/${repo}/pulls/${pr}/comments/${options.replyTo}/replies`;
  }

  let replayed = false;
  let commentId: number;
  try {
    const response = jsonOutput(['api', '-X', 'POST', endpoint], payload);
    commentId = getPostedCommentId(response);
  } catch (error) {
    if (error instanceof LedgerError) {
      const recovered = findMatchingBody(
        getReviewComments(repo, pr) as unknown as Array<
          Record<string, unknown>
        >,
        marker,
        body,
      );
      if (recovered === null) {
        throw error;
      }
      commentId = recovered;
      replayed = true;
    } else {
      throw error;
    }
  }

  verifyComment(repo, commentId, body);
  verifyHead(repo, pr, head);
  return { commentId, replayed };
}

/**
 *
 */
export function getThreadState(threadId: string, commentId?: number): boolean {
  const query = `
query($threadId: ID!) {
  node(id: $threadId) {
    ... on PullRequestReviewThread {
      id
      isResolved
      comments(first: 100) {
        nodes { databaseId }
        pageInfo { hasNextPage }
      }
    }
  }
}
`.trim();

  const response = jsonOutput<{ data?: { node?: unknown } }>(
    ['api', 'graphql'],
    { query, variables: { threadId } },
  );

  const thread = response?.data?.node as
    | {
        id?: unknown;
        isResolved?: unknown;
        comments?: {
          nodes?: Array<{ databaseId?: unknown }>;
          pageInfo?: { hasNextPage?: unknown };
        };
      }
    | undefined;

  if (typeof thread !== 'object' || thread === null || thread.id !== threadId) {
    fail(`could not verify review thread ${threadId}`);
  }
  if (typeof thread.isResolved !== 'boolean') {
    fail(`review thread ${threadId} has invalid resolution state`);
  }

  if (commentId !== undefined) {
    const comments = thread.comments;
    if (typeof comments !== 'object' || comments === null) {
      fail('review thread read-back omitted comments');
    }
    const pageInfo = comments.pageInfo;
    const nodes = comments.nodes;
    if (
      typeof pageInfo !== 'object' ||
      pageInfo === null ||
      pageInfo.hasNextPage !== false ||
      !Array.isArray(nodes)
    ) {
      fail('review thread comments are incomplete');
    }
    const ids = nodes.map((node) => node.databaseId);
    if (!ids.includes(commentId)) {
      fail('--comment-id does not belong to --thread-id');
    }
  }

  return thread.isResolved;
}

/**
 *
 */
export function setThreadState(
  threadId: string,
  resolved: boolean,
  commentId?: number,
): boolean {
  if (getThreadState(threadId, commentId) === resolved) {
    return true;
  }
  const field = resolved ? 'resolveReviewThread' : 'unresolveReviewThread';
  const mutation = `
mutation($threadId: ID!) {
  ${field}(input: {threadId: $threadId}) {
    thread { id isResolved }
  }
}
`.trim();

  try {
    const response = jsonOutput<
      Record<
        string,
        Record<string, { thread?: { id?: unknown; isResolved?: unknown } }>
      >
    >(['api', 'graphql'], { query: mutation, variables: { threadId } });
    const thread = response?.['data']?.[field]?.['thread'];
    if (typeof thread !== 'object' || thread === null) {
      fail('GitHub returned an invalid thread mutation response');
    }
    if (thread.id !== threadId || thread.isResolved !== resolved) {
      fail(`GitHub did not set review thread ${threadId} resolved=${resolved}`);
    }
  } catch (error: unknown) {
    let verifiedAfterError = false;
    try {
      if (getThreadState(threadId, commentId) === resolved) {
        verifiedAfterError = true;
      }
    } catch {
      // ignore
    }
    if (verifiedAfterError) {
      return false;
    }
    if (error instanceof LedgerError) {
      throw error;
    }
    throw new LedgerError(
      'GitHub returned an invalid thread mutation response',
      { cause: error },
    );
  }

  let verified: boolean;
  try {
    verified = getThreadState(threadId, commentId);
  } catch (error) {
    verified = getThreadState(threadId, commentId);
  }
  if (verified !== resolved) {
    fail(`could not verify review thread ${threadId} resolved=${resolved}`);
  }
  return false;
}

/**
 *
 */
export function loadReviewThreads(pathValue: string): GitHubReviewThreadNode[] {
  try {
    const stat = lstatSync(pathValue);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      fail('review threads must be a regular non-symlink file');
    }
  } catch (err) {
    if (err instanceof LedgerError) throw err;
    fail('review threads must be a regular non-symlink file');
  }

  let pages: unknown;
  try {
    pages = JSON.parse(readFileSync(pathValue, 'utf8'));
  } catch (error) {
    throw new LedgerError('review threads must contain valid UTF-8 JSON', {
      cause: error,
    });
  }

  if (!Array.isArray(pages) || pages.length === 0) {
    fail('review threads response has an unexpected shape');
  }

  const threads: GitHubReviewThreadNode[] = [];
  for (const page of pages as Array<{
    errors?: unknown;
    data?: {
      repository?: {
        pullRequest?: {
          reviewThreads?: {
            nodes?: unknown;
            pageInfo?: { hasNextPage?: unknown };
          };
        };
      };
    };
  }>) {
    if (typeof page !== 'object' || page === null || page.errors) {
      fail('GitHub review threads response contains errors');
    }
    const connection = page.data?.repository?.pullRequest?.reviewThreads;
    if (
      !connection ||
      !Array.isArray(connection.nodes) ||
      typeof connection.pageInfo !== 'object' ||
      typeof connection.pageInfo.hasNextPage !== 'boolean'
    ) {
      fail('GitHub review threads response has an unexpected shape');
    }
    for (const thread of connection.nodes as Array<{
      comments?: { nodes?: unknown; pageInfo?: { hasNextPage?: unknown } };
    }>) {
      if (typeof thread !== 'object' || thread === null) {
        fail('GitHub review thread has an unexpected shape');
      }
      const comments = thread.comments;
      if (
        !comments ||
        !Array.isArray(comments.nodes) ||
        typeof comments.pageInfo !== 'object' ||
        comments.pageInfo.hasNextPage !== false
      ) {
        fail('GitHub review thread comments are incomplete');
      }
      threads.push(thread as unknown as GitHubReviewThreadNode);
    }
  }

  const lastPage = pages[pages.length - 1] as {
    data?: {
      repository?: {
        pullRequest?: {
          reviewThreads?: { pageInfo?: { hasNextPage?: unknown } };
        };
      };
    };
  };
  if (
    lastPage?.data?.repository?.pullRequest?.reviewThreads?.pageInfo
      ?.hasNextPage !== false
  ) {
    fail('GitHub review thread pages are incomplete');
  }

  return threads;
}

/**
 *
 */
export function fetchReviewThreads(
  repo: string,
  pr: number,
): GitHubReviewThreadNode[] {
  const parts = repo.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    fail('--repo must be OWNER/REPO');
  }
  const [owner, name] = parts;
  const query = `
query($owner:String!, $name:String!, $number:Int!, $endCursor:String) {
  repository(owner:$owner, name:$name) {
    pullRequest(number:$number) {
      reviewThreads(first:100, after:$endCursor) {
        nodes {
          id
          isResolved
          comments(first:100) {
            nodes { databaseId body author { login } }
            pageInfo { hasNextPage }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}
`.trim();

  const pages = jsonOutput<unknown[]>([
    'api',
    'graphql',
    '--paginate',
    '--slurp',
    '-f',
    `query=${query}`,
    '-f',
    `owner=${owner}`,
    '-f',
    `name=${name}`,
    '-F',
    `number=${pr}`,
  ]);

  if (!Array.isArray(pages) || pages.length === 0) {
    fail('GitHub review-thread response has an unexpected shape');
  }

  const threads: GitHubReviewThreadNode[] = [];
  for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
    const page = pages[pageIndex] as {
      errors?: unknown;
      data?: {
        repository?: {
          pullRequest?: {
            reviewThreads?: {
              nodes?: unknown;
              pageInfo?: { hasNextPage?: unknown; endCursor?: unknown };
            };
          };
        };
      };
    };

    if (typeof page !== 'object' || page === null || page.errors) {
      fail('GitHub review-thread response is incomplete');
    }

    const connection = page.data?.repository?.pullRequest?.reviewThreads;
    const nodes = connection?.nodes;
    const pageInfo = connection?.pageInfo;

    if (
      !Array.isArray(nodes) ||
      typeof pageInfo !== 'object' ||
      pageInfo === null
    ) {
      fail('GitHub review-thread nodes have an unexpected shape');
    }

    const expectedMore = pageIndex < pages.length - 1;
    if (pageInfo.hasNextPage !== expectedMore) {
      fail('GitHub review-thread pagination is incomplete');
    }
    if (expectedMore && typeof pageInfo.endCursor !== 'string') {
      fail('GitHub review-thread pagination omitted its cursor');
    }

    for (const thread of nodes as Array<{
      comments?: { nodes?: unknown; pageInfo?: { hasNextPage?: unknown } };
    }>) {
      if (typeof thread !== 'object' || thread === null) {
        fail('GitHub review thread has an unexpected shape');
      }
      const comments = thread.comments;
      if (
        typeof comments !== 'object' ||
        comments === null ||
        !Array.isArray(comments.nodes) ||
        typeof comments.pageInfo !== 'object' ||
        comments.pageInfo.hasNextPage !== false
      ) {
        fail('GitHub review-thread comments are incomplete');
      }
      threads.push(thread as unknown as GitHubReviewThreadNode);
    }
  }

  return threads;
}

/**
 *
 */
export function loadHistoricalCommentIds(pathValue?: string): Set<number> {
  const finalPath =
    pathValue || process.env['AGENT_LOOP_REVIEW_HISTORICAL_COMMENT_IDS_FILE'];
  if (!finalPath) {
    return new Set();
  }
  try {
    const stat = lstatSync(finalPath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      fail('historical comment IDs must be a regular non-symlink file');
    }
  } catch (err) {
    if (err instanceof LedgerError) throw err;
    fail('historical comment IDs must be a regular non-symlink file');
  }

  let values: unknown;
  try {
    values = JSON.parse(readFileSync(finalPath, 'utf8'));
  } catch (error) {
    throw new LedgerError(
      'historical comment IDs must contain valid UTF-8 JSON',
      { cause: error },
    );
  }

  if (
    !Array.isArray(values) ||
    values.some(
      (v) => typeof v !== 'number' || !Number.isInteger(v) || v < 1,
    ) ||
    new Set(values).size !== values.length
  ) {
    fail('historical comment IDs must be unique positive integers');
  }

  return new Set(values as number[]);
}

/**
 *
 */
export function verifyPseudoV3History(
  threads: GitHubReviewThreadNode[],
  historicalCommentIds?: Set<number>,
): void {
  const actor = currentActor();
  for (const thread of threads) {
    const comments = thread.comments;
    if (
      !comments ||
      !Array.isArray(comments.nodes) ||
      !comments.pageInfo ||
      comments.pageInfo.hasNextPage !== false
    ) {
      fail('GitHub review thread comments are incomplete');
    }
    const nodes = comments.nodes;
    for (let index = 0; index < nodes.length; index++) {
      const row = nodes[index]!;
      const body = String(row.body ?? '');
      const author = row.author;
      if (!author || typeof author.login !== 'string') {
        if (body.includes('<!-- local-review')) {
          fail('could not establish local-review comment ownership');
        }
        continue;
      }
      if (author.login !== actor) {
        continue;
      }
      if (!body.includes('<!-- local-review:v3')) {
        continue;
      }
      const pseudo = matchPseudoV3(body);
      if (pseudo === null) {
        matchProtocol(body, FINDING_V3_RE, '<!-- local-review:v3');
        continue;
      }
      if (
        historicalCommentIds &&
        row.databaseId !== undefined &&
        !historicalCommentIds.has(row.databaseId)
      ) {
        fail(
          'historical local-review:v3 finding was not captured before the current pass',
        );
      }
      const laterSameActor = nodes.slice(index + 1).some((reply) => {
        const replyAuthor = reply.author;
        const replyBody = String(reply.body ?? '').trim();
        return (
          replyAuthor &&
          replyAuthor.login === actor &&
          Boolean(replyBody) &&
          !replyBody.includes('<!-- local-review')
        );
      });
      if (
        index !== 0 ||
        typeof thread.id !== 'string' ||
        thread.isResolved !== true ||
        !laterSameActor
      ) {
        fail(
          'historical local-review:v3 finding is not settled actor-owned history',
        );
      }
    }
  }
}

/**
 *
 */
export function loadAllowedHeads(
  path: string,
  before: string,
  afterSha: string,
  repo: string,
): Record<string, number> {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      fail('allowed transition heads must be a regular non-symlink file');
    }
  } catch (err) {
    if (err instanceof LedgerError) throw err;
    fail('allowed transition heads must be a regular non-symlink file');
  }

  let values: unknown;
  try {
    values = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new LedgerError(
      'allowed transition heads must contain valid UTF-8 JSON',
      { cause: error },
    );
  }

  if (
    !Array.isArray(values) ||
    values.length === 0 ||
    values.some((v) => typeof v !== 'string' || !SHA_RE.test(v)) ||
    new Set(values).size !== values.length ||
    values[0] !== before ||
    values[values.length - 1] !== afterSha
  ) {
    fail(
      'allowed transition heads do not match the observed review transition',
    );
  }

  const headList = values as string[];
  for (let i = 0; i < headList.length - 1; i++) {
    const cur = headList[i]!;
    const nxt = headList[i + 1]!;
    const comparison = activeRunner.gitCompare
      ? (activeRunner.gitCompare(repo, cur, nxt) as Record<string, unknown>)
      : jsonOutput<Record<string, unknown>>([
          'api',
          `repos/${repo}/compare/${cur}...${nxt}`,
        ]);
    const mergeBase = comparison?.['merge_base_commit'] as
      | { sha?: string }
      | undefined;
    if (
      typeof comparison !== 'object' ||
      comparison === null ||
      comparison['status'] !== 'ahead' ||
      typeof mergeBase !== 'object' ||
      mergeBase === null ||
      mergeBase.sha !== cur
    ) {
      fail('allowed transition heads are not forward-only');
    }
  }

  const allowed: Record<string, number> = {};
  headList.forEach((val, idx) => {
    allowed[val] = idx;
  });
  return allowed;
}

/**
 *
 */
export function rowsHavePseudoV3(rows: Array<{ body?: unknown }>): boolean {
  return rows.some((row) => PSEUDO_V3_RE.test(String(row.body ?? '')));
}
