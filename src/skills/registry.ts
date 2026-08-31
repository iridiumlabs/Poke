import fs from 'fs';
import path from 'path';
import { getSkillsHome } from '../config/paths.js';
import { getLogger } from '../logger/logger.js';

export interface SkillMetadata {
  name: string;
  description: string;
  body: string;
  path: string;
  mtime: number;
}

export function parseSkillFile(filePath: string): SkillMetadata | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const content = fs.readFileSync(filePath, 'utf8');
    const stat = fs.statSync(filePath);

    // Parse YAML frontmatter if present
    let name = path.basename(path.dirname(filePath));
    let description = '';
    let body = content;

    const frontmatterMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
    if (frontmatterMatch) {
      const frontmatter = frontmatterMatch[1];
      body = frontmatterMatch[2].trim();

      const nameMatch = frontmatter.match(/name:\s*([^\r\n]+)/);
      if (nameMatch) {
        name = nameMatch[1].trim().replace(/^['"]|['"]$/g, '');
      }

      const descMatch = frontmatter.match(/description:\s*([^\r\n]+)/);
      if (descMatch) {
        description = descMatch[1].trim().replace(/^['"]|['"]$/g, '');
      }
    } else {
      // Look for first markdown header or summary
      const headerMatch = content.match(/^#\s+(.+)$/m);
      if (headerMatch) {
        description = headerMatch[1].trim();
      }
    }

    return {
      name,
      description: description || `Skill for ${name}`,
      body,
      path: filePath,
      mtime: stat.mtimeMs,
    };
  } catch (err: any) {
    getLogger().warn({ err: err.message, filePath }, 'Failed to parse skill file');
    return null;
  }
}

export class SkillRegistry {
  private skillsDir: string;
  private skillsCache = new Map<string, SkillMetadata>();
  private watcher: fs.FSWatcher | null = null;

  constructor(customSkillsDir?: string) {
    this.skillsDir = customSkillsDir || getSkillsHome();
    this.ensureSkillsDir();
    this.rescan();
    this.startWatcher();
  }

  ensureSkillsDir(): void {
    if (!fs.existsSync(this.skillsDir)) {
      fs.mkdirSync(this.skillsDir, { recursive: true, mode: 0o700 });
    }
  }

  startWatcher(): void {
    try {
      this.ensureSkillsDir();
      this.watcher = fs.watch(this.skillsDir, { recursive: true }, () => {
        this.rescan();
      });
    } catch (err: any) {
      getLogger().warn({ err: err.message }, 'Failed to initialize skills directory watcher');
    }
  }

  stopWatcher(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
  }

  rescan(): Map<string, SkillMetadata> {
    this.ensureSkillsDir();
    const newCache = new Map<string, SkillMetadata>();

    try {
      const entries = fs.readdirSync(this.skillsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const skillFile = path.join(this.skillsDir, entry.name, 'SKILL.md');
          if (fs.existsSync(skillFile)) {
            const skill = parseSkillFile(skillFile);
            if (skill) {
              newCache.set(skill.name, skill);
            }
          }
        } else if (entry.isFile() && entry.name.endsWith('.md')) {
          const skillFile = path.join(this.skillsDir, entry.name);
          const skill = parseSkillFile(skillFile);
          if (skill) {
            newCache.set(skill.name, skill);
          }
        }
      }
    } catch (err: any) {
      getLogger().warn({ err: err.message }, 'Failed to rescan skills directory');
    }

    this.skillsCache = newCache;
    return this.skillsCache;
  }

  listSkills(): SkillMetadata[] {
    // Reconcile on every query
    this.rescan();
    return Array.from(this.skillsCache.values());
  }

  getSkill(name: string): SkillMetadata | null {
    this.rescan();
    return this.skillsCache.get(name) || null;
  }

  getCatalogPrompt(): string {
    const skills = this.listSkills();
    if (skills.length === 0) return '';

    const lines = skills.map((s) => `- ${s.name}: ${s.description}`);
    return `Available skills (use \`activate_skill\` with skill name to load full instructions):\n${lines.join('\n')}`;
  }

  seedDefaultSkills(): void {
    this.ensureSkillsDir();

    // 1. Skill authoring & installer
    const skillBuilderDir = path.join(this.skillsDir, 'skill-builder');
    if (!fs.existsSync(skillBuilderDir)) {
      fs.mkdirSync(skillBuilderDir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(
        path.join(skillBuilderDir, 'SKILL.md'),
        `---
name: skill-builder
description: Skill authoring and installation from links or instructions
---

# Skill Builder

Use this skill when installing new skills or authoring custom skills.

## Installing Skills
Skills live at \`~/.agents/skills/<skill-name>/SKILL.md\`.
To install from a URL or bash script, download or write the \`SKILL.md\` file in a subdirectory under \`~/.agents/skills/\`.

## Authoring Skills
1. Create directory \`~/.agents/skills/<skill-name>\`
2. Create \`SKILL.md\` with YAML frontmatter:
\`\`\`yaml
---
name: my-skill
description: Short concise summary of what this skill enables
---
\`\`\`
3. Follow with clear, actionable Markdown instructions.
4. The skill becomes available immediately on the next turn.
`
      );
    }

    // 2. Automations skill
    const automationsDir = path.join(this.skillsDir, 'automations');
    if (!fs.existsSync(automationsDir)) {
      fs.mkdirSync(automationsDir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(
        path.join(automationsDir, 'SKILL.md'),
        `---
name: automations
description: Managing durable automations and scheduled tasks
---

# Automations Skill

Use this skill when the user wants to set up recurring or one-time scheduled tasks.

## Schedule Types
- \`once\`: Runs once at a future ISO timestamp (e.g. \`2026-09-01T15:00:00+05:00\`) in timezone \`Asia/Karachi\`.
- \`cron\`: Standard 5-part cron expression (e.g. \`0 9 * * *\` for 9:00 AM daily in Karachi).
- \`interval\`: Interval string or milliseconds (e.g. \`1h\`, \`30m\`, \`86400000\`).

## Standalone Instructions
Stored instructions MUST be complete, self-contained, and make sense without conversation history.
Never store elliptical instructions like "Check it again".
Always specify what to check, how to compare, and what to send to WhatsApp.

## Tool Loading
Call \`load_tools({ capability: "automations" })\` to mount the \`automation\` tool for creating, updating, listing, or deleting automations.
`
      );
    }

    this.rescan();
  }
}
