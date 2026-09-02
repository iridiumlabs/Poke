import { execSync } from 'node:child_process';
import { resolvePokeInstallationPaths, type PokeInstallationPaths } from '../config/installation.js';
import { isDaemonRunning, runStart, runStop } from './lifecycle.js';
import { createCliUi, type CliUi, CliCommandFailedError } from './ui.js';

export interface UpdateDependencies {
  exec?: (command: string, options?: { cwd?: string; encoding?: 'utf8'; stdio?: any }) => string | Buffer;
  installationPaths?: PokeInstallationPaths;
  isDaemonRunning?: (customHome?: string) => boolean;
  stopDaemon?: (customHome?: string) => Promise<void>;
  startDaemon?: (
    options: { foreground?: boolean },
    customHome?: string,
    dependencies?: {
      exec?: (cmd: string) => any;
      installationPaths?: { pokeBinPath: string; workingDir: string };
      spawn?: typeof import('node:child_process').spawn;
    }
  ) => Promise<void>;
  verifyDaemonRunning?: (customHome?: string, timeoutMs?: number) => Promise<boolean>;
  npmCommand?: string;
  remoteBranch?: string;
  remoteName?: string;
}

export interface UpdateResult {
  success: boolean;
  previousCommit: string;
  updatedCommit: string;
  updated: boolean;
}

export interface RollbackResult {
  success: boolean;
  error?: string;
}

async function rollback(options: {
  workingDir: string;
  previousCommit: string;
  currentBranch: string | null;
  wasRunning: boolean;
  customHome?: string;
  paths: PokeInstallationPaths;
  exec: (command: string, options?: { cwd?: string; encoding?: 'utf8'; stdio?: any }) => any;
  npm: string;
  startDaemon: (
    options: { foreground?: boolean },
    customHome?: string,
    dependencies?: {
      exec?: (cmd: string) => any;
      installationPaths?: { pokeBinPath: string; workingDir: string };
      spawn?: typeof import('node:child_process').spawn;
    }
  ) => Promise<void>;
  stopDaemon?: (customHome?: string) => Promise<void>;
  ui: CliUi;
}): Promise<RollbackResult> {
  const {
    workingDir,
    previousCommit,
    currentBranch,
    wasRunning,
    customHome,
    paths,
    exec,
    npm,
    startDaemon,
    stopDaemon,
    ui,
  } = options;

  ui.note(`Restoring repository to ${previousCommit.slice(0, 7)}...`);
  try {
    if (stopDaemon && wasRunning) {
      await stopDaemon(customHome).catch(() => {});
    }

    if (currentBranch) {
      exec(`git checkout -B ${currentBranch} ${previousCommit}`, { cwd: workingDir });
    } else {
      exec(`git checkout --detach ${previousCommit}`, { cwd: workingDir });
    }

    ui.note('Rebuilding previous version...');
    exec(`${npm} install`, { cwd: workingDir });
    exec(`${npm} run build`, { cwd: workingDir });

    if (wasRunning) {
      ui.note('Restarting previous daemon version...');
      await startDaemon({}, customHome, {
        installationPaths: paths,
        exec: (cmd: string) => exec(cmd, { cwd: workingDir }),
      });
    }

    return { success: true };
  } catch (rollbackErr: any) {
    const errorMsg = rollbackErr.stderr?.toString().trim() || rollbackErr.message;
    ui.error(`Rollback encountered an error: ${errorMsg}`);
    return { success: false, error: errorMsg };
  }
}

async function defaultVerifyDaemonRunning(
  checkRunning: (customHome?: string) => boolean,
  customHome?: string,
  timeoutMs = 5000,
  stabilizationChecks = 3,
  pollIntervalMs = 250
): Promise<boolean> {
  const start = Date.now();
  let appeared = false;

  // 1. Wait for daemon to appear and write PID
  while (Date.now() - start < timeoutMs) {
    if (checkRunning(customHome)) {
      appeared = true;
      break;
    }
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }

  if (!appeared) {
    return false;
  }

  // 2. Ensure daemon remains running throughout stabilization window
  for (let i = 0; i < stabilizationChecks; i++) {
    await new Promise((r) => setTimeout(r, pollIntervalMs));
    if (!checkRunning(customHome)) {
      return false;
    }
  }

  return true;
}

