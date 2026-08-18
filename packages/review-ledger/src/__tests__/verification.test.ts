import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  attest,
  currentActor,
  getThreadState,
  readContent,
  reconcile,
  rowsHaveHistoricalMarkers,
  verifyForwardTransitionOrFail,
  verifyGitTransition,
  verifyLedger,
  verifyReviewBase,
  writeResult,
} from '../index.js';
import { resetGitHubRunner, setGitHubRunner } from '../github.js';
import type { GitHubReviewThreadNode, GitHubRunner } from '../types.js';

/**
 * Negative coverage for the verification core.
 *
 * The rule for everything here: deleting the check under test must fail the
 * test. The suites that predate this file all drive stubs that succeed
 * unconditionally, so the rules they exercise could each be removed with the
 * suite still green.
 */

const ACTOR = 'review-bot';
const REPO = 'loomantix/platform-oss';
const PR = 7;
const BASE = '0'.repeat(40);
const BEFORE = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);
const OTHER = 'c'.repeat(40);

const sha = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('hex');

function findingMarker(o: {
  fingerprint: string;
  occurrence?: number;
  severity?: string;
  content: string;
  head?: string;
  round?: number;
  engine?: string;
}): string {
  return (
    `<!-- local-review:v3 engine=${o.engine ?? 'claude'} round=${o.round ?? 1} ` +
    `head=${o.head ?? BEFORE} fingerprint=${o.fingerprint} ` +
    `occurrence=${o.occurrence ?? 1} severity=${o.severity ?? 'major'} ` +
    `lens=code-reviewer content-sha256=${sha(o.content)} -->`
  );
}

function dispositionMarker(o: {
  fingerprint: string;
  occurrence?: number;
  outcome?: string;
  content: string;
  head?: string;
  round?: number;
  engine?: string;
}): string {
  return (
    `<!-- local-review-disposition:v3 engine=${o.engine ?? 'claude'} round=${o.round ?? 1} ` +
    `head=${o.head ?? HEAD} fingerprint=${o.fingerprint} ` +
    `occurrence=${o.occurrence ?? 1} outcome=${o.outcome ?? 'fixed'} ` +
    `content-sha256=${sha(o.content)} -->`
  );
}

/** One fingerprint, posted at BEFORE and fixed at HEAD: a real changed round. */
function fixedThread(
  fingerprint = 'fp1',
  severity = 'major',
  round = 1,
): GitHubReviewThreadNode {
  const fc = 'the finding\n';
  const dc = 'the fix\n';
  return {
    id: `PRRT_${fingerprint}`,
    isResolved: true,
    repository: { nameWithOwner: REPO },
    pullRequest: { number: PR },
    comments: {
      nodes: [
        {
          databaseId: 1,
          body: `${findingMarker({ fingerprint, severity, round, content: fc })}\n${fc}`,
          author: { login: ACTOR },
        },
        {
          databaseId: 2,
          body: `${dispositionMarker({ fingerprint, round, content: dc })}\n${dc}`,
          author: { login: ACTOR },
        },
      ],
      pageInfo: { hasNextPage: false },
    },
  } as GitHubReviewThreadNode;
}

/**
 * A stub whose every verification input can be made to fail.
 *
 * Each knob exists because the check it feeds had no failing test.
 */
class ConfigurableRunner implements GitHubRunner {
  actor: string = ACTOR;
  actorRaw: string | null = null;
  threadNodes: GitHubReviewThreadNode[] = [];
  reviewComments: Array<Record<string, unknown>> = [];
  issueComments: Array<Record<string, unknown>> = [];
  prHead = HEAD;
  prBase = BASE;
  localHead = HEAD;
  ancestor = true;
  compareStatus = 'ahead';
  compareMergeBase: string | null = null;
  revList: string[] | null = null;
  commentIdSeq = 900;

