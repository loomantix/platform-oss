import { afterEach, describe, expect, it } from 'vitest';
import { classifyRangeEffect } from '../effect.js';
import { resetGitHubRunner, setGitHubRunner } from '../github.js';
import type { GitHubRunner } from '../types.js';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
  sources: Record<string, string> = {},
): void {
  const runner: GitHubRunner = {
    runGh() {
      throw new Error('unexpected gh call');
    },
    runGit(args: string[]): string {
      if (args[0] === 'show') {
        const source = sources[args[1]!];
        if (source === undefined) throw new Error('missing source blob');
        return source;
      }
      if (args.includes('--summary')) return '';
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

  it('treats every engine prompt directory as source, not just its own', () => {
    // This helper is vendored into each engine repo, so a rule naming only the
    // reading engine would make the same SKILL edit inert in the other two.
    for (const path of [
      '.claude/skills/critique/SKILL.md',
      '.codex/skills/critique/SKILL.md',
      '.agents/skills/critique/SKILL.md',
      '.codex/references/local-review-ledger.md',
    ]) {
      withDiff(`M\t${path}`);
      expect(classifyRangeEffect(BEFORE, AFTER)).toBe('behavioral');
    }
  });

  it('treats executing config as source whatever extension it wears', () => {
    // A workflow is `.yml` and a manifest is `.json`. Reading them as inert
    // config would let a rewritten pipeline or a bumped dependency attest
    // `minor`, so the other engine never re-reads the new head.
    for (const path of [
      '.github/workflows/ci.yml',
      '.github/actions/setup/action.yml',
      '.github/CODEOWNERS',
      'package.json',
      'pnpm-lock.yaml',
      'package-lock.json',
    ]) {
      withDiff(`M\t${path}`);
      expect(classifyRangeEffect(BEFORE, AFTER)).toBe('behavioral');
    }

    // Deleting one is not inert either.
    withDiff('D\t.github/workflows/publish.yml');
    expect(classifyRangeEffect(BEFORE, AFTER)).toBe('behavioral');
  });

  it('still reads a script under docs/ with the comment prover', () => {
    // A `docs/` segment is not a blanket answer for something that executes.
    withDiff('M\tdocs/scripts/bootstrap.sh', {
      'docs/scripts/bootstrap.sh': [
        '@@ -4 +4 @@',
        '-rm -rf "$target"',
        '+rm -rf "$target" "$cache"',
      ].join('\n'),
    });
    expect(classifyRangeEffect(BEFORE, AFTER)).toBe('behavioral');

    // ...and a comment-only edit to that same script is still inert.
    withDiff('M\tdocs/scripts/bootstrap.sh', {
      'docs/scripts/bootstrap.sh': [
        '@@ -4 +4 @@',
        '-# clears the build cache',
        '+# clears the build cache and the target dir',
      ].join('\n'),
    });
    expect(classifyRangeEffect(BEFORE, AFTER)).toBe('non-behavioral');
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
    withDiff(
      'M\tsrc/user.ts',
      {
        'src/user.ts': [
          '@@ -1 +1 @@',
          '-/* old note */',
          '+/* new note */',
        ].join('\n'),
      },
      {
        [`${BEFORE}:src/user.ts`]: '/* old note */',
        [`${AFTER}:src/user.ts`]: '/* new note */',
      },
    );
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

  it.each([
    [
      'JSDoc interior',
      '/**\n * Existing guard.\n */\nexport const identity = (value: string) => value;\n',
      '/**\n * The existing guard preserves input.\n */\nexport const identity = (value: string) => value;\n',
      'non-behavioral',
    ],
    [
      'multiline prose',
      '/* Old prose. */\nconst value = 1;',
      '/* New prose. */\nconst value = 1;',
      'non-behavioral',
    ],
    [
      'template contents',
      'const value = `\n/* Old prose. */\n`;',
      'const value = `\n/* New prose. */\n`;',
      'behavioral',
    ],
    [
      'template interpolation',
      'const value = `text ${1}`;',
      'const value = `text ${2}`;',
      'behavioral',
    ],
    [
      'regular expression',
      'const value = /old\\/*/;',
      'const value = /new\\/*/;',
      'behavioral',
    ],
    [
      'multiplication',
      'const value = 1\n * 2;',
      'const value = 1\n * 3;',
      'behavioral',
    ],
    [
      'runtime edit beside comment',
      '/* Prose. */ const value = 1;',
      '/* New prose. */ const value = 2;',
      'behavioral',
    ],
    [
      'semicolon insertion',
      'function value() { return /* prose */ 1; }',
      'function value() { return /* prose\n */ 1; }',
      'behavioral',
    ],
    [
      'type directive',
      '// @ts-check\nconst value = 1;',
      '// @ts-nocheck\nconst value = 1;',
      'behavioral',
    ],
    [
      'JSDoc type',
      '/** @type {string} */\nlet value;',
      '/** @type {number} */\nlet value;',
      'behavioral',
    ],
    [
      'coverage directive',
      '/* istanbul ignore next */\nconst value = 1;',
      '/* prose */\nconst value = 1;',
      'behavioral',
    ],
    [
      'unclosed comment',
      '/* prose */\nconst value = 1;',
      '/* prose\nconst value = 1;',
      'behavioral',
    ],
  ])('reads full lexical context for %s', (_label, before, after, expected) => {
    withDiff(
      'M\tsrc/identity.ts',
      {},
      {
        [`${BEFORE}:src/identity.ts`]: before,
        [`${AFTER}:src/identity.ts`]: after,
      },
    );
    expect(classifyRangeEffect(BEFORE, AFTER)).toBe(expected);
  });

  it.each([
    [
      'multiline JSDoc type',
      '/**\n * @type {{\n *   enabled: boolean\n * }}\n */\nconst settings = { enabled: true };',
      '/**\n * @type {{\n *   enabled: string\n * }}\n */\nconst settings = { enabled: true };',
    ],
    [
      'multiline lint directive',
      '/* eslint\n  no-console: "off"\n */\nconsole.log("ready");',
      '/* eslint\n  no-console: "error"\n */\nconsole.log("ready");',
    ],
    [
      'JSDoc opening delimiter',
      '/*\n * @type {string}\n */\nlet value = 1;',
      '/**\n * @type {string}\n */\nlet value = 1;',
    ],
  ])('preserves the complete %s comment', (_label, before, after) => {
    withDiff(
      'M\tsrc/settings.js',
      {},
      {
        [`${BEFORE}:src/settings.js`]: before,
        [`${AFTER}:src/settings.js`]: after,
      },
    );
    expect(classifyRangeEffect(BEFORE, AFTER)).toBe('behavioral');
  });

  it.each([
    '/* #__PURE__ */\nconst value = 1;',
    '//# sourceMappingURL=original.js.map\nconst value = 1;',
    '//# debugId=synthetic-debug-reference\nconst value = 1;',
    '/* #tool_annotation */\nconst value = 1;',
  ])('preserves hash annotations as directives: %s', (before) => {
    const after = before.startsWith('/*')
      ? '/* prose */\nconst value = 1;'
      : '// prose\nconst value = 1;';
    withDiff(
      'M\tsrc/identity.ts',
      {},
      {
        [`${BEFORE}:src/identity.ts`]: before,
        [`${AFTER}:src/identity.ts`]: after,
      },
    );
    expect(classifyRangeEffect(BEFORE, AFTER)).toBe('behavioral');
  });

  it('classifies a real JSDoc edit with Markdown and issue references, and rejects a mode change', () => {
    const directory = mkdtempSync(join(tmpdir(), 'review-effect-'));
    const git = (args: string[]) =>
      execFileSync('git', args, { cwd: directory, encoding: 'utf8' });
    try {
      git(['init', '-q']);
      const commit = () => {
        git(['add', '.']);
        git([
          '-c',
          'user.name=Example',
          '-c',
          'user.email=example@example.invalid',
          '-c',
          'commit.gpgsign=false',
          'commit',
          '-qm',
          'fixture',
        ]);
        return git(['rev-parse', 'HEAD']).trim();
      };
      writeFileSync(
        join(directory, 'identity.ts'),
        '/**\n * # Notes\n * Existing guard.\n * See issue #42.\n */\nexport const identity = (value: string) => value;\n',
      );
      const before = commit();
      writeFileSync(
        join(directory, 'identity.ts'),
        '/**\n * # Notes\n * The existing guard preserves input.\n * See issue #42.\n */\nexport const identity = (value: string) => value;\n',
      );
      const after = commit();
      setGitHubRunner({
        runGh() {
          throw new Error('unexpected gh call');
        },
        runGit: git,
      });
      expect(classifyRangeEffect(before, after)).toBe('non-behavioral');
      git(['update-index', '--chmod=+x', 'identity.ts']);
      git([
        '-c',
        'user.name=Example',
        '-c',
        'user.email=example@example.invalid',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '-qm',
        'mode fixture',
      ]);
      expect(
        classifyRangeEffect(after, git(['rev-parse', 'HEAD']).trim()),
      ).toBe('behavioral');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
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
