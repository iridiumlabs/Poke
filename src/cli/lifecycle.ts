import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn, execSync } from 'child_process';
import { resolvePokePaths } from '../config/paths.js';
import { resolvePokeInstallationPaths } from '../config/installation.js';
import { PokeDaemon } from '../daemon/daemon.js';
import {
  isLivePokeDaemon,
  readDaemonPidFile,
  removeDaemonPidFileIfMatches,
} from '../daemon/pid-file.js';

export function getSystemdUserDirectory(): string {
  if (process.env.XDG_CONFIG_HOME) {
    return path.join(process.env.XDG_CONFIG_HOME, 'systemd/user');
  }
  const home = process.env.HOME || os.homedir();
  return path.join(home, '.config/systemd/user');
}

export function getSystemdUserServicePath(): string {
  return path.join(getSystemdUserDirectory(), 'poke.service');
}

export function isSystemdAvailable(exec: (cmd: string) => any = execSync): boolean {
  try {
    exec('systemctl --user list-units --type=service');
    return true;
  } catch {
    return false;
  }
}

export function isSystemdServiceInstalled(): boolean {
  return fs.existsSync(getSystemdUserServicePath());
}

export function isSystemdServiceActive(exec: (cmd: string) => any = execSync): boolean {
  if (!isSystemdAvailable(exec) || !isSystemdServiceInstalled()) return false;
  try {
    const output = String(exec('systemctl --user is-active poke.service')).trim();
    return output === 'active' || output === 'activating';
  } catch {
    return false;
  }
}

export function isDaemonRunning(customHome?: string): boolean {
  if (isSystemdServiceActive()) return true;
  const paths = resolvePokePaths(customHome);
  const record = readDaemonPidFile(path.join(paths.root, 'daemon.pid'));
  return Boolean(record && isLivePokeDaemon(record, resolvePokeInstallationPaths().pokeBinPath));
}

export function generateSystemdServiceUnit(
  customHome?: string,
  installationPaths?: { pokeBinPath: string; workingDir: string }
): string {
  const nodePath = process.execPath;
  const { pokeBinPath, workingDir } = installationPaths || resolvePokeInstallationPaths();

  if (!workingDir || !path.isAbsolute(workingDir)) {
    throw new Error(`Working directory must be an absolute path: ${workingDir}`);
  }

  const formatSystemdPath = (value: string): string => {
    if (!value || !path.isAbsolute(value)) {
      throw new Error(`Working directory must be an absolute path: ${value}`);
    }
    return value.replace(/%/g, '%%');
  };

  const quoteSystemdArgument = (value: string) => `"${value.replace(/%/g, '%%').replace(/[\\"]/g, '\\$&')}"`;

  const envLines = ['Environment="NODE_ENV=production"'];
  const pokeHome = customHome || process.env.POKE_HOME;
  if (pokeHome) {
    const resolvedHome = path.resolve(pokeHome);
    if (!path.isAbsolute(resolvedHome)) {
      throw new Error(`POKE_HOME must be an absolute path: ${resolvedHome}`);
    }
    envLines.push(`Environment=${quoteSystemdArgument(`POKE_HOME=${resolvedHome}`)}`);
  }
  if (process.env.POKE_SKILLS_HOME) {
    const resolvedSkillsHome = path.resolve(process.env.POKE_SKILLS_HOME);
    if (!path.isAbsolute(resolvedSkillsHome)) {
      throw new Error(`POKE_SKILLS_HOME must be an absolute path: ${resolvedSkillsHome}`);
    }
    envLines.push(`Environment=${quoteSystemdArgument(`POKE_SKILLS_HOME=${resolvedSkillsHome}`)}`);
  }

  return `[Unit]
Description=Poke WhatsApp Personal Agent Daemon
After=network.target

[Service]
Type=exec
WorkingDirectory=${formatSystemdPath(workingDir)}
ExecStart=${quoteSystemdArgument(nodePath)} ${quoteSystemdArgument(pokeBinPath)} start --foreground
Restart=on-failure
RestartSec=5
KillMode=process
${envLines.join('\n')}

[Install]
WantedBy=default.target
`;
}

export function installSystemdService(
  customHome?: string,
  dependencies: {
    exec?: (cmd: string) => any;
    installationPaths?: { pokeBinPath: string; workingDir: string };
  } = {}
): boolean {
  const exec = dependencies.exec || ((cmd: string) => execSync(cmd, { stdio: 'ignore' }));
  try {
    const userSystemdDir = getSystemdUserDirectory();
    if (!fs.existsSync(userSystemdDir)) {
      fs.mkdirSync(userSystemdDir, { recursive: true, mode: 0o755 });
    }

    const unitContent = generateSystemdServiceUnit(customHome, dependencies.installationPaths);
    const serviceFile = getSystemdUserServicePath();
    const alreadyExists = fs.existsSync(serviceFile);
    let existingContent: string | null = null;
    if (alreadyExists) {
      try {
        existingContent = fs.readFileSync(serviceFile, 'utf8');
      } catch {
        existingContent = null;
      }
    }

    if (alreadyExists && existingContent === unitContent) {
      return true;
    }

    fs.writeFileSync(serviceFile, unitContent, { mode: 0o644 });

    exec('systemctl --user daemon-reload');
    exec('systemctl --user enable poke.service');

    if (alreadyExists) {
      console.log(`✓ Updated systemd user service at ${serviceFile}`);
    } else {
      console.log(`✓ Installed and enabled systemd user service at ${serviceFile}`);
    }
    return true;
  } catch (err: any) {
    console.log(`Could not configure systemd service: ${err.message}`);
    return false;
  }
}

