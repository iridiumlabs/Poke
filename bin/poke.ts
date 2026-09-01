#!/usr/bin/env node
import { createCli } from '../src/cli/index.js';
import { assertSupportedNodeVersion } from '../src/config/node-version.js';
import { CliCommandFailedError } from '../src/cli/ui.js';

try {
  assertSupportedNodeVersion();
  const program = createCli();
  void program.parseAsync(process.argv).catch((err: unknown) => {
    if (!(err instanceof CliCommandFailedError)) {
      console.error(err instanceof Error ? err.message : String(err));
    }
    process.exitCode = 1;
  });
} catch (err: unknown) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
}
