import fs from 'fs';
import path from 'path';
import { ConfigManager } from '../config/config.js';
import { PokeDatabase } from '../db/database.js';
import { ExaToolHandler } from '../tools/exa.js';
import { SupermemoryToolHandler } from '../tools/supermemory.js';
import { ComposioToolHandler } from '../tools/composio.js';
import { SkillRegistry } from '../skills/registry.js';
import { WorkerManager } from '../workers/worker-manager.js';
import { AutomationScheduler } from '../scheduler/scheduler.js';
import { CompactionManager } from '../context/compaction-manager.js';
import { WhatsAppGateway } from '../gateway/whatsapp.js';
import { PokeRuntime } from '../agent/runtime.js';
import { getLogger } from '../logger/logger.js';
import { resolvePokePaths, ensurePokeDirectories } from '../config/paths.js';

export class PokeDaemon {
  private configManager: ConfigManager;
  private db: PokeDatabase;
  private exa: ExaToolHandler;
  private supermemory: SupermemoryToolHandler;
  private composio: ComposioToolHandler;
  private skills: SkillRegistry;
  private workerManager: WorkerManager;
  private scheduler: AutomationScheduler;
  private compactionManager: CompactionManager;
  private gateway: WhatsAppGateway;
  private runtime: PokeRuntime;
  private pidFile: string;
  private isRunning = false;

  constructor(customHome?: string) {
    const paths = resolvePokePaths(customHome);
    ensurePokeDirectories(paths);

    this.pidFile = path.join(paths.root, 'daemon.pid');
    this.configManager = new ConfigManager(customHome);
    this.db = new PokeDatabase(customHome);

    const creds = this.configManager.getCredentials();
    this.exa = new ExaToolHandler(creds.exaApiKey);
    this.supermemory = new SupermemoryToolHandler(creds.supermemoryApiKey);
    this.composio = new ComposioToolHandler(creds.composioApiKey);
    this.skills = new SkillRegistry(paths.skillsDir);
    this.compactionManager = new CompactionManager(this.db, this.configManager);

    this.workerManager = new WorkerManager(
      this.db,
      this.configManager,
      this.exa,
      this.supermemory,
      this.composio,
      this.skills
    );

    this.scheduler = new AutomationScheduler(this.db);

    this.gateway = new WhatsAppGateway(
      this.configManager,
      this.db,
      async (inbound) => {
        // Dispatch incoming WhatsApp message to main agent
        await this.runtime.dispatchUserMessage(inbound.text, inbound.attachments);
      },
      async () => {
        // Exact /stop handler
        await this.runtime.abortAll();
      },
      customHome
    );

    this.runtime = new PokeRuntime(
      this.configManager,
      this.db,
      this.exa,
      this.supermemory,
      this.composio,
      this.skills,
      this.workerManager,
      this.scheduler,
      this.gateway.getSender(),
      this.compactionManager,
      customHome
    );
  }

  getConfigManager(): ConfigManager {
    return this.configManager;
  }

  getDatabase(): PokeDatabase {
    return this.db;
  }

  getRuntime(): PokeRuntime {
    return this.runtime;
  }

  getGateway(): WhatsAppGateway {
    return this.gateway;
  }

  getWorkerManager(): WorkerManager {
    return this.workerManager;
  }

  getScheduler(): AutomationScheduler {
    return this.scheduler;
  }

  getCompactionManager(): CompactionManager {
    return this.compactionManager;
  }

  async start(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;

    const logger = getLogger();
    logger.info({ pid: process.pid }, 'Starting Poke daemon');

    // Write PID file
    fs.writeFileSync(this.pidFile, String(process.pid), 'utf8');

    // Start Flue agent runtime
    await this.runtime.start();

    // Start WhatsApp gateway
    await this.gateway.start();

    // Graceful shutdown listeners
    const onSignal = async (signal: string) => {
      logger.info({ signal }, 'Received shutdown signal');
      await this.stop();
      process.exit(0);
    };

    process.on('SIGINT', () => onSignal('SIGINT'));
    process.on('SIGTERM', () => onSignal('SIGTERM'));

    logger.info('Poke daemon is running');
  }

  async stop(): Promise<void> {
    if (!this.isRunning) return;
    this.isRunning = false;

    const logger = getLogger();
    logger.info('Stopping Poke daemon gracefully');

    try {
      await this.gateway.stop();
      await this.runtime.stop();
      this.db.close();

      if (fs.existsSync(this.pidFile)) {
        fs.unlinkSync(this.pidFile);
      }
    } catch (err: any) {
      logger.error({ err: err.message }, 'Error during daemon shutdown');
    }
  }
}
