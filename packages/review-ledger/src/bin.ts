#!/usr/bin/env node
/**
 * Executable entry point for the `review-ledger` CLI.
 *
 * The runnable side effect lives here rather than in `cli.ts` so that importing
 * the library never starts a CLI run. Guarding by inspecting `process.argv[1]`
 * cannot do that safely: the package's own installed path contains the CLI's
 * name, so any such check fires on plain imports too.
 */
import { runCli } from './cli.js';

try {
  const exitCode = runCli();
  if (exitCode !== 0) {
    process.exit(exitCode);
  }
} catch (error: unknown) {
  const err = error as { message?: string };
  process.stderr.write(`review-ledger: ${err.message ?? String(error)}\n`);
  process.exit(1);
}
