import crypto from 'crypto';
import * as v from 'valibot';
import { defineTool } from '@flue/runtime';
import { WhatsAppSender } from '../gateway/sender.js';
import { ExaToolHandler } from '../tools/exa.js';
import { SupermemoryToolHandler } from '../tools/supermemory.js';
import { ComposioToolHandler } from '../tools/composio.js';
import { WorkerManager } from '../workers/worker-manager.js';
import { AutomationScheduler } from '../scheduler/scheduler.js';
import { SkillRegistry } from '../skills/registry.js';
import { ConfigManager } from '../config/config.js';

const CONDITIONAL_CAPABILITIES = new Set(['automations']);

export interface ToolContexts {
  sender: WhatsAppSender;
  exa: ExaToolHandler;
  supermemory: SupermemoryToolHandler;
  composio: ComposioToolHandler;
  workerManager: WorkerManager;
  scheduler: AutomationScheduler;
  skills: SkillRegistry;
  configManager: ConfigManager;
}

export function createPokeTools(ctx: ToolContexts) {
  // 1. send
  const sendTool = defineTool({
    name: 'send',
    description: 'Send a message or voice note to the user on WhatsApp. Only content sent through this tool reaches the user.',
    input: v.object({
      mode: v.picklist(['message', 'voice']),
      text: v.string(),
      attachments: v.optional(
        v.array(
          v.object({
            path: v.string(),
            filename: v.optional(v.string()),
            mimeType: v.optional(v.string()),
          })
        )
      ),
      reply_to: v.optional(v.string()),
    }),
    run: async ({ data, toolCallId }: any) => {
      const idempotencyKey = toolCallId
        ? `send-${toolCallId}`
        : `send-${crypto.randomUUID()}`;
      const res = await ctx.sender.send(
        {
          mode: data.mode,
          text: data.text,
          attachments: data.attachments,
          reply_to: data.reply_to,
        },
        idempotencyKey
      );
      return JSON.stringify({ success: true, messageId: res.messageId, mode: res.mode });
    },
  });

  // 2. web_search
  const webSearchTool = defineTool({
    name: 'web_search',
    description: 'Search the web using Exa for real-time information, news, and research.',
    input: v.object({
      query: v.string(),
      num_results: v.optional(v.number()),
      include_domains: v.optional(v.array(v.string())),
      exclude_domains: v.optional(v.array(v.string())),
      start_published_date: v.optional(v.string()),
      end_published_date: v.optional(v.string()),
    }),
    run: async ({ data }) => {
      const res = await ctx.exa.search(data);
      return JSON.stringify(res, null, 2);
    },
  });

  // 3. web_fetch
  const webFetchTool = defineTool({
    name: 'web_fetch',
    description: 'Fetch the full text content and metadata of a specific webpage by URL using Exa.',
    input: v.object({
      url: v.string(),
      max_characters: v.optional(v.number()),
    }),
    run: async ({ data }) => {
      const res = await ctx.exa.fetch(data);
      return JSON.stringify(res, null, 2);
    },
  });

  // 4. memory
  const memoryTool = defineTool({
    name: 'memory',
    description: 'Save stable personal facts, preferences, decisions, and long-term context to Supermemory.',
    input: v.object({
      content: v.string(),
      metadata: v.optional(v.record(v.string(), v.string())),
    }),
    run: async ({ data }) => {
      const res = await ctx.supermemory.save(data);
      return JSON.stringify(res);
    },
  });

  // 5. recall
  const recallTool = defineTool({
    name: 'recall',
    description: 'Search and recall past personal context, preferences, people, projects, and commitments from Supermemory.',
    input: v.object({
      query: v.string(),
      limit: v.optional(v.number()),
    }),
    run: async ({ data }) => {
      const res = await ctx.supermemory.recall(data);
      return JSON.stringify(res, null, 2);
    },
  });

  // 6. search_tools (Composio discovery)
  const searchToolsTool = defineTool({
    name: 'search_tools',
    description: 'Search available third-party connected tools and actions (e.g. Gmail, GitHub, Google Calendar) via Composio.',
    input: v.object({
      query: v.string(),
    }),
    run: async ({ data }) => {
      const res = await ctx.composio.search(data);
      return JSON.stringify(res, null, 2);
    },
  });
  const composioSearchTool = searchToolsTool;

  // 7. execute_tools (Composio execution)
  const executeToolsTool = defineTool({
    name: 'execute_tools',
    description: 'Execute a connected service action discovered via search_tools.',
    input: v.object({
      action: v.string(),
      params: v.optional(v.record(v.string(), v.any())),
    }),
    run: async ({ data }) => {
      const res = await ctx.composio.execute(data);
      return JSON.stringify(res, null, 2);
    },
  });
  const composioExecuteTool = executeToolsTool;

  // 8. jobs
  const jobsTool = defineTool({
    name: 'jobs',
    description: 'Manage asynchronous background workers for long-running, parallel, or heavy tasks.',
    input: v.object({
      action: v.picklist(['start', 'list', 'status', 'cancel']),
      name: v.optional(v.string()),
      instruction: v.optional(v.string()),
      cwd: v.optional(v.string()),
      id: v.optional(v.string()),
    }),
    run: async ({ data }) => {
      if (data.action === 'start') {
        if (!data.name || !data.instruction) {
          throw new Error('Action "start" requires "name" and "instruction".');
        }
        const job = await ctx.workerManager.startJob({
          name: data.name,
          instruction: data.instruction,
          cwd: data.cwd,
        });
        return JSON.stringify({
          status: 'queued',
          jobId: job.id,
          message: `Worker job "${job.name}" queued with ID ${job.id}. It will execute in the background and report completion back when done.`,
        });
      }

      if (data.action === 'list') {
        const list = ctx.workerManager.listJobs(20);
        return JSON.stringify({
          jobs: list.map((j) => ({
            id: j.id,
            name: j.name,
            status: j.status,
            created_at: new Date(j.created_at).toISOString(),
            finished_at: j.finished_at ? new Date(j.finished_at).toISOString() : undefined,
          })),
        }, null, 2);
      }

      if (data.action === 'status') {
        if (!data.id) throw new Error('Action "status" requires "id".');
        const job = ctx.workerManager.getJob(data.id);
        if (!job) throw new Error(`Job "${data.id}" not found.`);
        return JSON.stringify({ job }, null, 2);
      }

      if (data.action === 'cancel') {
        if (!data.id) throw new Error('Action "cancel" requires "id".');
        const success = ctx.workerManager.cancelJob(data.id);
        return JSON.stringify({ success, message: success ? `Job "${data.id}" cancelled.` : `Job "${data.id}" could not be cancelled.` });
      }

      throw new Error(`Unknown jobs action: ${data.action}`);
    },
  });

  // 9. load_tools
  const loadToolsTool = defineTool({
    name: 'load_tools',
    description: 'Mount conditionally active capability tools (e.g. "automations") into the agent until the next compaction.',
    input: v.object({
      capability: v.string(),
    }),
    run: async ({ data }) => {
      if (!CONDITIONAL_CAPABILITIES.has(data.capability)) {
        throw new Error(`Unknown conditional capability "${data.capability}".`);
      }
      ctx.configManager.addActiveCapability(data.capability);
      return JSON.stringify({
        success: true,
        message: `Capability "${data.capability}" mounted. Associated tools are now active.`,
      });
    },
  });

  // 10. activate_skill
  const activateSkillTool = defineTool({
    name: 'activate_skill',
    description: 'Activate a discovered skill and retrieve its full markdown instructions.',
    input: v.object({
      name: v.string(),
    }),
    run: async ({ data }) => {
      const skill = ctx.skills.getSkill(data.name);
      if (!skill) {
        throw new Error(`Skill "${data.name}" is not installed. List available skills in the catalog.`);
      }
      return JSON.stringify({
        name: skill.name,
        instructions: skill.body,
      });
    },
  });

  // 11. automation (Conditional tool)
  const automationTool = defineTool({
    name: 'automation',
    description: 'Create, update, delete, list, enable, or disable durable scheduled automations (in Asia/Karachi timezone).',
    input: v.object({
      action: v.picklist(['create', 'update', 'delete', 'list', 'enable', 'disable']),
      id: v.optional(v.string()),
      name: v.optional(v.string()),
      instruction: v.optional(v.string()),
      schedule_type: v.optional(v.picklist(['once', 'cron', 'interval'])),
      schedule_value: v.optional(v.string()),
      enabled: v.optional(v.boolean()),
    }),
    run: async ({ data }) => {
      if (data.action === 'create') {
        if (!data.name || !data.instruction || !data.schedule_type || !data.schedule_value) {
          throw new Error('Action "create" requires "name", "instruction", "schedule_type", and "schedule_value".');
        }
        const created = ctx.scheduler.createAutomation({
          name: data.name,
          instruction: data.instruction,
          schedule_type: data.schedule_type,
          schedule_value: data.schedule_value,
          enabled: data.enabled,
        });
        return JSON.stringify({
          success: true,
          automation: created,
          message: `Automation "${created.name}" created with ID ${created.id}. Next run: ${created.next_run_at ? new Date(created.next_run_at).toISOString() : 'none'} (Asia/Karachi).`,
        });
      }

      if (data.action === 'list') {
        const list = ctx.scheduler.listAutomations();
        return JSON.stringify({
          automations: list.map((a) => ({
            id: a.id,
            name: a.name,
            schedule_type: a.schedule_type,
            schedule_value: a.schedule_value,
            enabled: Boolean(a.enabled),
            next_run_at: a.next_run_at ? new Date(a.next_run_at).toISOString() : undefined,
            last_run_at: a.last_run_at ? new Date(a.last_run_at).toISOString() : undefined,
          })),
        }, null, 2);
      }

      if (data.action === 'update') {
        if (!data.id) throw new Error('Action "update" requires "id".');
        const updated = ctx.scheduler.updateAutomation(data.id, {
          name: data.name,
          instruction: data.instruction,
          schedule_type: data.schedule_type,
          schedule_value: data.schedule_value,
          enabled: data.enabled,
        });
        return JSON.stringify({ success: true, automation: updated });
      }

      if (data.action === 'delete') {
        if (!data.id) throw new Error('Action "delete" requires "id".');
        const success = ctx.scheduler.deleteAutomation(data.id);
        return JSON.stringify({ success, message: success ? `Automation "${data.id}" deleted.` : `Automation "${data.id}" not found.` });
      }

      if (data.action === 'enable') {
        if (!data.id) throw new Error('Action "enable" requires "id".');
        const enabled = ctx.scheduler.enableAutomation(data.id);
        return JSON.stringify({ success: true, automation: enabled });
      }

      if (data.action === 'disable') {
        if (!data.id) throw new Error('Action "disable" requires "id".');
        const disabled = ctx.scheduler.disableAutomation(data.id);
        return JSON.stringify({ success: true, automation: disabled });
      }

      throw new Error(`Unknown automation action: ${data.action}`);
    },
  });

  return {
    sendTool,
    webSearchTool,
    webFetchTool,
    memoryTool,
    recallTool,
    searchToolsTool,
    executeToolsTool,
    composioSearchTool,
    composioExecuteTool,
    jobsTool,
    loadToolsTool,
    activateSkillTool,
    automationTool,
  };
}
