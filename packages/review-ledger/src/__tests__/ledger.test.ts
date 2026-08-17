import { beforeEach, describe, expect, it } from 'vitest';
import {
  DefaultGitHubRunner,
  dispose,
  postFinding,
  preflightAnchor,
  reconcile,
  reopenOccurrence,
  resolve,
  setGitHubRunner,
  verifyLedger,
  writeResult,
} from '../index.js';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { existsSync, unlinkSync, writeFileSync } from 'node:fs';
import type { GitHubReviewThreadNode, GitHubRunner } from '../types.js';

class MockGitHubRunner implements GitHubRunner {
  public actor = 'test-actor';
  public prFiles: Record<string, string | null> = {};
  public reviewComments: Array<Record<string, unknown>> = [];
  public issueComments: Array<Record<string, unknown>> = [];
  public threads: GitHubReviewThreadNode[] = [];
  public commentIdSeq = 200;
  public prHead = '1111111111111111111111111111111111111111';

  runGh(args: string[], payload?: unknown): string {
    const cmd = args.join(' ');
    if (cmd.includes('api user --jq .login')) {
      return this.actor;
    }
    if (cmd.includes('pr view')) {
      return this.prHead;
    }
    if (cmd.includes('repos/') && cmd.includes('/files?per_page=100')) {
      const rows = Object.entries(this.prFiles).map(([filename, patch]) => ({
        filename,
        patch,
      }));
      return JSON.stringify([rows]);
    }
    if (
      cmd.includes('repos/') &&
      cmd.includes('/pulls/') &&
      cmd.includes('/comments?per_page=100')
    ) {
      return JSON.stringify([this.reviewComments]);
    }
    if (
      cmd.includes('repos/') &&
      cmd.includes('/issues/') &&
      cmd.includes('/comments?per_page=100')
    ) {
      return JSON.stringify([this.issueComments]);
    }
    if (cmd.includes('repos/') && cmd.includes('/pulls/comments/')) {
      const id = parseInt(args[1]!.split('/').pop()!, 10);
      const row = this.reviewComments.find((c) => c['id'] === id);
      return JSON.stringify(
        row ?? { id, user: { login: this.actor }, body: '' },
      );
    }
    if (cmd.includes('repos/') && cmd.includes('/issues/comments/')) {
      const id = parseInt(args[1]!.split('/').pop()!, 10);
      const row = this.issueComments.find((c) => c['id'] === id);
      return JSON.stringify(
        row ?? { id, user: { login: this.actor }, body: '' },
      );
    }
    if (
      cmd.includes('-X POST') &&
      (cmd.includes('/pulls/') || cmd.includes('/issues/'))
    ) {
      const id = this.commentIdSeq++;
      const data = payload as {
        body?: string;
        commit_id?: string;
        path?: string;
        line?: number;
        side?: string;
      };
      const row = {
        id,
        databaseId: id,
        user: { login: this.actor },
        author: { login: this.actor },
        body: data?.body ?? '',
        commit_id: data?.commit_id,
        path: data?.path,
        line: data?.line,
        side: data?.side,
      };
      if (cmd.includes('/pulls/')) {
        this.reviewComments.push(row);
      } else {
        this.issueComments.push(row);
      }
      return JSON.stringify({ id });
    }
    if (cmd.includes('api graphql')) {
      const p = payload as {
        query?: string;
        variables?: { threadId?: string };
      };
      if (p?.query?.includes('PullRequestReviewThread')) {
        const t = this.threads.find((th) => th.id === p.variables?.threadId);
        return JSON.stringify({
          data: {
            node: t ?? {
              id: p.variables?.threadId,
              isResolved: false,
              comments: { nodes: [], pageInfo: { hasNextPage: false } },
            },
          },
        });
      }
      if (p?.query?.includes('resolveReviewThread')) {
        const t = this.threads.find((th) => th.id === p.variables?.threadId);
        if (t) t.isResolved = true;
        return JSON.stringify({
          data: {
            resolveReviewThread: {
              thread: { id: p.variables?.threadId, isResolved: true },
            },
          },
        });
      }
      if (p?.query?.includes('unresolveReviewThread')) {
        const t = this.threads.find((th) => th.id === p.variables?.threadId);
        if (t) t.isResolved = false;
        return JSON.stringify({
          data: {
            unresolveReviewThread: {
              thread: { id: p.variables?.threadId, isResolved: false },
            },
          },
        });
      }
      if (p?.query?.includes('reviewThreads')) {
        return JSON.stringify([
          {
            data: {
              repository: {
                pullRequest: {
                  reviewThreads: {
                    nodes: this.threads,
                    pageInfo: { hasNextPage: false, endCursor: null },
                  },
                },
              },
            },
          },
        ]);
      }
    }
    return '{}';
  }

