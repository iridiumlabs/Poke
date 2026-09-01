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
import { resolvePokeInstallationPaths } from '../config/installation.js';
import { claimDaemonPidFile, removeOwnedDaemonPidFile } from './pid-file.js';
import { assertSupportedNodeVersion } from '../config/node-version.js';

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
  private ownsPidFile = false;
  private signalHandlers: Array<[NodeJS.Signals, () => void]> = [];
  private heartbeatInterval: NodeJS.Timeout | null = null;

  constructor(customHome?: string) {
    const paths = resolvePokePaths(customHome);
    ensurePokeDirectories(paths);

    this.pidFile = path.join(paths.root, 'daemon.pid');
    this.configManager = new ConfigManager(customHome);
    this.db = new PokeDatabase(customHome);

    const creds = this.configManager.getCredentials();
    this.exa = new ExaToolHandler(creds.exaApiKey);
    this.supermemory = new SupermemoryToolHandler(creds.supermemoryApiKey, 'poke-owner', this.db);
    this.composio = new ComposioToolHandler(creds.composioApiKey, undefined, this.db);
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
        await this.runtime.dispatchUserMessage(inbound.text, inbound.attachments, inbound.messageId);
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

    assertSupportedNodeVersion();

    const logger = getLogger();
    logger.info({ pid: process.pid }, 'Starting Poke daemon');

    try {
      claimDaemonPidFile(this.pidFile, resolvePokeInstallationPaths().pokeBinPath);
    } catch (err) {
      await this.stop();
      throw err;
    }
    this.ownsPidFile = true;
    this.isRunning = true;

    try {
      this.compactionManager.setMainAgentBusy(false);
      await this.runtime.start();
      await this.gateway.start();
      this.gateway.heartbeat();
      this.heartbeatInterval = setInterval(() => this.gateway.heartbeat(), 30_000);

      const onSignal = (signal: NodeJS.Signals) => {
        logger.info({ signal }, 'Received shutdown signal');
        void this.stop().finally(() => process.exit(0));
      };
      this.signalHandlers = [
        ['SIGINT', () => onSignal('SIGINT')],
        ['SIGTERM', () => onSignal('SIGTERM')],
      ];
      for (const [signal, handler] of this.signalHandlers) {
        process.once(signal, handler);
      }

      logger.info('Poke daemon is running');
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.message : String(err) }, 'Poke daemon startup failed');
      await this.stop();
      throw err;
    }
  }

  async stop(): Promise<void> {
    if (!this.isRunning && !this.db.isOpen()) return;
    this.isRunning = false;

    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }

    const logger = getLogger();
    logger.info('Stopping Poke daemon gracefully');

    for (const [signal, handler] of this.signalHandlers) {
      process.off(signal, handler);
    }
    this.signalHandlers = [];

    const cleanup = async (name: string, action: () => void | Promise<void>) => {
      try {
        await action();
      } catch (err: any) {
        logger.error({ err: err.message }, `Failed to stop ${name}`);
      }
    };

    await cleanup('WhatsApp gateway', () => this.gateway.stop());
    await cleanup('worker manager', () => this.workerManager.stop());
    await cleanup('Flue runtime', () => this.runtime.stop());
    await cleanup('skill registry', () => this.skills.stopWatcher());
    await cleanup('database', () => this.db.close());

    if (this.ownsPidFile) {
      await cleanup('PID file', () => removeOwnedDaemonPidFile(this.pidFile));
      this.ownsPidFile = false;
    }
  }
}
