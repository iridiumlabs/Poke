import { ConfigManager } from '../config/config.js';
import type { ModelInfo, ModelSelection, ProviderType, ReasoningEffort } from '../config/types.js';
import { FileCredentialStore } from '../providers/credential-store.js';
import { migrateLegacyProviderCredentials } from '../providers/credentials-migration.js';
import { ProviderRegistry, type ProviderCatalog } from '../providers/provider-registry.js';
import { redactSecrets } from '../logger/logger.js';
import { CliCancelledError, createCliUi, type CliUi } from './ui.js';
import { isDaemonRunning, runRestart } from './lifecycle.js';

const PROVIDER_CHOICES: ReadonlyArray<{ value: ProviderType; name: string; description: string }> = [
  { value: 'commandcode', name: 'Command Code', description: 'Provider API' },
  { value: 'fireworks', name: 'Fireworks AI', description: 'Live account catalog' },
  { value: 'codex', name: 'Codex', description: 'ChatGPT/Codex OAuth' },
];

function describeSelection(selection?: ModelSelection): string {
  if (!selection) return 'Not configured';
  return `${selection.provider} / ${selection.model} (reasoning: ${selection.reasoningEffort || 'default'})`;
}

function modelChoices(models: readonly ModelInfo[]) {
  return models.map((model) => ({
    value: model.id,
    name: model.name || model.id,
    description:
      model.capabilities.reasoningEfforts.length > 0
        ? `Reasoning: ${model.capabilities.reasoningEfforts.join(', ')}`
        : 'Provider default reasoning',
  }));
}

export async function runModelSelection(
  target: 'main' | 'worker' = 'main',
  customHome?: string,
  ui: CliUi = createCliUi(),
  catalog?: ProviderCatalog
): Promise<void> {
  const config = new ConfigManager(customHome);
  const credentials = new FileCredentialStore(config.getPaths().credentialsFile);
  await migrateLegacyProviderCredentials(config, credentials);
  const registry = catalog || new ProviderRegistry(credentials);
  const current = target === 'worker' ? config.getWorkerModel() : config.getMainModel();

  ui.note(`Configure ${target} model`);
  ui.note(`Current: ${describeSelection(current)}`);

  try {
    while (true) {
      const provider = await ui.select('Choose a provider', PROVIDER_CHOICES, current?.provider);
      let models: ModelInfo[];
      try {
        models = await ui.spinner(`Fetching ${provider} models…`, () => registry.fetchModels(provider));
      } catch (error: unknown) {
        ui.error(error instanceof Error ? redactSecrets(error.message) : 'Unable to fetch models.');
        if (await ui.confirm('Choose a different provider?', true)) continue;
        return;
      }

      if (models.length === 0) {
        ui.error(`${provider} returned no available models.`);
        if (await ui.confirm('Choose a different provider?', true)) continue;
        return;
      }

      const modelId = await ui.select('Choose a model', modelChoices(models));
      const model = models.find((candidate) => candidate.id === modelId);
      if (!model) {
        ui.error('That model is no longer available.');
        continue;
      }

      let reasoningEffort: ReasoningEffort | undefined;
      if (model.capabilities.reasoningEfforts.length > 0) {
        const selected = await ui.select(
          'Choose reasoning effort',
          [
            { value: 'default', name: 'Provider default' },
            ...model.capabilities.reasoningEfforts.map((value) => ({ value, name: value })),
          ],
          current?.provider === provider && current.model === model.id
            ? current.reasoningEffort || 'default'
            : 'default'
        );
        reasoningEffort = selected === 'default' ? undefined : selected;
      }

      const selection: ModelSelection = { provider, model: model.id, reasoningEffort };
      const validation = await ui.spinner('Validating selection…', () => registry.validateSelection(selection));
      if (!validation.valid) {
        ui.error(redactSecrets(validation.error || 'The selected model is no longer valid.'));
        continue;
      }

      if (target === 'main') {
        config.setMainModel(selection);
      } else {
        config.setWorkerModel(selection);
      }
      if (isDaemonRunning(customHome)) {
        ui.note('Restarting the running daemon so the new model definition is applied.');
        await runRestart({}, customHome);
      }
      ui.success(`${target === 'main' ? 'Main' : 'Worker'} model set to ${describeSelection(selection)}.`);
      return;
    }
  } catch (error: unknown) {
    if (error instanceof CliCancelledError) {
      ui.warning('Model selection cancelled. The previous selection was kept.');
      return;
    }
    throw error;
  }
}
