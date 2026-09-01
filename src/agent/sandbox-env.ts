const POKE_PROVIDER_SECRET_ENVIRONMENT_VARIABLES = [
  'COMPOSIO_API_KEY',
  'DEEPGRAM_API_KEY',
  'EXA_API_KEY',
  'FIREWORKS_API_KEY',
  'COMMAND_CODE_API_KEY',
  'COMMANDCODE_API_KEY',
  'OPENAI_API_KEY',
  'OPENAI_ACCESS_TOKEN',
  'OPENAI_REFRESH_TOKEN',
  'OPENAI_CODEX_ACCESS_TOKEN',
  'OPENAI_CODEX_REFRESH_TOKEN',
  'ANTHROPIC_API_KEY',
  'GOOGLE_API_KEY',
  'GEMINI_API_KEY',
  'PI_API_KEY',
  'SUPERMEMORY_API_KEY',
] as const;

/**
 * Poke's local sandbox inherits the host environment so ordinary host tools
 * keep working. Provider credentials stay behind Poke's host-side adapters.
 */
export function createPokeSandboxEnvironment(
  environment: NodeJS.ProcessEnv = process.env
): Record<string, string | undefined> {
  const sandboxEnvironment: Record<string, string | undefined> = { ...environment };
  for (const name of POKE_PROVIDER_SECRET_ENVIRONMENT_VARIABLES) {
    sandboxEnvironment[name] = undefined;
  }
  return sandboxEnvironment;
}
