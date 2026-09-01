import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { SkillRegistry, MAX_SKILL_PACKAGE_DEPTH } from '../../src/skills/registry.js';

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

  it('packages a skill’s supporting files for Flue activation', () => {
    const skillDir = path.join(tempDir, 'researcher');
    fs.mkdirSync(path.join(skillDir, 'references'), { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      `---
name: researcher
description: Research with a required checklist
---
Read references/checklist.md before researching.`
    );
    fs.writeFileSync(path.join(skillDir, 'references', 'checklist.md'), 'Verify primary sources first.');
    fs.writeFileSync(path.join(skillDir, 'references', 'undeclared.txt'), 'Not declared in SKILL.md');

    const skill = registry.getFlueSkills().find((candidate) => candidate.name === 'researcher');
    expect(skill?.instructions).toContain('references/checklist.md');
    expect(new TextDecoder().decode(skill?.files?.['references/checklist.md'] as Uint8Array)).toBe(
      'Verify primary sources first.'
    );
    expect(skill?.files?.['references/undeclared.txt']).toBeUndefined();
  });

  it('rejects secret-like and oversized supporting files in skill packages', () => {
    const skillDir = path.join(tempDir, 'security-skill');
    fs.mkdirSync(path.join(skillDir, 'secrets'), { recursive: true });
    fs.mkdirSync(path.join(skillDir, 'docs'), { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      `---
name: security-skill
description: Security skill with supporting files
---
Check secrets/.env and docs/huge.bin and docs/valid.txt.`
    );
    fs.writeFileSync(path.join(skillDir, 'secrets', '.env'), 'SECRET_KEY=12345');
    fs.writeFileSync(path.join(skillDir, 'docs', 'huge.bin'), Buffer.alloc(600 * 1024)); // > 512KB
    fs.writeFileSync(path.join(skillDir, 'docs', 'valid.txt'), 'Allowed content');

    const skill = registry.getFlueSkills().find((candidate) => candidate.name === 'security-skill');
    expect(skill?.files?.['secrets/.env']).toBeUndefined();
    expect(skill?.files?.['docs/huge.bin']).toBeUndefined();
    expect(new TextDecoder().decode(skill?.files?.['docs/valid.txt'] as Uint8Array)).toBe('Allowed content');
  });

  it('excludes bulk dependency directories and enforces the aggregate package byte budget', () => {
    const skillDir = path.join(tempDir, 'packaged-skill');
    fs.mkdirSync(path.join(skillDir, 'node_modules', 'dep'), { recursive: true });
    fs.mkdirSync(path.join(skillDir, 'references'), { recursive: true });
    // 17 referenced files, each under the per-file cap, together over budget.
    const fileCount = 17;
    const fileSize = 500 * 1024;
    const references = Array.from({ length: fileCount }, (_, i) => `references/file-${i}.md`);
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      `---
name: packaged-skill
description: Package with bulk dirs and a byte budget
---
Read ${references.join(' and ')} and node_modules/dep/index.js.`
    );
    fs.writeFileSync(path.join(skillDir, 'node_modules', 'dep', 'index.js'), 'bulk dependency');
    for (const reference of references) {
      fs.writeFileSync(path.join(skillDir, reference), Buffer.alloc(fileSize));
    }

    const skill = registry.getFlueSkills().find((candidate) => candidate.name === 'packaged-skill');
    expect(skill?.files?.['node_modules/dep/index.js']).toBeUndefined();
    // Exactly one referenced file drops once the aggregate budget is hit;
    // directory iteration order decides which one.
    const packaged = references.filter((reference) => skill?.files?.[reference] !== undefined);
    expect(packaged).toHaveLength(16);
  });

  it('stops descending past the package depth limit', () => {
    const skillDir = path.join(tempDir, 'deep-skill');
    let nested = skillDir;
    for (let i = 0; i <= MAX_SKILL_PACKAGE_DEPTH; i++) nested = path.join(nested, `level-${i}`);
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      `---
name: deep-skill
description: Deep nesting beyond the depth limit
---
Read ${path.relative(skillDir, path.join(nested, 'deep.txt')).split(path.sep).join('/')}.`
    );
    fs.writeFileSync(path.join(nested, 'deep.txt'), 'too deep');

    const skill = registry.getFlueSkills().find((candidate) => candidate.name === 'deep-skill');
    expect(skill?.files?.[path.relative(skillDir, path.join(nested, 'deep.txt')).split(path.sep).join('/')]).toBeUndefined();
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
