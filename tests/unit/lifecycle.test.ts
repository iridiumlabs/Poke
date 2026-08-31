import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { resolvePokeInstallationPaths } from '../../src/config/installation.js';
import { isLivePokeDaemon } from '../../src/daemon/pid-file.js';

describe('daemon lifecycle helpers', () => {
  it('resolves the CLI entrypoint and package root independently of process.cwd()', () => {
    const paths = resolvePokeInstallationPaths();

    expect(fs.existsSync(paths.pokeBinPath)).toBe(true);
    expect(fs.existsSync(path.join(paths.workingDir, 'package.json'))).toBe(true);
  });

  it('does not classify an arbitrary Node.js process as the Poke daemon', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    await once(child, 'spawn');

    try {
      expect(child.pid).toBeDefined();
      expect(isLivePokeDaemon({ pid: child.pid! }, resolvePokeInstallationPaths().pokeBinPath)).toBe(false);
    } finally {
      child.kill('SIGTERM');
      await once(child, 'exit');
    }
  });
});
