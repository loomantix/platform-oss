import { getGitHubRunner } from './github.js';

/**
 * Whether a Git range altered a surface that executes.
 *
 * `behavioral` is the fail-closed answer. Every path that cannot be proven
 * inert resolves to it, so an unknown language, an unparseable line, a rename,
 * or a mode change costs a pass nothing worse than the classification it had to
 * make before this check existed.
 */
export type RangeEffect = 'behavioral' | 'non-behavioral';

/**
 * Extensions the review chain treats as documentation, configuration, or
 * fixture data rather than as source.
 *
 * This mirrors the changeset classification in the review workflow, with two
 * consequences worth stating. Paths under an engine's prompt directory are
 * source whatever their extension, because the model reads them as
 * instructions. And a path whose content executes — a workflow, a manifest, a
 * lockfile, a review-gating owners file — is not configuration in the inert
 * sense this set means, whatever its extension. Both are excluded below, and
 * both then fail closed: `.md`, `.yml`, and `.json` have no comment syntax
 * registered, so the per-path prover cannot clear them either.
 */
const DOCS_CONFIG_EXTENSIONS: ReadonlySet<string> = new Set([
  '.md',
  '.mdx',
  '.txt',
  '.rst',
  '.yml',
  '.yaml',
  '.json',
  '.toml',
  '.ini',
  '.csv',
]);

const DOCS_CONFIG_BASENAMES: ReadonlySet<string> = new Set([
  'LICENSE',
  'NOTICE',
  'CHANGELOG',
  'README',
  '.gitignore',
  '.gitattributes',
  '.env.example',
]);

/**
 * Prompt directories, one per engine in the relay.
 *
 * This helper is vendored into every engine repo, so naming only the engine
 * that happens to be reading is what lets the same Markdown edit be source in
 * one repo and inert in the next. The list is the set of prompt roots, not the
 * current engine's.
 */
const PROMPT_SURFACE_RE = /(^|\/)\.(claude|codex|agents)\//;

/**
 * Paths whose content executes, decides what executes, or decides who must
 * review it — regardless of the extension they wear.
 *
 * A workflow is `.yml` and a manifest is `.json`, so the docs/config extension
 * set would otherwise swallow both and call a rewritten pipeline or a bumped
 * dependency inert. These are the same paths the sync engine refuses to write
 * without per-file consent, for the same reason: content here controls what
 * runs in the repo, what the build installs, or who has to approve it.
 */
const EXECUTING_PATH_RES: readonly RegExp[] = [
  /(^|\/)\.github\/workflows\//,
  /(^|\/)\.github\/actions\//,
  /(^|\/)CODEOWNERS$/,
  /(^|\/)package\.json$/,
  /(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock)$/,
];

const DOCS_DIR_RE = /(^|\/)docs\//;

/**
 * Paths whose only consumer is the test runner.
 *
 * A repair confined to these is `minor` by the severity ladder: the test edit
 * alone never carries behavior. The moment a repair needs an app-code line, the
 * range stops matching and the classification becomes `material`, which is the
 * intended rule — the app change is what makes it material.
 */
const TEST_PATH_RES: readonly RegExp[] = [
  /(^|\/)__tests__\//,
  /(^|\/)tests?\//,
  /(^|\/)spec\//,
  /\.(test|spec)\.[cm]?[jt]sx?$/,
  /(^|\/)test_[^/]+\.py$/,
  /_test\.(go|py|rb)$/,
];

interface CommentSyntax {
  line: readonly string[];
  block: readonly (readonly [string, string])[];
}

/**
 * Per-extension comment syntax.
 *
 * Only languages whose comment forms are unambiguous enough to decide a line
 * from its own text are listed. Anything absent fails closed.
 */
