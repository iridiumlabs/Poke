import readline from 'readline';
import { ConfigManager } from '../config/config.js';
import { ProviderType } from '../config/types.js';
import { CommandCodeCatalog } from '../providers/commandcode.js';
import { FireworksCatalog } from '../providers/fireworks.js';
import { CodexCatalog } from '../providers/codex.js';

function promptQuestion(rl: readline.Interface, query: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(query, (answer) => {
      resolve(answer.trim());
    });
  });
}

export async function runLogin(customHome?: string, inputRl?: readline.Interface): Promise<void> {
  const rl =
    inputRl ||
    readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

  const configManager = new ConfigManager(customHome);

  console.log('\n--- Poke Login: Select Model Provider ---\n');
  console.log('1. Command Code (Provider API Key)');
  console.log('2. Fireworks AI (API Key)');
  console.log('3. Codex (ChatGPT/Codex OAuth / Access Token)');

  try {
    const choice = await promptQuestion(rl, '\nSelect provider [1-3]: ');

    if (choice === '1' || choice.toLowerCase().includes('command')) {
      const key = await promptQuestion(rl, 'Enter Command Code Provider API key: ');
      if (key) {
        console.log('Validating Command Code credentials...');
        try {
          const models = await CommandCodeCatalog.fetchLiveModels(key);
          configManager.updateCredentials({ commandCodeApiKey: key });
          console.log(`✓ Command Code authenticated. Found ${models.length} available models.`);
        } catch (err: any) {
          console.error(`✗ Validation failed: ${err.message}`);
          configManager.updateCredentials({ commandCodeApiKey: key });
          console.log('Key saved. Check your network or key if errors persist.');
        }
      }
    } else if (choice === '2' || choice.toLowerCase().includes('fireworks')) {
      const key = await promptQuestion(rl, 'Enter Fireworks AI API key: ');
      if (key) {
        console.log('Validating Fireworks credentials...');
        try {
          const models = await FireworksCatalog.fetchLiveModels(key);
          configManager.updateCredentials({ fireworksApiKey: key });
          console.log(`✓ Fireworks AI authenticated. Found ${models.length} available models.`);
        } catch (err: any) {
          console.error(`✗ Validation failed: ${err.message}`);
          configManager.updateCredentials({ fireworksApiKey: key });
          console.log('Key saved.');
        }
      }
    } else if (choice === '3' || choice.toLowerCase().includes('codex')) {
      const token = await promptQuestion(rl, 'Enter Codex Access Token: ');
      if (token) {
        configManager.updateCredentials({
          codexAuth: {
            accessToken: token,
            expiresAt: Date.now() + 30 * 24 * 3600 * 1000,
          },
        });
        console.log('✓ Codex authentication credentials saved.');
      }
    } else {
      console.log('Invalid selection.');
    }
  } finally {
    if (!inputRl) {
      rl.close();
    }
  }
}
