/**
 * CLI interface for @loomantix/review-ledger.
 * Create, reconcile, and disposition deterministic local-review ledger entries.
 */

import { readFileSync } from 'node:fs';
import {
  PACKAGE_VERSION,
  PROTOCOL_VERSION,
  SHA_64_RE,
  SUPPORTED_CLASSIFICATIONS,
  SUPPORTED_ENGINES,
  SUPPORTED_OUTCOMES,
  SUPPORTED_SEVERITIES,
  SUPPORTED_SIDES,
} from './constants.js';
import { fail } from './errors.js';
import { assertRegularFile, parseJsonOrFail } from './io.js';
import { requireSha } from './hash.js';
import {
  attest,
  dispose,
  postFinding,
  postPrComment,
  preflightAnchor,
  reconcile,
  reopenOccurrence,
  reply,
  resolve,
  verifyLedger,
  writeResult,
} from './ledger.js';
import { readResult, validateResult, writeBlockedResult } from './result.js';
import { formatFindings } from './format.js';
import { resetGitHubRunner } from './github.js';
import type {
  ReviewFinding,
  SupportedClassification,
  SupportedEngine,
  SupportedOutcome,
  SupportedSeverity,
  SupportedSide,
} from './types.js';

interface CliArgs {
  command?: string | undefined;
  protocolVersion?: boolean | undefined;
  version?: boolean | undefined;
  repo?: string | undefined;
  pr?: number | undefined;
  head?: string | undefined;
  base?: string | undefined;
  before?: string | undefined;
  engine?: SupportedEngine | undefined;
  round?: number | undefined;
  fingerprint?: string | undefined;
  occurrence?: number | undefined;
  severity?: SupportedSeverity | undefined;
  lens?: string | undefined;
  outcome?: SupportedOutcome | undefined;
  commentId?: number | undefined;
  threadId?: string | undefined;
  path?: string | undefined;
  line?: number | undefined;
  fileLevel?: boolean | undefined;
  side?: SupportedSide | undefined;
  contentFile?: string | undefined;
  bodyFile?: string | undefined;
  resultFile?: string | undefined;
  resultHead?: string | undefined;
  allowedHeadsFile?: string | undefined;
  threadsFile?: string | undefined;
  actor?: string | undefined;
  historicalCommentIdsFile?: string | undefined;
  expectedResultSha256?: string | undefined;
  expectedThreadsSha256?: string | undefined;
  blockerFile?: string | undefined;
  classification?: SupportedClassification | undefined;
  jsonFile?: string | undefined;
  file?: string | undefined;
}

function writeSortedJson(value: unknown): void {
  const source = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    sorted[key] = source[key];
  }
  process.stdout.write(JSON.stringify(sorted) + '\n');
}