  runGh(args: string[], payload?: unknown): string {
    const cmd = args.join(' ');
    if (cmd === 'api user') {
      return this.actorRaw ?? JSON.stringify({ login: this.actor });
    }
    if (cmd.includes('pr view') && cmd.includes('baseRefOid')) {
      return this.prBase;
    }
    if (cmd.includes('pr view')) {
      return this.prHead;
    }
    if (cmd.includes('/issues/') && cmd.includes('comments?per_page=100')) {
      return JSON.stringify([this.issueComments]);
    }
    if (cmd.includes('/pulls/') && cmd.includes('comments?per_page=100')) {
      return JSON.stringify([this.reviewComments]);
    }
    if (cmd.includes('-X POST') && cmd.includes('/issues/')) {
      const id = this.commentIdSeq++;
      const data = payload as { body?: string };
      this.issueComments.push({
        id,
        databaseId: id,
        user: { login: this.actor },
        body: data?.body ?? '',
      });
      return JSON.stringify({ id });
    }
    if (cmd.includes('-X DELETE') && cmd.includes('/issues/comments/')) {
      const id = parseInt(args[args.length - 1]!.split('/').pop()!, 10);
      this.issueComments = this.issueComments.filter((c) => c['id'] !== id);
      return '{}';
    }
    if (cmd.includes('/issues/comments/')) {
      const id = parseInt(args[1]!.split('/').pop()!, 10);
      const row = this.issueComments.find((c) => c['id'] === id);
      return JSON.stringify(
        row ?? { id, user: { login: this.actor }, body: '' },
      );
    }
    if (cmd.includes('graphql')) {
      const p = payload as {
        query?: string;
        variables?: { threadId?: string };
      };
      if (p?.query?.includes('PullRequestReviewThread')) {
        return JSON.stringify({
          data: {
            node:
              this.threadNodes.find((t) => t.id === p.variables?.threadId) ??
              null,
          },
        });
      }
      return JSON.stringify([
        {
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  nodes: this.threadNodes,
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          },
        },
      ]);
    }
    return '{}';
  }

  currentActor(): string {
    return this.actor;
  }

  gitCompare(_repo: string, before: string): unknown {
    return {
      status: this.compareStatus,
      merge_base_commit: { sha: this.compareMergeBase ?? before },
    };
  }

  gitRevList(_before: string, head: string): string[] {
    return this.revList ?? [head];
  }

  runGit(args: string[]): string {
    if (args[0] === 'rev-parse' && args[1] === 'HEAD') return this.localHead;
    if (args[0] === 'rev-parse' && args[1] === '--verify') {
      return args[2]!.replace(/\^\{commit\}$/, '');
    }
    return '';
  }

  isAncestor(): boolean {
    return this.ancestor;
  }
}

let runner: ConfigurableRunner;
let dir: string;

beforeEach(() => {
  runner = new ConfigurableRunner();
  setGitHubRunner(runner);
  dir = mkdtempSync(join(tmpdir(), 'review-ledger-verify-'));
  delete process.env['AGENT_LOOP_REVIEW_ACTOR'];
  delete process.env['AGENT_LOOP_REVIEW_THREADS_SHA256'];
  delete process.env['AGENT_LOOP_REVIEW_HISTORICAL_COMMENT_IDS_FILE'];
});

afterEach(() => {
  resetGitHubRunner();
});

const resultPath = (): string => join(dir, 'review-result.json');

function writeResultJson(value: Record<string, unknown>): string {
  const path = resultPath();
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) sorted[key] = value[key];
  writeFileSync(path, JSON.stringify(sorted) + '\n', 'utf8');
  return path;
}

const changedResult = (
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  version: 3,
  status: 'changed',
  engine: 'claude',
  round: 1,
  baseSha: BASE,
  beforeSha: BEFORE,
  afterSha: HEAD,
  classification: 'material',
  findingFingerprints: ['fp1'],
  finalLaneComplete: true,
  ...overrides,
});

describe('forward-only transition predicate', () => {
  it('rejects a comparison that is not ahead', () => {
    runner.compareStatus = 'behind';
    expect(() =>
      verifyForwardTransitionOrFail(REPO, BEFORE, HEAD, 'not forward'),
    ).toThrow('not forward');
  });

  it('rejects a comparison whose merge base is not the before commit', () => {
    runner.compareMergeBase = OTHER;
    expect(() =>
      verifyForwardTransitionOrFail(REPO, BEFORE, HEAD, 'not forward'),
    ).toThrow('not forward');
  });

  it('accepts a strictly forward comparison', () => {
    expect(() =>
      verifyForwardTransitionOrFail(REPO, BEFORE, HEAD, 'not forward'),
    ).not.toThrow();
  });
});

describe('review base and git transition binding', () => {
  it('rejects a base that is not the pull request base', () => {
    runner.prBase = OTHER;
    expect(() => verifyReviewBase(REPO, PR, BASE, BEFORE)).toThrow();
  });

  it('rejects a before commit that is not an ancestor of the base', () => {
    runner.ancestor = false;
    expect(() => verifyReviewBase(REPO, PR, BASE, BEFORE)).toThrow();
  });

  it('rejects a local checkout that is not at the reviewed head', () => {
    runner.localHead = OTHER;
    expect(() => verifyGitTransition(BEFORE, HEAD, HEAD)).toThrow();
  });

  it('rejects a before commit that is not an ancestor of the head', () => {
    runner.ancestor = false;
    expect(() => verifyGitTransition(BEFORE, HEAD, HEAD)).toThrow();
  });
});

