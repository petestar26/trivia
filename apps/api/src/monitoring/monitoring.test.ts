import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MONITOR_QUERIES, readMonitorSource } from './sources.js';
import { createMonitorSignals, registerMonitorSignals } from './signals.js';
import { scheduleMonitor } from './runtime.js';
import { createSupportService } from '../support/service.js';

const taggedSql = (parts: TemplateStringsArray) =>
  parts.reduce((s, p, i) => s + (i ? `$${i}` : '') + p, '');
const adapter = (c: any): any => ({
  $queryRaw: async (parts: TemplateStringsArray, ...values: unknown[]) =>
    (await c.query(taggedSql(parts), values)).rows,
  $executeRaw: async (parts: TemplateStringsArray, ...values: unknown[]) =>
    (await c.query(taggedSql(parts), values)).affectedRows,
  $queryRawUnsafe: async (query: string) => (await c.query(query)).rows,
  $executeRawUnsafe: async (query: string) => (await c.query(query)).affectedRows,
});

describe('read-only operational sources', () => {
  let pg: PGlite, db: any;
  beforeEach(async () => {
    pg = new PGlite();
    await pg.exec(`
      CREATE TABLE users(id text PRIMARY KEY,username text,role text,status text);
      INSERT INTO users VALUES('member','private-member','USER','ACTIVE'),('admin','private-staff','ADMIN','ACTIVE');
      CREATE TABLE disputes(id text,status text,"openedAt" timestamptz);
      CREATE TABLE withdrawal_disputes(id text,status text,"openedAt" timestamptz);
      CREATE TABLE late_payment_cases(id text,status text,"openedAt" timestamptz);
      CREATE TABLE agent_orders(id text,status text,"releaseDeadlineAt" timestamptz,"createdAt" timestamptz,"completedAt" timestamptz);
      CREATE TABLE withdrawals(id text,status text,"paymentSubmissionDeadlineAt" timestamptz,"confirmationDeadlineAt" timestamptz,"createdAt" timestamptz,"completedAt" timestamptz);
      CREATE TABLE crypto_deposits(id text,status text,"createdAt" timestamptz,"lastCheckedAt" timestamptz,"checkError" text);
      CREATE TABLE crypto_withdrawals(id text,status text,"createdAt" timestamptz);
      CREATE TABLE audit_logs(id text,action text,"createdAt" timestamptz,"newData" jsonb,ip text);
      CREATE TABLE play_together_workers(id text,healthy_at timestamptz);
      CREATE TABLE play_together_rounds(id text,state text,recovery_deadline timestamptz,presentation_finishes_at timestamptz,seed text);
      CREATE TABLE play_together_events(delivered_at timestamptz,available_at timestamptz);
      CREATE TABLE wallets("coinsBalance" int,"gamePointsBalance" int);
      INSERT INTO wallets VALUES(500,100);
      CREATE TABLE invariant_check_runs(id text,"startedAt" timestamptz,"finishedAt" timestamptz,passed boolean,violations jsonb);
      CREATE TABLE sg_test_players(username text,balance_cents bigint);
      CREATE TABLE sg_test_movements(username text,error int,action text,amount_cents bigint,created_at timestamptz);
    `);
    await pg.exec(
      readFileSync(
        new URL(
          '../../../../packages/database/prisma/migrations/20261105013000_member_support/migration.sql',
          import.meta.url
        ),
        'utf8'
      )
    );
    db = { ...adapter(pg), $transaction: (fn: any) => pg.transaction((tx) => fn(adapter(tx))) };
  });
  afterEach(async () => {
    await pg.close();
  });

  it('sees committed support creation, replies and reopening without exposing private content', async () => {
    const service = createSupportService(db);
    const input = {
      subject: 'private-subject-password',
      body: 'private-payment-details',
      category: 'PAYMENTS' as const,
      requestId: randomUUID(),
    };
    const ticket = await service.create('member', input);
    await service.create('member', input); // idempotent retry remains one monitored record
    let data = await readMonitorSource(db, 'support');
    expect(data.awaitingStaff).toBe(1);
    expect(data.changedTotal).toBe(1);
    expect(JSON.stringify(data)).not.toMatch(/private-|member|password/);
    await service.reply(
      'admin',
      ticket.id,
      { body: 'private-staff-reply', requestId: randomUUID() },
      true
    );
    expect((await readMonitorSource(db, 'support')).awaitingStaff).toBe(0);
    await service.setStatus('admin', ticket.id, 'RESOLVED', true);
    await service.setStatus('member', ticket.id, 'OPEN');
    expect((await readMonitorSource(db, 'support')).awaitingStaff).toBe(1);
    await expect(
      service.reply('member', ticket.id, { body: '', requestId: randomUUID() })
    ).rejects.toThrow();
    data = await readMonitorSource(db, 'support');
    expect(data.changedTotal).toBe(1);
    expect((await pg.query('SELECT * FROM wallets')).rows).toEqual([
      { coinsBalance: 500, gamePointsBalance: 100 },
    ]);
  });

  it('enforces PostgreSQL read-only even if a future query attempts a write', async () => {
    const malicious = {
      $transaction: (fn: any) =>
        pg.transaction((tx) =>
          fn({
            ...adapter(tx),
            $queryRawUnsafe: () => tx.query('UPDATE wallets SET "coinsBalance"=0'),
          })
        ),
    };
    await expect(readMonitorSource(malicious as any, 'walletChecks')).rejects.toThrow(/read-only/i);
    expect((await pg.query('SELECT "coinsBalance" FROM wallets')).rows).toEqual([
      { coinsBalance: 500 },
    ]);
  });

  it('flags payment appeals and genuinely overdue deadlines, excluding completed records', async () => {
    await pg.exec(`
      INSERT INTO disputes VALUES('d1','OPEN',now()),('d2','RESOLVED',now());
      INSERT INTO withdrawal_disputes VALUES('w1','ASSIGNED',now());
      INSERT INTO late_payment_cases VALUES('l1','OPEN',now());
      INSERT INTO agent_orders VALUES('o1','PAYMENT_SUBMITTED',now()-interval '3 minutes',now(),NULL),('o2','COMPLETED',now()-interval '3 minutes',now(),now());
      INSERT INTO withdrawals VALUES('w2','HELD',now()+interval '2 minutes',NULL,now(),NULL),('w3','PAYMENT_SUBMITTED',NULL,now()-interval '3 minutes',now(),NULL);
      INSERT INTO crypto_deposits VALUES('c1','WAITING',now(),now(),'private provider error secret');
    `);
    const data = await readMonitorSource(db, 'paymentAttention');
    expect(data.total).toBe(6);
    expect(data.truncated).toBe(false);
    expect(JSON.stringify(data)).not.toContain('private');
    expect(JSON.stringify(data)).not.toMatch(/o2|w2/);
    expect((await readMonitorSource(db, 'paymentActivity')).agentDepositsCompleted24h).toBe(1);
  });

  it('bounds samples and reports truncation instead of silently omitting busy periods', async () => {
    await pg.exec(
      `INSERT INTO audit_logs(id,action,"createdAt") SELECT 'audit-'||n,'ADMIN_MEMBER_SUSPENDED',now() FROM generate_series(1,105) n`
    );
    const data = await readMonitorSource(db, 'audit');
    expect(data.total).toBe(105);
    expect(data.truncated).toBe(true);
    expect(data.items).toHaveLength(100);
  });

  it('redacts unknown audit actions and every audit payload', async () => {
    await pg.exec(
      `INSERT INTO audit_logs VALUES('event','token-secret-private',now(),'{"secret":"private-payload"}','private-ip')`
    );
    const data = await readMonitorSource(db, 'audit');
    expect(JSON.stringify(data)).toContain('OTHER_RECORDED_ACTION');
    expect(JSON.stringify(data)).not.toMatch(/private|token-secret|payload/);
  });

  it('detects stalled shared rounds without disclosing a future result', async () => {
    await pg.exec(`INSERT INTO play_together_rounds VALUES('round','DRAWN',now()-interval '1 minute',now()-interval '1 minute','private-future-seed');
      INSERT INTO play_together_workers VALUES('worker',now()-interval '1 minute');
      INSERT INTO play_together_events VALUES(NULL,now()-interval '1 minute');`);
    const data = await readMonitorSource(db, 'sharedGames');
    expect(data).toMatchObject({
      workerFresh: false,
      activeRounds: 1,
      overdueRounds: 1,
      delayedResults: 1,
      undeliveredEvents: 1,
    });
    expect(JSON.stringify(data)).not.toContain('private');
  });

  it('distinguishes absent cash reconciliation evidence and virtual-wallet mismatches', async () => {
    expect((await readMonitorSource(db, 'walletChecks')).latestInvariantCheck).toBeNull();
    await pg.exec(`INSERT INTO sg_test_players VALUES('private-username',99900);
      INSERT INTO sg_test_movements VALUES('private-username',0,'debit',100,now()),('private-username',1,'debit',500,now());`);
    expect(await readMonitorSource(db, 'providerPractice')).toMatchObject({
      mismatchedBalances: 0,
      movements24h: 2,
      rejectedMovements24h: 1,
    });
    await pg.exec('UPDATE sg_test_players SET balance_cents=0');
    const data = await readMonitorSource(db, 'providerPractice');
    expect(data.mismatchedBalances).toBe(1);
    expect(JSON.stringify(data)).not.toContain('private');
  });

  it('all fixed queries are executable and leave operational data unchanged', async () => {
    for (const source of Object.keys(MONITOR_QUERIES) as Array<keyof typeof MONITOR_QUERIES>) {
      expect(await readMonitorSource(db, source)).toBeTypeOf('object');
    }
    expect((await pg.query('SELECT * FROM wallets')).rows).toEqual([
      { coinsBalance: 500, gamePointsBalance: 100 },
    ]);
    expect((await pg.query('SELECT * FROM invariant_check_runs')).rows).toEqual([]);
  });
});

