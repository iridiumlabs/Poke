import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { PokeRuntime, MAIN_AGENT_INSTANCE_ID } from '../../src/agent/runtime.js';
import { PokeMainAgent } from '../../src/agent/main-agent.js';
import { PokeDatabase } from '../../src/db/database.js';
import { ConfigManager } from '../../src/config/config.js';
import { WhatsAppSender } from '../../src/gateway/sender.js';
import { CompactionManager } from '../../src/context/compaction-manager.js';
import { WorkerManager } from '../../src/workers/worker-manager.js';
import { AutomationScheduler } from '../../src/scheduler/scheduler.js';
import { SkillRegistry } from '../../src/skills/registry.js';
import { ExaToolHandler } from '../../src/tools/exa.js';
import { SupermemoryToolHandler } from '../../src/tools/supermemory.js';
import { ComposioToolHandler } from '../../src/tools/composio.js';

describe('PokeRuntime: Submission Delivery & Replay Recovery', () => {
  let tempDir: string;
  let db: PokeDatabase;
  let config: ConfigManager;
  let sender: WhatsAppSender;
  let compactionManager: CompactionManager;
  let runtime: PokeRuntime;

  let mockAgentHandle: {
    dispatch: ReturnType<typeof vi.fn>;
    read: ReturnType<typeof vi.fn>;
    abort: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'poke-runtime-test-'));
    db = new PokeDatabase(tempDir);
    config = new ConfigManager(tempDir);
    config.setOwnerPhoneNumber('923001234567');

    sender = new WhatsAppSender(
      {} as any,
      '923001234567@s.whatsapp.net',
      db,
      {} as any
    );
    compactionManager = new CompactionManager(db, config);

    runtime = new PokeRuntime(
      config,
      db,
      new ExaToolHandler(),
      new SupermemoryToolHandler(),
      new ComposioToolHandler(),
      new SkillRegistry(path.join(tempDir, 'skills')),
      new WorkerManager(db, config, {} as any, {} as any, {} as any, {} as any),
      new AutomationScheduler(db),
      sender,
      compactionManager,
      tempDir
    );

    mockAgentHandle = {
      dispatch: vi.fn(),
      read: vi.fn().mockResolvedValue({ text: 'reply' }),
      abort: vi.fn().mockResolvedValue(undefined),
    };
    (runtime as any).agentHandle = mockAgentHandle;

    (db as any).db.exec(`
      CREATE TABLE IF NOT EXISTS flue_agent_submissions (
        submission_id TEXT NOT NULL UNIQUE,
        session_key TEXT NOT NULL,
        kind TEXT NOT NULL,
        payload TEXT NOT NULL,
        status TEXT NOT NULL,
        accepted_at INTEGER NOT NULL
      )
    `);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('recovers via replay dispatch when post-admission dispatch throws and avoids sending false error', async () => {
    const directErrorSpy = vi.spyOn(sender, 'sendDirectError').mockResolvedValue();
    const sourceKey = 'whatsapp:msg-123';
    const submissionId = 'sub_ik_recovered_123';

    // First dispatch call throws post-admission error, second (replay) succeeds
    mockAgentHandle.dispatch
      .mockRejectedValueOnce(new Error('Connection reset after admission'))
      .mockResolvedValueOnce({ submissionId, deduplicated: true });

    const receipt = await runtime.dispatchUserMessage('Hello agent', [], 'msg-123');

    expect(receipt).toEqual({ submissionId, deduplicated: true });
    expect(mockAgentHandle.dispatch).toHaveBeenCalledTimes(2);
    expect(directErrorSpy).not.toHaveBeenCalled();

    // Check delivery record was attached in DB and settled upon read completion
    const delivery = db.getSubmissionDeliveryBySourceKey(sourceKey);
    expect(delivery).toMatchObject({
      source_key: sourceKey,
      submission_id: submissionId,
      status: 'completed',
    });
  });

  it('prunes unattached reservation and reports direct error on genuine pre-admission dispatch failure', async () => {
    const directErrorSpy = vi.spyOn(sender, 'sendDirectError').mockResolvedValue();
    const sourceKey = 'whatsapp:msg-fail-123';

    // Both initial dispatch and replay fail
    mockAgentHandle.dispatch
      .mockRejectedValueOnce(new Error('Pre-admission validation failure'))
      .mockRejectedValueOnce(new Error('Pre-admission validation failure'));

    await expect(
      runtime.dispatchUserMessage('Hello agent', [], 'msg-fail-123')
    ).rejects.toThrow('Pre-admission validation failure');

    expect(directErrorSpy).toHaveBeenCalledWith('Inference failed: Pre-admission validation failure');

    // Unattached reservation is pruned from DB, preventing orphaned pending row
    const delivery = db.getSubmissionDeliveryBySourceKey(sourceKey);
    expect(delivery).toBeNull();
  });

  it('recovers signals via replay dispatch on post-admission error and cleans up on persistent error', async () => {
    const sourceKey = 'signal-key-1';
    const submissionId = 'sub_ik_sig_1';

    // 1. Replay succeeds for signal
    mockAgentHandle.dispatch
      .mockRejectedValueOnce(new Error('Post-admission transport loss'))
      .mockResolvedValueOnce({ submissionId });

    const receipt = await runtime.dispatchSignal({
      type: 'automation.trigger',
      tagName: 'auto',
      attributes: {},
      body: 'run now',
      idempotencyKey: sourceKey,
    });
    expect(receipt).toEqual({ submissionId });
    expect(db.getSubmissionDeliveryBySourceKey(sourceKey)).toMatchObject({
      submission_id: submissionId,
      status: 'completed',
    });

    // 2. Persistent failure cleans up unattached row
    const failKey = 'signal-key-fail';
    mockAgentHandle.dispatch
      .mockRejectedValueOnce(new Error('Admission rejected'))
      .mockRejectedValueOnce(new Error('Admission rejected'));

    await expect(
      runtime.dispatchSignal({
        type: 'worker.completion',
        tagName: 'worker',
        attributes: {},
        body: 'done',
        idempotencyKey: failKey,
      })
    ).rejects.toThrow('Admission rejected');

    expect(db.getSubmissionDeliveryBySourceKey(failKey)).toBeNull();
  });

  it('recovers pending submission deliveries on startup: attaches admitted rows and prunes unadmitted rows', async () => {
    // Setup Flue table in sqlite to simulate Flue persistence
    (db as any).db.exec(`
      CREATE TABLE IF NOT EXISTS flue_agent_submissions (
        submission_id TEXT NOT NULL UNIQUE,
        session_key TEXT NOT NULL,
        kind TEXT NOT NULL,
        payload TEXT NOT NULL,
        status TEXT NOT NULL,
        accepted_at INTEGER NOT NULL
      )
    `);

    // 1. Row that was already attached before restart
    db.reserveSubmissionDelivery({
      sourceKey: 'whatsapp:already-attached',
      source: 'whatsapp',
      whatsappMessageId: 'already-attached',
    });
    db.attachSubmissionDelivery('whatsapp:already-attached', 'sub_already_attached');

    // 2. Row that was reserved, crashed, but Flue admitted it
    const admittedSourceKey = 'whatsapp:admitted-before-crash';
    db.reserveSubmissionDelivery({
      sourceKey: admittedSourceKey,
      source: 'whatsapp',
      whatsappMessageId: 'admitted-before-crash',
    });

    const preimage = `flue-submission-key\n${PokeMainAgent.name}\n${MAIN_AGENT_INSTANCE_ID}\n${admittedSourceKey}`;
    const admittedSubmissionId = `sub_ik_${crypto.createHash('sha256').update(preimage).digest('hex').slice(0, 32)}`;

    (db as any).db
      .prepare(
        `INSERT INTO flue_agent_submissions (submission_id, session_key, kind, payload, status, accepted_at)
         VALUES (?, 'owner', 'direct', '{}', 'queued', ?)`
      )
      .run(admittedSubmissionId, Date.now());

    // 3. Row that was reserved, crashed, but Flue NEVER admitted it
    const unadmittedSourceKey = 'whatsapp:never-admitted';
    db.reserveSubmissionDelivery({
      sourceKey: unadmittedSourceKey,
      source: 'whatsapp',
      whatsappMessageId: 'never-admitted',
    });

    // Run startup recovery
    (runtime as any).recoverSubmissionDeliveries();

    // Already attached row was watched
    expect(db.getSubmissionDeliveryBySourceKey('whatsapp:already-attached')).toMatchObject({
      submission_id: 'sub_already_attached',
      status: 'pending',
    });

    // Admitted row was found in Flue store, attached, and watched
    expect(db.getSubmissionDeliveryBySourceKey(admittedSourceKey)).toMatchObject({
      submission_id: admittedSubmissionId,
      status: 'pending',
    });

    // Unadmitted row was pruned from DB so it does not stay orphaned pending forever
    expect(db.getSubmissionDeliveryBySourceKey(unadmittedSourceKey)).toBeNull();
  });

  it('recovers admitted work when replay also encounters transport error without erasing reservation or sending false error', async () => {
    const directErrorSpy = vi.spyOn(sender, 'sendDirectError').mockResolvedValue();
    const sourceKey = 'whatsapp:msg-double-fail';
    const preimage = `flue-submission-key\n${PokeMainAgent.name}\n${MAIN_AGENT_INSTANCE_ID}\n${sourceKey}`;
    const admittedSubmissionId = `sub_ik_${crypto.createHash('sha256').update(preimage).digest('hex').slice(0, 32)}`;

    // Initial dispatch durably admits in Flue table before losing transport
    mockAgentHandle.dispatch
      .mockImplementationOnce(async () => {
        (db as any).db
          .prepare(
            `INSERT INTO flue_agent_submissions (submission_id, session_key, kind, payload, status, accepted_at)
             VALUES (?, 'owner', 'direct', '{}', 'queued', ?)`
          )
          .run(admittedSubmissionId, Date.now());
        throw new Error('Connection reset after admission');
      })
      .mockRejectedValueOnce(new Error('Replay connection reset'));

    const receipt = await runtime.dispatchUserMessage('Hello agent', [], 'msg-double-fail');

    expect(receipt).toEqual({ submissionId: admittedSubmissionId });
    expect(mockAgentHandle.dispatch).toHaveBeenCalledTimes(2);
    expect(directErrorSpy).not.toHaveBeenCalled();

    // Delivery record was attached in DB and settled
    const delivery = db.getSubmissionDeliveryBySourceKey(sourceKey);
    expect(delivery).toMatchObject({
      source_key: sourceKey,
      submission_id: admittedSubmissionId,
      status: 'completed',
    });
  });

  it('does not attempt replay dispatch when dispatch was never reached due to reservation failure', async () => {
    const directErrorSpy = vi.spyOn(sender, 'sendDirectError').mockResolvedValue();
    const reserveSpy = vi.spyOn(db, 'reserveSubmissionDelivery').mockImplementation(() => {
      throw new Error('SQLite disk full');
    });

    await expect(
      runtime.dispatchUserMessage('Hello agent', [], 'msg-reserve-fail')
    ).rejects.toThrow('SQLite disk full');

    expect(mockAgentHandle.dispatch).not.toHaveBeenCalled();
    expect(directErrorSpy).toHaveBeenCalledWith('Inference failed: SQLite disk full');
    reserveSpy.mockRestore();
  });

  it('preserves unattached pending reservations and propagates error when startup Flue lookup fails', () => {
    const pendingKey = 'whatsapp:lookup-error';
    db.reserveSubmissionDelivery({
      sourceKey: pendingKey,
      source: 'whatsapp',
      whatsappMessageId: 'lookup-error',
    });

    const hasFlueSpy = vi.spyOn(db, 'hasFlueSubmission').mockImplementation(() => {
      throw new Error('SQLite busy / locked');
    });

    expect(() => (runtime as any).recoverSubmissionDeliveries()).toThrow('SQLite busy / locked');

    // Unattached reservation must NOT be deleted on lookup error
    const delivery = db.getSubmissionDeliveryBySourceKey(pendingKey);
    expect(delivery).not.toBeNull();
    expect(delivery?.status).toBe('pending');
    hasFlueSpy.mockRestore();
  });
});