describe('result evidence is matched against real ledger evidence', () => {
  beforeEach(() => {
    runner.threadNodes = [fixedThread('fp1')];
  });

  it('rejects a result claiming a fingerprint the ledger does not show', () => {
    const file = writeResultJson(
      changedResult({ findingFingerprints: ['fp1', 'fp-not-in-ledger'] }),
    );
    expect(() =>
      verifyLedger({
        repo: REPO,
        pr: PR,
        head: HEAD,
        engine: 'claude',
        round: 1,
        base: BASE,
        before: BEFORE,
        resultFile: file,
      }),
    ).toThrow('do not equal the complete same-round disposition set');
  });

  it('rejects a result omitting a fingerprint the ledger does show', () => {
    runner.threadNodes = [fixedThread('fp1'), fixedThread('fp2')];
    const file = writeResultJson(changedResult());
    expect(() =>
      verifyLedger({
        repo: REPO,
        pr: PR,
        head: HEAD,
        engine: 'claude',
        round: 1,
        base: BASE,
        before: BEFORE,
        resultFile: file,
      }),
    ).toThrow('do not equal the complete same-round disposition set');
  });

  it('rejects a clean result that claims a fingerprint', () => {
    runner.threadNodes = [];
    const file = writeResultJson(
      changedResult({
        status: 'clean',
        classification: null,
        beforeSha: HEAD,
        findingFingerprints: ['fp1'],
      }),
    );
    expect(() =>
      verifyLedger({
        repo: REPO,
        pr: PR,
        head: HEAD,
        engine: 'claude',
        round: 1,
        base: BASE,
        before: HEAD,
        resultFile: file,
      }),
    ).toThrow('do not equal the complete same-round disposition set');
  });

  it('rejects a fixed major finding classified as minor', () => {
    const file = writeResultJson(changedResult({ classification: 'minor' }));
    expect(() =>
      verifyLedger({
        repo: REPO,
        pr: PR,
        head: HEAD,
        engine: 'claude',
        round: 1,
        base: BASE,
        before: BEFORE,
        resultFile: file,
      }),
    ).toThrow(
      'fixed blocking or major findings require material classification',
    );
  });

  it('rejects a convergence round that fixed a non-blocking finding', () => {
    runner.threadNodes = [fixedThread('fp1', 'minor', 3)];
    const file = writeResultJson(changedResult({ round: 3 }));
    expect(() =>
      verifyLedger({
        repo: REPO,
        pr: PR,
        head: HEAD,
        engine: 'claude',
        round: 3,
        base: BASE,
        before: BEFORE,
        resultFile: file,
      }),
    ).toThrow('convergence review results cannot fix non-blocking findings');
  });

  it('rejects a transition whose revision walk does not reach the head', () => {
    runner.revList = [OTHER];
    const file = writeResultJson(changedResult());
    expect(() =>
      verifyLedger({
        repo: REPO,
        pr: PR,
        head: HEAD,
        engine: 'claude',
        round: 1,
        base: BASE,
        before: BEFORE,
        resultFile: file,
      }),
    ).toThrow('review result transition is not forward-only');
  });

  it('accepts a result that exactly matches the ledger', () => {
    const file = writeResultJson(changedResult());
    expect(
      verifyLedger({
        repo: REPO,
        pr: PR,
        head: HEAD,
        engine: 'claude',
        round: 1,
        base: BASE,
        before: BEFORE,
        resultFile: file,
      }).verified,
    ).toBe(true);
  });
});

