import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { runUpdate } from '../../src/cli/update.js';
import { CliCommandFailedError, type CliUi, type SelectChoice, type TextPromptOptions } from '../../src/cli/ui.js';
import { ConfigManager } from '../../src/config/config.js';
import { PokeDatabase } from '../../src/db/database.js';

class MockCliUi implements CliUi {
  readonly notes: string[] = [];
  readonly errors: string[] = [];
  readonly successes: string[] = [];
  readonly warnings: string[] = [];

  async select<T extends string>(_message: string, _choices: readonly SelectChoice<T>[]): Promise<T> {
    return '' as T;
  }
  async text(_options: TextPromptOptions): Promise<string> {
    return '';
  }
  async secret(_options: TextPromptOptions): Promise<string> {
    return '';
  }
  async confirm(_message: string, defaultValue = false): Promise<boolean> {
    return defaultValue;
  }
  async spinner<T>(_message: string, action: () => Promise<T>): Promise<T> {
    return await action();
  }
  note(message: string): void {
    this.notes.push(message);
  }
  success(message: string): void {
    this.successes.push(message);
  }
  warning(message: string): void {
    this.warnings.push(message);
  }
  error(message: string): void {
    this.errors.push(message);
  }
}

describe('poke update CLI command', () => {
  let tempHomeDir: string;
  let tempRepoDir: string;

  beforeEach(() => {
    tempHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'poke-update-home-'));
    tempRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'poke-update-repo-'));
  });

  afterEach(() => {
    fs.rmSync(tempHomeDir, { recursive: true, force: true });
    fs.rmSync(tempRepoDir, { recursive: true, force: true });
  });

  it('reports immediately that Poke is already up to date when local HEAD matches remote origin/main', async () => {
    const ui = new MockCliUi();
    const executedCommands: string[] = [];
    const stopDaemon = vi.fn().mockResolvedValue(undefined);
    const startDaemon = vi.fn().mockResolvedValue(undefined);
    const isDaemonRunning = vi.fn().mockReturnValue(true);

    const fakeExec = (cmd: string) => {
      executedCommands.push(cmd);
      if (cmd.includes('--is-inside-work-tree')) return 'true\n';
      if (cmd.includes('git fetch')) return '';
      if (cmd.includes('rev-parse HEAD')) return 'abc1234567890abcdef1234567890abcdef12345\n';
      if (cmd.includes('rev-parse refs/remotes/origin/main')) return 'abc1234567890abcdef1234567890abcdef12345\n';
      return '';
    };

    const result = await runUpdate(tempHomeDir, ui, {
      exec: fakeExec,
      installationPaths: {
        pokeBinPath: path.join(tempRepoDir, 'dist/bin/poke.js'),
        workingDir: tempRepoDir,
      },
      isDaemonRunning,
      stopDaemon,
      startDaemon,
    });

    expect(result.updated).toBe(false);
    expect(result.previousCommit).toBe('abc1234567890abcdef1234567890abcdef12345');
    expect(result.updatedCommit).toBe('abc1234567890abcdef1234567890abcdef12345');
    expect(ui.successes.some((s) => s.includes('Poke is already up to date (abc1234)'))).toBe(true);

    // Ensure daemon was not stopped or started and no build commands were executed
    expect(stopDaemon).not.toHaveBeenCalled();
    expect(startDaemon).not.toHaveBeenCalled();
    expect(executedCommands.some((c) => c.includes('npm install'))).toBe(false);
    expect(executedCommands.some((c) => c.includes('npm run build'))).toBe(false);
    expect(executedCommands.some((c) => c.includes('git merge'))).toBe(false);
  });

  it('successfully updates from origin/main when daemon is running: stops daemon, fast-forwards, builds, and restarts daemon', async () => {
    const ui = new MockCliUi();
    const executedCommands: string[] = [];
    const stopDaemon = vi.fn().mockResolvedValue(undefined);
    const startDaemon = vi.fn().mockResolvedValue(undefined);
    let daemonLive = true;
    const isDaemonRunning = vi.fn().mockImplementation(() => daemonLive);
    const verifyDaemonRunning = vi.fn().mockResolvedValue(true);

    const oldCommit = '1111111111111111111111111111111111111111';
    const newCommit = '2222222222222222222222222222222222222222';

    const fakeExec = (cmd: string) => {
      executedCommands.push(cmd);
      if (cmd.includes('--is-inside-work-tree')) return 'true\n';
      if (cmd.includes('git fetch')) return '';
      if (cmd.includes('rev-parse HEAD')) return `${oldCommit}\n`;
      if (cmd.includes('rev-parse refs/remotes/origin/main')) return `${newCommit}\n`;
      if (cmd.includes('git status --porcelain')) return '';
      if (cmd.includes('git merge-base --is-ancestor')) return '';
      if (cmd.includes('git symbolic-ref')) return 'refs/heads/main\n';
      if (cmd.includes('git merge --ff-only')) return '';
      if (cmd.includes('npm install')) return '';
      if (cmd.includes('npm run build')) return '';
      return '';
    };

    const result = await runUpdate(tempHomeDir, ui, {
      exec: fakeExec,
      installationPaths: {
        pokeBinPath: path.join(tempRepoDir, 'dist/bin/poke.js'),
        workingDir: tempRepoDir,
      },
      isDaemonRunning,
      stopDaemon,
      startDaemon,
      verifyDaemonRunning,
    });

    expect(result.updated).toBe(true);
    expect(result.previousCommit).toBe(oldCommit);
    expect(result.updatedCommit).toBe(newCommit);

    // Verify correct execution sequence
    expect(stopDaemon).toHaveBeenCalledTimes(1);
    expect(executedCommands).toContain('git merge --ff-only refs/remotes/origin/main');
    expect(executedCommands).toContain('npm install');
    expect(executedCommands).toContain('npm run build');
    expect(startDaemon).toHaveBeenCalledTimes(1);
    expect(verifyDaemonRunning).toHaveBeenCalledTimes(1);
    expect(ui.successes.some((s) => s.includes('Poke successfully updated to 2222222 and daemon restarted'))).toBe(true);
  });

  it('successfully updates when daemon is not running without starting daemon afterwards', async () => {
    const ui = new MockCliUi();
    const executedCommands: string[] = [];
    const stopDaemon = vi.fn().mockResolvedValue(undefined);
    const startDaemon = vi.fn().mockResolvedValue(undefined);
    const isDaemonRunning = vi.fn().mockReturnValue(false);

    const oldCommit = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const newCommit = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

    const fakeExec = (cmd: string) => {
      executedCommands.push(cmd);
      if (cmd.includes('--is-inside-work-tree')) return 'true\n';
      if (cmd.includes('git fetch')) return '';
      if (cmd.includes('rev-parse HEAD')) return `${oldCommit}\n`;
      if (cmd.includes('rev-parse refs/remotes/origin/main')) return `${newCommit}\n`;
      if (cmd.includes('git status --porcelain')) return '';
      if (cmd.includes('git merge-base --is-ancestor')) return '';
      if (cmd.includes('git symbolic-ref')) return 'refs/heads/main\n';
      if (cmd.includes('git merge --ff-only')) return '';
      if (cmd.includes('npm install')) return '';
      if (cmd.includes('npm run build')) return '';
      return '';
    };

    const result = await runUpdate(tempHomeDir, ui, {
      exec: fakeExec,
      installationPaths: {
        pokeBinPath: path.join(tempRepoDir, 'dist/bin/poke.js'),
        workingDir: tempRepoDir,
      },
      isDaemonRunning,
      stopDaemon,
      startDaemon,
    });

    expect(result.updated).toBe(true);
    expect(stopDaemon).not.toHaveBeenCalled();
    expect(startDaemon).not.toHaveBeenCalled();
    expect(ui.successes.some((s) => s.includes('Poke successfully updated to bbbbbbb.'))).toBe(true);
  });

  it('rejects update when working tree contains uncommitted changes without modifying tree or stopping daemon', async () => {
    const ui = new MockCliUi();
    const executedCommands: string[] = [];
    const stopDaemon = vi.fn().mockResolvedValue(undefined);
    const startDaemon = vi.fn().mockResolvedValue(undefined);
    const isDaemonRunning = vi.fn().mockReturnValue(true);

    const fakeExec = (cmd: string) => {
      executedCommands.push(cmd);
      if (cmd.includes('--is-inside-work-tree')) return 'true\n';
      if (cmd.includes('git fetch')) return '';
      if (cmd.includes('rev-parse HEAD')) return '1111111111111111111111111111111111111111\n';
      if (cmd.includes('rev-parse refs/remotes/origin/main')) return '2222222222222222222222222222222222222222\n';
      if (cmd.includes('git status --porcelain')) return ' M src/cli/index.ts\n?? untracked.txt\n';
      return '';
    };

    await expect(
      runUpdate(tempHomeDir, ui, {
        exec: fakeExec,
        installationPaths: {
          pokeBinPath: path.join(tempRepoDir, 'dist/bin/poke.js'),
          workingDir: tempRepoDir,
        },
        isDaemonRunning,
        stopDaemon,
        startDaemon,
      })
    ).rejects.toThrow(CliCommandFailedError);

    expect(ui.errors.some((e) => e.includes('working tree has uncommitted changes'))).toBe(true);
    expect(stopDaemon).not.toHaveBeenCalled();
    expect(startDaemon).not.toHaveBeenCalled();
    expect(executedCommands.some((c) => c.includes('git merge'))).toBe(false);
    expect(executedCommands.some((c) => c.includes('git reset --hard'))).toBe(false);
  });

  it('rejects update when local branch has diverged from origin/main without modifying tree or stopping daemon', async () => {
    const ui = new MockCliUi();
    const executedCommands: string[] = [];
    const stopDaemon = vi.fn().mockResolvedValue(undefined);
    const startDaemon = vi.fn().mockResolvedValue(undefined);
    const isDaemonRunning = vi.fn().mockReturnValue(true);

    const fakeExec = (cmd: string) => {
      executedCommands.push(cmd);
      if (cmd.includes('--is-inside-work-tree')) return 'true\n';
      if (cmd.includes('git fetch')) return '';
      if (cmd.includes('rev-parse HEAD')) return '1111111111111111111111111111111111111111\n';
      if (cmd.includes('rev-parse refs/remotes/origin/main')) return '2222222222222222222222222222222222222222\n';
      if (cmd.includes('git status --porcelain')) return '';
      if (cmd.includes('git merge-base --is-ancestor')) {
        throw new Error('Not an ancestor');
      }
      return '';
    };

    await expect(
      runUpdate(tempHomeDir, ui, {
        exec: fakeExec,
        installationPaths: {
          pokeBinPath: path.join(tempRepoDir, 'dist/bin/poke.js'),
          workingDir: tempRepoDir,
        },
        isDaemonRunning,
        stopDaemon,
        startDaemon,
      })
    ).rejects.toThrow(CliCommandFailedError);

    expect(ui.errors.some((e) => e.includes('local branch has diverged from origin/main'))).toBe(true);
    expect(stopDaemon).not.toHaveBeenCalled();
    expect(startDaemon).not.toHaveBeenCalled();
    expect(executedCommands.some((c) => c.includes('git merge --ff-only'))).toBe(false);
  });

  it('handles build failure by rolling back git to previous commit, rebuilding previous version, and restarting daemon', async () => {
    const ui = new MockCliUi();
    const executedCommands: string[] = [];
    const stopDaemon = vi.fn().mockResolvedValue(undefined);
    const startDaemon = vi.fn().mockResolvedValue(undefined);
    const isDaemonRunning = vi.fn().mockReturnValue(true);

    const oldCommit = '1111111111111111111111111111111111111111';
    const newCommit = '2222222222222222222222222222222222222222';
    let buildAttempts = 0;

    const fakeExec = (cmd: string) => {
      executedCommands.push(cmd);
      if (cmd.includes('--is-inside-work-tree')) return 'true\n';
      if (cmd.includes('git fetch')) return '';
      if (cmd.includes('rev-parse HEAD')) return `${oldCommit}\n`;
      if (cmd.includes('rev-parse refs/remotes/origin/main')) return `${newCommit}\n`;
      if (cmd.includes('git status --porcelain')) return '';
      if (cmd.includes('git merge-base --is-ancestor')) return '';
      if (cmd.includes('git symbolic-ref')) return 'refs/heads/main\n';
      if (cmd.includes('git merge --ff-only')) return '';
      if (cmd.includes('npm install')) return '';
      if (cmd.includes('npm run build')) {
        buildAttempts++;
        if (buildAttempts === 1) {
          throw new Error('TypeScript compilation error in new version');
        }
        return ''; // Succeeded during rollback
      }
      if (cmd.includes('git checkout -B main')) return '';
      return '';
    };

    await expect(
      runUpdate(tempHomeDir, ui, {
        exec: fakeExec,
        installationPaths: {
          pokeBinPath: path.join(tempRepoDir, 'dist/bin/poke.js'),
          workingDir: tempRepoDir,
        },
        isDaemonRunning,
        stopDaemon,
        startDaemon,
      })
    ).rejects.toThrow(CliCommandFailedError);

    // Rollback checks
    expect(executedCommands).toContain(`git checkout -B main ${oldCommit}`);
    expect(startDaemon).toHaveBeenCalledTimes(1); // Restarted previous daemon version
    expect(ui.errors.some((e) => e.includes('Build failed: TypeScript compilation error in new version'))).toBe(true);
    expect(ui.notes.some((n) => n.includes(`Restoring repository to ${oldCommit.slice(0, 7)}`))).toBe(true);
  });

  it('handles post-update daemon verification failure by rolling back to previous commit and restoring previous daemon', async () => {
    const ui = new MockCliUi();
    const executedCommands: string[] = [];
    const stopDaemon = vi.fn().mockResolvedValue(undefined);
    const startDaemon = vi.fn().mockResolvedValue(undefined);
    const isDaemonRunning = vi.fn().mockReturnValue(true);
    const verifyDaemonRunning = vi.fn().mockResolvedValue(false); // Daemon failed to stay running

    const oldCommit = '1111111111111111111111111111111111111111';
    const newCommit = '2222222222222222222222222222222222222222';

    const fakeExec = (cmd: string) => {
      executedCommands.push(cmd);
      if (cmd.includes('--is-inside-work-tree')) return 'true\n';
      if (cmd.includes('git fetch')) return '';
      if (cmd.includes('rev-parse HEAD')) return `${oldCommit}\n`;
      if (cmd.includes('rev-parse refs/remotes/origin/main')) return `${newCommit}\n`;
      if (cmd.includes('git status --porcelain')) return '';
      if (cmd.includes('git merge-base --is-ancestor')) return '';
      if (cmd.includes('git symbolic-ref')) return 'refs/heads/main\n';
      if (cmd.includes('git merge --ff-only')) return '';
      if (cmd.includes('npm install')) return '';
      if (cmd.includes('npm run build')) return '';
      if (cmd.includes('git checkout -B main')) return '';
      return '';
    };

    await expect(
      runUpdate(tempHomeDir, ui, {
        exec: fakeExec,
        installationPaths: {
          pokeBinPath: path.join(tempRepoDir, 'dist/bin/poke.js'),
          workingDir: tempRepoDir,
        },
        isDaemonRunning,
        stopDaemon,
        startDaemon,
        verifyDaemonRunning,
      })
    ).rejects.toThrow(CliCommandFailedError);

    // Verified rollback was called
    expect(executedCommands).toContain(`git checkout -B main ${oldCommit}`);
    expect(stopDaemon).toHaveBeenCalledTimes(2); // Initial stop + stop failed daemon during rollback
    expect(startDaemon).toHaveBeenCalledTimes(2); // Attempted start + rollback restart
    expect(ui.errors.some((e) => e.includes('Updated Poke daemon failed to start or stay running'))).toBe(true);
  });

  it('rejects update when directory is not a Git repository', async () => {
    const ui = new MockCliUi();
    const fakeExec = (_cmd: string) => {
      throw new Error('fatal: not a git repository');
    };

    await expect(
      runUpdate(tempHomeDir, ui, {
        exec: fakeExec,
        installationPaths: {
          pokeBinPath: path.join(tempRepoDir, 'dist/bin/poke.js'),
          workingDir: tempRepoDir,
        },
      })
    ).rejects.toThrow(CliCommandFailedError);

    expect(ui.errors.some((e) => e.includes('is not a Git repository'))).toBe(true);
  });

  it('rejects update and leaves state unchanged when git fetch fails', async () => {
    const ui = new MockCliUi();
    const stopDaemon = vi.fn().mockResolvedValue(undefined);
    const startDaemon = vi.fn().mockResolvedValue(undefined);

    const fakeExec = (cmd: string) => {
      if (cmd.includes('--is-inside-work-tree')) return 'true\n';
      if (cmd.includes('git fetch')) {
        const error: any = new Error('Could not resolve host');
        error.stderr = Buffer.from('fatal: unable to access: Could not resolve host');
        throw error;
      }
      return '';
    };

    await expect(
      runUpdate(tempHomeDir, ui, {
        exec: fakeExec,
        installationPaths: {
          pokeBinPath: path.join(tempRepoDir, 'dist/bin/poke.js'),
          workingDir: tempRepoDir,
        },
        stopDaemon,
        startDaemon,
      })
    ).rejects.toThrow(CliCommandFailedError);

    expect(ui.errors.some((e) => e.includes('Failed to fetch from origin/main'))).toBe(true);
    expect(stopDaemon).not.toHaveBeenCalled();
    expect(startDaemon).not.toHaveBeenCalled();
  });

  it('preserves external Poke configuration and database state during update', async () => {
    const config = new ConfigManager(tempHomeDir);
    config.setOwnerPhoneNumber('+92 300 1234567');
    config.setMainModel({ provider: 'commandcode', model: 'claude-sonnet-4-6' });

    const db = new PokeDatabase(tempHomeDir);
    db.setState('custom_state_key', 'persisted_value');
    db.close();

    const ui = new MockCliUi();
    const fakeExec = (cmd: string) => {
      if (cmd.includes('--is-inside-work-tree')) return 'true\n';
      if (cmd.includes('git fetch')) return '';
      if (cmd.includes('rev-parse HEAD')) return '1111111111111111111111111111111111111111\n';
      if (cmd.includes('rev-parse refs/remotes/origin/main')) return '2222222222222222222222222222222222222222\n';
      if (cmd.includes('git status --porcelain')) return '';
      if (cmd.includes('git merge-base --is-ancestor')) return '';
      if (cmd.includes('git symbolic-ref')) return 'refs/heads/main\n';
      if (cmd.includes('git merge --ff-only')) return '';
      if (cmd.includes('npm install')) return '';
      if (cmd.includes('npm run build')) return '';
      return '';
    };

    await runUpdate(tempHomeDir, ui, {
      exec: fakeExec,
      installationPaths: {
        pokeBinPath: path.join(tempRepoDir, 'dist/bin/poke.js'),
        workingDir: tempRepoDir,
      },
      isDaemonRunning: () => false,
    });

    // Check configuration and db state are intact
    const loadedConfig = new ConfigManager(tempHomeDir);
    expect(loadedConfig.getOwnerPhoneNumber()).toBe('923001234567');
    expect(loadedConfig.getMainModel()?.model).toBe('claude-sonnet-4-6');

    const reopenedDb = new PokeDatabase(tempHomeDir);
    expect(reopenedDb.getState('custom_state_key')).toBe('persisted_value');
    reopenedDb.close();
  });

  it('real Git integration: performs full fast-forward update workflow against local Git repositories', async () => {
    // Create a bare remote repository
    const bareRemoteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'poke-bare-remote-'));
    execSync('git init --bare', { cwd: bareRemoteDir, stdio: 'pipe' });
    execSync('git symbolic-ref HEAD refs/heads/main', { cwd: bareRemoteDir, stdio: 'pipe' });

    // Create upstream work repository to seed commits
    const upstreamDir = fs.mkdtempSync(path.join(os.tmpdir(), 'poke-upstream-'));
    execSync('git init', { cwd: upstreamDir, stdio: 'pipe' });
    execSync('git config user.name "Test User"', { cwd: upstreamDir, stdio: 'pipe' });
    execSync('git config user.email "test@example.com"', { cwd: upstreamDir, stdio: 'pipe' });
    execSync('git branch -M main', { cwd: upstreamDir, stdio: 'pipe' });
    fs.writeFileSync(path.join(upstreamDir, 'file.txt'), 'version 1');
    execSync('git add file.txt && git commit -m "initial commit"', { cwd: upstreamDir, stdio: 'pipe' });
    execSync(`git remote add origin ${bareRemoteDir}`, { cwd: upstreamDir, stdio: 'pipe' });
    execSync('git push -u origin main', { cwd: upstreamDir, stdio: 'pipe' });

    // Create local deployed clone
    const localDir = fs.mkdtempSync(path.join(os.tmpdir(), 'poke-local-deployed-'));
    execSync(`git clone -b main ${bareRemoteDir} ${localDir}`, { stdio: 'pipe' });
    execSync('git config user.name "Test User"', { cwd: localDir, stdio: 'pipe' });
    execSync('git config user.email "test@example.com"', { cwd: localDir, stdio: 'pipe' });

    // Push new commit to upstream
    fs.writeFileSync(path.join(upstreamDir, 'file.txt'), 'version 2');
    execSync('git add file.txt && git commit -m "second commit"', { cwd: upstreamDir, stdio: 'pipe' });
    execSync('git push origin main', { cwd: upstreamDir, stdio: 'pipe' });

    const ui = new MockCliUi();
    const startDaemon = vi.fn().mockResolvedValue(undefined);
    const stopDaemon = vi.fn().mockResolvedValue(undefined);

    try {
      // Mock npm install and build to avoid running real tsc on dummy repo
      const customExec = (cmd: string, opts?: any) => {
        if (cmd.startsWith('npm install') || cmd.startsWith('npm run build')) {
          return '';
        }
        return execSync(cmd, { encoding: 'utf8', ...opts });
      };

      const result = await runUpdate(tempHomeDir, ui, {
        exec: customExec,
        installationPaths: {
          pokeBinPath: path.join(localDir, 'dist/bin/poke.js'),
          workingDir: localDir,
        },
        isDaemonRunning: () => false,
        startDaemon,
        stopDaemon,
      });

      expect(result.updated).toBe(true);
      expect(fs.readFileSync(path.join(localDir, 'file.txt'), 'utf8')).toBe('version 2');
      expect(ui.successes.some((s) => s.includes('Poke successfully updated'))).toBe(true);
    } finally {
      fs.rmSync(bareRemoteDir, { recursive: true, force: true });
      fs.rmSync(upstreamDir, { recursive: true, force: true });
      fs.rmSync(localDir, { recursive: true, force: true });
    }
  });
});