const COMMENT_SYNTAX: ReadonlyMap<string, CommentSyntax> = new Map([
  ['.ts', { line: ['//'], block: [['/*', '*/'] as const] }],
  ['.tsx', { line: ['//'], block: [['/*', '*/'] as const] }],
  ['.js', { line: ['//'], block: [['/*', '*/'] as const] }],
  ['.jsx', { line: ['//'], block: [['/*', '*/'] as const] }],
  ['.mjs', { line: ['//'], block: [['/*', '*/'] as const] }],
  ['.cjs', { line: ['//'], block: [['/*', '*/'] as const] }],
  ['.go', { line: ['//'], block: [['/*', '*/'] as const] }],
  ['.rs', { line: ['//'], block: [['/*', '*/'] as const] }],
  ['.java', { line: ['//'], block: [['/*', '*/'] as const] }],
  ['.kt', { line: ['//'], block: [['/*', '*/'] as const] }],
  ['.swift', { line: ['//'], block: [['/*', '*/'] as const] }],
  ['.c', { line: ['//'], block: [['/*', '*/'] as const] }],
  ['.h', { line: ['//'], block: [['/*', '*/'] as const] }],
  ['.cpp', { line: ['//'], block: [['/*', '*/'] as const] }],
  ['.cs', { line: ['//'], block: [['/*', '*/'] as const] }],
  ['.tf', { line: ['#', '//'], block: [['/*', '*/'] as const] }],
  ['.tfvars', { line: ['#', '//'], block: [['/*', '*/'] as const] }],
  ['.hcl', { line: ['#', '//'], block: [['/*', '*/'] as const] }],
  ['.py', { line: ['#'], block: [] }],
  ['.rb', { line: ['#'], block: [] }],
  ['.sh', { line: ['#'], block: [] }],
  ['.bash', { line: ['#'], block: [] }],
  ['.sql', { line: ['--'], block: [['/*', '*/'] as const] }],
]);

function extensionOf(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot).toLowerCase();
}

function basenameOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

function isPromptSurface(path: string): boolean {
  return PROMPT_SURFACE_RE.test(`/${path}`);
}

function isExecutingPath(path: string): boolean {
  return EXECUTING_PATH_RES.some((pattern) => pattern.test(`/${path}`));
}

function isDocsOrConfig(path: string): boolean {
  if (isPromptSurface(path) || isExecutingPath(path)) {
    return false;
  }
  // A `docs/` segment is only a blanket answer for paths the comment prover
  // cannot read anyway. A script that lives under `docs/` still executes, so
  // let rule 2 decide it: a comment-only edit there is still inert, an edit to
  // one of its statements is not.
  if (DOCS_DIR_RE.test(`/${path}`) && !COMMENT_SYNTAX.has(extensionOf(path))) {
    return true;
  }
  const base = basenameOf(path);
  if (DOCS_CONFIG_BASENAMES.has(base)) {
    return true;
  }
  return DOCS_CONFIG_EXTENSIONS.has(extensionOf(path));
}

function isTestPath(path: string): boolean {
  // An executing path does not become inert by sitting under a test directory.
  if (isPromptSurface(path) || isExecutingPath(path)) {
    return false;
  }
  return TEST_PATH_RES.some((pattern) => pattern.test(`/${path}`));
}

/**
 * Decide whether one changed line is inert, advancing block-comment state.
 *
 * The state machine is deliberately shallow: whitespace, a line comment that
 * begins the line, and a balanced block comment that begins the line. Anything
 * else is behavioral.
 *
 * That shape is what makes it safe without a real parser. A marker hidden in a
 * string — `x = "# not a comment"` — never begins the line, so it is rejected
 * by the same rule that rejects code. The converse, a line that begins with a
 * marker but is not a comment, does not exist in any listed language.
 */
