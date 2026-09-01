import { spawnSync } from 'node:child_process';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const result = spawnSync(npm, ['install-scripts', 'ls', '--json'], {
  encoding: 'utf8',
});

if (result.status !== 0) {
  process.stderr.write(result.stderr || result.stdout || 'Unable to inspect npm install-script policy.\n');
  process.exit(result.status || 1);
}

let report;
try {
  report = JSON.parse(result.stdout);
} catch {
  process.stderr.write('npm install-scripts returned invalid JSON.\n');
  process.exit(1);
}

const pending = Array.isArray(report.allowScripts) ? report.allowScripts : [];
if (pending.length > 0) {
  process.stderr.write(`Unreviewed dependency install scripts: ${pending.map((entry) => entry.name).join(', ')}\n`);
  process.exit(1);
}
