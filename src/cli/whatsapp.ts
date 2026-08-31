import readline from 'readline';
import fs from 'fs';
import path from 'path';
import { resolvePokePaths } from '../config/paths.js';
import { ConfigManager } from '../config/config.js';

function promptQuestion(rl: readline.Interface, query: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(query, (answer) => {
      resolve(answer.trim());
    });
  });
}

export async function runWhatsAppMenu(customHome?: string, inputRl?: readline.Interface): Promise<void> {
  const rl =
    inputRl ||
    readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

  const paths = resolvePokePaths(customHome);
  const configManager = new ConfigManager(customHome);
  const ownerPhone = configManager.getOwnerPhoneNumber();

  const sessionFiles = fs.existsSync(paths.whatsappDir)
    ? fs.readdirSync(paths.whatsappDir)
    : [];
  const hasSession = sessionFiles.length > 0;

  console.log('\n--- WhatsApp Configuration ---');
  console.log(`Status: ${hasSession ? 'session saved' : 'not authenticated'}`);
  console.log(`Owner Number: ${ownerPhone || 'none configured'}\n`);

  console.log('1. Show connection status');
  console.log('2. Clear session credentials');
  console.log('3. Re-authenticate');
  console.log('4. Cancel');

  try {
    const choice = await promptQuestion(rl, '\nChoice [1-4]: ');

    if (choice === '1') {
      console.log(`\nWhatsApp Session Status:`);
      console.log(`Auth Directory: ${paths.whatsappDir}`);
      console.log(`Saved Credential Files: ${sessionFiles.length}`);
      console.log(`Configured Owner: ${ownerPhone || 'none'}\n`);
    } else if (choice === '2') {
      const confirm = await promptQuestion(
        rl,
        'Are you sure you want to clear WhatsApp session credentials? (yes/no): '
      );
      if (confirm.toLowerCase() === 'yes' || confirm.toLowerCase() === 'y') {
        if (fs.existsSync(paths.whatsappDir)) {
          const files = fs.readdirSync(paths.whatsappDir);
          for (const file of files) {
            fs.unlinkSync(path.join(paths.whatsappDir, file));
          }
        }
        console.log('✓ WhatsApp session cleared. Existing conversations, memories, and jobs were preserved.\n');
      } else {
        console.log('Aborted session clearing.\n');
      }
    } else if (choice === '3') {
      console.log('\nTo re-authenticate, restart the Poke daemon or run setup.\n');
    } else {
      console.log('Cancelled.\n');
    }
  } finally {
    if (!inputRl) {
      rl.close();
    }
  }
}
