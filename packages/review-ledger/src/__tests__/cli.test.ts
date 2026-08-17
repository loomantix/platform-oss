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

  it('computes fingerprint via CLI', () => {
    const stdoutSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    const code = runCli([
      'compute-fingerprint',
      '--path',
      'src/index.ts',
      '--message',
      'test issue',
    ]);
    expect(code).toBe(0);
    expect(stdoutSpy).toHaveBeenCalled();
    stdoutSpy.mockRestore();
  });
});
