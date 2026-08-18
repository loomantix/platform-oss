import { describe, expect, it, vi } from 'vitest';
import { runCli } from '../cli.js';
import { PROTOCOL_VERSION } from '../constants.js';

describe('CLI command parser and execution', () => {
  it('outputs protocol version when requested', () => {
    const stdoutSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    const code = runCli(['--protocol-version']);
    expect(code).toBe(0);
    expect(stdoutSpy).toHaveBeenCalledWith(`${PROTOCOL_VERSION}\n`);
    stdoutSpy.mockRestore();
  });

  it('fails when no subcommand is provided', () => {
    expect(() => runCli([])).toThrowError(/subcommand required/);
  });

  it('rejects an unknown subcommand', () => {
    expect(() => runCli(['not-a-command'])).toThrowError(/unknown command/);
  });

  it('rejects verify-ledger without its required arguments', () => {
    expect(() => runCli(['verify-ledger', '--repo', 'a/b'])).toThrowError(
      /verify-ledger requires --repo, --pr, and --head/,
    );
  });

  it.each(['0', '-1', '1.5', '1junk', '9007199254740992'])(
    'rejects malformed numeric argument %s',
    (value) => {
      expect(() => runCli(['verify-ledger', '--pr', value])).toThrowError(
        /--pr must be a positive/,
      );
    },
  );

  it('requires a sealed result for attestation', () => {
    const sha = 'a'.repeat(40);
    expect(() =>
      runCli([
        'attest',
        '--repo',
        'owner/repo',
        '--pr',
        '1',
        '--head',
        sha,
        '--engine',
        'codex',
        '--round',
        '1',
        '--base',
        sha,
        '--before',
        sha,
        '--result-file',
        'result.json',
      ]),
    ).toThrowError(/--expected-result-sha256/);
  });
});
