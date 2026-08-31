import readline from 'readline';
import { ConfigManager } from '../config/config.js';
import { ProviderRegistry } from '../providers/provider-registry.js';
import { ProviderType, ReasoningEffort } from '../config/types.js';

function promptQuestion(rl: readline.Interface, query: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(query, (answer) => {
      resolve(answer.trim());
    });
  });
}

export async function runModelSelection(
  target: 'main' | 'worker' = 'main',
  customHome?: string,
  inputRl?: readline.Interface
): Promise<void> {
  const rl =
    inputRl ||
    readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

  const configManager = new ConfigManager(customHome);
  const currentSelection =
    target === 'worker' ? configManager.getWorkerModel() : configManager.getMainModel();

  console.log(`\n--- Configure ${target.toUpperCase()} Model ---`);
  if (currentSelection) {
    console.log(
      `Current: ${currentSelection.provider} / ${currentSelection.model} (reasoning: ${currentSelection.reasoningEffort || 'default'})\n`
    );
  } else {
    console.log('Current: None configured\n');
  }

  try {
    // 1. Choose Provider
    console.log('Select Provider:');
    console.log('1. Command Code');
    console.log('2. Fireworks AI');
    console.log('3. Codex');

    const provChoice = await promptQuestion(rl, 'Choice [1-3]: ');
    let provider: ProviderType = 'commandcode';
    if (provChoice === '2' || provChoice.toLowerCase().includes('fireworks')) {
      provider = 'fireworks';
    } else if (provChoice === '3' || provChoice.toLowerCase().includes('codex')) {
      provider = 'codex';
    }

    // 2. Fetch Live Models
    console.log(`\nFetching live models from ${provider}...`);
    const creds = configManager.getCredentials();
    const models = await ProviderRegistry.fetchModels(provider, creds);

    if (models.length === 0) {
      console.log('No models returned from provider.');
      return;
    }

    console.log('\nAvailable Models:');
    models.forEach((m, idx) => {
      const reasoningNote =
        m.capabilities.reasoningEfforts.length > 0
          ? `[reasoning: ${m.capabilities.reasoningEfforts.join('/')}]`
          : '';
      console.log(`${idx + 1}. ${m.id} ${reasoningNote}`);
    });

    const modelIdxInput = await promptQuestion(rl, `\nSelect model [1-${models.length}]: `);
    const modelIdx = parseInt(modelIdxInput, 10) - 1;
    if (isNaN(modelIdx) || modelIdx < 0 || modelIdx >= models.length) {
      console.log('Invalid model selection.');
      return;
    }

    const selectedModel = models[modelIdx];

    // 3. Reasoning Effort (only shown if model has selectable levels)
    let selectedEffort: ReasoningEffort | undefined;
    const availableEfforts = selectedModel.capabilities.reasoningEfforts;

    if (availableEfforts.length > 0) {
      console.log(`\nSelect Reasoning Effort for ${selectedModel.id}:`);
      console.log('0. Default (none)');
      availableEfforts.forEach((eff, idx) => {
        console.log(`${idx + 1}. ${eff}`);
      });

      const effortInput = await promptQuestion(rl, `Choice [0-${availableEfforts.length}]: `);
      const effortIdx = parseInt(effortInput, 10);
      if (effortIdx > 0 && effortIdx <= availableEfforts.length) {
        selectedEffort = availableEfforts[effortIdx - 1];
      }
    }

    // 4. Save Validated Selection
    const selection = {
      provider,
      model: selectedModel.id,
      reasoningEffort: selectedEffort,
    };

    if (target === 'worker') {
      configManager.setWorkerModel(selection);
      console.log(`\n✓ Worker model set to: ${provider}/${selectedModel.id} (reasoning: ${selectedEffort || 'default'})\n`);
    } else {
      configManager.setMainModel(selection);
      console.log(`\n✓ Main agent model set to: ${provider}/${selectedModel.id} (reasoning: ${selectedEffort || 'default'})\n`);
    }
  } catch (err: any) {
    console.error(`\n✗ Error configuring model: ${err.message}\n`);
  } finally {
    if (!inputRl) {
      rl.close();
    }
  }
}