export async function runUpdate(
  customHome?: string,
  ui: CliUi = createCliUi(),
  dependencies: UpdateDependencies = {}
): Promise<UpdateResult> {
  const paths = dependencies.installationPaths || resolvePokeInstallationPaths();
  const workingDir = paths.workingDir;
  const exec = dependencies.exec || ((cmd, opts) => execSync(cmd, { encoding: 'utf8', ...opts }));
  const checkDaemonRunning = dependencies.isDaemonRunning || isDaemonRunning;
  const stopDaemon = dependencies.stopDaemon || runStop;
  const startDaemon = dependencies.startDaemon || runStart;
  const npm = dependencies.npmCommand || (process.platform === 'win32' ? 'npm.cmd' : 'npm');
  const remote = dependencies.remoteName || 'origin';
  const branch = dependencies.remoteBranch || 'main';

  // 1. Verify working directory is a Git repository
  try {
    const isInsideWorkTree = String(exec('git rev-parse --is-inside-work-tree', { cwd: workingDir })).trim();
    if (isInsideWorkTree !== 'true') {
      throw new Error('Not inside a Git work tree');
    }
  } catch {
    const msg = `Poke installation directory (${workingDir}) is not a Git repository.`;
    ui.error(msg);
    throw new CliCommandFailedError(msg);
  }

  // 2. Fetch latest remote state
  ui.note(`Fetching latest updates from ${remote}/${branch}...`);
  try {
    exec(`git fetch ${remote} +refs/heads/${branch}:refs/remotes/${remote}/${branch}`, { cwd: workingDir });
  } catch (err: any) {
    const msg = `Failed to fetch from ${remote}/${branch}: ${err.stderr?.toString().trim() || err.message}`;
    ui.error(msg);
    throw new CliCommandFailedError(msg);
  }

  // 3. Resolve local HEAD and remote commit
  let localCommit: string;
  let remoteCommit: string;
  try {
    localCommit = String(exec('git rev-parse HEAD', { cwd: workingDir })).trim();
    remoteCommit = String(exec(`git rev-parse refs/remotes/${remote}/${branch}`, { cwd: workingDir })).trim();
  } catch (err: any) {
    const msg = `Failed to resolve Git commits: ${err.stderr?.toString().trim() || err.message}`;
    ui.error(msg);
    throw new CliCommandFailedError(msg);
  }

  // 4. If HEAD matches remote, report up-to-date and exit immediately
  if (localCommit === remoteCommit) {
    ui.success(`Poke is already up to date (${localCommit.slice(0, 7)}).`);
    return {
      success: true,
      previousCommit: localCommit,
      updatedCommit: localCommit,
      updated: false,
    };
  }

  // 5. Check working tree cleanliness before making changes
  let statusOutput: string;
  try {
    statusOutput = String(exec('git status --porcelain', { cwd: workingDir })).trim();
  } catch (err: any) {
    const msg = `Failed to check Git status: ${err.stderr?.toString().trim() || err.message}`;
    ui.error(msg);
    throw new CliCommandFailedError(msg);
  }

  if (statusOutput.length > 0) {
    const msg = 'Cannot update: working tree has uncommitted changes. Please commit, stash, or discard local changes before updating.';
    ui.error(msg);
    throw new CliCommandFailedError(msg);
  }

  // 6. Check if local HEAD can be fast-forwarded to remote
  try {
    exec(`git merge-base --is-ancestor HEAD refs/remotes/${remote}/${branch}`, { cwd: workingDir });
  } catch {
    const msg = `Cannot update: local branch has diverged from ${remote}/${branch}. Automatic fast-forward update is not possible.`;
    ui.error(msg);
    throw new CliCommandFailedError(msg);
  }

  // 7. Record pre-update state
  const previousCommit = localCommit;
  const wasRunning = checkDaemonRunning(customHome);
  let currentBranch: string | null = null;
  try {
    const branchOutput = String(exec('git symbolic-ref --short -q HEAD', { cwd: workingDir })).trim();
    if (branchOutput) {
      currentBranch = branchOutput.replace(/^refs\/heads\//, '');
    }
  } catch {
    currentBranch = null; // Detached HEAD
  }

  // 8. Gracefully stop Poke daemon if running
  if (wasRunning) {
    ui.note('Stopping Poke daemon...');
    await stopDaemon(customHome);
  }

  // 9. Fast-forward to origin/main
  ui.note(`Updating Poke from ${previousCommit.slice(0, 7)} to ${remoteCommit.slice(0, 7)}...`);
  try {
    if (currentBranch) {
      exec(`git merge --ff-only refs/remotes/${remote}/${branch}`, { cwd: workingDir });
    } else {
      exec(`git checkout --detach refs/remotes/${remote}/${branch}`, { cwd: workingDir });
    }
  } catch (mergeErr: any) {
    ui.error(`Fast-forward failed: ${mergeErr.stderr?.toString().trim() || mergeErr.message}`);
    if (wasRunning) {
      await startDaemon({}, customHome, {
        installationPaths: paths,
        exec: (cmd: string) => exec(cmd, { cwd: workingDir }),
      }).catch(() => {});
    }
    throw new CliCommandFailedError(
      `Fast-forward update failed: ${mergeErr.stderr?.toString().trim() || mergeErr.message}`
    );
  }

  // 10. Install dependencies and build production artifacts
  try {
    ui.note('Installing dependencies...');
    exec(`${npm} install`, { cwd: workingDir });
    ui.note('Building Poke...');
    exec(`${npm} run build`, { cwd: workingDir });
  } catch (buildErr: any) {
    const buildErrorMsg = buildErr.stderr?.toString().trim() || buildErr.message;
    ui.error(`Build failed: ${buildErrorMsg}`);
    const rollbackResult = await rollback({
      workingDir,
      previousCommit,
      currentBranch,
      wasRunning,
      customHome,
      paths,
      exec,
      npm,
      startDaemon,
      stopDaemon,
      ui,
    });
    if (rollbackResult.success) {
      throw new CliCommandFailedError(
        `Update failed during build. Restored previous version (${previousCommit.slice(0, 7)}).`
      );
    } else {
      throw new CliCommandFailedError(
        `Update failed during build. Rollback to ${previousCommit.slice(0, 7)} also failed: ${rollbackResult.error || 'unknown error'}`
      );
    }
  }

  // 11. Start newly built version and verify (if daemon was running)
  if (wasRunning) {
    let startupFailed = false;
    let startupErrorMsg = '';

    try {
      ui.note('Starting updated Poke daemon...');
      await startDaemon({}, customHome, {
        installationPaths: paths,
        exec: (cmd: string) => exec(cmd, { cwd: workingDir }),
      });

      ui.note('Verifying Poke daemon is running...');
      const verifyFn = dependencies.verifyDaemonRunning || ((home?: string) => defaultVerifyDaemonRunning(checkDaemonRunning, home));
      const isRunning = await verifyFn(customHome);
      if (!isRunning) {
        startupFailed = true;
        startupErrorMsg = 'Updated Poke daemon failed to start or stay running.';
      }
    } catch (startErr: any) {
      startupFailed = true;
      startupErrorMsg = `Failed to start updated daemon: ${startErr.stderr?.toString().trim() || startErr.message}`;
    }

    if (startupFailed) {
      ui.error(startupErrorMsg);
      const rollbackResult = await rollback({
        workingDir,
        previousCommit,
        currentBranch,
        wasRunning,
        customHome,
        paths,
        exec,
        npm,
        startDaemon,
        stopDaemon,
        ui,
      });
      if (rollbackResult.success) {
        throw new CliCommandFailedError(
          `Updated daemon failed to stay running. Restored previous version (${previousCommit.slice(0, 7)}).`
        );
      } else {
        throw new CliCommandFailedError(
          `Updated daemon failed to stay running. Rollback to ${previousCommit.slice(0, 7)} also failed: ${rollbackResult.error || 'unknown error'}`
        );
      }
    }

    ui.success(`Poke successfully updated to ${remoteCommit.slice(0, 7)} and daemon restarted.`);
  } else {
    ui.success(`Poke successfully updated to ${remoteCommit.slice(0, 7)}.`);
  }

  return {
    success: true,
    previousCommit,
    updatedCommit: remoteCommit,
    updated: true,
  };
}