describe('writeResult rejects results its evidence does not support', () => {
  const params = (overrides: Record<string, unknown> = {}) =>
    ({
      repo: REPO,
      pr: PR,
      head: HEAD,
      engine: 'claude' as const,
      round: 1,
      base: BASE,
      before: BEFORE,
      resultFile: resultPath(),
      classification: 'material' as const,
      ...overrides,
    }) as Parameters<typeof writeResult>[0];

  it('binds the declared base to the live pull request', () => {
    runner.threadNodes = [fixedThread('fp1')];
    runner.prBase = OTHER;
    expect(() => writeResult(params())).toThrow();
  });

  it('binds the declared head to the local checkout', () => {
    runner.threadNodes = [fixedThread('fp1')];
    runner.localHead = OTHER;
    expect(() => writeResult(params())).toThrow();
  });

  it('rejects a changed result with no classification', () => {
    runner.threadNodes = [fixedThread('fp1')];
    expect(() => writeResult(params({ classification: undefined }))).toThrow(
      'changed review result requires --classification',
    );
  });

  it('rejects a changed result with no ledger evidence', () => {
    runner.threadNodes = [];
    expect(() => writeResult(params())).toThrow(
      'changed review results require ledger evidence',
    );
  });

  it('writes a clean result for a round that moved nothing', () => {
    runner.threadNodes = [];
    const out = writeResult(
      params({ before: HEAD, classification: undefined }),
    );
    expect(out.status).toBe('clean');
    expect(out.classification).toBeNull();
    expect(out.findingFingerprints).toEqual([]);
  });

  it('rejects a round 3 changed result that is not material', () => {
    runner.threadNodes = [fixedThread('fp1')];
    expect(() =>
      writeResult(params({ round: 3, classification: 'minor' })),
    ).toThrow(
      'round 3+ changed review results require material classification',
    );
  });

  it('writes a result the ledger supports', () => {
    runner.threadNodes = [fixedThread('fp1')];
    const out = writeResult(params());
    expect(out.status).toBe('changed');
    expect(out.findingFingerprints).toEqual(['fp1']);
    expect(out.resultSha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('attestation identity is one per engine and round', () => {
  const attestParams = (file: string, digest: string) =>
    ({
      repo: REPO,
      pr: PR,
      head: HEAD,
      engine: 'claude' as const,
      round: 1,
      base: BASE,
      before: BEFORE,
      resultFile: file,
      expectedResultSha256: digest,
    }) as Parameters<typeof attest>[0];

  const seal = (value: Record<string, unknown>): [string, string] => {
    const file = writeResultJson(value);
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) sorted[key] = value[key];
    return [file, sha(JSON.stringify(sorted) + '\n')];
  };

  beforeEach(() => {
    runner.threadNodes = [fixedThread('fp1')];
  });

  it('rejects a result file that changed after it was sealed', () => {
    const [file] = seal(changedResult());
    expect(() => attest(attestParams(file, sha('other')))).toThrow(
      'review result changed before attestation',
    );
  });

  it('replays an identical attestation instead of posting a second one', () => {
    const [file, digest] = seal(changedResult());
    const first = attest(attestParams(file, digest));
    expect(first.replayed).toBe(false);
    const second = attest(attestParams(file, digest));
    expect(second.replayed).toBe(true);
    expect(second.comment_id).toBe(first.comment_id);
    expect(runner.issueComments).toHaveLength(1);
  });

  it('refuses a second attestation for the same engine and round', () => {
    const [file, digest] = seal(changedResult());
    attest(attestParams(file, digest));

    // Same round, different evidence: a contradiction, not a new record.
    runner.threadNodes = [fixedThread('fp1'), fixedThread('fp2')];
    const [file2, digest2] = seal(
      changedResult({ findingFingerprints: ['fp1', 'fp2'] }),
    );
    expect(() => attest(attestParams(file2, digest2))).toThrow(
      'local-review attestation identity conflicts with existing evidence',
    );
    expect(runner.issueComments).toHaveLength(1);
  });

  it('removes an attestation whose read-back fails', () => {
    const [file, digest] = seal(changedResult());
    const params = attestParams(file, digest);
    // The head moves between the evidence check and the post-publication check.
    let seen = 0;
    const original = runner.runGh.bind(runner);
    runner.runGh = (args: string[], payload?: unknown): string => {
      const cmd = args.join(' ');
      if (cmd.includes('pr view') && !cmd.includes('baseRefOid')) {
        seen += 1;
        if (seen > 1) return OTHER;
      }
      return original(args, payload);
    };
    expect(() => attest(params)).toThrow();
    expect(runner.issueComments).toHaveLength(0);
  });
});

describe('reconcile reports the action the ledger actually needs', () => {
  it('tells a caller to post a fingerprint that has never been posted', () => {
    const out = reconcile({
      repo: REPO,
      pr: PR,
      head: HEAD,
      fingerprint: 'never-posted',
    });
    expect(out.sequenceValid).toBe(true);
    expect(out.ledgerValid).toBe(true);
    expect(out.nextAction).toBe('post-finding');
    expect(out.nextOccurrence).toBe(1);
  });

  it('does not count another engine or round as disposing an occurrence', () => {
    const fc = 'the finding\n';
    const dc = 'the fix\n';
    runner.reviewComments = [
      {
        id: 1,
        databaseId: 1,
        user: { login: ACTOR },
        body: `${findingMarker({ fingerprint: 'fp1', content: fc })}\n${fc}`,
      },
      {
        id: 2,
        databaseId: 2,
        user: { login: ACTOR },
        // Same fingerprint and occurrence, different engine.
        body: `${dispositionMarker({ fingerprint: 'fp1', content: dc, engine: 'codex' })}\n${dc}`,
      },
    ];
    const out = reconcile({
      repo: REPO,
      pr: PR,
      head: HEAD,
      fingerprint: 'fp1',
    });
    expect(out.ledgerValid).toBe(false);
    expect(out.nextAction).toBe('repair-sequence');
  });
});

describe('authenticated actor resolution', () => {
  it('rejects a user response with no login', () => {
    resetGitHubRunner();
    const bare = new ConfigurableRunner();
    bare.actorRaw = JSON.stringify({ id: 1 });
    // Force the module-level resolution path rather than the runner seam.
    setGitHubRunner({ runGh: (args) => bare.runGh(args) } as GitHubRunner);
    expect(() => currentActor()).toThrow(
      'GitHub returned an invalid authenticated-user response',
    );
  });

  it('rejects the literal null a jq projection would print', () => {
    resetGitHubRunner();
    setGitHubRunner({ runGh: () => 'null' } as GitHubRunner);
    expect(() => currentActor()).toThrow(
      'GitHub returned an invalid authenticated-user response',
    );
  });
});

describe('historical marker detection', () => {
  it('flags legacy v1 records', () => {
    expect(
      rowsHaveHistoricalMarkers([
        { body: '<!-- local-review:v1 engine=claude -->\nlegacy' },
      ]),
    ).toBe(true);
  });

  it('flags a v3 marker that does not parse', () => {
    expect(
      rowsHaveHistoricalMarkers([
        { body: '<!-- local-review:v3 engine=claude round=nope -->\nbroken' },
      ]),
    ).toBe(true);
  });

  it('does not flag an ordinary comment', () => {
    expect(rowsHaveHistoricalMarkers([{ body: 'just a comment' }])).toBe(false);
  });

  it('does not flag a well-formed v3 finding', () => {
    const content = 'the finding\n';
    expect(
      rowsHaveHistoricalMarkers([
        {
          body: `${findingMarker({ fingerprint: 'fp1', content })}\n${content}`,
        },
      ]),
    ).toBe(false);
  });
});

describe('content files are decoded strictly', () => {
  it('rejects invalid UTF-8 rather than substituting replacement characters', () => {
    const path = join(dir, 'content.txt');
    writeFileSync(path, Buffer.from([0x68, 0x69, 0xff, 0xfe, 0x0a]));
    expect(() => readContent(path)).toThrow('content file must be valid UTF-8');
  });

  it('accepts valid multi-byte UTF-8 unchanged', () => {
    const path = join(dir, 'content-ok.txt');
    writeFileSync(path, 'findings — café 日本語\n', 'utf8');
    expect(readContent(path)).toBe('findings — café 日本語\n');
  });
});

describe('thread read-back is bound to its pull request and root comment', () => {
  const scoped = (
    overrides: Partial<GitHubReviewThreadNode> = {},
  ): GitHubReviewThreadNode =>
    ({
      id: 'PRRT_x',
      isResolved: false,
      repository: { nameWithOwner: REPO },
      pullRequest: { number: PR },
      comments: {
        nodes: [{ databaseId: 11 }, { databaseId: 12 }],
        pageInfo: { hasNextPage: false },
      },
      ...overrides,
    }) as GitHubReviewThreadNode;

  it('rejects a thread belonging to another repository', () => {
    runner.threadNodes = [
      scoped({ repository: { nameWithOwner: 'someone/else' } }),
    ];
    expect(() =>
      getThreadState('PRRT_x', undefined, { repo: REPO, pr: PR }),
    ).toThrow(`does not belong to ${REPO}#${PR}`);
  });

  it('rejects a thread belonging to another pull request', () => {
    runner.threadNodes = [scoped({ pullRequest: { number: 999 } })];
    expect(() =>
      getThreadState('PRRT_x', undefined, { repo: REPO, pr: PR }),
    ).toThrow(`does not belong to ${REPO}#${PR}`);
  });

  it('rejects a comment that is not the root of the thread', () => {
    runner.threadNodes = [scoped()];
    expect(() => getThreadState('PRRT_x', 12, { repo: REPO, pr: PR })).toThrow(
      '--comment-id is not the root comment of --thread-id',
    );
  });

  it('accepts the thread root in the requested pull request', () => {
    runner.threadNodes = [scoped()];
    expect(getThreadState('PRRT_x', 11, { repo: REPO, pr: PR })).toBe(false);
  });
});
