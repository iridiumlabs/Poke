import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PokeDatabase } from '../../src/db/database.js';

describe('PokeDatabase', () => {
  let db: PokeDatabase;

  beforeEach(() => {
    db = new PokeDatabase(undefined, true); // in-memory
  });

  afterEach(() => {
    db.close();
  });

  it('handles state kv operations', () => {
    expect(db.getState('test_key')).toBeNull();
    db.setState('test_key', 'test_value');
    expect(db.getState('test_key')).toBe('test_value');
    db.setState('test_key', 'updated_value');
    expect(db.getState('test_key')).toBe('updated_value');
    db.deleteState('test_key');
    expect(db.getState('test_key')).toBeNull();
  });

  it('creates and updates worker jobs', () => {
    const job = db.createWorkerJob({
      id: 'job-1',
      name: 'test-job',
      instruction: 'Do something',
      cwd: '/tmp',
    });

    expect(job.id).toBe('job-1');
    expect(job.status).toBe('queued');

    const fetched = db.getWorkerJob('job-1');
    expect(fetched).not.toBeNull();
    expect(fetched?.name).toBe('test-job');

    db.updateWorkerJob('job-1', {
      status: 'running',
      started_at: Date.now(),
    });

    expect(db.getWorkerJob('job-1')?.status).toBe('running');

    const running = db.getRunningWorkerJobs();
    expect(running.length).toBe(1);

    const abortResult = db.abortAllActiveWorkerJobs();
    expect(abortResult.abortedIds).toContain('job-1');
    expect(db.getWorkerJob('job-1')?.status).toBe('aborted');
  });

  it('manages automations and due triggers', () => {
    const now = Date.now();
    const auto = db.createAutomation({
      id: 'auto-1',
      name: 'Daily check',
      instruction: 'Check prices',
      schedule_type: 'cron',
      schedule_value: '0 9 * * *',
      next_run_at: now - 1000,
    });

    expect(auto.id).toBe('auto-1');
    expect(auto.enabled).toBe(1);

    const due = db.getDueAutomations(now);
    expect(due.length).toBe(1);
    expect(due[0].id).toBe('auto-1');

    db.updateAutomation('auto-1', {
      enabled: false,
      last_outcome: 'success',
      last_run_at: now,
    });

    expect(db.getDueAutomations(now).length).toBe(0);
    expect(db.getAutomation('auto-1')?.enabled).toBe(0);

    const deleted = db.deleteAutomation('auto-1');
    expect(deleted).toBe(true);
    expect(db.getAutomation('auto-1')).toBeNull();
  });

  it('records idempotency and errors', () => {
    expect(db.checkIdempotency('key-1')).toBeNull();
    db.recordIdempotency('key-1', 'whatsapp_send', 'hash123', '{"msgId":"w-1"}');
    const record = db.checkIdempotency('key-1');
    expect(record).not.toBeNull();
    expect(record?.response_data).toBe('{"msgId":"w-1"}');

    db.recordOperationalError('provider', 'Timeout error', 'details...');
    const lastErr = db.getLastOperationalError();
    expect(lastErr).not.toBeNull();
    expect(lastErr?.source).toBe('provider');
    expect(lastErr?.message).toBe('Timeout error');
  });

  it('does not persist credentials embedded in operational errors', () => {
    const secret = 'super-secret-token-value';
    db.recordOperationalError('provider', `Authorization: Bearer ${secret}`, `token=${secret}`);

    const last = db.getLastOperationalError();
    expect(last?.message).not.toContain(secret);
    expect(last?.details).not.toContain(secret);
  });

  it('persists a delivery intent before a transport result and preserves an unknown outcome', () => {
    const first = db.reserveOutgoingDelivery('send-1:part:0', 'whatsapp_send_part', 'payload-hash');
    expect(first.created).toBe(true);
    expect(first.record.status).toBe('pending');

    const retry = db.reserveOutgoingDelivery('send-1:part:0', 'whatsapp_send_part', 'payload-hash');
    expect(retry.created).toBe(false);
    expect(retry.record.status).toBe('pending');

    db.completeOutgoingDelivery(
      'send-1:part:0',
      'whatsapp_send_part',
      'payload-hash',
      JSON.stringify({ messageId: 'wa-123' })
    );
    expect(db.getOutgoingDelivery('send-1:part:0')).toMatchObject({ status: 'sent' });
    expect(db.checkIdempotency('send-1:part:0')?.response_data).toContain('wa-123');
  });
});
