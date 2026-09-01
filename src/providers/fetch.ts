export const PROVIDER_REQUEST_TIMEOUT_MS = 15_000;

export function providerRequestSignal(parent?: AbortSignal): AbortSignal {
  const deadline = AbortSignal.timeout(PROVIDER_REQUEST_TIMEOUT_MS);
  return parent ? AbortSignal.any([parent, deadline]) : deadline;
}
