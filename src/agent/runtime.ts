import fs from 'fs';
import crypto from 'node:crypto';
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
import { CompactionManager, estimateTokenCount } from '../context/compaction-manager.js';
import { getLogger } from '../logger/logger.js';
import { resolvePokePaths, ensurePokeDirectories } from '../config/paths.js';
import { registerAllProviders, ProviderRegistry } from '../providers/provider-registry.js';
import { FileCredentialStore } from '../providers/credential-store.js';
import { migrateLegacyProviderCredentials } from '../providers/credentials-migration.js';
import { SignalPayload } from './signals.js';

export const MAIN_AGENT_INSTANCE_ID = 'owner';
const OWNER_COMPACTION_ENTRY_STATE_KEY = 'owner_compaction_entry_id';
const INTERNAL_COMPACTION_SIGNAL = 'poke.context_compact';

export class PokeRuntime {
  private flue: Flue | null = null;
  private agentHandle: AgentInstanceHandle | null = null;
  private isRunning = false;
  private idleCheckInterval: NodeJS.Timeout | null = null;
  private unsubscribeObserver: (() => void) | null = null;
  private compactionRequest: Promise<void> | null = null;
  private runningOwnerSubmissions = new Set<string>();
  private ownerTurnTokenEstimates = new Map<string, number>();
  private watchedSubmissionSettlements = new Set<string>();

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

