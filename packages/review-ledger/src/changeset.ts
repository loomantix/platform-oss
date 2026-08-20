import { runGit } from './github.js';
import { fail } from './errors.js';
import { requireSha } from './hash.js';
import type {
  ChangedFile,
  Changeset,
  ChangesetClass,
  ChangesetReport,
  ClassifyOptions,
  FileClassification,
} from './types.js';

/**
 * Version of the rules below, recorded on every changeset this module produces.
 *
 * A later pass that lexes comments out of `app`, or that reclassifies a path
 * pattern, changes what a stored count means. Without this field the change
 * would silently rewrite the meaning of every historical data point, and a
 * trend line drawn across the boundary would be measuring the classifier
 * rather than the work.
 */
export const CHANGESET_CLASSIFIER_VERSION = 1;

/**
 * Prompt surfaces treated as source whatever the extension, per the protocol.
 *
 * These paths are read by a model as instructions and sync to every consumer,
 * so a defect in them ships exactly like a code defect. Callers whose prompt
 * surface lives elsewhere pass their own prefixes; the protocol's rule is about
 * the role of the file, not about these particular directory names.
 */
export const DEFAULT_PROMPT_SURFACES: readonly string[] = [
  '.claude/',
  '.codex/',
  '.agents/',
  '.gemini/',
  '.github/copilot-instructions.md',
  'AGENTS.md',
  'CLAUDE.md',
  'GEMINI.md',
] as const;

/**
 * Generated output: recorded for visibility, excluded from every ratio.
 *
 * One lockfile bump is larger than most pull requests, so counting it as work
 * craters tokens-per-line for the pass that happened to carry it.
 */
const GENERATED_BASENAMES: ReadonlySet<string> = new Set([
  'pnpm-lock.yaml',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'bun.lockb',
  'cargo.lock',
  'poetry.lock',
  'uv.lock',
  'gemfile.lock',
  'composer.lock',
  'go.sum',
  'flake.lock',
  'podfile.lock',
  'pubspec.lock',
]);

const GENERATED_PREFIXES: readonly string[] = [
  'dist/',
  'build/',
  'vendor/',
  'node_modules/',
  'target/debug/',
  'target/release/',
];

const GENERATED_SEGMENTS: readonly string[] = ['/dist/', '/build/', '/vendor/'];

/** Dependency and build manifests: source even with an inert extension. */
const CONFIG_BASENAMES: ReadonlySet<string> = new Set([
  'package.json',
  'pnpm-workspace.yaml',
  'lerna.json',
  'turbo.json',
  'nx.json',
  'pyproject.toml',
  'setup.py',
  'setup.cfg',
  'cargo.toml',
  'go.mod',
  'gemfile',
  'podfile',
  'pubspec.yaml',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'composer.json',
  'dockerfile',
  'docker-compose.yml',
  'docker-compose.yaml',
  'makefile',
  'justfile',
  'procfile',
  '.gitlab-ci.yml',
  '.platform-config.yml',
]);

const CONFIG_PREFIXES: readonly string[] = [
  '.github/workflows/',
  '.github/actions/',
  'helm/',
  'charts/',
  'k8s/',
  'kubernetes/',
  'deploy/',
  'terraform/',
  'infra/',
  'migrations/',
  'db/migrations/',
  'prisma/',
];

const CONFIG_SEGMENTS: readonly string[] = ['/migrations/', '/helm/'];

const CONFIG_EXTENSIONS: ReadonlySet<string> = new Set([
  'tf',
  'tfvars',
  'sql',
  'prisma',
  'graphql',
  'gql',
  'proto',
]);

/** Docs, inert config, and fixtures: never on their own a reason to review. */
const DOCS_BASENAMES: ReadonlySet<string> = new Set([
  'license',
  'license.md',
  'license.txt',
  'notice',
  'changelog',
  'changelog.md',
  'readme',
  'readme.md',
  'authors',
  'codeowners',
  '.gitignore',
  '.gitattributes',
  '.prettierignore',
  '.npmignore',
  '.editorconfig',
  '.env.example',
]);

const DOCS_EXTENSIONS: ReadonlySet<string> = new Set([
  'md',
  'mdx',
  'txt',
  'rst',
  'adoc',
]);

const DOCS_PREFIXES: readonly string[] = ['docs/', 'handbook/'];

const DOCS_SEGMENTS: readonly string[] = ['/docs/', '/__snapshots__/'];

/** Test paths. Path-based and reliable, so it ships ahead of the lexer. */
const TEST_SEGMENTS: readonly string[] = [
  '/__tests__/',
  '/tests/',
  '/test/',
  '/spec/',
];