  currentActor(): string {
    return this.actor;
  }

  gitRevList(before: string, head: string): string[] {
    return [head];
  }

  gitCompare(repo: string, before: string, after: string): unknown {
    return { status: 'ahead', merge_base_commit: { sha: before } };
  }
}

describe('ledger operations and workflow verification', () => {
  let mock: MockGitHubRunner;
  const headSha = '1111111111111111111111111111111111111111';
  const samplePatch = '@@ -1,5 +1,6 @@\n context\n+new line\n';

  beforeEach(() => {
    mock = new MockGitHubRunner();
    mock.prFiles = { 'src/index.ts': samplePatch };
    setGitHubRunner(mock);
  });

  it('verifies anchor with preflightAnchor', () => {
    const res = preflightAnchor({
      repo: 'loomantix/platform-oss',
      pr: 10,
      head: headSha,
      path: 'src/index.ts',
      line: 2,
      side: 'RIGHT',
    });
    expect(res.verified).toBe(true);
    expect(res.anchor).toBe('RIGHT:2');
  });

  it('posts a finding and records comment', () => {
    const res = postFinding({
      repo: 'loomantix/platform-oss',
      pr: 10,
      head: headSha,
      path: 'src/index.ts',
      line: 2,
      side: 'RIGHT',
      engine: 'gemini',
      round: 1,
      fingerprint: 'fp-1',
      occurrence: 1,
      severity: 'major',
      lens: 'code-reviewer',
      content: 'Potential null pointer dereference',
    });

    expect(res.verified).toBe(true);
    expect(res.comment_id).toBeDefined();
    expect(mock.reviewComments.length).toBe(1);
  });

  it('disposes a finding and marks thread resolved', () => {
    const threadId = 'PRRT_kwDO123';
    const commentId = 100;
    mock.threads = [
      {
        id: threadId,
        isResolved: false,
        comments: {
          nodes: [
            {
              id: commentId,
              databaseId: commentId,
              author: { login: mock.actor },
              body: '<!-- local-review:v3 engine=gemini round=1 head=1111111111111111111111111111111111111111 fingerprint=fp-1 occurrence=1 severity=minor lens=code-reviewer content-sha256=2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae -->\nfoo',
            },
          ],
          pageInfo: { hasNextPage: false },
        },
      },
    ];
    mock.reviewComments = [...mock.threads[0]!.comments.nodes] as Array<
      Record<string, unknown>
    >;

    const res = dispose({
      repo: 'loomantix/platform-oss',
      pr: 10,
      head: headSha,
      engine: 'gemini',
      round: 1,
      fingerprint: 'fp-1',
      occurrence: 1,
      outcome: 'fixed',
      commentId,
      threadId,
      content: 'Fixed by adding null check.',
    });

    expect(res.verified).toBe(true);
    expect(res.resolved).toBe(true);
    expect(mock.threads[0]!.isResolved).toBe(true);
  });

  it('reconciles findings and dispositions', () => {
    const commentId = 100;
    mock.reviewComments = [
      {
        id: commentId,
        databaseId: commentId,
        author: { login: mock.actor },
        body: '<!-- local-review:v3 engine=gemini round=1 head=1111111111111111111111111111111111111111 fingerprint=fp-test occurrence=1 severity=minor lens=code-reviewer content-sha256=2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae -->\nfoo',
      },
    ];

    const report = reconcile({
      repo: 'loomantix/platform-oss',
      pr: 10,
      head: headSha,
      fingerprint: 'fp-test',
    });

    expect(report.sequenceValid).toBe(true);
    expect(report.undisposedOccurrences).toEqual([1]);
    expect(report.nextAction).toBe('dispose');
  });

  it('resolves a review thread', () => {
    mock.threads = [
      {
        id: 'PRRT_test',
        isResolved: false,
        comments: { nodes: [], pageInfo: { hasNextPage: false } },
      },
    ];
    const res = resolve({
      repo: 'loomantix/platform-oss',
      pr: 10,
      head: headSha,
      threadId: 'PRRT_test',
    });
    expect(res.resolved).toBe(true);
    expect(mock.threads[0]!.isResolved).toBe(true);
  });
});
