import readline from 'readline';
import { ConfigManager, normalizePhoneNumber } from '../config/config.js';

function promptQuestion(rl: readline.Interface, query: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(query, (answer) => {
      resolve(answer.trim());
    });
  });
}

export async function runSetup(customHome?: string, inputRl?: readline.Interface): Promise<void> {
  const rl =
    inputRl ||
    readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

  const configManager = new ConfigManager(customHome);

  console.log('\n--- Poke Setup ---\n');
  console.log('Timezone: Asia/Karachi (fixed default)\n');

  try {
    // 1. Owner Phone Number
    let ownerPhone = configManager.getOwnerPhoneNumber() || '';
    const phonePrompt = ownerPhone ? `Owner phone number [${ownerPhone}]: ` : 'Owner phone number (e.g. +923001234567): ';
    const inputPhone = await promptQuestion(rl, phonePrompt);
    if (inputPhone) {
      ownerPhone = normalizePhoneNumber(inputPhone);
      configManager.setOwnerPhoneNumber(ownerPhone);
      console.log(`✓ Owner phone saved as: ${ownerPhone}`);
    }

    // 2. Service Keys
    console.log('\nConfigure External Services:\n');
    const existingCreds = configManager.getCredentials();

    // Composio
    const compPrompt = existingCreds.composioApiKey
      ? 'Composio API key [already set, press enter to keep]: '
      : 'Composio API key (optional, press enter to skip): ';
    const composioKey = await promptQuestion(rl, compPrompt);
    if (composioKey) {
      configManager.updateCredentials({ composioApiKey: composioKey });
      console.log('✓ Composio API key updated');
    }

    // Supermemory
    const superPrompt = existingCreds.supermemoryApiKey
      ? 'Supermemory API key [already set, press enter to keep]: '
      : 'Supermemory API key (optional, press enter to skip): ';
    const superKey = await promptQuestion(rl, superPrompt);
    if (superKey) {
      configManager.updateCredentials({ supermemoryApiKey: superKey });
      console.log('✓ Supermemory API key updated');
    }

    // Exa
    const exaPrompt = existingCreds.exaApiKey
      ? 'Exa API key [already set, press enter to keep]: '
      : 'Exa API key (for web search/fetch): ';
    const exaKey = await promptQuestion(rl, exaPrompt);
    if (exaKey) {
      configManager.updateCredentials({ exaApiKey: exaKey });
      console.log('✓ Exa API key updated');
    }

    // Deepgram
    const dgPrompt = existingCreds.deepgramApiKey
      ? 'Deepgram API key [already set, press enter to keep]: '
      : 'Deepgram API key (for voice notes STT & TTS): ';
    const dgKey = await promptQuestion(rl, dgPrompt);
    if (dgKey) {
      configManager.updateCredentials({ deepgramApiKey: dgKey });
      console.log('✓ Deepgram API key updated');
    }

    console.log('\n✓ Setup complete. Run `poke login` to authenticate an AI model provider.\n');
  } finally {
    if (!inputRl) {
      rl.close();
    }
  }
}
