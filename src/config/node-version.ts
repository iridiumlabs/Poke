export const SUPPORTED_NODE_VERSION_RANGE = '>=24.20.0 <25';

interface NodeVersion {
  major: number;
  minor: number;
  patch: number;
}

function parseNodeVersion(value: string): NodeVersion | null {
  const match = value.trim().replace(/^v/, '').match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

export function isSupportedNodeVersion(value: string): boolean {
  const version = parseNodeVersion(value);
  if (!version || version.major !== 24) return false;
  if (version.minor > 20) return true;
  if (version.minor < 20) return false;
  return version.patch >= 0;
}

export function assertSupportedNodeVersion(value = process.versions.node): void {
  if (isSupportedNodeVersion(value)) return;

  throw new Error(
    `Poke requires Node.js ${SUPPORTED_NODE_VERSION_RANGE}. Detected ${value}. ` +
      'Install Node 24.20.0 LTS or a newer Node 24 release before starting Poke.'
  );
}
