import os from 'os';
import path from 'path';
import fs from 'fs';

export function getPokeHome(): string {
  if (process.env.POKE_HOME) {
    return path.resolve(process.env.POKE_HOME);
  }
  return path.join(os.homedir(), '.poke');
}

export function getSkillsHome(): string {
  if (process.env.POKE_SKILLS_HOME) {
    return path.resolve(process.env.POKE_SKILLS_HOME);
  }
  return path.join(os.homedir(), '.agents', 'skills');
}

export interface PokePaths {
  root: string;
  configFile: string;
  credentialsFile: string;
  runtimeStatusFile: string;
  sqliteFile: string;
  whatsappDir: string;
  inboxDir: string;
  outboxDir: string;
  logsDir: string;
  cacheDir: string;
  skillsDir: string;
  socketFile: string;
}

export function resolvePokePaths(customHome?: string): PokePaths {
  const root = customHome ? path.resolve(customHome) : getPokeHome();
  const skillsDir = process.env.POKE_SKILLS_HOME
    ? path.resolve(process.env.POKE_SKILLS_HOME)
    : getSkillsHome();

  return {
    root,
    configFile: path.join(root, 'config.json'),
    credentialsFile: path.join(root, 'credentials.json'),
    runtimeStatusFile: path.join(root, 'runtime-status.json'),
    sqliteFile: path.join(root, 'state.sqlite'),
    whatsappDir: path.join(root, 'whatsapp'),
    inboxDir: path.join(root, 'inbox'),
    outboxDir: path.join(root, 'outbox'),
    logsDir: path.join(root, 'logs'),
    cacheDir: path.join(root, 'cache'),
    skillsDir,
    socketFile: path.join(root, 'daemon.sock'),
  };
}

export function ensurePokeDirectories(paths: PokePaths): void {
  const dirs = [
    paths.root,
    paths.whatsappDir,
    paths.inboxDir,
    paths.outboxDir,
    paths.logsDir,
    paths.cacheDir,
    paths.skillsDir,
  ];

  for (const dir of dirs) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
  }
}
