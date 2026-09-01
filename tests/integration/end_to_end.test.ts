import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { PokeDaemon } from '../../src/daemon/daemon.js';
import { createPokeTools } from '../../src/agent/tools.js';
import { SkillRegistry } from '../../src/skills/registry.js';
import { ExaToolHandler } from '../../src/tools/exa.js';
import { SupermemoryToolHandler } from '../../src/tools/supermemory.js';
import { ComposioToolHandler } from '../../src/tools/composio.js';

describe('Integration: End-to-End Poke Agent Flows', () => {
  let tempDir: string;
  let daemon: PokeDaemon;
  let skills: SkillRegistry | null = null;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'poke-e2e-test-'));
    daemon = new PokeDaemon(tempDir);
    const config = daemon.getConfigManager();
    config.setOwnerPhoneNumber('923001234567');
    config.updateCredentials({
      commandCodeApiKey: 'cmd-test-key',
      exaApiKey: 'exa-test-key',
      deepgramApiKey: 'dg-test-key',
      supermemoryApiKey: 'sm-test-key',
    });
    config.setMainModel({ provider: 'commandcode', model: 'claude-sonnet-4-6' });
  });

  afterEach(async () => {
    skills?.stopWatcher();
    await daemon.stop();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('mounts tools and handles send, jobs, load_tools, activate_skill, and automations', async () => {
    const config = daemon.getConfigManager();
    const gateway = daemon.getGateway();
    const sender = gateway.getSender();
    const workerManager = daemon.getWorkerManager();
    const scheduler = daemon.getScheduler();
    skills = new SkillRegistry(path.join(tempDir, 'skills'));
    skills.seedDefaultSkills();

    let sentMessage = '';
    vi.spyOn(sender, 'send').mockImplementation(async (params) => {
      sentMessage = params.text;
      return { messageId: 'msg-mock-1', mode: params.mode, timestamp: Date.now() };
    });
    vi.spyOn(workerManager, 'startJob').mockResolvedValue({
      id: 'job-mock-1',
      name: 'data-processing',
      instruction: 'Process records in /tmp/data',
      cwd: null,
      status: 'queued',
      result: null,
      error: null,
      created_at: Date.now(),
      started_at: null,
      finished_at: null,
      completion_dispatched_at: null,
    });

    const tools = createPokeTools({
      sender,
      exa: new ExaToolHandler(),
      supermemory: new SupermemoryToolHandler(),
      composio: new ComposioToolHandler(),
      workerManager,
      scheduler,
      skills,
      configManager: config,
    });

    // 1. Test `send` tool
    const sendResult = await tools.sendTool.run({
      data: { mode: 'message', text: 'Hello owner from Poke!' },
    } as any);
    expect(sendResult).toContain('msg-mock-1');
    expect(sentMessage).toBe('Hello owner from Poke!');

    // 2. Test `jobs` tool
    const jobResult = await tools.jobsTool.run({
      data: {
        action: 'start',
        name: 'data-processing',
        instruction: 'Process records in /tmp/data',
      },
    } as any);
    expect(jobResult).toContain('job-');
    expect(jobResult).toContain('queued');

    // 3. Test `load_tools` and `automation` tool
    expect(config.getActiveCapabilities()).not.toContain('automations');
    await tools.loadToolsTool.run({
      data: { capability: 'automations' },
    } as any);
    expect(config.getActiveCapabilities()).toContain('automations');
    await expect(
      tools.loadToolsTool.run({ data: { capability: 'untrusted-capability' } } as any)
    ).rejects.toThrow('Unknown conditional capability');
    expect(config.getActiveCapabilities()).not.toContain('untrusted-capability');

    const autoResult = await tools.automationTool.run({
      data: {
        action: 'create',
        name: 'Weekly summary',
        instruction: 'Generate weekly activity digest and send to WhatsApp.',
        schedule_type: 'cron',
        schedule_value: '0 9 * * 1',
      },
    } as any);
    expect(autoResult).toContain('Weekly summary');
    expect(autoResult).toContain('auto-');

    // 4. Test `activate_skill` tool
    const skillResult = await tools.activateSkillTool.run({
      data: { name: 'automations' },
    } as any);
    expect(skillResult).toContain('# Automations');
    expect(skillResult).toContain('Asia/Karachi');

    // 5. Test compaction resets conditional capabilities
    const compaction = daemon.getCompactionManager();
    compaction.onCompactionSuccess(20000);
    expect(config.getActiveCapabilities()).toEqual([]);
  });
});
