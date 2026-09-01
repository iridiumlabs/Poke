import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { ConfigManager } from '../config/config.js';
import { resolvePokePaths } from '../config/paths.js';
import { getPendingMigrations } from '../db/migrations.js';
import { readGatewayRuntimeStatus } from '../gateway/runtime-status.js';
import { FileCredentialStore } from '../providers/credential-store.js';
import { ProviderRegistry } from '../providers/provider-registry.js';
import type { ProviderCatalog } from '../providers/provider-registry.js';
import {
  REQUIRED_SERVICES,
  validateServiceCredential,
  type ServiceCredentialKey,
} from '../services/health.js';
import { SkillRegistry } from '../skills/registry.js';
import { redactSecrets } from '../logger/logger.js';

export interface DoctorCheckResult {
  name: string;
  passed: boolean;
  message?: string;
  warning?: boolean;
}

export interface DoctorDependencies {
  catalog?: ProviderCatalog;
  validateService?: (service: ServiceCredentialKey, apiKey: string) => Promise<void>;
}

function add(checks: DoctorCheckResult[], check: DoctorCheckResult): void {
  checks.push(check);
}

function safeErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? redactSecrets(error.message) : fallback;
}

async function checkServiceCredential(
  checks: DoctorCheckResult[],
  name: string,
  service: ServiceCredentialKey,
  apiKey: string | undefined,
  validateService: (service: ServiceCredentialKey, apiKey: string) => Promise<void>
): Promise<void> {
  if (!apiKey?.trim()) {
    add(checks, {
      name,
      passed: false,
      message: 'Missing. Run `poke setup`.',
    });
    return;
  }

  try {
    await validateService(service, apiKey);
    add(checks, { name, passed: true, message: 'Connected' });
  } catch (error: unknown) {
    add(checks, {
      name,
      passed: false,
      message: `Unusable: ${safeErrorMessage(error, 'Service validation failed.')}`,
    });
  }
}

