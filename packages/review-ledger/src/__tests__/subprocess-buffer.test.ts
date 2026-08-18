import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { SUBPROCESS_MAX_BUFFER } from '../constants.js';

/**
 * These tests run a real child process rather than the injected runner. The
 * defect they pin lived in the exec options, which every mocked runner in this
 * suite replaces — so only an actual subprocess can observe it.
 */
describe('subprocess output ceiling', () => {
  const emit = (bytes: number): string[] => [
    '-e',
    `process.stdout.write('x'.repeat(${bytes}))`,
  ];

  it("exceeds Node's 1 MiB default, which is what the ledger hit in practice", () => {
    expect(SUBPROCESS_MAX_BUFFER).toBeGreaterThan(1024 * 1024);
  });

  it('fails with ENOBUFS and an empty stderr at the default ceiling', () => {
    // The empty stderr is the reason the original failure reported
    // "no diagnostic returned" and read as a GitHub outage.
    let caught: { code?: string; stderr?: string } | undefined;
    try {
      execFileSync(process.execPath, emit(2 * 1024 * 1024), {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error: unknown) {
      caught = error as { code?: string; stderr?: string };
    }
    expect(caught?.code).toBe('ENOBUFS');
    expect(caught?.stderr).toBe('');
  });

  it('passes the same output through under the configured ceiling', () => {
    const stdout = execFileSync(process.execPath, emit(2 * 1024 * 1024), {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: SUBPROCESS_MAX_BUFFER,
    });
    expect(stdout.length).toBe(2 * 1024 * 1024);
  });
});