const TEST_PREFIXES: readonly string[] = [
  '__tests__/',
  'tests/',
  'test/',
  'spec/',
  'e2e/',
];

const TEST_BASENAMES: ReadonlySet<string> = new Set(['conftest.py']);

/**
 * Extension to language key for `linesByLanguage`.
 *
 * Tokens per application line differ enormously between languages, so a
 * cross-repository comparison without the language mix is confounded. Only
 * mapped extensions produce a key: inventing one from an unknown extension
 * would manufacture a language that no rate of comparison could interpret.
 */
const LANGUAGE_BY_EXTENSION: Readonly<Record<string, string>> = {
  ts: 'ts',
  tsx: 'tsx',
  js: 'js',
  jsx: 'jsx',
  mjs: 'js',
  cjs: 'js',
  py: 'py',
  rs: 'rs',
  go: 'go',
  java: 'java',
  kt: 'kt',
  kts: 'kt',
  swift: 'swift',
  rb: 'rb',
  cs: 'cs',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  sh: 'sh',
  bash: 'sh',
  sql: 'sql',
  tf: 'tf',
  tfvars: 'tf',
  prisma: 'prisma',
  graphql: 'graphql',
  gql: 'graphql',
  proto: 'proto',
  yml: 'yaml',
  yaml: 'yaml',
  json: 'json',
  toml: 'toml',
  md: 'md',
  mdx: 'md',
  vue: 'vue',
  svelte: 'svelte',
  dart: 'dart',
  php: 'php',
  scala: 'scala',
};

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '');
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

function extensionOf(path: string): string {
  const name = basename(path);
  const dot = name.lastIndexOf('.');
  if (dot <= 0) {
    return '';
  }
  return name.slice(dot + 1).toLowerCase();
}

function hasPrefix(path: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => path.startsWith(prefix));
}

function hasSegment(path: string, segments: readonly string[]): boolean {
  return segments.some((segment) => path.includes(segment));
}

function isGenerated(path: string, name: string): boolean {
  return (
    GENERATED_BASENAMES.has(name) ||
    hasPrefix(path, GENERATED_PREFIXES) ||
    hasSegment(path, GENERATED_SEGMENTS) ||
    /\.min\.(js|css)$/.test(name) ||
    /\.bundle\.(js|mjs|cjs)$/.test(name) ||
    /\.generated\.[^.]+$/.test(name) ||
    /\.snap$/.test(name) ||
    /\.pb\.go$/.test(name) ||
    /_pb2(_grpc)?\.py$/.test(name) ||
    /\.g\.dart$/.test(name)
  );
}

function isTest(path: string, name: string): boolean {
  return (
    TEST_BASENAMES.has(name) ||
    hasPrefix(path, TEST_PREFIXES) ||
    hasSegment(path, TEST_SEGMENTS) ||
    /\.(test|spec)\.[^.]+$/.test(name) ||
    /_test\.(go|py|rb)$/.test(name)
  );
}

function isFixture(path: string, name: string): boolean {
  return /\.fixture\.[^.]+$/.test(name) || path.includes('/fixtures/');
}

function isConfig(path: string, name: string, extension: string): boolean {
  return (
    CONFIG_BASENAMES.has(name) ||
    CONFIG_EXTENSIONS.has(extension) ||
    hasPrefix(path, CONFIG_PREFIXES) ||
    hasSegment(path, CONFIG_SEGMENTS) ||
    /^dockerfile(\.|$)/.test(name) ||
    /^tsconfig(\.[^.]+)?\.json$/.test(name) ||
    /^requirements(-[^.]+)?\.txt$/.test(name)
  );
}

function isDocs(path: string, name: string, extension: string): boolean {
  return (
    DOCS_BASENAMES.has(name) ||
    DOCS_EXTENSIONS.has(extension) ||
    hasPrefix(path, DOCS_PREFIXES) ||
    hasSegment(path, DOCS_SEGMENTS)
  );
}

/**
 * Classify one path into a telemetry class and a review-gate decision.
 *
 * The two outputs are deliberately separate. `class` answers what kind of work
 * a line represents, which is what makes tokens-per-application-line mean
 * anything; `reviewSignificant` answers whether a lane must run at all. A
 * lockfile is the case that proves they cannot be one field: it must be
 * reviewed and it must stay out of the denominator.
 *
 * Rules are applied in a fixed order and the first match wins, so a path that
 * satisfies two rules classifies the same way every time. Anything unmatched
 * falls through to `app`, which is the protocol's "anything else — treat as
 * source": an unrecognised path is reviewed rather than silently skipped.
 */
