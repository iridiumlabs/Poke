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
