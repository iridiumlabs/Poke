import { describe, expect, it, vi } from 'vitest';
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

  it('emits WorkingDirectory using valid unquoted absolute systemd path syntax', async () => {
    const { generateSystemdServiceUnit } = await import('../../src/cli/lifecycle.js');
    const unit = generateSystemdServiceUnit();

    // WorkingDirectory must be an absolute path without surrounding quotes
    const workingDirMatch = unit.match(/^WorkingDirectory=(.+)$/m);
    expect(workingDirMatch).not.toBeNull();
    const workingDirPath = workingDirMatch![1];
    expect(workingDirPath.startsWith('/')).toBe(true);
    expect(workingDirPath.startsWith('"')).toBe(false);
    expect(workingDirPath.endsWith('"')).toBe(false);

    // ExecStart and Environment must retain safe argument quoting
    expect(unit).toMatch(/^ExecStart=".*" ".*" start --foreground$/m);
    expect(unit).toContain('Environment="NODE_ENV=production"');
  });

  it('handles arbitrary absolute installation paths with spaces and percent characters', async () => {
    const { generateSystemdServiceUnit } = await import('../../src/cli/lifecycle.js');
    const customHome = '/opt/custom poke%20home/dir with spaces';

    const unit = generateSystemdServiceUnit(customHome);
    // WorkingDirectory is based on installation path
    const workingDirMatch = unit.match(/^WorkingDirectory=(.+)$/m);
    expect(workingDirMatch).not.toBeNull();
    expect(workingDirMatch![1].startsWith('/')).toBe(true);
    expect(workingDirMatch![1].startsWith('"')).toBe(false);

    // POKE_HOME should escape % as %% and quote the env argument
    expect(unit).toContain('Environment="POKE_HOME=/opt/custom poke%%20home/dir with spaces"');
  });

  it('validates that working directory and custom paths must be absolute', async () => {
    const { generateSystemdServiceUnit } = await import('../../src/cli/lifecycle.js');

    expect(() =>
      generateSystemdServiceUnit(undefined, {
        pokeBinPath: 'bin/poke.js',
        workingDir: 'relative/path',
      })
    ).toThrow(/Working directory must be an absolute path/);
  });

  it('passes systemd-analyze verify when systemd is available and catches invalid quoted paths', async () => {
    const { execSync } = await import('node:child_process');
    const os = await import('node:os');
    const { generateSystemdServiceUnit } = await import('../../src/cli/lifecycle.js');

    let systemdAnalyzeAvailable = false;
    try {
      execSync('systemd-analyze --version', { stdio: 'ignore' });
      systemdAnalyzeAvailable = true;
    } catch {
      systemdAnalyzeAvailable = false;
    }

    if (!systemdAnalyzeAvailable) {
      return;
    }

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'poke-systemd-test-'));
    const validUnitPath = path.join(tempDir, 'poke-valid.service');
    const invalidUnitPath = path.join(tempDir, 'poke-invalid.service');

    try {
      const validUnit = generateSystemdServiceUnit();
      fs.writeFileSync(validUnitPath, validUnit);

      // Verify the generated unit is accepted by systemd-analyze verify
      const verifyOutput = execSync(`systemd-analyze verify ${validUnitPath} 2>&1`, { encoding: 'utf8' });
      expect(verifyOutput).not.toContain('fatal error');
      expect(verifyOutput).not.toContain('WorkingDirectory= path is not absolute');

      // Emulate the previously generated unit with quotes around WorkingDirectory
      const invalidUnit = validUnit.replace(/^WorkingDirectory=(.+)$/m, 'WorkingDirectory="$1"');
      fs.writeFileSync(invalidUnitPath, invalidUnit);

      let caughtError: any;
      try {
        execSync(`systemd-analyze verify ${invalidUnitPath} 2>&1`, { encoding: 'utf8' });
      } catch (err) {
        caughtError = err;
      }
      expect(caughtError).toBeDefined();
      const output = (caughtError.stderr || caughtError.stdout || caughtError.message).toString();
      expect(output).toContain('WorkingDirectory= path is not absolute');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('refreshes existing outdated/invalid systemd service unit on installation/update', async () => {
    const os = await import('node:os');
    const { installSystemdService, generateSystemdServiceUnit } = await import('../../src/cli/lifecycle.js');

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'poke-home-test-'));
    const userSystemdDir = path.join(tempDir, 'systemd/user');
    fs.mkdirSync(userSystemdDir, { recursive: true });
    const serviceFile = path.join(userSystemdDir, 'poke.service');

    // Simulate an existing outdated/invalid service file from a previous Poke version
    const outdatedContent = `[Unit]
Description=Old Poke Daemon
[Service]
WorkingDirectory="/invalid/quoted/path"
ExecStart="/old/node" "/old/bin/poke.js" start --foreground
`;
    fs.writeFileSync(serviceFile, outdatedContent);

    const oldXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = tempDir;

    const executedCommands: string[] = [];
    const fakeExec = (command: string) => {
      executedCommands.push(command);
      return '';
    };

    try {
      const installed = installSystemdService(undefined, { exec: fakeExec });
      expect(installed).toBe(true);

      // Verify file was updated to current generated unit
      const currentContent = fs.readFileSync(serviceFile, 'utf8');
      expect(currentContent).toBe(generateSystemdServiceUnit());
      expect(currentContent).not.toContain('WorkingDirectory="/invalid/quoted/path"');

      // Verify systemd was reloaded and service enabled
      expect(executedCommands).toContain('systemctl --user daemon-reload');
      expect(executedCommands).toContain('systemctl --user enable poke.service');

      // Running install again with matching content should be idempotent and not reload
      executedCommands.length = 0;
      const secondInstall = installSystemdService(undefined, { exec: fakeExec });
      expect(secondInstall).toBe(true);
      expect(executedCommands.length).toBe(0);
    } finally {
      if (oldXdg !== undefined) {
        process.env.XDG_CONFIG_HOME = oldXdg;
      } else {
        delete process.env.XDG_CONFIG_HOME;
      }
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('runStart refreshes outdated unit file and starts service via systemd without breaking running daemon', async () => {
    const os = await import('node:os');
    const { runStart, generateSystemdServiceUnit } = await import('../../src/cli/lifecycle.js');

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'poke-runstart-test-'));
    const userSystemdDir = path.join(tempDir, 'systemd/user');
    fs.mkdirSync(userSystemdDir, { recursive: true });
    const serviceFile = path.join(userSystemdDir, 'poke.service');

    // Write outdated unit
    fs.writeFileSync(serviceFile, 'WorkingDirectory="/old/quoted/path"\n');

    const oldXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = tempDir;

    const executedCommands: string[] = [];
    const fakeExec = (command: string) => {
      executedCommands.push(command);
      if (command.includes('is-active')) {
        return 'inactive\n';
      }
      return '';
    };

    try {
      await runStart({}, undefined, { exec: fakeExec });

      // Unit should be refreshed
      const updatedContent = fs.readFileSync(serviceFile, 'utf8');
      expect(updatedContent).toBe(generateSystemdServiceUnit());

      // Should have reloaded systemd and started the service
      expect(executedCommands).toContain('systemctl --user daemon-reload');
      expect(executedCommands).toContain('systemctl --user enable poke.service');
      expect(executedCommands).toContain('systemctl --user start poke.service');
    } finally {
      if (oldXdg !== undefined) {
        process.env.XDG_CONFIG_HOME = oldXdg;
      } else {
        delete process.env.XDG_CONFIG_HOME;
      }
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('runStart does not restart an already active healthy service during unit refresh', async () => {
    const os = await import('node:os');
    const { runStart } = await import('../../src/cli/lifecycle.js');

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'poke-runstart-active-'));
    const userSystemdDir = path.join(tempDir, 'systemd/user');
    fs.mkdirSync(userSystemdDir, { recursive: true });
    const serviceFile = path.join(userSystemdDir, 'poke.service');

    // Write outdated unit
    fs.writeFileSync(serviceFile, 'WorkingDirectory="/old/path"\n');

    const oldXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = tempDir;

    const executedCommands: string[] = [];
    const fakeExec = (command: string) => {
      executedCommands.push(command);
      if (command.includes('is-active')) {
        return 'active\n';
      }
      return '';
    };

    try {
      await runStart({}, undefined, { exec: fakeExec });

      // Daemon-reload was called to refresh unit, but start was skipped since already active
      expect(executedCommands).toContain('systemctl --user daemon-reload');
      expect(executedCommands).not.toContain('systemctl --user start poke.service');
    } finally {
      if (oldXdg !== undefined) {
        process.env.XDG_CONFIG_HOME = oldXdg;
      } else {
        delete process.env.XDG_CONFIG_HOME;
      }
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