function parsePositiveInteger(value: string, name: string): number {
  if (!/^[1-9]\d*$/.test(value)) {
    fail(`${name} must be a positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    fail(`${name} must be a positive safe integer`);
  }
  return parsed;
}

function parseEnum<T extends string>(
  arg: string,
  value: string,
  allowed: readonly T[],
): T {
  if (!allowed.includes(value as T)) {
    fail(`${arg} must be one of: ${allowed.join(', ')}`);
  }
  return value as T;
}

function parseCliArgs(argv: string[]): CliArgs {
  const args: CliArgs = {};
  let i = 0;

  while (i < argv.length) {
    const arg = argv[i]!;

    if (arg === '--protocol-version') {
      args.protocolVersion = true;
      i++;
      continue;
    }

    if (arg === '--version') {
      args.version = true;
      i++;
      continue;
    }

    if (!arg.startsWith('-') && args.command === undefined) {
      args.command = arg;
      i++;
      continue;
    }

    if (arg === '--file-level') {
      args.fileLevel = true;
      i++;
      continue;
    }

    const next = argv[i + 1];
    const parseVal = (name: string): string => {
      if (next === undefined || next.startsWith('--')) {
        fail(`missing argument for ${name}`);
      }
      i += 2;
      return next;
    };

    switch (arg) {
      case '--repo':
        args.repo = parseVal(arg);
        break;
      case '--pr':
        args.pr = parsePositiveInteger(parseVal(arg), arg);
        break;
      case '--head':
        args.head = parseVal(arg);
        break;
      case '--base':
        args.base = parseVal(arg);
        break;
      case '--before':
        args.before = parseVal(arg);
        break;
      case '--engine':
        args.engine = parseEnum(arg, parseVal(arg), SUPPORTED_ENGINES);
        break;
      case '--round':
        args.round = parsePositiveInteger(parseVal(arg), arg);
        break;
      case '--fingerprint':
        args.fingerprint = parseVal(arg);
        break;
      case '--occurrence':
        args.occurrence = parsePositiveInteger(parseVal(arg), arg);
        break;
      case '--severity':
        args.severity = parseEnum(arg, parseVal(arg), SUPPORTED_SEVERITIES);
        break;
      case '--lens':
        args.lens = parseVal(arg);
        break;
      case '--outcome':
        args.outcome = parseEnum(arg, parseVal(arg), SUPPORTED_OUTCOMES);
        break;
      case '--comment-id':
        args.commentId = parsePositiveInteger(parseVal(arg), arg);
        break;
      case '--thread-id':
        args.threadId = parseVal(arg);
        break;
      case '--path':
        args.path = parseVal(arg);
        break;
      case '--line':
        args.line = parsePositiveInteger(parseVal(arg), arg);
        break;
      case '--side':
        args.side = parseEnum(arg, parseVal(arg), SUPPORTED_SIDES);
        break;
      case '--content-file':
        args.contentFile = parseVal(arg);
        break;
      case '--body-file':
        args.bodyFile = parseVal(arg);
        break;
      case '--result-file':
        args.resultFile = parseVal(arg);
        break;
      case '--result-head':
        args.resultHead = parseVal(arg);
        break;
      case '--allowed-heads-file':
        args.allowedHeadsFile = parseVal(arg);
        break;
      case '--threads-file':
        args.threadsFile = parseVal(arg);
        break;
      case '--actor':
        args.actor = parseVal(arg);
        break;
      case '--historical-comment-ids-file':
        args.historicalCommentIdsFile = parseVal(arg);
        break;
      case '--expected-result-sha256':
        args.expectedResultSha256 = parseVal(arg);
        break;
      case '--expected-threads-sha256':
        args.expectedThreadsSha256 = parseVal(arg);
        break;
      case '--blocker-file':
        args.blockerFile = parseVal(arg);
        break;
      case '--classification':
        args.classification = parseEnum(
          arg,
          parseVal(arg),
          SUPPORTED_CLASSIFICATIONS,
        );
        break;
      case '--file':
        args.file = parseVal(arg);
        break;
      case '--json-file':
        args.jsonFile = parseVal(arg);
        break;
      default:
        fail(`unknown argument: ${arg}`);
    }
  }

  return args;
}

function validateArgs(args: CliArgs): void {
  if (args.protocolVersion) {
    return;
  }
  if (!args.command) {
    fail('subcommand required');
  }

  for (const name of ['head', 'base', 'before', 'resultHead'] as const) {
    const val = args[name];
    if (val !== undefined) {
      requireSha(val, name === 'resultHead' ? 'result-head' : name);
    }
  }

  if (
    args.expectedResultSha256 !== undefined &&
    !SHA_64_RE.test(args.expectedResultSha256)
  ) {
    fail('--expected-result-sha256 must be a lowercase SHA-256 digest');
  }

  if (
    args.contentFile &&
    (args.command === 'post-finding' ||
      args.command === 'reopen-occurrence' ||
      args.command === 'dispose')
  ) {
    const required: Array<keyof CliArgs> = ['engine', 'round', 'fingerprint'];
    if (args.command === 'post-finding') {
      required.push('severity', 'lens');
    }
    const missing = required.filter((r) => args[r] === undefined);
    if (missing.length > 0) {
      const names = missing.map(
        (m) =>
          `--${String(m)
            .replace(/([A-Z])/g, '-$1')
            .toLowerCase()}`,
      );
      fail(`v3 content mode requires ${names.join(', ')}`);
    }
  }

  if (args.command === 'verify-ledger') {
    const resultFields: Array<keyof CliArgs> = [
      'engine',
      'round',
      'base',
      'before',
      'resultFile',
    ];
    const present = resultFields.map((f) => args[f] !== undefined);
    if (present.some(Boolean) && !present.every(Boolean)) {
      fail(
        'verify-ledger result evidence requires --engine, --round, --base, --before, and --result-file',
      );
    }
  }
}

/**
 * Parse argv, dispatch the requested subcommand, and return an exit code.
 */
export function runCli(argv: string[] = process.argv.slice(2)): number {
  resetGitHubRunner();
  const args = parseCliArgs(argv);

  if (args.version) {
    process.stdout.write(`${PACKAGE_VERSION}\n`);
    return 0;
  }

  if (args.protocolVersion) {
    process.stdout.write(`${PROTOCOL_VERSION}\n`);
    return 0;
  }

  validateArgs(args);

  switch (args.command) {
    case 'preflight-anchor': {
      if (!args.repo || args.pr === undefined || !args.head || !args.path) {
        fail('preflight-anchor requires --repo, --pr, --head, and --path');
      }
      if (args.line === undefined && !args.fileLevel) {
        fail('preflight-anchor requires --line or --file-level');
      }
      const out = preflightAnchor({
        repo: args.repo,
        pr: args.pr,
        head: args.head,
        path: args.path,
        line: args.line,
        fileLevel: args.fileLevel,
        side: args.side,
      });
      process.stdout.write(JSON.stringify(out) + '\n');
      break;
    }
    case 'post-finding': {
      if (!args.repo || args.pr === undefined || !args.head || !args.path) {
        fail('post-finding requires --repo, --pr, --head, and --path');
      }
      if (args.line === undefined && !args.fileLevel) {
        fail('post-finding requires --line or --file-level');
      }
      if (!args.contentFile && !args.bodyFile) {
        fail('post-finding requires --content-file or --body-file');
      }
      const out = postFinding({
        repo: args.repo,
        pr: args.pr,
        head: args.head,
        path: args.path,
        line: args.line,
        fileLevel: args.fileLevel,
        side: args.side,
        contentFile: args.contentFile,
        bodyFile: args.bodyFile,
        engine: args.engine,
        round: args.round,
        fingerprint: args.fingerprint,
        occurrence: args.occurrence,
        severity: args.severity,
        lens: args.lens,
      });
      process.stdout.write(JSON.stringify(out) + '\n');
      break;
    }
    case 'reopen-occurrence': {
      if (
        !args.repo ||
        args.pr === undefined ||
        !args.head ||
        !args.engine ||
        args.round === undefined ||
        !args.fingerprint ||
        args.occurrence === undefined ||
        !args.severity ||
        !args.lens ||
        args.commentId === undefined ||
        !args.threadId ||
        !args.contentFile
      ) {
        fail('reopen-occurrence missing required parameters');
      }
      const out = reopenOccurrence({
        repo: args.repo,
        pr: args.pr,
        head: args.head,
        engine: args.engine,
        round: args.round,
        fingerprint: args.fingerprint,
        occurrence: args.occurrence,
        severity: args.severity,
        lens: args.lens,
        commentId: args.commentId,
        threadId: args.threadId,
        contentFile: args.contentFile,
      });
      process.stdout.write(JSON.stringify(out) + '\n');
      break;
    }
    case 'dispose': {
      if (
        !args.repo ||
        args.pr === undefined ||
        !args.head ||
        !args.engine ||
        args.round === undefined ||
        !args.fingerprint ||
        !args.outcome ||
        args.commentId === undefined ||
        !args.threadId ||
        !args.contentFile
      ) {
        fail('dispose missing required parameters');
      }
      const out = dispose({
        repo: args.repo,
        pr: args.pr,
        head: args.head,
        engine: args.engine,
        round: args.round,
        fingerprint: args.fingerprint,
        occurrence: args.occurrence ?? 1,
        outcome: args.outcome,
        commentId: args.commentId,
        threadId: args.threadId,
        contentFile: args.contentFile,
      });
      process.stdout.write(JSON.stringify(out) + '\n');
      break;
    }
    case 'reply': {
      if (
        !args.repo ||
        args.pr === undefined ||
        !args.head ||
        args.commentId === undefined ||
        !args.bodyFile
      ) {
        fail(
          'reply requires --repo, --pr, --head, --comment-id, and --body-file',
        );
      }
      const out = reply({
        repo: args.repo,
        pr: args.pr,
        head: args.head,
        commentId: args.commentId,
        bodyFile: args.bodyFile,
      });
      process.stdout.write(JSON.stringify(out) + '\n');
      break;
    }
    case 'post-pr-comment': {
      if (!args.repo || args.pr === undefined || !args.head || !args.bodyFile) {
        fail('post-pr-comment requires --repo, --pr, --head, and --body-file');
      }
      const out = postPrComment({
        repo: args.repo,
        pr: args.pr,
        head: args.head,
        bodyFile: args.bodyFile,
      });
      process.stdout.write(JSON.stringify(out) + '\n');
      break;
    }
    case 'validate-result': {
      if (
        !args.head ||
        !args.engine ||
        args.round === undefined ||
        !args.base ||
        !args.before ||
        !args.resultFile
      ) {
        fail('validate-result missing required arguments');
      }
      const out = validateResult({
        head: args.head,
        engine: args.engine,
        round: args.round,
        base: args.base,
        before: args.before,
        resultFile: args.resultFile,
        resultHead: args.resultHead,
      });
      writeSortedJson(out);
      break;
    }
    case 'write-result': {
      if (
        !args.head ||
        !args.engine ||
        args.round === undefined ||
        !args.base ||
        !args.before ||
        !args.resultFile ||
        !args.repo ||
        args.pr === undefined
      ) {
        fail('write-result missing required arguments');
      }
      const out = writeResult({
        head: args.head,
        engine: args.engine,
        round: args.round,
        base: args.base,
        before: args.before,
        resultFile: args.resultFile,
        repo: args.repo,
        pr: args.pr,
        allowedHeadsFile: args.allowedHeadsFile,
        actor: args.actor,
        historicalCommentIdsFile: args.historicalCommentIdsFile,
        classification: args.classification,
      });
      writeSortedJson(out);
      break;
    }
    case 'write-blocked-result': {
      if (
        !args.head ||
        !args.engine ||
        args.round === undefined ||
        !args.base ||
        !args.before ||
        !args.resultFile ||
        !args.blockerFile
      ) {
        fail('write-blocked-result missing required arguments');
      }
      const out = writeBlockedResult({
        head: args.head,
        engine: args.engine,
        round: args.round,
        base: args.base,
        before: args.before,
        resultFile: args.resultFile,
        blockerFile: args.blockerFile,
      });
      writeSortedJson(out);
      break;
    }
    case 'attest': {
      if (
        !args.repo ||
        args.pr === undefined ||
        !args.head ||
        !args.engine ||
        args.round === undefined ||
        !args.base ||
        !args.before ||
        !args.resultFile ||
        !args.expectedResultSha256
      ) {
        fail(
          'attest requires --repo, --pr, --head, --engine, --round, --base, --before, --result-file, and --expected-result-sha256',
        );
      }
      const out = attest({
        repo: args.repo,
        pr: args.pr,
        head: args.head,
        engine: args.engine,
        round: args.round,
        base: args.base,
        before: args.before,
        resultFile: args.resultFile,
        threadsFile: args.threadsFile,
        allowedHeadsFile: args.allowedHeadsFile,
        actor: args.actor,
        historicalCommentIdsFile: args.historicalCommentIdsFile,
        expectedResultSha256: args.expectedResultSha256,
        expectedThreadsSha256: args.expectedThreadsSha256,
        contentFile: args.contentFile,
      });
      process.stdout.write(JSON.stringify(out) + '\n');
      break;
    }
    case 'resolve': {
      if (!args.repo || args.pr === undefined || !args.head || !args.threadId) {
        fail('resolve requires --repo, --pr, --head, and --thread-id');
      }
      const out = resolve({
        repo: args.repo,
        pr: args.pr,
        head: args.head,
        threadId: args.threadId,
      });
      process.stdout.write(JSON.stringify(out) + '\n');
      break;
    }
    case 'reconcile': {
      if (
        !args.repo ||
        args.pr === undefined ||
        !args.head ||
        !args.fingerprint
      ) {
        fail('reconcile requires --repo, --pr, --head, and --fingerprint');
      }
      const out = reconcile({
        repo: args.repo,
        pr: args.pr,
        head: args.head,
        fingerprint: args.fingerprint,
      });
      writeSortedJson(out);
      break;
    }
    case 'verify-ledger': {
      if (!args.repo || args.pr === undefined || !args.head) {
        fail('verify-ledger requires --repo, --pr, and --head');
      }
      const out = verifyLedger({
        repo: args.repo,
        pr: args.pr,
        head: args.head,
        threadsFile: args.threadsFile,
        actor: args.actor,
        historicalCommentIdsFile: args.historicalCommentIdsFile,
        engine: args.engine,
        round: args.round,
        base: args.base,
        before: args.before,
        resultHead: args.resultHead,
        resultFile: args.resultFile,
        allowedHeadsFile: args.allowedHeadsFile,
        expectedThreadsSha256: args.expectedThreadsSha256,
      });
      writeSortedJson(out);
      break;
    }
    case 'read-result': {
      const targetFile = args.file ?? args.resultFile;
      if (!targetFile) {
        fail('read-result requires --file or --result-file');
      }
      const out = readResult(targetFile);
      process.stdout.write(JSON.stringify(out, null, 2) + '\n');
      break;
    }
    case 'format-findings': {
      const jsonPath = args.jsonFile ?? args.file;
      if (!jsonPath) {
        fail('format-findings requires --json-file or --file');
      }
      assertRegularFile(
        jsonPath,
        'findings file must be a regular non-symlink file',
      );
      const parsed = parseJsonOrFail(
        readFileSync(jsonPath, 'utf8'),
        'findings file must contain valid UTF-8 JSON',
      );
      if (
        !Array.isArray(parsed) ||
        parsed.some(
          (row) =>
            typeof row !== 'object' || row === null || Array.isArray(row),
        )
      ) {
        fail('findings file must contain a JSON array of finding objects');
      }
      const formatted = formatFindings(parsed as ReviewFinding[]);
      process.stdout.write(formatted + '\n');
      break;
    }
    default:
      fail(`unknown command: ${args.command}`);
  }

  return 0;
}
