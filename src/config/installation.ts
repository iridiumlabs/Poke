import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface PokeInstallationPaths {
  pokeBinPath: string;
  workingDir: string;
}

export function resolvePokeInstallationPaths(): PokeInstallationPaths {
  const modulePath = fileURLToPath(import.meta.url);
  const moduleDir = path.dirname(modulePath);
  const extension = path.extname(modulePath);
  const candidates = [path.resolve(moduleDir, '../..'), path.resolve(moduleDir, '../../..')];
  const workingDir = candidates.find((candidate) => fs.existsSync(path.join(candidate, 'package.json'))) || candidates[0];

  return {
    pokeBinPath: path.resolve(moduleDir, `../../bin/poke${extension}`),
    workingDir,
  };
}
