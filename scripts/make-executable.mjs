import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

const binaries = [
  path.join(projectRoot, 'dist', 'bin', 'poke.js'),
];

if (process.platform !== 'win32') {
  for (const binPath of binaries) {
    if (fs.existsSync(binPath)) {
      fs.chmodSync(binPath, 0o755);
    }
  }
}
