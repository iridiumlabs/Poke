/**
 * Poke's local sandbox inherits the host environment so ordinary host tools
 * and user scripts keep working. The daemon forwards the full environment.
 */
export function createPokeSandboxEnvironment(
  environment: NodeJS.ProcessEnv = process.env
): Record<string, string | undefined> {
  return { ...environment };
}
