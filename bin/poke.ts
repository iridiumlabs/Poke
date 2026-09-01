#!/usr/bin/env node
import { assertSupportedNodeVersion } from '../src/config/node-version.js';

try {
  assertSupportedNodeVersion();
  const [{ createCli }, { CliCommandFailedError }] = await Promise.all([
    import('../src/cli/index.js'),
    import('../src/cli/ui.js'),
  ]);
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
