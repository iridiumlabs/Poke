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

export function isSystemdAvailable(): boolean {
  try {
    execSync('systemctl --user list-units --type=service', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function isSystemdServiceInstalled(): boolean {
  const serviceFile = path.join(os.homedir(), '.config/systemd/user/poke.service');
  return fs.existsSync(serviceFile);
}

export function isSystemdServiceActive(): boolean {
  if (!isSystemdAvailable() || !isSystemdServiceInstalled()) return false;
  try {
    const output = execSync('systemctl --user is-active poke.service', { encoding: 'utf8' }).trim();
    return output === 'active';
  } catch {
    return false;
  }
}

export function installSystemdService(): boolean {
  try {
    const userSystemdDir = path.join(os.homedir(), '.config/systemd/user');
    if (!fs.existsSync(userSystemdDir)) {
      fs.mkdirSync(userSystemdDir, { recursive: true, mode: 0o755 });
    }

    const nodePath = process.execPath;
    const { pokeBinPath, workingDir } = resolvePokeInstallationPaths();
    const quoteSystemdArgument = (value: string) => `"${value.replace(/[\\"]/g, '\\$&')}"`;

    const unitContent = `[Unit]
Description=Poke WhatsApp Personal Agent Daemon
After=network.target

[Service]
Type=exec
WorkingDirectory=${quoteSystemdArgument(workingDir)}
ExecStart=${quoteSystemdArgument(nodePath)} ${quoteSystemdArgument(pokeBinPath)} start --foreground
Restart=on-failure
RestartSec=5
KillMode=process
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
`;

    const serviceFile = path.join(userSystemdDir, 'poke.service');
    fs.writeFileSync(serviceFile, unitContent, { mode: 0o644 });

    execSync('systemctl --user daemon-reload', { stdio: 'ignore' });
    execSync('systemctl --user enable poke.service', { stdio: 'ignore' });

    console.log(`✓ Installed and enabled systemd user service at ${serviceFile}`);
    return true;
  } catch (err: any) {
    console.log(`Could not configure systemd service: ${err.message}`);
    return false;
  }
}

export function uninstallSystemdService(): boolean {
  try {
    execSync('systemctl --user stop poke.service', { stdio: 'ignore' });
    execSync('systemctl --user disable poke.service', { stdio: 'ignore' });
    const serviceFile = path.join(os.homedir(), '.config/systemd/user/poke.service');
    if (fs.existsSync(serviceFile)) {
      fs.unlinkSync(serviceFile);
    }
    execSync('systemctl --user daemon-reload', { stdio: 'ignore' });
    console.log('✓ Stopped and removed systemd user service');
    return true;
  } catch (err: any) {
    console.log(`Could not remove systemd service: ${err.message}`);
    return false;
  }
}

export async function runStart(options: { foreground?: boolean }, customHome?: string): Promise<void> {
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
  if (isSystemdAvailable()) {
    if (!isSystemdServiceInstalled()) {
      installSystemdService();
    }
    try {
      execSync('systemctl --user start poke.service');
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
