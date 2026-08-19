import { beforeEach, describe, expect, it } from 'vitest';
import {
  attestationsAtHead,
  buildRosterBody,
  coverage,
  coverageTier,
  matchRoster,
  parseReviewers,
  postRoster,
  readRoster,
  verifyCoverage,
} from '../index.js';
import { resetGitHubRunner, setGitHubRunner } from '../github.js';
import type { GitHubRunner } from '../types.js';

const HEAD = '1111111111111111111111111111111111111111';
const OLD_HEAD = '3333333333333333333333333333333333333333';
const BASE = '2222222222222222222222222222222222222222';
const DIGEST = 'a'.repeat(64);

class MockRunner implements GitHubRunner {
  public actor = 'test-actor';
  public issueComments: Array<Record<string, unknown>> = [];
  public commentIdSeq = 500;
  public prHead = HEAD;

  runGh(args: string[], payload?: unknown): string {
    const cmd = args.join(' ');
    if (cmd.startsWith('api user')) {
      return JSON.stringify({ login: this.actor });
    }
    if (cmd.includes('pr view')) {
      return this.prHead;
    }
    if (cmd.includes('/issues/') && cmd.includes('/comments?per_page=100')) {
      return JSON.stringify([this.issueComments]);
    }
    if (cmd.includes('/issues/comments/')) {
      const id = parseInt(args[1]!.split('/').pop()!, 10);
      const row = this.issueComments.find((c) => c['id'] === id);
      return JSON.stringify(
        row ?? { id, user: { login: this.actor }, body: '' },
      );
    }
    if (cmd.includes('-X POST') && cmd.includes('/issues/')) {
      const id = this.commentIdSeq++;
      const body = (payload as { body?: string })?.body ?? '';
      this.issueComments.push({ id, user: { login: this.actor }, body });
      return JSON.stringify({ id });
    }
    throw new Error(`unexpected gh call: ${cmd}`);
  }

  runGit(): string {
    return '';
  }
}

let runner: MockRunner;

function passMarker(engine: string, round: number, head: string): string {
  return `<!-- local-review-pass:v3 engine=${engine} round=${round} base=${BASE} head=${head} result-sha256=${DIGEST} -->\nNo new material findings.`;
}

function completeMarker(engine: string, round: number, head: string): string {
  return (
    `<!-- local-review-complete:v3 engine=${engine} round=${round} base=${BASE} before=${OLD_HEAD} ` +
    `head=${head} classification=minor fingerprints=src/a.ts:leak result-sha256=${DIGEST} -->\nFixed.`
  );
}

function addComment(body: string): number {
  const id = runner.commentIdSeq++;
  runner.issueComments.push({ id, user: { login: runner.actor }, body });
  return id;
}

function declareRoster(author: string, reviewers: string[]): void {
  const { body } = buildRosterBody({
    author: author as never,
    reviewers: reviewers as never,
    content: 'Roster for this relay.',
  });
  addComment(body);
}

beforeEach(() => {
  resetGitHubRunner();
  runner = new MockRunner();
  setGitHubRunner(runner);
});

describe('parseReviewers', () => {
  it('reads none as a deliberate empty roster', () => {
    expect(parseReviewers('none', 'claude')).toEqual([]);
  });

  it('reads a comma-separated list', () => {
    expect(parseReviewers('codex,gemini', 'claude')).toEqual([
      'codex',
      'gemini',
    ]);
  });

  it('rejects the author appearing as its own reviewer', () => {
    expect(() => parseReviewers('codex,claude', 'claude')).toThrow(
      /author engine cannot also be listed/,
    );
  });

  it('rejects duplicates and unsupported engines', () => {
    expect(() => parseReviewers('codex,codex', 'claude')).toThrow(/distinct/);
    expect(() => parseReviewers('copilot', 'claude')).toThrow(/must be one of/);
  });
});

describe('buildRosterBody', () => {
  it('refuses content that embeds a protocol marker', () => {
    const embedded = `Solo because reasons.\n${passMarker('codex', 1, HEAD)}`;
    expect(() =>
      buildRosterBody({
        author: 'claude',
        reviewers: ['codex'],
        content: embedded,
      }),
    ).toThrow(/must not contain local-review markers/);
  });

  it('refuses an unsupported author', () => {
    expect(() =>
      buildRosterBody({
        author: 'copilot' as never,
        reviewers: [],
        content: 'x',
      }),
    ).toThrow(/author must be one of/);
  });

  it('emits none rather than an empty value for a solo relay', () => {
    const { marker } = buildRosterBody({
      author: 'claude',
      reviewers: [],
      content: 'Solo: prototype spike, no external consumers.',
    });
    expect(marker).toContain('author=claude reviewers=none');
    expect(marker).toMatch(/content-sha256=[0-9a-f]{64} -->$/);
  });

  it('round-trips through matchRoster', () => {
    const { body } = buildRosterBody({
      author: 'gemini',
      reviewers: ['claude', 'codex'],
      content: 'Full coverage requested.',
    });
    expect(matchRoster(body)).toMatchObject({
      author: 'gemini',
      reviewers: ['claude', 'codex'],
    });
  });

  it('refuses a roster whose recorded reason was edited after the fact', () => {
    const { marker } = buildRosterBody({
      author: 'claude',
      reviewers: [],
      content: 'Solo: prototype spike.',
    });
    expect(() => matchRoster(`${marker}\nSolo: reviewed by everyone.`)).toThrow(
      /invalid content hash/,
    );
  });
});

