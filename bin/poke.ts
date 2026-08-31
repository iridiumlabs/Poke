#!/usr/bin/env node
import { createCli } from '../src/cli/index.js';

const program = createCli();
void program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