export function classifyPath(
  rawPath: string,
  options?: ClassifyOptions,
): FileClassification {
  const path = normalizePath(rawPath);
  const name = basename(path).toLowerCase();
  const extension = extensionOf(path);
  const promptSurfaces = options?.promptSurfaces ?? DEFAULT_PROMPT_SURFACES;

  const language = LANGUAGE_BY_EXTENSION[extension] ?? null;
  const classify = (
    cls: ChangesetClass,
    reviewSignificant: boolean,
  ): FileClassification => ({ path, class: cls, reviewSignificant, language });

  if (isGenerated(path, name)) {
    // A lockfile is generated and review-significant at once: the dependency
    // bump must be reviewed, and its line count must stay out of the
    // denominator. Collapsing the two axes would either skip a supply-chain
    // change or destroy the metric.
    return classify('generated', GENERATED_BASENAMES.has(name));
  }
  if (isTest(path, name)) {
    return classify('test', true);
  }
  if (
    promptSurfaces.some(
      (surface) =>
        path === surface ||
        (surface.endsWith('/') && path.startsWith(surface)) ||
        path.endsWith(`/${surface}`),
    )
  ) {
    return classify('app', true);
  }
  if (isFixture(path, name)) {
    return classify('docsConfig', false);
  }
  if (isConfig(path, name, extension)) {
    return classify('app', true);
  }
  if (isDocs(path, name, extension)) {
    return classify('docsConfig', false);
  }
  return classify('app', true);
}

function emptyChangeset(): Changeset {
  return {
    classifierVersion: CHANGESET_CLASSIFIER_VERSION,
    files: { app: 0, test: 0, docsConfig: 0, generated: 0 },
    linesChanged: {
      app: 0,
      test: 0,
      comment: null,
      docsConfig: 0,
      generated: 0,
      blank: 0,
    },
    linesByLanguage: {},
  };
}

/**
 * Classify a set of changed files into the changeset a telemetry record holds.
 *
 * Churn — added plus deleted — is the measure, never net lines. Net goes to
 * zero or negative on a refactor, which is exactly the pass whose cost most
 * needs a denominator.
 *
 * `comment` stays `null` because no lexer has shipped: line-prefix heuristics
 * are wrong on block comments, `#` inside shell strings, URLs in string
 * literals, and JSX. `null` and `0` are different answers and aggregation must
 * exclude the first rather than average it in, so the field is never filled
 * with a guess.
 */
export function classifyFiles(
  files: readonly ChangedFile[],
  options?: ClassifyOptions,
): ChangesetReport {
  const changeset = emptyChangeset();
  const classifications: FileClassification[] = [];
  let reviewSignificantFiles = 0;

  for (const file of files) {
    const classification = classifyPath(file.path, options);
    classifications.push(classification);
    if (classification.reviewSignificant) {
      reviewSignificantFiles += 1;
    }
    changeset.files[classification.class] += 1;

    const churn = file.added + file.deleted;
    if (!Number.isSafeInteger(churn) || churn < 0) {
      fail(`changed file ${file.path} reports an invalid churn count`);
    }
    const blank = file.blank ?? 0;
    if (!Number.isSafeInteger(blank) || blank < 0 || blank > churn) {
      fail(`changed file ${file.path} reports an invalid blank count`);
    }

    // The classes partition the churn: a blank line is counted once, as blank,
    // and not again under the class of the file that carried it. When the
    // comment lexer lands it partitions the same total further, which is what
    // `classifierVersion` exists to record.
    const counted = churn - blank;
    changeset.linesChanged.blank += blank;
    changeset.linesChanged[classification.class] += counted;

    if (classification.class !== 'generated' && classification.language) {
      const key = classification.language;
      changeset.linesByLanguage[key] =
        (changeset.linesByLanguage[key] ?? 0) + counted;
    }
  }

  return {
    changeset,
    classifications,
    reviewSignificantFiles,
    skip: reviewSignificantFiles === 0,
  };
}

