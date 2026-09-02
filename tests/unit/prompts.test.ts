import { describe, expect, it } from 'vitest';
import { MAIN_AGENT_SYSTEM_PROMPT } from '../../src/agent/prompts.js';
import { createPokeTools } from '../../src/agent/tools.js';

describe('WhatsApp reply prompt and tool metadata', () => {
  it('instructs omitting reply_to for normal messages in the system prompt', () => {
    expect(MAIN_AGENT_SYSTEM_PROMPT).toContain('omit `reply_to`');
    expect(MAIN_AGENT_SYSTEM_PROMPT).toContain('The presence of a `[WhatsApp message ID: …]` marker does not itself justify using `reply_to`');
    expect(MAIN_AGENT_SYSTEM_PROMPT).toContain('Use `reply_to` only when quoting a specific earlier message materially helps disambiguate');
    expect(MAIN_AGENT_SYSTEM_PROMPT).toContain('Do not reply-to or quote every inbound message');
  });

  it('tells the agent not to invent content for failed voice attachments', () => {
    expect(MAIN_AGENT_SYSTEM_PROMPT).toContain('`[voice transcription failed]`');
    expect(MAIN_AGENT_SYSTEM_PROMPT).toContain('`[voice transcription low confidence]`');
    expect(MAIN_AGENT_SYSTEM_PROMPT).toContain('`[voice media download failed]`');
    expect(MAIN_AGENT_SYSTEM_PROMPT).toContain('Do not infer its content from surrounding messages or attachments');
    expect(MAIN_AGENT_SYSTEM_PROMPT).toContain('ask the user to resend it or provide the text before proceeding');
  });

  it('clarifies reply_to omission and usage criteria in send tool description while preserving quoting capability', () => {
    const tools = createPokeTools({} as any);
    const sendTool = tools.sendTool;

    expect(sendTool.name).toBe('send');
    expect(sendTool.description).toContain('Omit reply_to for normal messages');
    expect(sendTool.description).toContain('the presence of a [WhatsApp message ID: …] marker does not itself justify quoting it');
    expect(sendTool.description).toContain('Set reply_to to a specific message ID only when quoting that message materially helps disambiguate');
    // Ensure the old biasing phrase is removed
    expect(sendTool.description).not.toContain('To quote the current inbound message, pass its [WhatsApp message ID: …] marker as reply_to');
  });
});

describe('Composio tool metadata', () => {
  it('clarifies that search_tools searches the full tool catalog with separate connected accounts and mixed auth requirements', () => {
    const tools = createPokeTools({} as any);
    const searchTool = tools.searchToolsTool;

    expect(searchTool.name).toBe('search_tools');
    expect(searchTool.description).toContain('full tool catalog');
    expect(searchTool.description).toContain('not limited to connected accounts');
    expect(searchTool.description).toContain('connected accounts are returned separately');
    expect(searchTool.description).toContain('Some actions require an authenticated connection while others require no auth');
    expect(searchTool.description).not.toContain('connected tools and actions');
  });

  it('ensures execute_tools does not imply every action requires a connected service', () => {
    const tools = createPokeTools({} as any);
    const executeTool = tools.executeToolsTool;

    expect(executeTool.name).toBe('execute_tools');
    expect(executeTool.description).toBe('Execute an action discovered via search_tools.');
    expect(executeTool.description).not.toContain('connected service');
  });
});