    try {
      const logger = getLogger();
      logger.info('Starting Poke Flue runtime');

      const paths = resolvePokePaths(this.customHome);
      ensurePokeDirectories(paths);

      const credentialStore = new FileCredentialStore(paths.credentialsFile);
      await migrateLegacyProviderCredentials(this.configManager, credentialStore);
      const providerRegistry = new ProviderRegistry(credentialStore);

      const creds = this.configManager.getCredentials();
      const mainModel = this.configManager.getMainModel();
      const workerModel = this.configManager.getWorkerModel();
      if (!mainModel || !workerModel) {
        throw new Error('Both main and worker models must be configured. Run `poke model` and `poke model worker`.');
      }
      const mainValidation = await providerRegistry.validateSelection(mainModel);
      if (!mainValidation.valid) {
        if (mainValidation.transient) {
          getLogger().warn(
            { err: mainValidation.error },
            'Main model validation encountered a transient issue during startup; continuing'
          );
        } else {
          throw new Error(`Invalid main model configuration: ${mainValidation.error}`);
        }
      }
      const workerValidation = await providerRegistry.validateSelection(workerModel);
      if (!workerValidation.valid) {
        if (workerValidation.transient) {
          getLogger().warn(
            { err: workerValidation.error },
            'Worker model validation encountered a transient issue during startup; continuing'
          );
        } else {
          throw new Error(`Invalid worker model configuration: ${workerValidation.error}`);
        }
      }

      // Register the exact selected Command Code definitions with Flue. The
      // live catalog is authoritative for its reasoning, image, and context
      // metadata; leaving it dynamic makes every model look text-only.
      const commandCodeModels = [
        mainModel?.provider === 'commandcode' ? mainValidation.modelInfo : undefined,
        workerModel?.provider === 'commandcode' ? workerValidation.modelInfo : undefined,
      ]
        .filter((model): model is NonNullable<typeof model> => Boolean(model))
        .filter((model, index, all) => all.findIndex((candidate) => candidate.id === model.id) === index);
      registerAllProviders(providerRegistry.models, commandCodeModels);

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

      // Provider credentials remain behind request-time auth resolvers. Service
      // integrations receive only the keys they directly own.
      const runtimeEnv: Record<string, string | undefined> = {
        ...process.env,
        EXA_API_KEY: creds.exaApiKey || process.env.EXA_API_KEY,
        DEEPGRAM_API_KEY: creds.deepgramApiKey || process.env.DEEPGRAM_API_KEY,
        SUPERMEMORY_API_KEY: creds.supermemoryApiKey || process.env.SUPERMEMORY_API_KEY,
        COMPOSIO_API_KEY: creds.composioApiKey || process.env.COMPOSIO_API_KEY,
      };

      // Subscribe before starting Flue so recovery events from an accepted
      // owner submission cannot race past the observer during startup.
      try {
        this.unsubscribeObserver = observe((event: any) => {
          if (!this.isOwnerEvent(event)) return;
          try {
            this.observeOwnerEvent(event);
          } catch (err: any) {
            getLogger().error(
              { eventType: event?.type, err: err?.message || String(err) },
              'Failed to process owner Flue event'
            );
          }
        }) as any;
      } catch (err: any) {
        getLogger().warn({ err: err?.message || err }, 'Failed to subscribe to Flue owner events');
      }

      // Start Flue runtime with SQLite persistence
      this.flue = await start({
        agents: [PokeMainAgent, PokeWorkerAgent],
        db: sqlite(paths.sqliteFile),
        env: runtimeEnv as any,
      });

      // Obtain stable handle for owner
      this.agentHandle = init(PokeMainAgent, { id: MAIN_AGENT_INSTANCE_ID });
      this.reconcileOwnerCompactionState();
      this.recoverSubmissionDeliveries();

      // Connect worker completion dispatcher to main agent
      this.workerManager.setCompletionDispatcher(async (signal) => {
        return await this.dispatchSignal(signal);
      });

      // Connect automation dispatcher to main agent
      this.scheduler.setDispatcher(async (signal) => {
        return await this.dispatchSignal(signal);
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
    } catch (err) {
      try {
        await this.stop();
      } catch (cleanupErr: any) {
        getLogger().error({ err: cleanupErr.message }, 'Failed to clean up Poke runtime after startup failure');
      }
      throw err;
    }
  }

  async checkIdleCompaction(): Promise<void> {
    if (this.compactionManager.shouldCompactIdle()) {
      getLogger().info('Idle compaction threshold reached (>100k tokens and 30m inactive).');
      await this.requestOwnerCompaction('idle');
    }
  }

  async dispatchUserMessage(
    body: string,
    attachments: any[] = [],
    whatsappMessageId?: string
  ): Promise<DispatchReceipt> {
    if (!this.agentHandle) {
      throw new Error('Poke runtime is not started.');
    }

    const logger = getLogger();
    logger.info(
      {
        ...(whatsappMessageId ? { whatsappMessageId } : {}),
        inputLength: body.length,
        attachmentCount: attachments.length,
      },
      'Dispatching user message to main agent'
    );

    const sourceKey = whatsappMessageId ? `whatsapp:${whatsappMessageId}` : undefined;
    let messagePayload: any;
    let dispatchAttempted = false;
    try {
      await this.ensurePreflightCompaction();
      this.compactionManager.recordActivity();

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

      messagePayload = {
        kind: 'user' as const,
        body: whatsappMessageId ? `[WhatsApp message ID: ${whatsappMessageId}]\n\n${body}` : body,
        ...(flueAttachments.length > 0 ? { attachments: flueAttachments as any } : {}),
      };

      if (sourceKey) {
        this.db.reserveSubmissionDelivery({
          sourceKey,
          source: 'whatsapp',
          whatsappMessageId,
        });
      }
      dispatchAttempted = true;
      const receipt = await this.agentHandle.dispatch({
        message: messagePayload as any,
        ...(sourceKey ? { idempotencyKey: sourceKey } : {}),
      });
      if (sourceKey) {
        this.db.attachSubmissionDelivery(sourceKey, receipt.submissionId);
        this.watchSubmissionSettlement(receipt.submissionId);
      }

      return receipt;
    } catch (err: any) {
      logger.error({ err: err.message }, 'Failed to dispatch user message to agent');
      const recovered = await this.recoverFailedDispatch({
        messagePayload,
        sourceKey,
        dispatchAttempted,
        label: 'submission',
      });
      if (recovered) return recovered;

      await this.sender.sendDirectError(`Inference failed: ${err.message}`);
      throw err;
    }
  }

  async dispatchSignal(signal: SignalPayload): Promise<DispatchReceipt> {
    if (!this.agentHandle) {
      throw new Error('Poke runtime is not started.');
    }

    const logger = getLogger();
    logger.info(
      { type: signal.type, tagName: signal.tagName, signalLength: signal.body.length },
      'Dispatching signal to main agent'
    );

    await this.ensurePreflightCompaction();
    this.compactionManager.recordActivity();

    const source = signal.type === 'automation.trigger'
      ? 'automation'
      : signal.type === 'worker.completion'
        ? 'worker'
        : undefined;
    if (source && signal.idempotencyKey) {
      this.db.reserveSubmissionDelivery({ sourceKey: signal.idempotencyKey, source });
    }

    const signalMessage = {
      kind: 'signal' as const,
      type: signal.type,
      tagName: signal.tagName,
      attributes: signal.attributes,
      body: signal.body,
    };

    let dispatchAttempted = false;
    try {
      dispatchAttempted = true;
      const receipt = await this.agentHandle.dispatch({
        message: signalMessage as any,
        ...(signal.idempotencyKey ? { idempotencyKey: signal.idempotencyKey } : {}),
      });
      if (source && signal.idempotencyKey) {
        this.db.attachSubmissionDelivery(signal.idempotencyKey, receipt.submissionId);
        this.watchSubmissionSettlement(receipt.submissionId);
      }
      return receipt;
    } catch (err: any) {
      logger.error({ err: err?.message || String(err) }, 'Failed to dispatch signal to agent');
      const recovered = await this.recoverFailedDispatch({
        messagePayload: signalMessage,
        sourceKey: source && signal.idempotencyKey ? signal.idempotencyKey : undefined,
        dispatchAttempted,
        label: 'signal submission',
      });
      if (recovered) return recovered;

      throw err;
    }
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

    const flue = this.flue;
    this.flue = null;
    this.agentHandle = null;

    if (flue) {
      await flue.stop();
    }
    this.compactionRequest = null;
    this.runningOwnerSubmissions.clear();
    this.ownerTurnTokenEstimates.clear();
    this.watchedSubmissionSettlements.clear();
  }

  private isOwnerEvent(event: any): boolean {
    return event?.agentName === PokeMainAgent.name && event?.instanceId === MAIN_AGENT_INSTANCE_ID;
  }

  private observeOwnerEvent(event: any): void {
    switch (event.type) {
      case 'submission_running':
        this.runningOwnerSubmissions.add(event.submissionId);
        this.compactionManager.setMainAgentBusy(true);
        return;
      case 'submission_settled':
        this.runningOwnerSubmissions.delete(event.submissionId);
        this.compactionManager.setMainAgentBusy(this.runningOwnerSubmissions.size > 0);
        void this.handleSubmissionSettlement(event).catch((err: any) => {
          getLogger().error(
            { submissionId: event.submissionId, err: err?.message || String(err) },
            'Failed to persist owner submission settlement'
          );
        });
        return;
      case 'turn_request':
        if (event.purpose === 'agent') {
          const tokens = estimateTokenCount(event.request?.input);
          this.ownerTurnTokenEstimates.set(event.turnId, tokens);
          this.compactionManager.setEstimatedTokens(tokens);
          this.compactionManager.recordActivity();
        }
        return;
      case 'turn': {
        if (event.purpose !== 'agent') return;
        const inputTokens = this.ownerTurnTokenEstimates.get(event.turnId)
          ?? this.compactionManager.getEstimatedTokens();
        this.ownerTurnTokenEstimates.delete(event.turnId);
        const usage = event.response?.usage;
        const totalTokens = Number(usage?.totalTokens);
        if (Number.isFinite(totalTokens) && totalTokens > 0) {
          this.compactionManager.setEstimatedTokens(totalTokens);
        } else {
          // Models without usage metadata still receive Poke's policy. The
          // request estimate includes the rendered system prompt, tools,
          // history, attachments, and prior tool results; add this turn's
          // output so the next admission sees the grown conversation.
          this.compactionManager.setEstimatedTokens(
            inputTokens + estimateTokenCount(event.response?.output)
          );
        }
        this.compactionManager.recordActivity();
        if (this.compactionManager.shouldCompactActive()) {
          void this.requestOwnerCompaction('active');
        }
        return;
      }
      case 'compaction':
        if (event.isError) {
          this.compactionManager.onCompactionFailure(event.error || new Error('Flue compaction failed.'));
        } else {
          this.reconcileOwnerCompactionState();
        }
        return;
      default:
        return;
    }
  }

  private reconcileOwnerCompactionState(): void {
    const entryId = this.db.getLatestFlueCompactionEntry(PokeMainAgent.name, MAIN_AGENT_INSTANCE_ID);
    const appliedEntryId = this.db.getState(OWNER_COMPACTION_ENTRY_STATE_KEY);
    if (!entryId) {
      // Seed an explicit empty baseline. Without it, the first compaction of
      // a new conversation would be mistaken for an upgrade-era record.
      if (!appliedEntryId) this.db.setState(OWNER_COMPACTION_ENTRY_STATE_KEY, 'none');
      return;
    }
    if (!appliedEntryId) {
      // This installation predates the marker. Establish a baseline rather
      // than treating an old, already-accounted-for compaction as new.
      this.db.setState(OWNER_COMPACTION_ENTRY_STATE_KEY, entryId);
      return;
    }
    if (appliedEntryId === entryId) return;

    // Store the marker only after the capability transition succeeds. If the
    // process dies in between, startup repeats the idempotent clear.
    this.compactionManager.onCompactionSuccess();
    this.db.setState(OWNER_COMPACTION_ENTRY_STATE_KEY, entryId);
  }

  private async ensurePreflightCompaction(): Promise<void> {
    if (this.compactionManager.shouldPreflightCompact()) {
      await this.requestOwnerCompaction('preflight');
    }
  }

  private async requestOwnerCompaction(reason: 'active' | 'idle' | 'preflight'): Promise<void> {
    if (!this.agentHandle) return;
    if (this.compactionRequest) {
      try {
        await this.compactionRequest;
      } catch (error: any) {
        if (reason === 'preflight') throw error;
        getLogger().error(
          { err: error?.message || String(error), reason },
          'A shared owner compaction request failed'
        );
      }
      return;
    }

    const request = (async () => {
      const handle = this.agentHandle;
      if (!handle) return;
      const receipt = await handle.dispatch({
        message: {
          kind: 'signal',
          type: INTERNAL_COMPACTION_SIGNAL,
          tagName: 'context_compact',
          attributes: { reason },
          body: 'Compact the owner conversation before more work is admitted.',
        } as any,
        idempotencyKey: `owner-compaction:${reason}:${Date.now()}`,
      });
      await handle.read(receipt);
      this.reconcileOwnerCompactionState();
    })();
    this.compactionRequest = request;
    try {
      await request;
    } catch (error: any) {
      getLogger().error(
        { err: error?.message || String(error), reason },
        'Failed to run requested owner compaction'
      );
      // A preflight is the admission gate: do not add new work to a context
      // that could not be compacted. Background active/idle attempts remain
      // best-effort and are retried at their next seam.
      if (reason === 'preflight') throw error;
    } finally {
      if (this.compactionRequest === request) this.compactionRequest = null;
    }
  }

  private async recoverFailedDispatch(params: {
    messagePayload?: Record<string, unknown>;
    sourceKey?: string;
    dispatchAttempted: boolean;
    label: string;
  }): Promise<DispatchReceipt | null> {
    const { messagePayload, sourceKey, dispatchAttempted, label } = params;
    if (!sourceKey) return null;

    const logger = getLogger();
    if (dispatchAttempted && this.agentHandle && messagePayload) {
      try {
        const replayReceipt = await this.agentHandle.dispatch({
          message: messagePayload as any,
          idempotencyKey: sourceKey,
        });
        this.db.attachSubmissionDelivery(sourceKey, replayReceipt.submissionId);
        this.watchSubmissionSettlement(replayReceipt.submissionId);
        return replayReceipt;
      } catch (replayErr: any) {
        logger.warn(
          { err: replayErr?.message || String(replayErr) },
          `Failed to recover ${label} through idempotency replay`
        );
      }
    }

    if (dispatchAttempted) {
      let isAdmitted = false;
      let lookupSucceeded = false;
      try {
        const derivedSubmissionId = this.deriveOwnerSubmissionId(sourceKey);
        isAdmitted = this.db.hasFlueSubmission(derivedSubmissionId);
        lookupSucceeded = true;
        if (isAdmitted) {
          this.db.attachSubmissionDelivery(sourceKey, derivedSubmissionId);
          this.watchSubmissionSettlement(derivedSubmissionId);
          return { submissionId: derivedSubmissionId } as DispatchReceipt;
        }
      } catch (lookupErr: any) {
        logger.warn(
          { err: lookupErr?.message || String(lookupErr) },
          `Failed to verify ${label} admission status`
        );
      }
      if (lookupSucceeded && !isAdmitted) {
        this.db.removeUnattachedSubmissionDelivery(sourceKey);
      }
    }

    return null;
  }

  private recoverSubmissionDeliveries(): void {
    for (const delivery of this.db.getPendingSubmissionDeliveries()) {
      let submissionId = delivery.submission_id;
      if (!submissionId) {
        const derivedSubmissionId = this.deriveOwnerSubmissionId(delivery.source_key);
        if (this.db.hasFlueSubmission(derivedSubmissionId)) {
          submissionId = derivedSubmissionId;
          this.db.attachSubmissionDelivery(delivery.source_key, submissionId);
        } else {
          this.db.removeUnattachedSubmissionDelivery(delivery.source_key);
          continue;
        }
      }
      this.watchSubmissionSettlement(submissionId);
    }
  }

  private deriveOwnerSubmissionId(sourceKey: string): string {
    const preimage = `flue-submission-key\n${PokeMainAgent.name}\n${MAIN_AGENT_INSTANCE_ID}\n${sourceKey}`;
    const digest = crypto.createHash('sha256').update(preimage).digest('hex').slice(0, 32);
    return `sub_ik_${digest}`;
  }

  /**
   * The durable delivery row plus filtered Flue events are authoritative.
   * This read only closes the narrow live race where a very fast settlement
   * is emitted between Flue admission and Poke attaching the local receipt.
   */
  private watchSubmissionSettlement(submissionId: string): void {
    const handle = this.agentHandle;
    if (!handle || this.watchedSubmissionSettlements.has(submissionId)) return;
    this.watchedSubmissionSettlements.add(submissionId);
    void handle
      .read(submissionId)
      .then(() => this.handleSubmissionSettlement({
        submissionId,
        outcome: 'completed',
      }))
      .catch((error: any) => this.handleSubmissionSettlement({
        submissionId,
        outcome: error?.outcome === 'aborted' ? 'aborted' : 'failed',
        error: { message: (error?.cause as Error)?.message || error?.message || 'Inference failed' },
      }))
      .finally(() => this.watchedSubmissionSettlements.delete(submissionId));
  }

  private async handleSubmissionSettlement(event: {
    submissionId: string;
    outcome: 'completed' | 'failed' | 'aborted';
    error?: { message?: string };
  }): Promise<void> {
    const delivery = this.db.getSubmissionDelivery(event.submissionId);
    if (!delivery || delivery.status !== 'pending') return;

    const errorMessage = event.error?.message || 'Inference failed';
    const settled = this.db.settleSubmissionDelivery(
      event.submissionId,
      event.outcome,
      event.outcome === 'failed' ? errorMessage : undefined
    );
    if (!settled) return;

    if (event.outcome !== 'failed') return;
    getLogger().error(
      { submissionId: event.submissionId, source: delivery.source, err: errorMessage },
      'Agent submission failed'
    );
    try {
      await this.sender.sendDirectError(errorMessage);
    } catch (error: any) {
      getLogger().error(
        { submissionId: event.submissionId, err: error?.message || String(error) },
        'Failed to report agent submission failure to WhatsApp'
      );
    }
  }
}
