import fs from 'fs';
import { init, AgentInstanceHandle, DispatchReceipt, observe } from '@flue/runtime';
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
import { registerAllProviders, ProviderRegistry } from '../providers/provider-registry.js';

export const MAIN_AGENT_INSTANCE_ID = 'owner';

export class PokeRuntime {
  private flue: Flue | null = null;
  private agentHandle: AgentInstanceHandle | null = null;
  private isRunning = false;
  private idleCheckInterval: NodeJS.Timeout | null = null;
  private unsubscribeObserver: (() => void) | null = null;

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

    // Register all AI model providers (Command Code, Fireworks, Codex)
    registerAllProviders();

    const creds = this.configManager.getCredentials();
    const mainModel = this.configManager.getMainModel();
    if (mainModel) {
      const validation = await ProviderRegistry.validateSelection(mainModel, creds);
      if (!validation.valid) {
        throw new Error(`Invalid main model configuration: ${validation.error}`);
      }
    }

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

    // Prepare runtime environment forwarding system env + configured credentials
    const runtimeEnv: Record<string, string | undefined> = {
      ...process.env,
      COMMANDCODE_API_KEY: creds.commandCodeApiKey || process.env.COMMANDCODE_API_KEY,
      FIREWORKS_API_KEY: creds.fireworksApiKey || process.env.FIREWORKS_API_KEY,
      OPENAI_API_KEY: creds.codexAuth?.accessToken || process.env.OPENAI_API_KEY,
      OPENAI_CODEX_ACCESS_TOKEN: creds.codexAuth?.accessToken || process.env.OPENAI_CODEX_ACCESS_TOKEN,
      EXA_API_KEY: creds.exaApiKey || process.env.EXA_API_KEY,
      DEEPGRAM_API_KEY: creds.deepgramApiKey || process.env.DEEPGRAM_API_KEY,
      SUPERMEMORY_API_KEY: creds.supermemoryApiKey || process.env.SUPERMEMORY_API_KEY,
      COMPOSIO_API_KEY: creds.composioApiKey || process.env.COMPOSIO_API_KEY,
    };

    // Start Flue runtime with SQLite persistence
    this.flue = await start({
      agents: [PokeMainAgent, PokeWorkerAgent],
      db: sqlite(paths.sqliteFile),
      env: runtimeEnv as any,
    });

    // Subscribe to Flue events for compaction observation
    try {
      this.unsubscribeObserver = observe((event: any) => {
        if (event.type === 'compaction') {
          this.compactionManager.onCompactionSuccess();
        }
      }) as any;
    } catch {}

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
      logger.info('Idle compaction threshold reached (>100k tokens and 30m inactive).');
    }
  }

  async dispatchUserMessage(body: string, attachments: any[] = []): Promise<DispatchReceipt> {
    if (!this.agentHandle) {
      throw new Error('Poke runtime is not started.');
    }

    const logger = getLogger();
    logger.info({ bodyPreview: body.slice(0, 80) }, 'Dispatching user message to main agent');

    // Token accounting
    this.compactionManager.recordActivity(Math.ceil(body.length / 4));

    // Convert image attachments to native Flue format
    const flueAttachments = attachments
      .filter((att) => att.isImage || (att.mimeType && att.mimeType.startsWith('image/')))
      .map((att) => {
        try {
          if (fs.existsSync(att.path)) {
            const data = fs.readFileSync(att.path).toString('base64');
            return {
              type: 'image' as const,
              data,
              mimeType: att.mimeType || 'image/jpeg',
              filename: att.filename,
            };
          }
        } catch {}
        return null;
      })
      .filter(Boolean);

    const messagePayload = {
      kind: 'user' as const,
      body,
      ...(flueAttachments.length > 0 ? { attachments: flueAttachments as any } : {}),
    };

    try {
      const receipt = await this.agentHandle.dispatch({
        message: messagePayload as any,
      });

      // Observe settlement in background to catch provider/inference failures
      this.agentHandle.read(receipt).catch(async (err: any) => {
        if (err.message?.includes('aborted') || err.outcome === 'aborted') {
          return;
        }
        logger.error({ err: err.message }, 'Inference execution failed');
        await this.sender.sendDirectError(err.message || 'Inference failed');
      });

      return receipt;
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

    if (this.unsubscribeObserver) {
      this.unsubscribeObserver();
      this.unsubscribeObserver = null;
    }

    if (this.flue) {
      await this.flue.stop();
      this.flue = null;
    }
  }
}
