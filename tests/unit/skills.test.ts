import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { SkillRegistry } from '../../src/skills/registry.js';

describe('SkillRegistry Live Discovery', () => {
  let tempDir: string;
  let registry: SkillRegistry;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'poke-skills-test-'));
    registry = new SkillRegistry(tempDir);
  });

  afterEach(() => {
    registry.stopWatcher();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('seeds the skill-manager and automations skills with their operating contracts', () => {
    registry.seedDefaultSkills();
    const skills = registry.listSkills();
    const names = skills.map((s) => s.name);

    expect(names).toContain('skill-manager');
    expect(names).toContain('automations');

    const skillManager = registry.getSkill('skill-manager');
    expect(skillManager?.description).toContain('Install, create, or revise agent skills');
    expect(skillManager?.body).toContain('Treat the `description` as a context pointer');
    expect(skillManager?.body).toContain('every supporting file as one package');

    const automations = registry.getSkill('automations');
    expect(automations?.description).toContain('schedule, repeat, list, change, pause, resume, or delete');
    expect(automations?.body).toContain('Cron and interval automations do not replay');
    expect(automations?.body).toContain('Do not store credentials');
  });

  it('does not overwrite a customized default skill', () => {
    const skillDir = path.join(tempDir, 'automations');
    fs.mkdirSync(skillDir);
    const customSkill = `---
name: automations
description: My custom automations
---
Custom instructions`;
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), customSkill);

    registry.seedDefaultSkills();

    expect(fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8')).toBe(customSkill);
  });

  it('discovers dynamically installed skills without restarting', () => {
    expect(registry.getSkill('researcher')).toBeNull();

    // Create a new skill directory
    const newSkillDir = path.join(tempDir, 'researcher');
    fs.mkdirSync(newSkillDir);
    fs.writeFileSync(
      path.join(newSkillDir, 'SKILL.md'),
      `---
name: researcher
description: Deep web research capability
---

# Deep Research
Perform exhaustive search across multiple sources.`
    );

    const skill = registry.getSkill('researcher');
    expect(skill).not.toBeNull();
    expect(skill?.name).toBe('researcher');
    expect(skill?.description).toBe('Deep web research capability');
    expect(skill?.body).toContain('Perform exhaustive search');
  });

  it('updates edited skills immediately', () => {
    const skillDir = path.join(tempDir, 'my-skill');
    fs.mkdirSync(skillDir);
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      `---
name: my-skill
description: Version 1
---
Instruction v1`
    );

    expect(registry.getSkill('my-skill')?.description).toBe('Version 1');

    // Update skill
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      `---
name: my-skill
description: Version 2
---
Instruction v2`
    );

    const updated = registry.getSkill('my-skill');
    expect(updated?.description).toBe('Version 2');
    expect(updated?.body).toContain('Instruction v2');
  });

  it('removes deleted skills from catalog immediately', () => {
    const skillDir = path.join(tempDir, 'temp-skill');
    fs.mkdirSync(skillDir);
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      `---
name: temp-skill
description: Will be deleted
---
Content`
    );

    expect(registry.getSkill('temp-skill')).not.toBeNull();

    // Delete skill directory
    fs.rmSync(skillDir, { recursive: true, force: true });

    expect(registry.getSkill('temp-skill')).toBeNull();
  });
});
