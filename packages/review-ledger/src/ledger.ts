import { execFileSync } from 'node:child_process';
import {
  DISPOSITION_V1,
  DISPOSITION_V1_RE,
  FINDING_V1,
  FINDING_V1_RE,
  PR_V1_MARKERS,
  PROTOCOL_VERSION,
} from './constants.js';
import { fail, LedgerError } from './errors.js';
import {
  currentActor,
  fetchReviewThreads,
  findMatchingBody,
  getGitHubRunner,
  getIssueComments,
  getPostedCommentId,
  getPrFiles,
  getReviewComments,
  jsonOutput,
  loadAllowedHeads,
  loadHistoricalCommentIds,
  loadReviewThreads,
  postReviewComment,
  rowsHavePseudoV3,
  setThreadState,
  verifyComment,
  verifyHead,
  verifyIssueComment,
  verifyPseudoV3History,
} from './github.js';
import { sha256Bytes, sha256Text } from './hash.js';
import { validateAnchor } from './diff.js';
import {
  buildDispositionBody,
  buildFindingBody,
  matchDisposition,
  matchFinding,
  matchPseudoV3,
  readContent,
  readLegacyBody,
  validateContentString,
} from './protocol.js';
import {
  readResultBytes,
  resultHead,
  validateResultData,
  writeResultFile,
} from './result.js';
import type {
  AttestParams,
  AttestResult,
  DisposeParams,
  DisposeResult,
  DispositionV1Match,
  DispositionV3Match,
  FindingV1Match,
  FindingV3Match,
  GitHubReviewCommentNode,
  GitHubReviewThreadNode,
  LedgerResult,
  PostFindingParams,
  PostFindingResult,
  PostPrCommentParams,
  PreflightAnchorParams,
  PreflightAnchorResult,
  ReconcileParams,
  ReconcileResult,
  ReopenOccurrenceParams,
  ReopenOccurrenceResult,
  ReplyParams,
  ResolveParams,
  ResolveResult,
  SupportedEngine,
  VerifyLedgerParams,
  VerifyLedgerResult,
  WriteResultParams,
} from './types.js';

/**
 *
 */
export function threadProtocolRecords(
  thread: GitHubReviewThreadNode,
  historicalCommentIds?: Set<number>,
): {
  findingsV3: Array<[number, FindingV3Match]>;
  dispositionsV3: Array<[number, DispositionV3Match]>;
  findingsV1: Array<[number, FindingV1Match]>;
  dispositionsV1: Array<[number, DispositionV1Match]>;
} {
  verifyPseudoV3History([thread], historicalCommentIds);
  const comments = thread.comments.nodes;
  const actor = currentActor();

  const findingsV3: Array<[number, FindingV3Match]> = [];
  const dispositionsV3: Array<[number, DispositionV3Match]> = [];
  const findingsV1: Array<[number, FindingV1Match]> = [];
  const dispositionsV1: Array<[number, DispositionV1Match]> = [];

  for (let index = 0; index < comments.length; index++) {
    const row = comments[index]!;
    const body = String(row.body ?? '');
    const author = row.author ?? row.user;
    if (!author || author.login !== actor) {
      continue;
    }
    if (matchPseudoV3(body) !== null) {
      continue;
    }
    const findingV3 = matchFinding(body);
    const dispositionV3 = matchDisposition(body);
    if (findingV3 !== null) {
      findingsV3.push([index, findingV3]);
    }
    if (dispositionV3 !== null) {
      dispositionsV3.push([index, dispositionV3]);
    }
    const findingV1 = FINDING_V1_RE.exec(body);
    const dispositionV1 = DISPOSITION_V1_RE.exec(body);
    if (findingV1?.groups) {
      findingsV1.push([
        index,
        {
          engine: findingV1.groups['engine'] as SupportedEngine,
          round: parseInt(findingV1.groups['round']!, 10),
          head: findingV1.groups['head']!,
          fingerprint: findingV1.groups['fingerprint']!,
        },
      ]);
    }
    if (dispositionV1?.groups) {
      dispositionsV1.push([
        index,
        {
          engine: dispositionV1.groups['engine'] as SupportedEngine,
          round: parseInt(dispositionV1.groups['round']!, 10),
          head: dispositionV1.groups['head']!,
          fingerprint: dispositionV1.groups['fingerprint']!,
          outcome: dispositionV1.groups['outcome'] as
            | 'fixed'
            | 'dismissed'
            | 'deferred',
        },
      ]);
    }
  }

  return { findingsV3, dispositionsV3, findingsV1, dispositionsV1 };
}

/**
 *
 */
export function matchingDispositions<
  T extends FindingV3Match | FindingV1Match,
  D extends DispositionV3Match | DispositionV1Match,
