import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { resolvePokeInstallationPaths } from '../../src/config/installation.js';
import { isLivePokeDaemon } from '../../src/daemon/pid-file.js';
import { isSupportedNodeVersion, SUPPORTED_NODE_VERSION_RANGE } from '../../src/config/node-version.js';

describe('daemon lifecycle helpers', () => {
  it('accepts the supported Node 24 line and rejects older or future majors', () => {
    expect(SUPPORTED_NODE_VERSION_RANGE).toBe('>=24.20.0 <25');
    expect(isSupportedNodeVersion('24.20.0')).toBe(true);
    expect(isSupportedNodeVersion('24.99.0')).toBe(true);
    expect(isSupportedNodeVersion('24.19.9')).toBe(false);
    expect(isSupportedNodeVersion('25.0.0')).toBe(false);
  });

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

  it('fails closed when pid is running but start time is missing or mismatched and args unavailable', () => {
    // process.pid is running
    expect(isLivePokeDaemon({ pid: process.pid, startTime: 'invalid-non-matching-time' }, 'nonexistent')).toBe(false);
  });

  it('preserves configured POKE_HOME and POKE_SKILLS_HOME in the generated systemd unit', async () => {
    const { generateSystemdServiceUnit } = await import('../../src/cli/lifecycle.js');
    const customHome = '/custom/poke/home';
    const oldSkillsHome = process.env.POKE_SKILLS_HOME;
    process.env.POKE_SKILLS_HOME = '/custom/skills/home';

    try {
      const unit = generateSystemdServiceUnit(customHome);
      expect(unit).toContain('Environment="POKE_HOME=/custom/poke/home"');
      expect(unit).toContain('Environment="POKE_SKILLS_HOME=/custom/skills/home"');
      expect(unit).toContain('Environment="NODE_ENV=production"');
    } finally {
      if (oldSkillsHome !== undefined) {
        process.env.POKE_SKILLS_HOME = oldSkillsHome;
      } else {
        delete process.env.POKE_SKILLS_HOME;
      }
    }
  });
});
