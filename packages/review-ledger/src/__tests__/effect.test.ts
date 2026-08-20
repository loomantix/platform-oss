import { afterEach, describe, expect, it } from 'vitest';
import { classifyRangeEffect } from '../effect.js';
import { resetGitHubRunner, setGitHubRunner } from '../github.js';
import type { GitHubRunner } from '../types.js';

const BEFORE = 'a'.repeat(40);
const AFTER = 'b'.repeat(40);

/**
 * Drive `classifyRangeEffect` against a fixed `git diff` transcript.
 *
 * `nameStatus` is the `--name-status` body; `patches` maps a path to the
 * `--unified=0` patch the second call returns for it.
 */
function withDiff(
  nameStatus: string,
  patches: Record<string, string> = {},
): void {
  const runner: GitHubRunner = {
    runGh() {
      throw new Error('unexpected gh call');
    },
    runGit(args: string[]): string {
      if (args.includes('--name-status')) {
        return `${nameStatus}\n`;
      }
      const path = args[args.length - 1]!;
      return patches[path] ?? '';
    },
  };
  setGitHubRunner(runner);
}

afterEach(() => {
  resetGitHubRunner();
});

describe('classifyRangeEffect', () => {
  it('accepts a comment-only Terraform range', () => {
    // The reported failure: five findings fixed, every changed line a comment,
    // and the plan still reporting no changes.
    withDiff('M\tinfra/eks/main.tf', {
      'infra/eks/main.tf': [
        '@@ -3 +3 @@',
        '-# the node floor is 3',
        '+# the node floor is 2',
        '@@ -11 +11 @@',
        '-// applied by CI',
        '+// hand-applied by an admin',
      ].join('\n'),
    });
    expect(classifyRangeEffect(BEFORE, AFTER)).toBe('non-behavioral');
  });

  it('rejects a range that also changes a non-comment line', () => {
    withDiff('M\tinfra/eks/main.tf', {
      'infra/eks/main.tf': [
        '@@ -3 +3 @@',
        '-# the node floor is 3',
        '+# the node floor is 2',
        '@@ -8 +8 @@',
        '-  min_size = 3',
        '+  min_size = 2',
      ].join('\n'),
    });
    expect(classifyRangeEffect(BEFORE, AFTER)).toBe('behavioral');
  });

  it('accepts a test-only range', () => {
    withDiff('M\tpackages/app/src/__tests__/user.test.ts');
    expect(classifyRangeEffect(BEFORE, AFTER)).toBe('non-behavioral');
  });

  it('rejects a range that touches a test and app code', () => {
    withDiff(
      [
        'M\tpackages/app/src/__tests__/user.test.ts',
        'M\tpackages/app/src/user.ts',
      ].join('\n'),
      {
        'packages/app/src/user.ts': [
          '@@ -4 +4 @@',
          '-  return name.trim();',
          '+  return name.trim().toLowerCase();',
        ].join('\n'),
      },
    );
    expect(classifyRangeEffect(BEFORE, AFTER)).toBe('behavioral');
  });

  it('accepts a docs range but not a prompt-surface one', () => {
    withDiff('M\tdocs/how-to/deploy.md');
    expect(classifyRangeEffect(BEFORE, AFTER)).toBe('non-behavioral');

    // `.claude/**` is source whatever the extension: the model reads it as
    // instructions, so editing it changes behavior.
    withDiff('M\t.claude/skills/critique/SKILL.md');
    expect(classifyRangeEffect(BEFORE, AFTER)).toBe('behavioral');
  });

  it('treats a marker hidden in a string as code', () => {
    withDiff('M\tscripts/deploy.sh', {
      'scripts/deploy.sh': [
        '@@ -2 +2 @@',
        '-echo "# starting"',
        '+echo "# starting deploy"',
      ].join('\n'),
    });
    expect(classifyRangeEffect(BEFORE, AFTER)).toBe('behavioral');
  });

  it('accepts a balanced block comment and rejects code sharing its line', () => {
    withDiff('M\tsrc/user.ts', {
      'src/user.ts': ['@@ -1 +1 @@', '-/* old note */', '+/* new note */'].join(
        '\n',
      ),
    });
    expect(classifyRangeEffect(BEFORE, AFTER)).toBe('non-behavioral');

    withDiff('M\tsrc/user.ts', {
      'src/user.ts': [
        '@@ -1 +1 @@',
        '-/* note */ const a = 1;',
        '+/* note */ const a = 2;',
      ].join('\n'),
    });
    expect(classifyRangeEffect(BEFORE, AFTER)).toBe('behavioral');
  });

  it('fails closed on an unknown extension, a rename, and a missing git seam', () => {
    withDiff('M\tsrc/thing.zig');
    expect(classifyRangeEffect(BEFORE, AFTER)).toBe('behavioral');

    withDiff('R100\tsrc/a.ts\tsrc/b.ts');
    expect(classifyRangeEffect(BEFORE, AFTER)).toBe('behavioral');

    setGitHubRunner({
      runGh() {
        throw new Error('unexpected gh call');
      },
    });
    expect(classifyRangeEffect(BEFORE, AFTER)).toBe('behavioral');
  });

  it('does not consult severity in either direction', () => {
    // The function takes only a range. There is no argument by which a `major`
    // finding could force `behavioral` or a `nit` could force `non-behavioral`.
    expect(classifyRangeEffect.length).toBe(2);
  });
});