>(
  findingIndex: number,
  finding: T,
  dispositions: Array<[number, D]>,
  expectedHead?: string,
): D[] {
  return dispositions
    .filter(([index, disposition]) => {
      if (index <= findingIndex) return false;
      if (disposition.engine !== finding.engine) return false;
      if (disposition.round !== finding.round) return false;
      if (disposition.fingerprint !== finding.fingerprint) return false;
      if ('occurrence' in finding && 'occurrence' in disposition) {
        if (finding.occurrence !== disposition.occurrence) return false;
      }
      if (expectedHead !== undefined && disposition.head !== expectedHead) {
        return false;
      }
      return true;
    })
    .map(([, disposition]) => disposition);
}

/**
 *
 */
export function verifyForwardTransition(
  repo: string,
  before: string,
  after: string,
): void {
  if (before === after) {
    fail('superseding fixed occurrence is not a forward transition');
  }
  const runner = getGitHubRunner();
  const comparison = runner.gitCompare
    ? (runner.gitCompare(repo, before, after) as Record<string, unknown>)
    : jsonOutput<Record<string, unknown>>([
        'api',
        `repos/${repo}/compare/${before}...${after}`,
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
    mergeBase.sha !== before
  ) {
    fail('superseding local-review occurrence is not forward-only');
  }
}

/**
 *
 */
export function verifyThreadDispositions(
  threads: GitHubReviewThreadNode[],
  historicalCommentIds?: Set<number>,
  options?: { repo?: string | undefined },
): number {
  let verified = 0;
  const fingerprintThreads = new Map<string, number>();

  for (let threadIndex = 0; threadIndex < threads.length; threadIndex++) {
    const thread = threads[threadIndex]!;
    const { findingsV3, dispositionsV3, findingsV1, dispositionsV1 } =
      threadProtocolRecords(thread, historicalCommentIds);

    const groupedV3 = new Map<string, Array<[number, FindingV3Match]>>();
    for (const [findingIndex, finding] of findingsV3) {
      const fingerprint = finding.fingerprint;
      const priorThread = fingerprintThreads.get(fingerprint);
      if (priorThread !== undefined && priorThread !== threadIndex) {
        fail('local-review fingerprint has duplicated root threads');
      }
      fingerprintThreads.set(fingerprint, threadIndex);
      const list = groupedV3.get(fingerprint) ?? [];
      list.push([findingIndex, finding]);
      groupedV3.set(fingerprint, list);
    }

    for (const [fingerprint, occurrences] of groupedV3.entries()) {
      const numbers = occurrences.map(([, finding]) => finding.occurrence);
      const expectedNumbers = Array.from(
        { length: numbers.length },
        (_, i) => i + 1,
      );
      const isSequential =
        numbers.length === expectedNumbers.length &&
        numbers.every((v, i) => v === expectedNumbers[i]);
      if (!isSequential) {
        fail(
          `local-review fingerprint ${fingerprint} occurrences are not sequential`,
        );
      }

      for (let position = 0; position < occurrences.length - 1; position++) {
        const [findingIndex, finding] = occurrences[position]!;
        const matches = dispositionsV3.filter(
          ([index, disposition]) =>
            index > findingIndex &&
            disposition.engine === finding.engine &&
            disposition.round === finding.round &&
            disposition.fingerprint === finding.fingerprint &&
            disposition.occurrence === finding.occurrence,
        );
        const nextFindingIndex = occurrences[position + 1]![0];
        if (matches.length !== 1 || matches[0]![0] >= nextFindingIndex) {
          fail(
            `local-review fingerprint ${fingerprint} recurrence is not sequentially disposed`,
          );
        }
      }

      const matchedOccurrences: Array<[FindingV3Match, DispositionV3Match]> =
        [];
      for (const [findingIndex, finding] of occurrences) {
        const occurrenceMatches = matchingDispositions(
          findingIndex,
          finding,
          dispositionsV3,
        );
        if (occurrenceMatches.length !== 1) {
          fail('local-review finding lacks exactly one matching disposition');
        }
        matchedOccurrences.push([finding, occurrenceMatches[0]!]);
      }

      const [, latestDisposition] =
        matchedOccurrences[matchedOccurrences.length - 1]!;
      const [latestFinding] =
        matchedOccurrences[matchedOccurrences.length - 1]!;
      if (
        latestFinding.severity === 'blocking' &&
        latestDisposition.outcome !== 'fixed'
      ) {
        fail('blocking local-review findings must be fixed');
      }

      const priorUnfixedBlockers: number[] = [];
      for (let pos = 0; pos < matchedOccurrences.length - 1; pos++) {
        const [f, d] = matchedOccurrences[pos]!;
        if (f.severity === 'blocking' && d.outcome !== 'fixed') {
          priorUnfixedBlockers.push(pos);
        }
      }

      if (priorUnfixedBlockers.length > 0) {
        if (latestDisposition.outcome !== 'fixed') {
          fail(
            'an unfixed blocker must be cleared by a later fixed occurrence',
          );
        }
        if (options?.repo) {
          const start = priorUnfixedBlockers[priorUnfixedBlockers.length - 1]!;
          for (let i = start; i < matchedOccurrences.length - 1; i++) {
            verifyForwardTransition(
              options.repo,
              matchedOccurrences[i]![1].head,
              matchedOccurrences[i + 1]![0].head,
            );
          }
          verifyForwardTransition(
            options.repo,
            latestFinding.head,
            latestDisposition.head,
          );
        }
      }
    }

    const allFindings: Array<
      [
        number,
        FindingV3Match | FindingV1Match,
        Array<[number, DispositionV3Match | DispositionV1Match]>,
      ]
    > = [
      ...findingsV3.map(
        ([idx, f]) =>
          [idx, f, dispositionsV3] as [
            number,
            FindingV3Match,
            Array<[number, DispositionV3Match]>,
          ],
      ),
      ...findingsV1.map(
        ([idx, f]) =>
          [idx, f, dispositionsV1] as [
            number,
            FindingV1Match,
            Array<[number, DispositionV1Match]>,
          ],
      ),
    ];

    if (allFindings.length === 0) {
      continue;
    }
    if (thread.isResolved !== true) {
      fail('local-review thread is not resolved');
    }

    for (const [findingIndex, finding, disps] of allFindings) {
      const findingMatches = matchingDispositions(findingIndex, finding, disps);
      if (findingMatches.length !== 1) {
        fail('local-review finding lacks exactly one matching disposition');
      }
    }

    verified += 1;
  }

  return verified;
}

/**
 *
 */
export function sameRoundDispositions(
  args: { engine: SupportedEngine; round: number; repo?: string | undefined },
  threads: GitHubReviewThreadNode[],
  allowedHeads: Record<string, number>,
  historicalCommentIds?: Set<number>,
): Array<[string, boolean, boolean, boolean]> {
  const evidence = new Map<string, [boolean, boolean, boolean]>();
  const fingerprintThreads = new Map<string, number>();

  for (let threadIndex = 0; threadIndex < threads.length; threadIndex++) {
    const thread = threads[threadIndex]!;
    const { findingsV3, dispositionsV3 } = threadProtocolRecords(
      thread,
      historicalCommentIds,
    );

    for (const [findingIndex, finding] of findingsV3) {
      if (finding.engine !== args.engine || finding.round !== args.round) {
        continue;
      }
      const fingerprint = finding.fingerprint;
      const findingHead = finding.head;
      const priorThread = fingerprintThreads.get(fingerprint);
      if (priorThread !== undefined && priorThread !== threadIndex) {
        fail('same-round finding fingerprint has duplicate root threads');
      }
      fingerprintThreads.set(fingerprint, threadIndex);

      if (!(findingHead in allowedHeads)) {
        const historicalMatches = matchingDispositions(
          findingIndex,
          finding,
          dispositionsV3,
        );
        if (thread.isResolved !== true || historicalMatches.length !== 1) {
          fail(
            'same-round finding outside the observed transition is not settled',
          );
        }
        if (
          finding.severity === 'blocking' &&
          historicalMatches[0]!.outcome !== 'fixed'
        ) {
          fail('blocking local-review findings must be fixed');
        }
        const historicalDisposition = historicalMatches[0]!;
        if (historicalDisposition.outcome === 'fixed') {
          const dispositionHead = historicalDisposition.head;
          if (dispositionHead === findingHead || !args.repo) {
            fail('historical fixed disposition is not a forward transition');
          }
          const runner = getGitHubRunner();
          const comparison = runner.gitCompare
            ? (runner.gitCompare(
                args.repo,
                findingHead,
                dispositionHead,
              ) as Record<string, unknown>)
            : jsonOutput<Record<string, unknown>>([
                'api',
                `repos/${args.repo}/compare/${findingHead}...${dispositionHead}`,
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
            mergeBase.sha !== findingHead
          ) {
            fail('historical fixed disposition is not a forward transition');
          }
        }
        continue;
      }

      const matches = dispositionsV3
        .filter(([index, disposition]) => {
          if (index <= findingIndex) return false;
          if (disposition.engine !== finding.engine) return false;
          if (disposition.round !== finding.round) return false;
          if (disposition.fingerprint !== finding.fingerprint) return false;
          if (disposition.occurrence !== finding.occurrence) return false;
          if (!(disposition.head in allowedHeads)) return false;
          const dispRank = allowedHeads[disposition.head]!;
          const findRank = allowedHeads[findingHead]!;
          if (dispRank < findRank) return false;
          if (disposition.outcome === 'fixed' && dispRank <= findRank) {
            return false;
          }
          return true;
        })
        .map(([, disposition]) => disposition);

      if (thread.isResolved !== true || matches.length !== 1) {
        fail('same-round finding lacks one resolved matching disposition');
      }

      const disposition = matches[0]!;
      if (finding.severity === 'blocking' && disposition.outcome !== 'fixed') {
        fail('blocking local-review findings must be fixed');
      }

      const fixed = disposition.outcome === 'fixed';
      const fixedMajor =
        fixed &&
        (finding.severity === 'blocking' || finding.severity === 'major');
      const fixedNonblocking = fixed && finding.severity !== 'blocking';

      const prev = evidence.get(fingerprint) ?? [false, false, false];
      evidence.set(fingerprint, [
        prev[0] || fixed,
        prev[1] || fixedMajor,
        prev[2] || fixedNonblocking,
      ]);
    }
  }

  const sortedFingerprints = Array.from(evidence.keys()).sort();
  return sortedFingerprints.map((fp) => [fp, ...evidence.get(fp)!]);
}

/**
 *
 */
export function verifyResultEvidence(
  args: {
    head: string;
    engine: SupportedEngine;
    round: number;
    base: string;
    before: string;
    resultHead?: string | undefined;
    repo?: string | undefined;
  },
  threads: GitHubReviewThreadNode[],
  options?: {
    data?: LedgerResult | undefined;
    allowedHeads?: Record<string, number> | undefined;
    historicalCommentIds?: Set<number> | undefined;
  },
): LedgerResult {
  const data = options?.data ?? validateResultData(args);
  if (data.status !== 'clean' && data.status !== 'changed') {
    fail('ledger result evidence requires a changed review result');
  }

  const allowedHeads =
    options?.allowedHeads ??
    loadAllowedHeads(
      (args as unknown as { allowedHeadsFile: string }).allowedHeadsFile,
      args.before,
      resultHead(args),
      args.repo ?? '',
    );

  const evidence = sameRoundDispositions(
    args,
    threads,
    allowedHeads,
    options?.historicalCommentIds,
  );

  const evidenceFp = evidence.map(([fp]) => fp);
  const dataFp = [...data.findingFingerprints].sort();
  const fpsMatch =
    evidenceFp.length === dataFp.length &&
    evidenceFp.every((v, i) => v === dataFp[i]);
  if (!fpsMatch) {
    fail(
      'review result fingerprints do not exactly match same-round ledger evidence',
    );
  }

  if (data.status === 'clean') {
    if (evidence.some(([, hasFix]) => hasFix)) {
      fail('clean review results cannot have same-round fixes');
    }
    return data;
  }

  if (args.round >= 3 && data.classification !== 'material') {
    fail('round 3+ changed review results require material classification');
  }

  if (evidence.length === 0) {
    fail('changed review results require ledger evidence');
  }

  if (!evidence.some(([, hasFix]) => hasFix)) {
    fail('changed review results require a fixed ledger finding');
  }

  if (
    args.round >= 3 &&
    evidence.some(([, , , hasNonblockingFix]) => hasNonblockingFix)
  ) {
    fail('convergence review results cannot fix non-blocking findings');
  }

  const fixedMajor = evidence.some(([, , hasMajorFix]) => hasMajorFix);
  if (fixedMajor && data.classification !== 'material') {
    fail('fixed blocking or major findings require material classification');
  }

  return data;
}

/**
 *
 */
export function writeResult(params: WriteResultParams): LedgerResult {
  const threads = params.threadsFile
    ? loadReviewThreads(params.threadsFile)
    : fetchReviewThreads(params.repo ?? '', params.pr ?? 0);

  const historicalCommentIds = loadHistoricalCommentIds(
    params.historicalCommentIdsFile,
  );

  verifyThreadDispositions(threads, historicalCommentIds, {
    repo: params.repo,
  });

  let allowedHeads: Record<string, number>;
  if (params.allowedHeadsFile) {
    allowedHeads = loadAllowedHeads(
      params.allowedHeadsFile,
      params.before,
      params.head,
      params.repo ?? '',
    );
  } else {
    const runner = getGitHubRunner();
    const list = runner.gitRevList
      ? runner.gitRevList(params.before, params.head)
      : execFileSync(
          'git',
          [
            'rev-list',
            '--reverse',
            '--ancestry-path',
            `${params.before}..${params.head}`,
          ],
          { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
        )
          .trim()
          .split(/\r?\n/)
          .filter(Boolean);

    const values = [params.before, ...list];
    if (
      values[values.length - 1] !== params.head ||
      new Set(values).size !== values.length
    ) {
      fail('review result transition is not forward-only');
    }
    allowedHeads = {};
    values.forEach((v, idx) => {
      allowedHeads[v] = idx;
    });
  }

  const dispositions = sameRoundDispositions(
    params,
    threads,
    allowedHeads,
    historicalCommentIds,
  );

  const changed = params.before !== params.head;
  if (!changed && dispositions.some(([, hasFix]) => hasFix)) {
    fail('clean review results cannot have same-round fixes');
  }
  if (
    changed &&
    params.classification !== 'minor' &&
    params.classification !== 'material'
  ) {
    fail('changed review result requires --classification');
  }
  if (!changed && params.classification !== undefined) {
    fail('clean review result cannot have a classification');
  }
  if (changed && params.round >= 3 && params.classification !== 'material') {
    fail('round 3+ changed review results require material classification');
  }
  if (changed && dispositions.length === 0) {
    fail('changed review results require ledger evidence');
  }
  if (changed && !dispositions.some(([, hasFix]) => hasFix)) {
    fail('changed review results require a fixed ledger finding');
  }
  if (
    changed &&
    params.round >= 3 &&
    dispositions.some(([, , , hasNonblockingFix]) => hasNonblockingFix)
  ) {
    fail('convergence review results cannot fix non-blocking findings');
  }
  if (
    changed &&
    params.classification !== 'material' &&
    dispositions.some(([, , hasMajorFix]) => hasMajorFix)
  ) {
    fail('fixed blocking or major findings require material classification');
  }

  const value: Record<string, unknown> = {
    version: PROTOCOL_VERSION,
    status: changed ? 'changed' : 'clean',
    engine: params.engine,
    round: params.round,
    baseSha: params.base,
    beforeSha: params.before,
    afterSha: params.head,
    classification: changed ? params.classification : null,
    findingFingerprints: dispositions.map(([fp]) => fp),
    finalLaneComplete: true,
  };

  writeResultFile(params.resultFile, value);
  const raw = readResultBytes(params.resultFile);
  const resultSha256 = sha256Bytes(raw);

  return { ...(value as unknown as LedgerResult), resultSha256 };
}

/**
 *
 */
export function preflightAnchor(
  params: PreflightAnchorParams,
): PreflightAnchorResult {
  verifyHead(params.repo, params.pr, params.head);
  const files = getPrFiles(params.repo, params.pr);
  const line = params.fileLevel ? null : params.line;
  const side = params.fileLevel ? null : (params.side ?? 'RIGHT');
  validateAnchor(files, params.path, line, side);
  return {
    anchor: params.fileLevel
      ? 'file'
      : `${params.side ?? 'RIGHT'}:${params.line}`,
    path: params.path,
    verified: true,
  };
}

/**
 *
 */
export function postFinding(params: PostFindingParams): PostFindingResult {
  let content = params.content;
  if (content === undefined && params.contentFile) {
    content = readContent(params.contentFile);
  }

  let marker: string;
  let body: string;
  const isV3 = content !== undefined;

  if (isV3) {
    if (
      !params.engine ||
      params.round === undefined ||
      !params.fingerprint ||
      !params.severity ||
      !params.lens
    ) {
      fail(
        'v3 content mode requires --engine, --round, --fingerprint, --severity, --lens',
      );
    }
    const contentStr = content!;
    const built = buildFindingBody({
      engine: params.engine,
      round: params.round,
      head: params.head,
      fingerprint: params.fingerprint,
      occurrence: params.occurrence ?? 1,
      severity: params.severity,
      lens: params.lens,
      content: contentStr,
    });
    marker = built.marker;
    body = built.body;
  } else {
    marker = FINDING_V1;
    body = readLegacyBody(params.bodyFile ?? '-', marker, params.content);
  }

  verifyHead(params.repo, params.pr, params.head);
  const files = getPrFiles(params.repo, params.pr);
  const line = params.fileLevel ? null : params.line;
  const side = params.fileLevel ? null : (params.side ?? 'RIGHT');
  validateAnchor(files, params.path, line, side);

  let commentId: number;
  let replayed = false;

  if (isV3) {
    const comments = getReviewComments(params.repo, params.pr);
    if (rowsHavePseudoV3(comments)) {
      verifyPseudoV3History(fetchReviewThreads(params.repo, params.pr));
    }
    const existing = findMatchingBody(
      comments as unknown as Array<Record<string, unknown>>,
      marker,
      body,
    );
    const records = comments.filter((row) => {
      const match = matchFinding(String(row.body ?? ''));
      return match !== null && match.fingerprint === params.fingerprint;
    });

    if (existing === null && records.length > 0) {
      fail('fingerprint already has a root thread; use reopen-occurrence');
    }
    if ((params.occurrence ?? 1) !== 1) {
      fail('post-finding creates occurrence 1; use reopen-occurrence later');
    }

    const res = postReviewComment(
      params.repo,
      params.pr,
      params.head,
      marker,
      body,
      {
        path: params.path,
        line: params.fileLevel ? undefined : params.line,
        side: params.fileLevel ? undefined : (params.side ?? 'RIGHT'),
        fileLevel: params.fileLevel,
      },
    );
    commentId = res.commentId;
    replayed = res.replayed;
  } else {
    const payload: Record<string, unknown> = {
      body,
      commit_id: params.head,
      path: params.path,
    };
    if (params.fileLevel) {
      payload['subject_type'] = 'file';
    } else {
      payload['line'] = params.line;
      payload['side'] = params.side ?? 'RIGHT';
    }
    const response = jsonOutput(
      ['api', '-X', 'POST', `repos/${params.repo}/pulls/${params.pr}/comments`],
      payload,
    );
    commentId = getPostedCommentId(response);
    verifyComment(params.repo, commentId, body);
    verifyHead(params.repo, params.pr, params.head);
  }

  return {
    comment_id: commentId,
    verified: true,
    ...(isV3 ? { replayed } : {}),
  };
}

/**
 *
 */
export function reopenOccurrence(
  params: ReopenOccurrenceParams,
): ReopenOccurrenceResult {
  let content = params.content;
  if (content === undefined && params.contentFile) {
    content = readContent(params.contentFile);
  } else if (content !== undefined) {
    content = validateContentString(content);
  } else {
    fail('reopen-occurrence requires content or content-file');
  }

  const { marker, body } = buildFindingBody({
    engine: params.engine,
    round: params.round,
    head: params.head,
    fingerprint: params.fingerprint,
    occurrence: params.occurrence,
    severity: params.severity,
    lens: params.lens,
    content,
  });

  verifyHead(params.repo, params.pr, params.head);
  const comments = getReviewComments(params.repo, params.pr);
  if (rowsHavePseudoV3(comments)) {
    verifyPseudoV3History(fetchReviewThreads(params.repo, params.pr));
  }

  const records = comments.filter((row) => {
    const match = matchFinding(String(row.body ?? ''));
    return match !== null && match.fingerprint === params.fingerprint;
  });
  const existing = findMatchingBody(
    comments as unknown as Array<Record<string, unknown>>,
    marker,
    body,
  );

  if (params.occurrence < 2) {
    fail('reopen-occurrence requires occurrence 2 or later');
  }

  const roots = records.filter((row) => {
    const match = matchFinding(String(row.body ?? ''));
    return match !== null && match.occurrence === 1;
  });
  if (
    roots.length !== 1 ||
    (roots[0]?.databaseId ?? roots[0]?.id) !== params.commentId
  ) {
    fail('--comment-id does not identify the fingerprint root comment');
  }

  // Verify prior occurrences disposed
  const dispositions = comments
    .map((row) => matchDisposition(String(row.body ?? '')))
    .filter((d): d is DispositionV3Match => d !== null);

  for (const row of records) {
    const finding = matchFinding(String(row.body ?? ''))!;
    if (finding.occurrence >= params.occurrence) {
      continue;
    }
    const matches = dispositions.filter(
      (disp) =>
        disp.engine === finding.engine &&
        disp.round === finding.round &&
        disp.fingerprint === finding.fingerprint &&
        disp.occurrence === finding.occurrence,
    );
    if (matches.length !== 1) {
      fail('every prior finding occurrence must have exactly one disposition');
    }
  }

  if (existing === null) {
    const occurrences = records
      .map((row) => matchFinding(String(row.body ?? ''))!.occurrence)
      .sort((a, b) => a - b);
    const expected = Array.from(
      { length: params.occurrence - 1 },
      (_, i) => i + 1,
    );
    const matchSeq =
      occurrences.length === expected.length &&
      occurrences.every((v, i) => v === expected[i]);
    if (!matchSeq) {
      fail('finding occurrences are missing, duplicated, or out of sequence');
    }
  }

  const { commentId, replayed } = postReviewComment(
    params.repo,
    params.pr,
    params.head,
    marker,
    body,
    { replyTo: params.commentId },
  );

  const threadReplayed = setThreadState(
    params.threadId,
    false,
    params.commentId,
  );
  verifyHead(params.repo, params.pr, params.head);

  return {
    comment_id: commentId,
    replayed,
    thread_replayed: threadReplayed,
    resolved: false,
    verified: true,
  };
}

/**
 *
 */
export function dispose(params: DisposeParams): DisposeResult {
  let content = params.content;
  if (content === undefined && params.contentFile) {
    content = readContent(params.contentFile);
  } else if (content !== undefined) {
    content = validateContentString(content);
  } else {
    fail('dispose requires content or content-file');
  }

  const occurrence = params.occurrence ?? 1;
  const { marker, body } = buildDispositionBody({
    engine: params.engine,
    round: params.round,
    head: params.head,
    fingerprint: params.fingerprint,
    occurrence,
    outcome: params.outcome,
    content,
  });

  verifyHead(params.repo, params.pr, params.head);
  const comments = getReviewComments(params.repo, params.pr);
  if (rowsHavePseudoV3(comments)) {
    verifyPseudoV3History(fetchReviewThreads(params.repo, params.pr));
  }

  const records = comments.filter((row) => {
    const match = matchFinding(String(row.body ?? ''));
    return match !== null && match.fingerprint === params.fingerprint;
  });
  const roots = records.filter((row) => {
    const match = matchFinding(String(row.body ?? ''));
    return match !== null && match.occurrence === 1;
  });
  if (
    roots.length !== 1 ||
    (roots[0]?.databaseId ?? roots[0]?.id) !== params.commentId
  ) {
    fail('--comment-id does not identify the fingerprint root comment');
  }

  const matches = records
    .map((row) => matchFinding(String(row.body ?? ''))!)
    .filter(
      (match) =>
        match.engine === params.engine &&
        match.round === params.round &&
        match.occurrence === occurrence,
    );

  if (matches.length !== 1) {
    fail(
      'disposition does not identify exactly one existing finding occurrence',
    );
  }

  const finding = matches[0]!;
  if (finding.severity === 'blocking' && params.outcome !== 'fixed') {
    fail('blocking local-review findings must be fixed');
  }

  // Consistency check
  const dispMatches = comments.filter((row) => {
    const match = matchDisposition(String(row.body ?? ''));
    return (
      match !== null &&
      match.engine === params.engine &&
      match.round === params.round &&
      match.fingerprint === params.fingerprint &&
      match.occurrence === occurrence
    );
  });
  if (dispMatches.length > 1) {
    fail('disposition identity is duplicated');
  }
  if (dispMatches.length === 1 && dispMatches[0]?.body !== body) {
    fail(
      'disposition identity already exists with conflicting content or outcome',
    );
  }

  const { commentId, replayed } = postReviewComment(
    params.repo,
    params.pr,
    params.head,
    marker,
    body,
    { replyTo: params.commentId },
  );

  const threadReplayed = setThreadState(
    params.threadId,
    true,
    params.commentId,
  );
  verifyHead(params.repo, params.pr, params.head);

  return {
    comment_id: commentId,
    replayed,
    thread_replayed: threadReplayed,
    resolved: true,
    verified: true,
  };
}

/**
 *
 */
export function reply(params: ReplyParams): {
  comment_id: number;
  verified: true;
} {
  const body = readLegacyBody(
    params.bodyFile ?? '-',
    DISPOSITION_V1,
    params.body,
  );
  verifyHead(params.repo, params.pr, params.head);
  const response = jsonOutput(
    [
      'api',
      '-X',
      'POST',
      `repos/${params.repo}/pulls/${params.pr}/comments/${params.commentId}/replies`,
    ],
    { body },
  );
  const commentId = getPostedCommentId(response);
  verifyComment(params.repo, commentId, body);
  verifyHead(params.repo, params.pr, params.head);
  return { comment_id: commentId, verified: true };
}

/**
 *
 */
export function postPrComment(params: PostPrCommentParams): {
  comment_id: number;
  verified: true;
} {
  const body = readLegacyBody(
    params.bodyFile ?? '-',
    PR_V1_MARKERS,
    params.body,
  );
  verifyHead(params.repo, params.pr, params.head);
  const response = jsonOutput(
    ['api', '-X', 'POST', `repos/${params.repo}/issues/${params.pr}/comments`],
    { body },
  );
  const commentId = getPostedCommentId(response);
  verifyIssueComment(params.repo, commentId, body);
  verifyHead(params.repo, params.pr, params.head);
  return { comment_id: commentId, verified: true };
}

/**
 *
 */
export function attest(params: AttestParams): AttestResult {
  const raw = readResultBytes(params.resultFile);
  const data = validateResultData(params, raw);
  const resultHash = sha256Bytes(raw);

  if (
    params.expectedResultSha256 &&
    resultHash !== params.expectedResultSha256
  ) {
    fail('review result changed before attestation');
  }

  if (data.status === 'blocked') {
    fail('blocked review results cannot be attested as complete');
  }

  const threads = loadReviewThreads(params.threadsFile!);
  const historicalCommentIds = loadHistoricalCommentIds(
    params.historicalCommentIdsFile,
  );

  verifyThreadDispositions(threads, historicalCommentIds, {
    repo: params.repo,
  });
  verifyResultEvidence(params, threads, {
    data,
    historicalCommentIds,
    allowedHeads: loadAllowedHeads(
      params.allowedHeadsFile!,
      params.before,
      params.head,
      params.repo,
    ),
  });

  let content: string;
  if (params.content !== undefined) {
    content = validateContentString(params.content);
  } else if (params.contentFile) {
    content = readContent(params.contentFile);
  } else {
    content =
      data.status === 'clean'
        ? 'No new material findings.'
        : 'Review fixes completed and ledger dispositions verified.';
  }

  let marker: string;
  if (data.status === 'clean') {
    marker = `<!-- local-review-pass:v3 engine=${params.engine} round=${params.round} base=${params.base} head=${params.head} result-sha256=${resultHash} -->`;
  } else {
    const fingerprints = data.findingFingerprints.join(',');
    marker = `<!-- local-review-complete:v3 engine=${params.engine} round=${params.round} base=${params.base} before=${params.before} head=${params.head} classification=${data.classification} fingerprints=${fingerprints} result-sha256=${resultHash} -->`;
  }

  const body = `${marker}\n${content}`;
  verifyHead(params.repo, params.pr, params.head);

  const existing = findMatchingBody(
    getIssueComments(params.repo, params.pr),
    marker,
    body,
  );
  let commentId: number;
  let replayed = existing !== null;

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
      } else {
        throw error;
      }
    }
  } else {
    commentId = existing;
  }

  verifyIssueComment(params.repo, commentId, body);
  verifyHead(params.repo, params.pr, params.head);

  return {
    comment_id: commentId,
    replayed,
    result_sha256: resultHash,
    verified: true,
  };
}