describe('readRoster', () => {
  it('reports absence rather than inventing a default', () => {
    expect(readRoster({ repo: 'o/r', pr: 1 })).toMatchObject({
      present: false,
      author: null,
      reviewers: [],
    });
  });

  it('rejects two conflicting declarations', () => {
    declareRoster('claude', ['codex']);
    declareRoster('claude', ['gemini']);
    expect(() => readRoster({ repo: 'o/r', pr: 1 })).toThrow(
      /declared more than once/,
    );
  });
});

describe('postRoster', () => {
  it('declares the roster and replays an identical re-post', () => {
    const first = postRoster({
      repo: 'o/r',
      pr: 1,
      head: HEAD,
      author: 'claude',
      reviewers: ['codex'],
      content: 'Codex reviews this one.',
    });
    expect(first).toMatchObject({ replayed: false, reviewers: ['codex'] });

    const second = postRoster({
      repo: 'o/r',
      pr: 1,
      head: HEAD,
      author: 'claude',
      reviewers: ['codex'],
      content: 'Codex reviews this one.',
    });
    expect(second.replayed).toBe(true);
    expect(second.comment_id).toBe(first.comment_id);
    expect(runner.issueComments).toHaveLength(1);
  });

  it('refuses a second roster that contradicts the first', () => {
    postRoster({
      repo: 'o/r',
      pr: 1,
      head: HEAD,
      author: 'claude',
      reviewers: ['codex'],
      content: 'Codex reviews this one.',
    });
    expect(() =>
      postRoster({
        repo: 'o/r',
        pr: 1,
        head: HEAD,
        author: 'claude',
        reviewers: ['gemini'],
        content: 'Gemini reviews this one.',
      }),
    ).toThrow(/conflicting content/);
  });
});

describe('attestationsAtHead', () => {
  it('counts pass and completion markers naming the exact head', () => {
    const rows = [
      { body: passMarker('codex', 1, HEAD) },
      { body: completeMarker('gemini', 2, HEAD) },
    ];
    expect(attestationsAtHead(rows, HEAD)).toEqual([
      { engine: 'codex', round: 1, status: 'clean' },
      { engine: 'gemini', round: 2, status: 'changed' },
    ]);
  });

  it('ignores an attestation naming an earlier head', () => {
    const rows = [{ body: passMarker('codex', 1, OLD_HEAD) }];
    expect(attestationsAtHead(rows, HEAD)).toEqual([]);
  });

  it('ignores unrelated comments', () => {
    expect(attestationsAtHead([{ body: 'looks good to me' }], HEAD)).toEqual(
      [],
    );
  });

  it('refuses a marker that is not the first line of the body', () => {
    const quoted = `Round 1 summary. Codex posted:\n\n${passMarker('codex', 1, HEAD)}`;
    expect(attestationsAtHead([{ body: quoted }], HEAD)).toEqual([]);
  });

  it('refuses a marker quoted inside a fenced block', () => {
    const fenced = [
      'Here is what we will post:',
      '',
      '```',
      passMarker('codex', 1, HEAD),
      '```',
    ].join('\n');
    expect(attestationsAtHead([{ body: fenced }], HEAD)).toEqual([]);
  });

  it('refuses a marker with no content after it', () => {
    const bare = passMarker('codex', 1, HEAD).split('\n')[0]!;
    expect(attestationsAtHead([{ body: bare }], HEAD)).toEqual([]);
  });

  it('reads a completion marker even when another body quoted a stale pass', () => {
    const rows = [
      { body: `context\n${passMarker('codex', 1, OLD_HEAD)}` },
      { body: completeMarker('codex', 2, HEAD) },
    ];
    expect(attestationsAtHead(rows, HEAD)).toEqual([
      { engine: 'codex', round: 2, status: 'changed' },
    ]);
  });
});

describe('coverageTier', () => {
  it('maps non-author reviewer counts onto the declared tiers', () => {
    expect(coverageTier(0)).toBe('solo');
    expect(coverageTier(1)).toBe('cross');
    expect(coverageTier(2)).toBe('full');
    expect(coverageTier(3)).toBe('full');
  });
});

