export const PROVIDER_REQUEST_TIMEOUT_MS = 15_000;

export function providerRequestSignal(): AbortSignal {
  return AbortSignal.timeout(PROVIDER_REQUEST_TIMEOUT_MS);
}