/**
 *
 */
export function resolve(params: ResolveParams): ResolveResult {
  verifyHead(params.repo, params.pr, params.head);
  setThreadState(params.threadId, true);
  verifyHead(params.repo, params.pr, params.head);
  return { thread_id: params.threadId, resolved: true };
}

/**
 *
 */
export function resolveThreads(params: {
  repo: string;
  pr: number;
  head: string;
  threadIds: string[];
}): { threadIds: string[]; resolved: true } {
  verifyHead(params.repo, params.pr, params.head);
  for (const threadId of params.threadIds) {
    setThreadState(threadId, true);
  }
  verifyHead(params.repo, params.pr, params.head);
  return { threadIds: params.threadIds, resolved: true };
}

/**
 *
 */
export function reconcile(params: ReconcileParams): ReconcileResult {
  verifyHead(params.repo, params.pr, params.head);
  const comments = getReviewComments(params.repo, params.pr);
  if (rowsHavePseudoV3(comments)) {
    verifyPseudoV3History(fetchReviewThreads(params.repo, params.pr));
  }

  const findingRows: Array<Record<string, unknown>> = [];
  const dispositionRows: Array<Record<string, unknown>> = [];

  for (const row of comments) {
    const body = String(row.body ?? '');
    const finding = matchFinding(body);
    const disposition = matchDisposition(body);
    if (finding && finding.fingerprint === params.fingerprint) {
      findingRows.push({ id: row.databaseId ?? row.id, ...finding });
    }
    if (disposition && disposition.fingerprint === params.fingerprint) {
      dispositionRows.push({ id: row.databaseId ?? row.id, ...disposition });
    }
  }

  const occurrences = findingRows
    .map((row) => row['occurrence'] as number)
    .sort((a, b) => a - b);
  const sequenceValid =
    occurrences.length > 0 && occurrences.every((val, idx) => val === idx + 1);

  const disposed = new Set(
    dispositionRows.map((row) => row['occurrence'] as number),
  );
  const ledgerValid =
    sequenceValid &&
    disposed.size === dispositionRows.length &&
    [...disposed].every((occ) => occurrences.includes(occ));

  const undisposed = occurrences.filter((occ) => !disposed.has(occ));
  const nextAction = !ledgerValid
    ? 'repair-sequence'
    : undisposed.length > 0
      ? 'dispose'
      : occurrences.length > 0
        ? 'reopen-occurrence'
        : 'post-finding';

  return {
    findings: findingRows,
    dispositions: dispositionRows,
    sequenceValid,
    ledgerValid,
    nextOccurrence: sequenceValid ? occurrences.length + 1 : null,
    undisposedOccurrences: undisposed,
    nextAction,
    verified: true,
  };
}