describe('monitor lifecycle and request aggregation', () => {
  afterEach(() => {
    vi.useRealTimers();
  });
  it('bounds attacker-controlled routes and clears counters between windows', () => {
    const signals = createMonitorSignals();
    for (let n = 0; n < 10000; n++) signals.response(`/secret/${n}`, 401, 1);
    signals.response('/api/v1/provider-test/launch', 503, 4000);
    signals.callback('invalid_signature_or_payload');
    const data = signals.take();
    expect(Object.keys(data.http)).toEqual(['other', 'casino']);
    expect(data.http.casino).toMatchObject({ serverErrors: 1, slow: 1 });
    expect(data.callbacks).toEqual({ invalid_signature_or_payload: 1 });
    expect(JSON.stringify(data)).not.toContain('secret');
    expect(signals.take().http).toEqual({});
  });

  it('captures real responses through child plugins, without request content', async () => {
    const app = Fastify();
    registerMonitorSignals(app, true);
    app.register(async (child) => {
      child.post('/api/v1/provider-test/launch', async (_req, reply) => {
        child.salemMonitor?.callback('failed');
        return reply.code(503).send({ private: 'private-response' });
      });
    });
    await app.inject({
      method: 'POST',
      url: '/api/v1/provider-test/launch?token=private-query',
      payload: { password: 'private-body' },
    });
    const data = app.salemMonitor!.take();
    expect(data.http.casino.serverErrors).toBe(1);
    expect(data.callbacks.failed).toBe(1);
    expect(JSON.stringify(data)).not.toContain('private');
    await app.close();
  });

  it('classifies the registered sportsbook and agent payment route families', () => {
    const signals = createMonitorSignals();
    signals.response('/api/v1/sportsbook/launch', 503, 1);
    signals.response('/api/v1/agent-orders/:id/release', 503, 1);
    signals.response('/api/v1/payment-orders/:id/messages', 503, 1);
    signals.response('/api/v1/late-payments/:id', 503, 1);
    expect(signals.take().http).toMatchObject({
      sports: { serverErrors: 1 },
      payments: { serverErrors: 3 },
    });
  });

  it('does nothing when disabled', async () => {
    const app = Fastify();
    registerMonitorSignals(app, false);
    expect(app.salemMonitor).toBeUndefined();
    await app.close();
  });

  it('reports partial failure and recovery with a fresh heartbeat, without raw errors', async () => {
    vi.useFakeTimers();
    const emitted: any[] = [];
    const read = vi.fn(async (source: string) => {
      if (source === 'support') throw Error('private database credential');
      return { total: 0 };
    });
    const stop = scheduleMonitor({ read, emit: (e) => emitted.push(e), signals: () => ({}) });
    await vi.advanceTimersByTimeAsync(0);
    expect(emitted.at(-1)).toMatchObject({
      kind: 'heartbeat',
      status: 'partial',
      failedSources: ['support'],
    });
    expect(emitted[0]).toMatchObject({
      source: 'support',
      status: 'unavailable',
      lastSuccessAt: null,
    });
    expect(JSON.stringify(emitted)).not.toContain('private');
    read.mockImplementation(async () => ({ total: 0 }));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(emitted.at(-1)).toMatchObject({ status: 'ok', sequence: 2 });
    await stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(read).toHaveBeenCalledTimes(14);
  });

  it('never overlaps a slow scan and waits for the in-flight read on shutdown', async () => {
    vi.useFakeTimers();
    let finish!: (data: Record<string, unknown>) => void;
    const read = vi.fn(
      () =>
        new Promise<Record<string, unknown>>((resolve) => {
          finish = resolve;
        })
    );
    const stop = scheduleMonitor({ read, emit: () => {}, signals: () => ({}) });
    await vi.advanceTimersByTimeAsync(180_000);
    expect(read).toHaveBeenCalledTimes(1);
    const stopped = stop();
    finish({ total: 0 });
    await stopped;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(read).toHaveBeenCalledTimes(1);
  });
});
