import { WorkerJobRecord } from '../db/database.js';
import { ConfigManager } from '../config/config.js';
import { ExaToolHandler } from '../tools/exa.js';
import { SupermemoryToolHandler } from '../tools/supermemory.js';
import { ComposioToolHandler } from '../tools/composio.js';
import { SkillRegistry } from '../skills/registry.js';
import { getLogger } from '../logger/logger.js';
import { withProviderRetry } from '../providers/retry.js';
import { init, AgentInstanceHandle } from '@flue/runtime';
import { PokeWorkerAgent } from '../agent/worker-agent.js';

export interface WorkerRunResult {
  status: 'completed' | 'failed' | 'aborted';
  result?: string;
  error?: string;
}

export class WorkerRunner {
  private abortController: AbortController | null = null;
  private agentHandle: AgentInstanceHandle | null = null;

  constructor(
    private job: WorkerJobRecord,
    private configManager: ConfigManager,
    private exa: ExaToolHandler,
    private supermemory: SupermemoryToolHandler,
    private composio: ComposioToolHandler,
    private skills: SkillRegistry
  ) {}

  abort(): void {
    if (this.abortController) {
      this.abortController.abort();
    }
    if (this.agentHandle) {
      try {
        this.agentHandle.abort();
      } catch {
        // Ignore abort error
      }
    }
  }

  async run(): Promise<WorkerRunResult> {
    this.abortController = new AbortController();
    const logger = getLogger().child({ jobId: this.job.id, jobName: this.job.name });
    logger.info('Starting worker execution');

    try {
      if (this.abortController.signal.aborted) {
        return { status: 'aborted' };
      }

      const workerModel = this.configManager.getWorkerModel() || this.configManager.getMainModel();
      if (!workerModel) {
        throw new Error('No worker or main model configured. Run `poke model worker` or `poke model`.');
      }

      // Execute worker task through Flue PokeWorkerAgent instance
      const resultText = await withProviderRetry(async () => {
        if (this.abortController?.signal.aborted) {
          throw new Error('Worker aborted');
        }

        this.agentHandle = init(PokeWorkerAgent, { id: this.job.id });
        const receipt = await this.agentHandle.dispatch({
          message: this.job.instruction,
          initialData: { cwd: this.job.cwd || undefined },
        });

        const reply = await this.agentHandle.read(receipt, {
          signal: this.abortController?.signal,
        });

        return reply.text || 'Worker task completed.';
      });

      if (this.abortController.signal.aborted) {
        return { status: 'aborted' };
      }

      return {
        status: 'completed',
        result: resultText,
      };
    } catch (err: any) {
      if (this.abortController?.signal.aborted || err.message === 'Worker aborted') {
        return { status: 'aborted' };
      }
      logger.error({ err: err.message }, 'Worker execution failed');
      return {
        status: 'failed',
        error: err.message,
      };
    }
  }
}