/**
 *
 */
export function verifyLedger(params: VerifyLedgerParams): VerifyLedgerResult {
  verifyHead(params.repo, params.pr, params.head);
  const threads = loadReviewThreads(params.threadsFile!);
  const historicalCommentIds = loadHistoricalCommentIds(
    params.historicalCommentIdsFile,
  );
  const threadCount = verifyThreadDispositions(threads, historicalCommentIds, {
    repo: params.repo,
  });

  let data: LedgerResult | null = null;
  if (params.resultFile !== undefined) {
    if (
      !params.engine ||
      params.round === undefined ||
      !params.base ||
      !params.before ||
      !params.allowedHeadsFile
    ) {
      fail(
        'verify-ledger result evidence requires --engine, --round, --base, --before, --result-file, and --allowed-heads-file',
      );
    }
    data = verifyResultEvidence(
      {
        head: params.head,
        engine: params.engine,
        round: params.round,
        base: params.base,
        before: params.before,
        resultHead: params.resultHead,
        repo: params.repo,
      },
      threads,
      {
        allowedHeads: loadAllowedHeads(
          params.allowedHeadsFile,
          params.before,
          resultHead({ head: params.head, resultHead: params.resultHead }),
          params.repo,
        ),
        historicalCommentIds,
      },
    );
  }

  return {
    resultStatus: data ? data.status : null,
    threadsVerified: threadCount,
    verified: true,
  };
}
