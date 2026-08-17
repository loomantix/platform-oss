import {
  closeSync,
  fchmodSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { PROTOCOL_VERSION, TOKEN_RE } from './constants.js';
import { fail, LedgerError } from './errors.js';
import { sha256Bytes, sha256Text } from './hash.js';
import { readContent, validateContentString } from './protocol.js';
import type {
  BaseResultParams,
  LedgerResult,
  ValidateResultParams,
  WriteBlockedParams,
} from './types.js';

/**
 *
 */
export function readResultBytes(pathValue: string): Buffer {
  try {
    const stat = lstatSync(pathValue);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      fail('review result must be a regular non-symlink file');
    }
  } catch (err) {
    if (err instanceof LedgerError) throw err;
    fail('review result must be a regular non-symlink file');
  }
  return readFileSync(pathValue);
}

/**
 *
 */
export function resultHead(args: {
  head: string;
  resultHead?: string | undefined;
}): string {
  return args.resultHead || args.head;
}

/**
 *
 */
export function validateResultData(
  args: {
    engine: string;
    round: number;
    base: string;
    before: string;
    head: string;
    resultHead?: string | undefined;
  },
  rawInput?: Buffer | string,
): LedgerResult {
  const raw =
    rawInput !== undefined
      ? typeof rawInput === 'string'
        ? Buffer.from(rawInput, 'utf8')
        : rawInput
      : undefined;

  let data: Record<string, unknown>;
  try {
    if (raw === undefined) {
      fail('review result raw content is required');
    }
    data = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
  } catch (error) {
    if (error instanceof LedgerError) throw error;
    throw new LedgerError('review result must contain valid UTF-8 JSON', {
      cause: error,
    });
  }

  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    fail('review result must be a JSON object');
  }

  const required = new Set([
    'version',
    'status',
    'engine',
    'round',
    'baseSha',
    'beforeSha',
    'afterSha',
    'classification',
    'findingFingerprints',
    'finalLaneComplete',
  ]);
  const allowed = new Set([...required, 'blocker']);
  const keys = new Set(Object.keys(data));

  const isExactRequired =
    keys.size === required.size && [...keys].every((k) => required.has(k));
  const isExactAllowed =
    keys.size === allowed.size && [...keys].every((k) => allowed.has(k));

  if (!isExactRequired && !isExactAllowed) {
    fail('review result has missing or unknown fields');
  }

  if (
    typeof data['version'] !== 'number' ||
    !Number.isInteger(data['version']) ||
    typeof data['round'] !== 'number' ||
    !Number.isInteger(data['round'])
  ) {
    fail('review result version and round must be integers');
  }

  const expectedHead = resultHead(args);
  const expected: Record<string, unknown> = {
    version: PROTOCOL_VERSION,
    engine: args.engine,
    round: args.round,
    baseSha: args.base,
    beforeSha: args.before,
    afterSha: expectedHead,
  };

  for (const [key, value] of Object.entries(expected)) {
    if (data[key] !== value) {
      fail(`review result ${key} mismatch`);
    }
  }

  const status = data['status'];
  if (status !== 'clean' && status !== 'changed' && status !== 'blocked') {
    fail('review result status must be clean, changed, or blocked');
  }

  const fingerprints = data['findingFingerprints'];
  if (
    !Array.isArray(fingerprints) ||
    fingerprints.some(
      (value) => typeof value !== 'string' || !TOKEN_RE.test(value),
    ) ||
    new Set(fingerprints).size !== fingerprints.length
  ) {
    fail('review result findingFingerprints must be unique protocol tokens');
  }

  if (typeof data['finalLaneComplete'] !== 'boolean') {
    fail('review result finalLaneComplete must be boolean');
  }

  const classification = data['classification'];
  if (status === 'clean') {
    if (
      args.before !== expectedHead ||
      classification !== null ||
      data['finalLaneComplete'] !== true ||
      'blocker' in data
    ) {
      fail('clean review result conflicts with the observed pass');
    }
  } else if (status === 'changed') {
    if (
      args.before === expectedHead ||
      (classification !== 'minor' && classification !== 'material') ||
      (args.round >= 3 && classification !== 'material') ||
      fingerprints.length === 0 ||
      data['finalLaneComplete'] !== true ||
      'blocker' in data
    ) {
      fail('changed review result conflicts with the observed pass');
    }
  } else {
    const blocker = data['blocker'];
    if (
      classification !== null ||
      data['finalLaneComplete'] !== false ||
      typeof blocker !== 'string' ||
      !blocker.trim() ||
      blocker.includes('<!-- local-review')
    ) {
      fail('blocked review result lacks a safe blocker');
    }
  }

  return data as unknown as LedgerResult;
}

/**
 *
 */
export function writeResultFile(
  pathValue: string,
  value: Record<string, unknown>,
): void {
  const sortedKeys = Object.keys(value).sort();
  const sortedObj: Record<string, unknown> = {};
  for (const k of sortedKeys) {
    sortedObj[k] = value[k];
  }
  const raw = Buffer.from(JSON.stringify(sortedObj) + '\n', 'utf8');

  try {
    const stat = lstatSync(pathValue);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      fail('review result destination must be a regular non-symlink file');
    }
  } catch (err) {
    if (err instanceof LedgerError) throw err;
    // file might not exist yet; ok
  }

  const targetDir = dirname(pathValue);
  mkdirSync(targetDir, { recursive: true });

  const tempName = `.tmp-${randomBytes(8).toString('hex')}-${Date.now()}`;
  const tempPath = join(targetDir, tempName);

  let fd: number | null = null;
  try {
    fd = openSync(tempPath, 'wx', 0o600);
    fchmodSync(fd, 0o600);
    writeSync(fd, raw);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(tempPath, pathValue);
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // ignore
      }
    }
    try {
      unlinkSync(tempPath);
    } catch {
      // ignore
    }
  }
}

/**
 *
 */
export function readResult(resultFile: string): LedgerResult {
  const raw = readResultBytes(resultFile);
  const data = JSON.parse(raw.toString('utf8')) as LedgerResult;
  data.resultSha256 = sha256Bytes(raw);
  return data;
}

/**
 *
 */
export function validateResult(
  params: ValidateResultParams,
): LedgerResult & { resultSha256: string; verified: true } {
  const raw = readResultBytes(params.resultFile);
  const data = validateResultData(params, raw);
  return { ...data, resultSha256: sha256Bytes(raw), verified: true };
}

/**
 *
 */
export function writeBlockedResult(params: WriteBlockedParams): LedgerResult {
  let blocker: string;
  if (params.blocker !== undefined) {
    blocker = validateContentString(params.blocker).trim();
  } else if (params.blockerFile) {
    blocker = readContent(params.blockerFile).trim();
  } else {
    fail('blocked review result requires a blocker file or content');
  }

  const value: Record<string, unknown> = {
    version: PROTOCOL_VERSION,
    status: 'blocked',
    engine: params.engine,
    round: params.round,
    baseSha: params.base,
    beforeSha: params.before,
    afterSha: params.head,
    classification: null,
    findingFingerprints: [],
    finalLaneComplete: false,
    blocker,
  };

  const raw = Buffer.from(JSON.stringify(value) + '\n', 'utf8');
  validateResultData(params, raw);
  writeResultFile(params.resultFile, value);

  return {
    ...(value as unknown as LedgerResult),
    resultSha256: sha256Bytes(raw),
  };
}
