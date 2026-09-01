import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { AutomationScheduler } from '../../src/scheduler/scheduler.js';
import { computeNextRun, parseDurationMs, POKE_TIMEZONE } from '../../src/scheduler/timezone.js';
import { PokeDatabase } from '../../src/db/database.js';
import { SignalPayload } from '../../src/agent/signals.js';

describe('AutomationScheduler & Timezone (Asia/Karachi)', () => {
  let tempDir: string;
  let db: PokeDatabase;
  let scheduler: AutomationScheduler;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'poke-sched-test-'));
    db = new PokeDatabase(tempDir);
    scheduler = new AutomationScheduler(db);
  });

  afterEach(() => {
    scheduler.stop();
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('parses duration strings accurately into milliseconds', () => {
    expect(parseDurationMs('30s')).toBe(30000);
    expect(parseDurationMs('15m')).toBe(900000);
    expect(parseDurationMs('2h')).toBe(7200000);
    expect(parseDurationMs('1d')).toBe(86400000);
    expect(parseDurationMs('5000')).toBe(5000);
  });

  it('computes next runs for once, interval, and cron in Asia/Karachi', () => {
    const baseTime = Date.parse('2026-09-01T12:00:00Z');

    // Interval
    const nextInterval = computeNextRun('interval', '1h', baseTime);
    expect(nextInterval).toBe(baseTime + 3600000);

    // Cron: 9am daily in Karachi
    const nextCron = computeNextRun('cron', '0 9 * * *', baseTime);
    expect(nextCron).toBeGreaterThan(baseTime);

    // Once with timezone offset
    const targetIso = '2026-09-05T15:00:00.000Z';
    const nextOnce = computeNextRun('once', targetIso, baseTime);
    expect(nextOnce).toBe(Date.parse(targetIso));

    // Once without timezone offset: parsed in Asia/Karachi (+05:00)
    const localStr = '2026-09-05 15:00:00';
    const parsedKarachi = computeNextRun('once', localStr, baseTime);
    expect(parsedKarachi).toBe(Date.parse('2026-09-05T15:00:00+05:00'));

    // Once with date-only format (YYYY-MM-DD)
    const dateOnlyStr = '2026-09-05';
    const parsedDateOnly = computeNextRun('once', dateOnlyStr, baseTime);
    expect(parsedDateOnly).toBe(Date.parse('2026-09-05T00:00:00+05:00'));

    // Past time throws
    expect(() => computeNextRun('once', '2026-08-01 10:00:00', baseTime)).toThrow(
      'One-off schedule must be set in the future (Asia/Karachi).'
    );
  });

  it('creates, updates, disables, enables, lists, and deletes automations', () => {
    const auto = scheduler.createAutomation({
      name: 'Daily check',
      instruction: 'Check pricing and send summary if changed.',
      schedule_type: 'cron',
      schedule_value: '0 9 * * *',
    });

    expect(auto.name).toBe('Daily check');
    expect(auto.enabled).toBe(1);

    const list = scheduler.listAutomations();
    expect(list.length).toBe(1);

    scheduler.disableAutomation(auto.id);
    expect(scheduler.getAutomation(auto.id)?.enabled).toBe(0);

    scheduler.enableAutomation(auto.id);
    expect(scheduler.getAutomation(auto.id)?.enabled).toBe(1);

    scheduler.updateAutomation(auto.id, { name: 'Updated check' });
    expect(scheduler.getAutomation(auto.id)?.name).toBe('Updated check');

    const deleted = scheduler.deleteAutomation(auto.id);
    expect(deleted).toBe(true);
    expect(scheduler.getAutomation(auto.id)).toBeNull();
  });

  it('handles downtime catch-up: runs overdue once exactly once, skips missed cron/interval', () => {
    const now = Date.now();
    const pastTime = now - 100000;

    // 1. Overdue Once
    const onceAuto = db.createAutomation({
      id: 'auto-once',
      name: 'One-time alert',
      instruction: 'Alert user once',
      schedule_type: 'once',
      schedule_value: new Date(pastTime).toISOString(),
      next_run_at: pastTime,
    });

    // 2. Overdue Cron
    const cronAuto = db.createAutomation({
      id: 'auto-cron',
      name: 'Hourly sync',
      instruction: 'Hourly sync task',
      schedule_type: 'cron',
      schedule_value: '0 * * * *',
      next_run_at: pastTime,
    });

    scheduler.reconcileDowntime();

    // Overdue once remains due to execute once
    const updatedOnce = db.getAutomation('auto-once');
    expect(updatedOnce?.next_run_at).toBe(pastTime);

    // Overdue cron was recomputed to a future occurrence (missed intervals skipped)
    const updatedCron = db.getAutomation('auto-cron');
    expect(updatedCron?.next_run_at).toBeGreaterThan(now);
  });

  it('atomically claims an overdue automation and formats its signal payload', async () => {
    const scheduledAt = Date.now() - 1_000;
    db.createAutomation({
      id: 'auto-"<&',
      name: 'Daily "summary" & review',
      instruction: 'Read <untrusted> & report it.',
      schedule_type: 'once',
      schedule_value: new Date(scheduledAt).toISOString(),
      next_run_at: scheduledAt,
    });

    const dispatched: SignalPayload[] = [];
    scheduler.setDispatcher(async (signal) => {
      dispatched.push(signal);
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    scheduler.start(60_000);

    await Promise.all([scheduler.tick(), scheduler.tick()]);

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].type).toBe('automation.trigger');
    expect(dispatched[0].tagName).toBe('automation_trigger');
    expect(dispatched[0].attributes.id).toBe('auto-"<&');
    expect(dispatched[0].attributes.name).toBe('Daily "summary" & review');
    expect(dispatched[0].body).toBe('Read <untrusted> & report it.');
    expect(db.getAutomation('auto-"<&')?.last_outcome).toBe('dispatched');
    expect(db.getAutomation('auto-"<&')?.enabled).toBe(0);
  });

  it('keeps a failed dispatch eligible for a bounded retry instead of leaving it claimed', async () => {
    const scheduledAt = Date.now() - 1_000;
    db.createAutomation({
      id: 'auto-retry',
      name: 'Retry alert',
      instruction: 'Send the alert.',
      schedule_type: 'once',
      schedule_value: new Date(scheduledAt).toISOString(),
      next_run_at: scheduledAt,
    });
    scheduler.setDispatcher(vi.fn().mockRejectedValue(new Error('main agent unavailable')));
    scheduler.start(60_000);

    await scheduler.tick();

    const updated = db.getAutomation('auto-retry');
    expect(updated?.last_outcome).toContain('dispatch_error: main agent unavailable');
    expect(updated?.next_run_at).toBeGreaterThan(Date.now());
    expect(updated?.enabled).toBe(1);
  });
});
