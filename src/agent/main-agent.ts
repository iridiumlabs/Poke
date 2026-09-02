import {
  useModel,
  useSandbox,
  useInstruction,
  useTool,
  useAgentStart,
  useAgentFinish,
  useDelivery,
  useSkill,
} from '@flue/runtime';
import { local } from '@flue/runtime/node';
import { MAIN_AGENT_SYSTEM_PROMPT } from './prompts.js';
import { createPokeTools, ToolContexts } from './tools.js';
import { createPokeSandboxEnvironment } from './sandbox-env.js';
import { resolveFlueModelSpecifier, normalizeCatalogModelId } from '../providers/provider-registry.js';
import { COMMAND_CODE_MANUAL_CATALOG } from '../providers/commandcode.js';
import {
  CompactionManager,
  RECENT_TOKENS_RETENTION,
  ACTIVE_COMPACTION_TOKEN_THRESHOLD,
} from '../context/compaction-manager.js';

let sharedContexts: ToolContexts | null = null;
let sharedCompactionManager: CompactionManager | null = null;

function getModelContextWindow(modelId?: string, provider?: string): number {
  // Runtime validation supplies the exact metadata to Flue. This local
  // reserve calculation only needs a safe fallback when that catalog is
  // unavailable; assuming a 1M window can otherwise over-reserve a 128K
  // model before Poke's own 272K policy gets a chance to run.
  if (!modelId) return 128000;
  const normalized = normalizeCatalogModelId(modelId, provider as any);
  if (provider === 'commandcode') {
    const manual = COMMAND_CODE_MANUAL_CATALOG.find((m) => m.id === normalized);
    if (manual?.capabilities.contextWindow) return manual.capabilities.contextWindow;
  }
  return 128000;
}

export function setMainAgentContexts(
  contexts: ToolContexts,
  compactionManager: CompactionManager
): void {
  sharedContexts = contexts;
  sharedCompactionManager = compactionManager;
}

export function PokeMainAgent() {
  if (!sharedContexts) {
    throw new Error('PokeMainAgent initialized before shared contexts were set.');
  }

  const config = sharedContexts.configManager.loadConfig();
  const mainModel = config.mainModel;
  const delivery = useDelivery();
  const isInternalCompaction =
    delivery.kind === 'signal' && delivery.type === 'poke.context_compact';

  const modelSpecifier = resolveFlueModelSpecifier(mainModel);
  const thinkingLevel = mainModel?.reasoningEffort as any;

  const contextWindow = getModelContextWindow(mainModel?.model, mainModel?.provider);
  const reserveTokens =
    contextWindow > ACTIVE_COMPACTION_TOKEN_THRESHOLD
      ? contextWindow - ACTIVE_COMPACTION_TOKEN_THRESHOLD
      : Math.min(20000, Math.floor(contextWindow / 4));

  // 1. Declare model
  useModel(modelSpecifier, {
    thinkingLevel,
    compaction: {
      keepRecentTokens: RECENT_TOKENS_RETENTION,
      reserveTokens,
    },
  });

  // 2. Attach the trusted host sandbox with the daemon's full environment.
  useSandbox(local({ env: createPokeSandboxEnvironment() }));

  // 3. Mount tools
  const tools = createPokeTools(sharedContexts);
  useTool(tools.sendTool);
  useTool(tools.webSearchTool);
  useTool(tools.webFetchTool);
  useTool(tools.memoryTool);
  useTool(tools.recallTool);
  useTool(tools.composioSearchTool);
  useTool(tools.composioExecuteTool);
  useTool(tools.jobsTool);
  useTool(tools.loadToolsTool);
  for (const skill of sharedContexts.skills.getFlueSkills()) {
    useSkill(skill);
  }

  // Conditionally mount automation tool if capability is active
  const activeCaps = sharedContexts.configManager.getActiveCapabilities();
  if (activeCaps.includes('automations')) {
    useTool(tools.automationTool);
  }

  // 4. Lifecycle hooks
  useAgentStart(async ({ harness }) => {
    if (isInternalCompaction) {
      await harness.compact();
    }
    if (sharedCompactionManager) {
      sharedCompactionManager.recordActivity();
    }
  });

  useAgentFinish(async () => {
    if (sharedCompactionManager) {
      sharedCompactionManager.recordActivity();
    }
  });

  if (isInternalCompaction) {
    useInstruction(
      'This is an internal context-maintenance signal. Do not call tools or send a user-facing response.'
    );
  }

  return MAIN_AGENT_SYSTEM_PROMPT;
}

// Flue applies this durable budget when recovering work after a process
// interruption. Model-stream retries are framework-owned (see POKE.md).
PokeMainAgent.durability = { maxAttempts: 5, timeoutMs: 3_600_000 };
