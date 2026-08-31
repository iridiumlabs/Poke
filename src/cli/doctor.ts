import fs from 'fs';
import Database from 'better-sqlite3';
import { ConfigManager } from '../config/config.js';
import { resolvePokePaths } from '../config/paths.js';
import { getPendingMigrations } from '../db/migrations.js';
import { ProviderRegistry } from '../providers/provider-registry.js';
import { SkillRegistry } from '../skills/registry.js';

export interface DoctorCheckResult {
  name: string;
  passed: boolean;
  message?: string;
  warning?: boolean;
}

export async function runDoctor(customHome?: string): Promise<{ success: boolean; checks: DoctorCheckResult[] }> {
  const paths = resolvePokePaths(customHome);
  const checks: DoctorCheckResult[] = [];

  console.log('\n--- Running Poke Diagnostics (`poke doctor`) ---\n');

  // 1. Filesystem & Directory Permissions (Read-only verification)
  try {
    const testDirs = [
      paths.root,
      paths.whatsappDir,
      paths.inboxDir,
      paths.outboxDir,
      paths.logsDir,
      paths.cacheDir,
      paths.skillsDir,
    ];

    let missingDirs: string[] = [];
    for (const d of testDirs) {
      if (!fs.existsSync(d)) {
        missingDirs.push(d);
      } else {
        fs.accessSync(d, fs.constants.R_OK | fs.constants.W_OK);
      }
    }

    if (missingDirs.length === 0) {
      checks.push({ name: 'Directories & Permissions', passed: true, message: 'All directories exist and are writable' });
    } else {
      checks.push({ name: 'Directories & Permissions', passed: false, warning: true, message: `${missingDirs.length} directories not initialized yet.` });
    }
  } catch (err: any) {
    checks.push({ name: 'Directories & Permissions', passed: false, message: err.message });
  }

  // 2. Database & Migrations (Read-only inspection)
  let rawDb: Database.Database | null = null;
  try {
    if (!fs.existsSync(paths.sqliteFile)) {
      checks.push({ name: 'Database & Migrations', passed: false, warning: true, message: 'SQLite database file not created yet.' });
    } else {
      rawDb = new Database(paths.sqliteFile, { readonly: true, fileMustExist: true });
      const pending = getPendingMigrations(rawDb);
      if (pending.length === 0) {
        checks.push({ name: 'Database & Migrations', passed: true, message: 'SQLite database healthy, no pending migrations' });
      } else {
        checks.push({ name: 'Database & Migrations', passed: false, message: `${pending.length} pending migrations` });
      }
    }
  } catch (err: any) {
    checks.push({ name: 'Database & Migrations', passed: false, message: err.message });
  } finally {
    if (rawDb) {
      try {
        rawDb.close();
      } catch {}
    }
  }

  // 3. Configuration & Owner Binding
  const configManager = new ConfigManager(customHome);
  const ownerPhone = configManager.getOwnerPhoneNumber();

  if (ownerPhone) {
    checks.push({ name: 'Owner Phone Number', passed: true, message: `Bound to owner ${ownerPhone}` });
  } else {
    checks.push({ name: 'Owner Phone Number', passed: false, message: 'Owner phone number not configured. Run `poke setup`.' });
  }

  // 4. WhatsApp Credentials
  const whatsappFiles = fs.existsSync(paths.whatsappDir) ? fs.readdirSync(paths.whatsappDir) : [];
  if (whatsappFiles.length > 0) {
    checks.push({ name: 'WhatsApp Credentials', passed: true, message: 'Session credentials present on disk' });
  } else {
    checks.push({ name: 'WhatsApp Credentials', passed: false, warning: true, message: 'No WhatsApp session. Start daemon to pair QR code.' });
  }

  // 5. Service Keys Checks
  const creds = configManager.getCredentials();

  // Exa
  if (creds.exaApiKey) {
    checks.push({ name: 'Exa API Key', passed: true, message: 'Present' });
  } else {
    checks.push({ name: 'Exa API Key', passed: false, message: 'Exa API key missing' });
  }

  // Deepgram
  if (creds.deepgramApiKey) {
    checks.push({ name: 'Deepgram API Key', passed: true, message: 'Present' });
  } else {
    checks.push({ name: 'Deepgram API Key', passed: false, message: 'Deepgram API key missing' });
  }

  // Supermemory (Optional)
  if (creds.supermemoryApiKey) {
    checks.push({ name: 'Supermemory API Key', passed: true, message: 'Present' });
  } else {
    checks.push({ name: 'Supermemory API Key', passed: true, warning: true, message: 'Not configured (optional)' });
  }

  // Composio (Optional)
  if (creds.composioApiKey) {
    checks.push({ name: 'Composio API Key', passed: true, message: 'Present' });
  } else {
    checks.push({ name: 'Composio API Key', passed: true, warning: true, message: 'Not configured (optional)' });
  }

  // 6. Model Selection & Live Catalog Verification
  const mainModel = configManager.getMainModel();
  if (mainModel) {
    try {
      const validation = await ProviderRegistry.validateSelection(mainModel, creds);
      if (validation.valid) {
        checks.push({
          name: 'Main Model Configuration',
          passed: true,
          message: `${mainModel.provider}/${mainModel.model} verified against live catalog`,
        });
      } else {
        checks.push({
          name: 'Main Model Configuration',
          passed: false,
          message: validation.error || 'Model validation failed',
        });
      }
    } catch (err: any) {
      checks.push({ name: 'Main Model Configuration', passed: false, message: err.message });
    }
  } else {
    checks.push({ name: 'Main Model Configuration', passed: false, message: 'No main model selected. Run `poke model`.' });
  }

  // 7. Skills Registry (Clean up watcher)
  let skills: SkillRegistry | null = null;
  try {
    skills = new SkillRegistry(paths.skillsDir);
    const list = skills.listSkills();
    checks.push({ name: 'Skills Registry', passed: true, message: `${list.length} skills loaded from ${paths.skillsDir}` });
  } catch (err: any) {
    checks.push({ name: 'Skills Registry', passed: false, message: err.message });
  } finally {
    if (skills) {
      skills.stopWatcher();
    }
  }

  // Print results
  let overallSuccess = true;
  for (const check of checks) {
    if (!check.passed && !check.warning) {
      overallSuccess = false;
      console.log(`✗ [FAIL] ${check.name}: ${check.message}`);
    } else if (check.warning) {
      console.log(`! [WARN] ${check.name}: ${check.message}`);
    } else {
      console.log(`✓ [PASS] ${check.name}: ${check.message}`);
    }
  }

  console.log(`\nOverall Doctor Status: ${overallSuccess ? 'HEALTHY' : 'ISSUES DETECTED'}\n`);
  return { success: overallSuccess, checks };
}
