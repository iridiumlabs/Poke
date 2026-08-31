import { init, AgentInstanceHandle, DispatchReceipt } from '@flue/runtime';
import { sqlite, start, Flue } from '@flue/runtime/node';
import { PokeMainAgent, setMainAgentContexts } from './main-agent.js';
import { PokeWorkerAgent, setWorkerAgentContexts } from './worker-agent.js';
import { ConfigManager } from '../config/config.js';
import { PokeDatabase } from '../db/database.js';
import { ExaToolHandler } from '../tools/exa.js';
import { SupermemoryToolHandler } from '../tools/supermemory.js';
import { ComposioToolHandler } from '../tools/composio.js';
import { SkillRegistry } from '../skills/registry.js';
import { WorkerManager } from '../workers/worker-manager.js';
import { AutomationScheduler } from '../scheduler/scheduler.js';
import { WhatsAppSender } from '../gateway/sender.js';
import { CompactionManager } from '../context/compaction-manager.js';
import { getLogger } from '../logger/logger.js';
import { resolvePokePaths, ensurePokeDirectories } from '../config/paths.js';

export const MAIN_AGENT_INSTANCE_ID = 'owner';

export class PokeRuntime {
  private flue: Flue | null = null;
  private agentHandle: AgentInstanceHandle | null = null;
  private isRunning = false;
  private idleCheckInterval: NodeJS.Timeout | null = null;

  constructor(
    private configManager: ConfigManager,
    private db: PokeDatabase,
    private exa: ExaToolHandler,
    private supermemory: SupermemoryToolHandler,
    private composio: ComposioToolHandler,
    private skills: SkillRegistry,
    private workerManager: WorkerManager,
    private scheduler: AutomationScheduler,
    private sender: WhatsAppSender,
    private compactionManager: CompactionManager,
    private customHome?: string
  ) {}

  async start(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;

    const logger = getLogger();
    logger.info('Starting Poke Flue runtime');

    const paths = resolvePokePaths(this.customHome);
    ensurePokeDirectories(paths);

    const toolContexts = {
      sender: this.sender,
      exa: this.exa,
      supermemory: this.supermemory,
      composio: this.composio,
      workerManager: this.workerManager,
      scheduler: this.scheduler,
      skills: this.skills,
      configManager: this.configManager,
    };

    // Set shared contexts for main agent and worker agent
    setMainAgentContexts(toolContexts, this.compactionManager);
    setWorkerAgentContexts(toolContexts);

    // Seed default skills
    this.skills.seedDefaultSkills();

    // Start Flue runtime with SQLite persistence
    this.flue = await start({
      agents: [PokeMainAgent, PokeWorkerAgent],
      db: sqlite(paths.sqliteFile),
      env: process.env,
    });

    // Obtain stable handle for owner
    this.agentHandle = init(PokeMainAgent, { id: MAIN_AGENT_INSTANCE_ID });

    // Connect worker completion dispatcher to main agent
    this.workerManager.setCompletionDispatcher(async (signalXml) => {
      await this.dispatchSignal('worker.completion', signalXml);
    });

    // Connect automation dispatcher to main agent
    this.scheduler.setDispatcher(async (signalXml) => {
      await this.dispatchSignal('automation.trigger', signalXml);
    });

    // Start scheduler
    this.scheduler.start();

    // Reconcile startup worker queue
    this.workerManager.reconcileStartupJobs();
    this.workerManager.processQueue();

    // Start idle compaction check loop (every 60s)
    this.idleCheckInterval = setInterval(() => {
      this.checkIdleCompaction();
    }, 60000);

    logger.info('Poke Flue runtime started with instance "owner"');
  }

  async checkIdleCompaction(): Promise<void> {
    if (this.compactionManager.shouldCompactIdle()) {
      const logger = getLogger();
      logger.info('Idle compaction threshold reached (>100k tokens and 30m inactive). Performing compaction.');
      try {
        if (this.agentHandle && typeof (this.agentHandle as any).compact === 'function') {
          await (this.agentHandle as any).compact();
        }
        this.compactionManager.onCompactionSuccess();
      } catch (err: any) {
        this.compactionManager.onCompactionFailure(err);
      }
    }
  }

  async dispatchUserMessage(body: string, attachments: any[] = []): Promise<DispatchReceipt> {
    if (!this.agentHandle) {
      throw new Error('Poke runtime is not started.');
    }

    const logger = getLogger();
    logger.info({ bodyPreview: body.slice(0, 80) }, 'Dispatching user message to main agent');

    // Preflight compaction check
    if (this.compactionManager.shouldPreflightCompact()) {
      logger.info('Preflight idle compaction triggered before message dispatch');
      try {
        if (typeof (this.agentHandle as any).compact === 'function') {
          await (this.agentHandle as any).compact();
        }
        this.compactionManager.onCompactionSuccess();
      } catch (err: any) {
        this.compactionManager.onCompactionFailure(err);
      }
    }

    // Token accounting
    this.compactionManager.recordActivity(Math.ceil(body.length / 4));

    try {
      return await this.agentHandle.dispatch({
        message: body,
      });
    } catch (err: any) {
      logger.error({ err: err.message }, 'Failed to dispatch user message to agent');
      await this.sender.sendDirectError(`Inference failed: ${err.message}`);
      throw err;
    }
  }

  async dispatchSignal(type: string, signalBody: string): Promise<DispatchReceipt> {
    if (!this.agentHandle) {
      throw new Error('Poke runtime is not started.');
    }

    const logger = getLogger();
    logger.info({ type, signalPreview: signalBody.slice(0, 80) }, 'Dispatching signal to main agent');

    this.compactionManager.recordActivity(Math.ceil(signalBody.length / 4));

    return await this.agentHandle.dispatch({
      message: {
        kind: 'signal' as any,
        type,
        body: signalBody,
      } as any,
    });
  }

  async abortAll(): Promise<void> {
    const logger = getLogger();
    logger.info('Executing global abort across main agent and all workers');

    // 1. Abort main agent
    if (this.agentHandle) {
      try {
        await this.agentHandle.abort();
      } catch (err: any) {
        logger.error({ err: err.message }, 'Error aborting main agent handle');
      }
    }

    // 2. Abort all workers and cancel queued jobs
    this.workerManager.abortAll();
  }

  async stop(): Promise<void> {
    this.isRunning = false;
    if (this.idleCheckInterval) {
      clearInterval(this.idleCheckInterval);
      this.idleCheckInterval = null;
    }

    this.scheduler.stop();

    if (this.flue) {
      await this.flue.stop();
      this.flue = null;
    }
  }
}
