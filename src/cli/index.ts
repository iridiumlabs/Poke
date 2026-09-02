import { Command } from 'commander';
import { runSetup } from './setup.js';
import { runConfigure } from './configure.js';
import { runLogin } from './login.js';
import { runModelSelection } from './model.js';
import { runWhatsAppMenu } from './whatsapp.js';
import { runStatus } from './status.js';
import { runDoctor } from './doctor.js';
import { runLogs } from './logs.js';
import {
  runStart,
  runStop,
  runRestart,
} from './lifecycle.js';
import { runUpdate } from './update.js';
import { runCompact } from './compact.js';

export function createCli(): Command {
  const program = new Command();

  program
    .name('poke')
    .description('Private, WhatsApp-first personal agent running on a dedicated Ubuntu VPS')
    .version('1.0.0');

  program
    .command('setup')
    .description('Interactive setup for WhatsApp pairing, owner number, and service API keys')
    .action(async () => {
      await runSetup();
    });

  program
    .command('configure')
    .description('Add or replace Supermemory, Composio, Exa, Deepgram, and Groq API keys')
    .action(async () => {
      await runConfigure();
    });

  program
    .command('login')
    .description('Authenticate an AI provider (Command Code, Fireworks AI, Codex)')
    .action(async () => {
      await runLogin();
    });

  program
    .command('model')
    .description('Configure the AI model and reasoning effort for the main agent or workers')
    .argument('[target]', 'Target agent ("main" or "worker")', 'main')
    .action(async (target) => {
      if (target !== 'main' && target !== 'worker') {
        throw new Error('Model target must be "main" or "worker".');
      }
      await runModelSelection(target);
    });

  program
    .command('whatsapp')
    .description('Manage WhatsApp connection, session credentials, and status')
    .action(async () => {
      await runWhatsAppMenu();
    });

  program
    .command('start')
    .description('Start the Poke daemon')
    .option('-f, --foreground', 'Run in foreground instead of background daemon')
    .action(async (options) => {
      await runStart(options);
    });

  program
    .command('stop')
    .description('Gracefully stop the background Poke daemon')
    .action(async () => {
      await runStop();
    });

  program
    .command('restart')
    .description('Restart the Poke daemon')
    .option('-f, --foreground', 'Run in foreground after restart')
    .action(async (options) => {
      await runRestart(options);
    });

  program
    .command('status')
    .description('Show runtime status, WhatsApp state, models, worker queue, and compaction info')
    .action(async () => {
      await runStatus();
    });

  program
    .command('compact')
    .description('Manually compact the main agent conversation')
    .action(async () => {
      await runCompact();
    });

  program
    .command('doctor')
    .description('Run read-only system diagnostics and health checks')
    .action(async () => {
      const { success } = await runDoctor();
      if (!success) {
        process.exit(1);
      }
    });

  program
    .command('logs')
    .description('Show structured daemon logs')
    .option('-f, --follow', 'Follow log output in real time')
    .option('-n, --lines <number>', 'Number of lines to show', '100')
    .action(async (options) => {
      await runLogs({
        follow: options.follow,
        lines: parseInt(options.lines, 10) || 100,
      });
    });

  program
    .command('update')
    .description('Update Poke from origin/main, install dependencies, rebuild, and restart daemon if running')
    .action(async () => {
      await runUpdate();
    });

  return program;
}