export function uninstallSystemdService(dependencies: { exec?: (cmd: string) => any } = {}): boolean {
  const exec = dependencies.exec || ((cmd: string) => execSync(cmd, { stdio: 'ignore' }));
  try {
    exec('systemctl --user stop poke.service');
    exec('systemctl --user disable poke.service');
    const serviceFile = getSystemdUserServicePath();
    if (fs.existsSync(serviceFile)) {
      fs.unlinkSync(serviceFile);
    }
    exec('systemctl --user daemon-reload');
    console.log('✓ Stopped and removed systemd user service');
    return true;
  } catch (err: any) {
    console.log(`Could not remove systemd service: ${err.message}`);
    return false;
  }
}

export async function runStart(
  options: { foreground?: boolean },
  customHome?: string,
  dependencies: {
    exec?: (cmd: string) => any;
    installationPaths?: { pokeBinPath: string; workingDir: string };
  } = {}
): Promise<void> {
  const exec = dependencies.exec || execSync;
  const paths = resolvePokePaths(customHome);
  const pidFile = path.join(paths.root, 'daemon.pid');

  // If foreground mode requested, start directly
  if (options.foreground) {
    console.log('Starting Poke daemon in foreground...');
    const daemon = new PokeDaemon(customHome);
    await daemon.start();
    return;
  }

  // Ensure systemd user service is installed and started if systemd is available
  if (isSystemdAvailable(exec)) {
    installSystemdService(customHome, dependencies);
    if (isSystemdServiceActive(exec)) {
      console.log('Poke daemon is already running via systemd.');
      return;
    }
    try {
      exec('systemctl --user start poke.service');
      console.log('✓ Started Poke daemon via systemd user service (poke.service).');
      return;
    } catch (err: any) {
      console.log(`Failed to start via systemd (${err.message}), falling back to background process.`);
    }
  }

  if (fs.existsSync(pidFile)) {
    const record = readDaemonPidFile(pidFile);
    const { pokeBinPath } = resolvePokeInstallationPaths();
    if (record && isLivePokeDaemon(record, pokeBinPath)) {
      console.log(`Poke daemon is already running (PID: ${record.pid}).`);
      return;
    }
    // Let the daemon claim remove a stale PID atomically, avoiding a race with a
    // daemon which is just starting.
  }

  console.log('Starting Poke daemon in background...');
  const { pokeBinPath: scriptPath } = resolvePokeInstallationPaths();
  const child = spawn(process.execPath, [scriptPath, 'start', '--foreground'], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, ...(customHome ? { POKE_HOME: customHome } : {}) },
  });

  child.unref();
  console.log(`✓ Poke daemon started in background (PID: ${child.pid}).`);
}

export async function runStop(customHome?: string): Promise<void> {
  // If systemd service is active, stop it via systemctl
  if (isSystemdServiceInstalled() && isSystemdAvailable()) {
    try {
      execSync('systemctl --user stop poke.service');
      console.log('✓ Stopped Poke daemon via systemd.');
      return;
    } catch {
      // Fall through to PID check
    }
  }

  const paths = resolvePokePaths(customHome);
  const pidFile = path.join(paths.root, 'daemon.pid');

  if (!fs.existsSync(pidFile)) {
    console.log('Poke daemon is not running.');
    return;
  }

  const record = readDaemonPidFile(pidFile);
  const { pokeBinPath } = resolvePokeInstallationPaths();
  if (!record || !isLivePokeDaemon(record, pokeBinPath)) {
    console.log('Stale PID file detected, removing.');
    if (record) {
      removeDaemonPidFileIfMatches(pidFile, record);
    }
    return;
  }

  const { pid } = record;

  try {
    process.kill(pid, 'SIGTERM');
    console.log(`Sent SIGTERM to Poke daemon (PID: ${pid}). Waiting for graceful shutdown...`);

    // Wait up to 5 seconds for shutdown
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 250));
      try {
        process.kill(pid, 0);
      } catch {
        console.log('✓ Poke daemon stopped successfully.');
        return;
      }
    }

    if (!isLivePokeDaemon(record, pokeBinPath)) {
      console.log('Daemon exited or PID was reused; not sending SIGKILL.');
      removeDaemonPidFileIfMatches(pidFile, record);
      return;
    }

    console.log('Daemon did not stop in time, sending SIGKILL...');
    try {
      process.kill(pid, 'SIGKILL');
    } catch {}
    removeDaemonPidFileIfMatches(pidFile, record);
    console.log('✓ Poke daemon terminated.');
  } catch (err: any) {
    console.log(`Daemon was not running: ${err.message}`);
    removeDaemonPidFileIfMatches(pidFile, record);
  }
}

export async function runRestart(options: { foreground?: boolean }, customHome?: string): Promise<void> {
  console.log('Restarting Poke daemon...');
  await runStop(customHome);
  await new Promise((r) => setTimeout(r, 1000));
  await runStart(options, customHome);
}
