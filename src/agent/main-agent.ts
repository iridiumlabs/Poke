import {
  useModel,
  useSandbox,
  useInstruction,
  useTool,
  useAgentStart,
  useAgentFinish,
} from '@flue/runtime';
import { local } from '@flue/runtime/node';
import { MAIN_AGENT_SYSTEM_PROMPT } from './prompts.js';
import { createPokeTools, ToolContexts } from './tools.js';
import { resolveFlueModelSpecifier } from '../providers/provider-registry.js';
import { CompactionManager, RECENT_TOKENS_RETENTION } from '../context/compaction-manager.js';

let sharedContexts: ToolContexts | null = null;
let sharedCompactionManager: CompactionManager | null = null;

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

  const modelSpecifier = resolveFlueModelSpecifier(mainModel);
  const thinkingLevel = mainModel?.reasoningEffort as any;

  // 1. Declare model
  useModel(modelSpecifier, {
    thinkingLevel,
    compaction: {
      keepRecentTokens: RECENT_TOKENS_RETENTION,
    },
  });

  // 2. Attach local host sandbox forwarding daemon's full environment
  useSandbox(
    local({
      env: { ...process.env },
    })
  );

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
  useTool(tools.activateSkillTool);

  // Conditionally mount automation tool if capability is active
  const activeCaps = sharedContexts.configManager.getActiveCapabilities();
  if (activeCaps.includes('automations')) {
    useTool(tools.automationTool);
  }

  // 4. Lifecycle hooks
  useAgentStart(async () => {
    if (sharedCompactionManager) {
      sharedCompactionManager.setMainAgentBusy(true);
      sharedCompactionManager.recordActivity();
    }
  });

  useAgentFinish(async () => {
    if (sharedCompactionManager) {
      sharedCompactionManager.setMainAgentBusy(false);
      sharedCompactionManager.recordActivity();
    }
  });

  // 5. Instruction & Live skills catalog
  const skillsCatalog = sharedContexts.skills.getCatalogPrompt();
  if (skillsCatalog) {
    useInstruction(`\n${skillsCatalog}`);
  }

  return MAIN_AGENT_SYSTEM_PROMPT;
}
