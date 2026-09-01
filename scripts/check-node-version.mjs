const supportedRange = '>=24.20.0 <25';
const match = process.versions.node.match(/^(\d+)\.(\d+)\.(\d+)/);
const supported =
  match &&
  Number(match[1]) === 24 &&
  (Number(match[2]) > 20 || (Number(match[2]) === 20 && Number(match[3]) >= 0));

if (!supported) {
  console.error(
    `Poke requires Node.js ${supportedRange}. Detected ${process.versions.node}. ` +
      'Install Node 24.20.0 LTS or a newer Node 24 release before installing Poke.'
  );
  process.exitCode = 1;
}