export async function runDoctor(
  customHome?: string,
  dependencies: DoctorDependencies = {}
): Promise<{ success: boolean; checks: DoctorCheckResult[] }> {
  const paths = resolvePokePaths(customHome);
  const checks: DoctorCheckResult[] = [];
  console.log('\n--- Running Poke Diagnostics (`poke doctor`) ---\n');

  // This manager never creates config or directories. Every following check is
  // either a read or a bounded network request through an existing credential.
  const config = new ConfigManager(customHome, { initialize: false });
  let loadedConfig = false;
  try {
    config.loadConfig();
    loadedConfig = true;
    add(checks, { name: 'Configuration', passed: true, message: 'Readable' });
  } catch (error: unknown) {
    add(checks, {
      name: 'Configuration',
      passed: false,
      message: safeErrorMessage(error, 'Unable to read config.'),
    });
  }

  try {
    const directories = [paths.root, paths.inboxDir, paths.outboxDir, paths.logsDir, paths.cacheDir];
    const missing = directories.filter((directory) => !fs.existsSync(directory));
    if (missing.length > 0) {
      add(checks, {
        name: 'Directories & Permissions',
        passed: false,
        warning: true,
        message: `${missing.length} state directories have not been initialized yet.`,
      });
    } else {
      for (const directory of directories) fs.accessSync(directory, fs.constants.R_OK | fs.constants.W_OK);
      add(checks, { name: 'Directories & Permissions', passed: true, message: 'Readable and writable' });
    }
  } catch (error: unknown) {
    add(checks, {
      name: 'Directories & Permissions',
      passed: false,
      message: safeErrorMessage(error, 'Directory access failed.'),
    });
  }

  let database: Database.Database | undefined;
  let diagnosticDatabaseDirectory: string | undefined;
  try {
    if (!fs.existsSync(paths.sqliteFile)) {
      add(checks, {
        name: 'Database & Migrations',
        passed: false,
        warning: true,
        message: 'SQLite database has not been initialized yet.',
      });
    } else {
      // SQLite touches its -shm lock file even in readonly mode. Inspect an
      // ephemeral copy instead so doctor never mutates the live state tree.
      diagnosticDatabaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'poke-doctor-'));
      const copy = path.join(diagnosticDatabaseDirectory, 'state.sqlite');
      fs.copyFileSync(paths.sqliteFile, copy);
      for (const suffix of ['-wal', '-shm']) {
        const source = `${paths.sqliteFile}${suffix}`;
        if (fs.existsSync(source)) fs.copyFileSync(source, `${copy}${suffix}`);
      }
      database = new Database(copy, {
        readonly: true,
        fileMustExist: true,
      });
      const pending = getPendingMigrations(database);
      add(checks, {
        name: 'Database & Migrations',
        passed: pending.length === 0,
        message: pending.length === 0 ? 'Healthy, no pending migrations' : `${pending.length} pending migrations`,
      });
    }
  } catch (error: unknown) {
    add(checks, {
      name: 'Database & Migrations',
      passed: false,
      message: safeErrorMessage(error, 'Unable to inspect SQLite state.'),
    });
  } finally {
    database?.close();
    if (diagnosticDatabaseDirectory) {
      fs.rmSync(diagnosticDatabaseDirectory, { recursive: true, force: true });
    }
  }

  if (loadedConfig) {
    const owner = config.getOwnerPhoneNumber();
    add(checks, owner
      ? { name: 'Owner Phone Number', passed: true, message: `Bound to owner ${owner}` }
      : { name: 'Owner Phone Number', passed: false, message: 'Not configured. Run `poke setup`.' });

    const status = readGatewayRuntimeStatus(paths.runtimeStatusFile);
    const paired = status?.pairedAccount || config.getWhatsAppAccount();
    add(checks, paired
      ? { name: 'WhatsApp Session', passed: true, message: `${status?.state || 'saved'} (${paired})` }
      : { name: 'WhatsApp Session', passed: false, warning: true, message: 'No paired account reported yet.' });

    const credentials = config.getCredentials();
    const validateService = dependencies.validateService || validateServiceCredential;
    for (const service of REQUIRED_SERVICES) {
      await checkServiceCredential(
        checks,
        `${service.name} API Key`,
        service.key,
        credentials[service.key],
        validateService
      );
    }

    const registry = dependencies.catalog || new ProviderRegistry(new FileCredentialStore(paths.credentialsFile));
    for (const [name, selection] of [
      ['Main Model Configuration', config.getMainModel()],
      ['Worker Model Configuration', config.getWorkerModel()],
    ] as const) {
      if (!selection) {
        add(checks, { name, passed: false, message: `No ${name.startsWith('Main') ? 'main' : 'worker'} model selected.` });
        continue;
      }
      const validation = await registry.validateSelection(selection);
      add(checks, validation.valid
        ? { name, passed: true, message: `${selection.provider}/${selection.model} is available` }
        : { name, passed: false, message: redactSecrets(validation.error || 'Model validation failed.') });
    }
  }

  try {
    const skills = new SkillRegistry(paths.skillsDir, { readOnly: true });
    const count = skills.listSkills().length;
    skills.stopWatcher();
    add(checks, { name: 'Skills Registry', passed: true, message: `${count} skills readable` });
  } catch (error: unknown) {
    add(checks, {
      name: 'Skills Registry',
      passed: false,
      message: safeErrorMessage(error, 'Unable to inspect skills.'),
    });
  }

  const success = checks.every((check) => check.passed || check.warning);
  for (const check of checks) {
    const marker = check.passed ? '✓ [PASS]' : check.warning ? '! [WARN]' : '✗ [FAIL]';
    console.log(`${marker} ${check.name}: ${check.message || ''}`);
  }
  console.log(`\nOverall Doctor Status: ${success ? 'HEALTHY' : 'ISSUES DETECTED'}\n`);
  return { success, checks };
}