describe('coverage', () => {
  it('does not count the author engine towards cross-model coverage', () => {
    declareRoster('claude', ['codex']);
    addComment(passMarker('claude', 1, HEAD));

    const report = coverage({ repo: 'o/r', pr: 1, head: HEAD });
    expect(report.authorAttested).toBe(true);
    expect(report.nonAuthorAttested).toEqual([]);
    expect(report.tier).toBe('solo');
    expect(report.missingReviewers).toEqual(['codex']);
    expect(report.roundComplete).toBe(false);
  });

  it('reaches cross when one declared reviewer attests the head', () => {
    declareRoster('claude', ['codex']);
    addComment(passMarker('codex', 1, HEAD));

    const report = coverage({ repo: 'o/r', pr: 1, head: HEAD });
    expect(report.tier).toBe('cross');
    expect(report.roundComplete).toBe(true);
    expect(report.missingReviewers).toEqual([]);
  });

  it('reaches full with two non-author engines at the same head', () => {
    declareRoster('claude', ['codex', 'gemini']);
    addComment(passMarker('codex', 1, HEAD));
    addComment(completeMarker('gemini', 1, HEAD));

    const report = coverage({ repo: 'o/r', pr: 1, head: HEAD });
    expect(report.tier).toBe('full');
    expect(report.roundComplete).toBe(true);
  });

  it('drops an engine whose attestation names a superseded head', () => {
    declareRoster('claude', ['codex', 'gemini']);
    addComment(passMarker('codex', 1, HEAD));
    addComment(passMarker('gemini', 1, OLD_HEAD));

    const report = coverage({ repo: 'o/r', pr: 1, head: HEAD });
    expect(report.attestedAtHead).toEqual(['codex']);
    expect(report.missingReviewers).toEqual(['gemini']);
    expect(report.tier).toBe('cross');
    expect(report.roundComplete).toBe(false);
  });

  it('does not attribute non-author coverage when no roster names an author', () => {
    addComment(passMarker('claude', 1, HEAD));
    const report = coverage({ repo: 'o/r', pr: 1, head: HEAD });
    expect(report.rosterPresent).toBe(false);
    expect(report.nonAuthorAttested).toEqual([]);
    expect(report.tier).toBe('solo');
  });

  it('ignores an attestation authored by anyone but the actor', () => {
    declareRoster('claude', ['codex']);
    runner.issueComments.push({
      id: runner.commentIdSeq++,
      user: { login: 'someone-else' },
      body: passMarker('codex', 1, HEAD),
    });
    const report = coverage({ repo: 'o/r', pr: 1, head: HEAD });
    expect(report.attestedAtHead).toEqual([]);
    expect(report.missingReviewers).toEqual(['codex']);
  });

  it('marks a declared solo relay acknowledged and complete', () => {
    declareRoster('claude', []);
    addComment(passMarker('claude', 1, HEAD));
    const report = coverage({ repo: 'o/r', pr: 1, head: HEAD });
    expect(report.tier).toBe('solo');
    expect(report.soloAcknowledged).toBe(true);
    expect(report.roundComplete).toBe(true);
  });
});

describe('verifyCoverage', () => {
  it('refuses a pull request with no declared roster', () => {
    addComment(passMarker('codex', 1, HEAD));
    expect(() => verifyCoverage({ repo: 'o/r', pr: 1, head: HEAD })).toThrow(
      /no local-review roster is declared/,
    );
  });

  it('refuses a relay whose declared reviewer has not attested this head', () => {
    declareRoster('claude', ['codex', 'gemini']);
    addComment(passMarker('codex', 1, HEAD));
    expect(() => verifyCoverage({ repo: 'o/r', pr: 1, head: HEAD })).toThrow(
      /declared reviewers have not attested this head: gemini/,
    );
  });

  it('accepts a solo relay that was declared up front and reviewed', () => {
    declareRoster('claude', []);
    addComment(passMarker('claude', 1, HEAD));
    expect(verifyCoverage({ repo: 'o/r', pr: 1, head: HEAD })).toMatchObject({
      tier: 'solo',
      soloAcknowledged: true,
      authorAttested: true,
    });
  });

  it('refuses a declared solo relay carrying no attestation at all', () => {
    declareRoster('claude', []);
    expect(() => verifyCoverage({ repo: 'o/r', pr: 1, head: HEAD })).toThrow(
      /solo relay still requires the author engine to attest/,
    );
  });

  it('accepts a complete cross-model relay', () => {
    declareRoster('gemini', ['claude']);
    addComment(passMarker('claude', 2, HEAD));
    expect(verifyCoverage({ repo: 'o/r', pr: 1, head: HEAD })).toMatchObject({
      tier: 'cross',
      roundComplete: true,
    });
  });
});