function classifyLine(
  text: string,
  syntax: CommentSyntax,
  inBlock: boolean,
): { inert: boolean; inBlock: boolean } {
  let rest = text.trim();

  if (inBlock) {
    // Only one block form can be open at a time in every listed language.
    const close = syntax.block[0]?.[1];
    if (close === undefined) {
      return { inert: false, inBlock: false };
    }
    const end = rest.indexOf(close);
    if (end === -1) {
      return { inert: true, inBlock: true };
    }
    rest = rest.slice(end + close.length).trim();
    if (rest === '') {
      return { inert: true, inBlock: false };
    }
    return { inert: false, inBlock: false };
  }

  if (rest === '') {
    return { inert: true, inBlock: false };
  }

  if (syntax.line.some((marker) => rest.startsWith(marker))) {
    return { inert: true, inBlock: false };
  }

  for (const [open, close] of syntax.block) {
    if (!rest.startsWith(open)) {
      continue;
    }
    const end = rest.indexOf(close, open.length);
    if (end === -1) {
      return { inert: true, inBlock: true };
    }
    const tail = rest.slice(end + close.length).trim();
    return { inert: tail === '', inBlock: false };
  }

  return { inert: false, inBlock: false };
}

/**
 * Whether every added and removed line in one path's patch is a comment.
 *
 * Block state is tracked independently per side and only across that side's own
 * lines, so a hunk that starts mid-block is read as continuing it. That is the
 * conservative direction: it can only accept lines a full parse would also
 * accept, because a line inside a block comment is inert either way.
 */
function isCommentOnlyPatch(patch: string, syntax: CommentSyntax): boolean {
  let leftBlock = false;
  let rightBlock = false;
  let inHunk = false;

  for (const raw of patch.split(/\r?\n/)) {
    if (raw.startsWith('@@')) {
      inHunk = true;
      leftBlock = false;
      rightBlock = false;
      continue;
    }
    if (!inHunk || raw.startsWith('\\ No newline')) {
      continue;
    }
    const prefix = raw.slice(0, 1);
    const text = raw.slice(1);
    if (prefix === '-') {
      const result = classifyLine(text, syntax, leftBlock);
      leftBlock = result.inBlock;
      if (!result.inert) {
        return false;
      }
    } else if (prefix === '+') {
      const result = classifyLine(text, syntax, rightBlock);
      rightBlock = result.inBlock;
      if (!result.inert) {
        return false;
      }
    }
  }

  return true;
}

/**
 * Classify what a Git range changed.
 *
 * This is the sole input to the `minor` / `material` decision. Severity is a
 * property of a finding and says nothing about what its fix moved, so it is
 * deliberately not consulted here: a `major` finding repaired by correcting a
 * comment is a `non-behavioral` range, and a `nit` repaired by editing a
 * conditional is a `behavioral` one.
 *
 * Reading the range rather than a marker is also what makes the rule
 * unforgeable. Severity and any declared effect field are model-authored, so a
 * gate built on either can be cleared by writing a different word. Git content
 * cannot.
 */
export function classifyRangeEffect(
  before: string,
  after: string,
): RangeEffect {
  if (before === after) {
    return 'non-behavioral';
  }

  const runner = getGitHubRunner();
  if (!runner.runGit) {
    return 'behavioral';
  }

  const status = runner
    .runGit(['diff', '--name-status', '--no-renames', `${before}..${after}`])
    .trim();
  if (status === '') {
    return 'non-behavioral';
  }

  const paths: string[] = [];
  for (const row of status.split(/\r?\n/)) {
    if (row === '') {
      continue;
    }
    const [code, path] = row.split('\t', 2);
    // Adds and deletes of a whole file are only inert when the path itself is,
    // which the per-path check below decides. Anything exotic fails closed.
    if (code === undefined || path === undefined || !/^[AMD]$/.test(code)) {
      return 'behavioral';
    }
    paths.push(path);
  }

  for (const path of paths) {
    if (isDocsOrConfig(path) || isTestPath(path)) {
      continue;
    }
    const syntax = COMMENT_SYNTAX.get(extensionOf(path));
    if (syntax === undefined) {
      return 'behavioral';
    }
    const patch = runner.runGit([
      'diff',
      '--unified=0',
      '--no-renames',
      `${before}..${after}`,
      '--',
      path,
    ]);
    if (!isCommentOnlyPatch(patch, syntax)) {
      return 'behavioral';
    }
  }

  return 'non-behavioral';
}
