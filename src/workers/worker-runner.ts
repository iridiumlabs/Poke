import { WorkerJobRecord } from '../db/database.js';
import { ConfigManager } from '../config/config.js';
import { ExaToolHandler } from '../tools/exa.js';
import { SupermemoryToolHandler } from '../tools/supermemory.js';
import { ComposioToolHandler } from '../tools/composio.js';
import { SkillRegistry } from '../skills/registry.js';
import { getLogger } from '../logger/logger.js';
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

      const workerModel = this.configManager.getWorkerModel();
      if (!workerModel) {
        throw new Error('No worker model configured. Run `poke model worker`.');
      }

      // A stable key means recovery reattaches to the exact worker submission
      // rather than admitting a second worker conversation for the same job.
      this.agentHandle = init(PokeWorkerAgent, { id: this.job.id });
      const receipt = await this.agentHandle.dispatch({
        message: this.job.instruction,
        initialData: { cwd: this.job.cwd || undefined },
        idempotencyKey: `worker:${this.job.id}:run`,
      });
      const reply = await this.agentHandle!.read(receipt, {
        signal: this.abortController?.signal,
      });
      const resultText = reply.text || 'Worker task completed.';

      if (this.abortController.signal.aborted) {
        return { status: 'aborted' };
      }

      return {
        status: 'completed',
        result: resultText,
      };
    } catch (err: any) {
      if (this.abortController?.signal.aborted || err.message === 'Worker aborted' || err.outcome === 'aborted') {
        return { status: 'aborted' };
      }
      const errorMessage = (err.cause as Error)?.message || err.message || 'Worker execution failed';
      logger.error({ err: errorMessage }, 'Worker execution failed');
      return {
        status: 'failed',
        error: errorMessage,
      };
    }
  }
}