function unquotePath(raw: string): string {
  if (!raw.startsWith('"') || !raw.endsWith('"')) {
    return raw;
  }
  // Git escapes a non-ASCII path one UTF-8 byte at a time, so the octal
  // escapes are decoded into bytes and the whole path is decoded once. Decoding
  // each escape as a character instead would turn every accented path into a
  // different string from the one the diff named.
  const inner = raw.slice(1, -1);
  const bytes: number[] = [];
  const simple: Record<string, number> = {
    n: 0x0a,
    t: 0x09,
    r: 0x0d,
    '"': 0x22,
    '\\': 0x5c,
  };
  for (let i = 0; i < inner.length; i++) {
    const char = inner[i]!;
    if (char !== '\\') {
      bytes.push(...Buffer.from(char, 'utf8'));
      continue;
    }
    const next = inner[i + 1];
    if (next === undefined) {
      bytes.push(0x5c);
      continue;
    }
    const octal = inner.slice(i + 1, i + 4);
    if (/^[0-7]{3}$/.test(octal)) {
      bytes.push(parseInt(octal, 8));
      i += 3;
      continue;
    }
    const mapped = simple[next];
    if (mapped === undefined) {
      bytes.push(...Buffer.from(next, 'utf8'));
    } else {
      bytes.push(mapped);
    }
    i += 1;
  }
  return Buffer.from(bytes).toString('utf8');
}

/**
 * Read the destination path from a `diff --git` header.
 *
 * The `---`/`+++` lines are authoritative and cover every textual change, but a
 * binary or mode-only change has no such lines at all. Dropping those files
 * would understate the changeset the reviewer was handed, so the header is the
 * fallback.
 */
function headerPath(rest: string): string | null {
  const quoted = /^("(?:[^"\\]|\\.)*") ("(?:[^"\\]|\\.)*")$/.exec(rest);
  if (quoted) {
    return stripSide(quoted[2]!);
  }
  const split = rest.lastIndexOf(' b/');
  if (split === -1) {
    return null;
  }
  return stripSide(rest.slice(split + 1));
}

function stripSide(raw: string): string | null {
  if (raw === '/dev/null') {
    return null;
  }
  const unquoted = unquotePath(raw);
  return unquoted.replace(/^[ab]\//, '');
}

/**
 * Parse a unified diff into per-file churn, including blank-line churn.
 *
 * Churn is read from the patch rather than from `git diff --numstat` because
 * the two agree on added and deleted counts and only the patch carries the
 * line content. Blank churn is the one part of the class partition that needs
 * no lexer, and recording it from a guess is not an option.
 *
 * Binary files carry no lines and contribute a zero-churn entry: they are still
 * files in the changeset, and dropping them would understate the file counts.
 */
export function parseDiffPatch(patch: string): ChangedFile[] {
  const files: ChangedFile[] = [];
  let current: ChangedFile | null = null;
  let inHunk = false;

  const push = (): void => {
    if (current !== null) {
      files.push(current);
    }
  };

  for (const rawLine of patch.split(/\r?\n/)) {
    if (rawLine.startsWith('diff --git ')) {
      push();
      current = {
        path: headerPath(rawLine.slice('diff --git '.length).trim()) ?? '',
        added: 0,
        deleted: 0,
        blank: 0,
      };
      inHunk = false;
      continue;
    }
    if (current === null) {
      continue;
    }
    if (rawLine.startsWith('--- ')) {
      const left = stripSide(rawLine.slice(4).trim());
      if (left !== null) {
        current.path = left;
      }
      continue;
    }
    if (rawLine.startsWith('+++ ')) {
      const right = stripSide(rawLine.slice(4).trim());
      if (right !== null) {
        current.path = right;
      }
      continue;
    }
    if (rawLine.startsWith('@@')) {
      inHunk = true;
      continue;
    }
    if (!inHunk || rawLine.startsWith('\\ No newline')) {
      continue;
    }
    const prefix = rawLine.slice(0, 1);
    if (prefix !== '+' && prefix !== '-') {
      continue;
    }
    const content = rawLine.slice(1);
    if (prefix === '+') {
      current.added += 1;
    } else {
      current.deleted += 1;
    }
    if (content.trim() === '') {
      current.blank = (current.blank ?? 0) + 1;
    }
  }
  push();

  const named = files.filter((file) => file.path !== '');
  if (named.length !== files.length) {
    fail('unified diff contains a file header with no readable path');
  }
  return named;
}

/**
 * Classify the pinned `base..head` review range from the local clone.
 *
 * The range is the one the ledger pinned, never the working tree: a classifier
 * that reads uncommitted state would report a changeset no reviewer saw.
 */
export function classifyRange(params: {
  base: string;
  head: string;
  options?: ClassifyOptions | undefined;
}): ChangesetReport {
  requireSha(params.base, 'base');
  requireSha(params.head, 'head');
  const patch = runGit([
    'diff',
    '--no-color',
    '--no-ext-diff',
    '--find-renames',
    `${params.base}..${params.head}`,
  ]);
  return classifyFiles(parseDiffPatch(patch), params.options);
}
