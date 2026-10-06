import { PGlite } from '@electric-sql/pglite';
import type { Transaction } from '@electric-sql/pglite';
import type { PrismaClient } from '@socialplay/database';
import { readFile } from 'node:fs/promises';
import { beforeAll, afterAll, expect, it } from 'vitest';
import { createCrashPointService } from './service.js';
let pg: PGlite;
let service: ReturnType<typeof createCrashPointService>;
// Real PostgreSQL expressions/triggers, serialized WASM connections. Native CI covers locks.
function wrap(tx: Pick<Transaction, 'query'>) {
  const query = async (strings: TemplateStringsArray, ...values: unknown[]) =>
    tx.query(
      strings.reduce((s, part, i) => s + (i ? `$${i}` : '') + part, ''),
      values.map((v) =>
        v instanceof Date ? v.toISOString() : Array.isArray(v) ? `{${v.join(',')}}` : v
      )
    );
  return {
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) =>
      (await query(strings, ...values)).rows,
    $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) =>
      (await query(strings, ...values)).affectedRows,
  };
}
beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(
    `CREATE TYPE "GameType" AS ENUM ('DICE');CREATE TABLE users(id text PRIMARY KEY,status text DEFAULT 'ACTIVE');`
  );
  await pg.exec(
    await readFile(
      '../../packages/database/prisma/migrations/20261006190000_crash_point_practice/migration.sql',
      'utf8'
    )
  );
  await pg.exec(
    await readFile(
      '../../packages/database/prisma/migrations/20261006210000_crash_point_dual_tickets/migration.sql',
      'utf8'
    )
  );
  service = createCrashPointService({
    ...wrap(pg),
    $transaction: (run: (tx: unknown) => Promise<unknown>) => pg.transaction((tx) => run(wrap(tx))),
  } as unknown as PrismaClient);
});
afterAll(() => pg.close());
async function fixture(id: string, startIn: number, crash: number) {
  await pg.query('INSERT INTO users(id) VALUES($1)', [id]);
  await service.snapshot(id);
  const starts = new Date(Date.now() + startIn);
  await pg.query(
    `INSERT INTO crash_point_rounds(id,opens_at,starts_at,ends_at,crash_cents,seed,commitment) VALUES($1,$2,$3,$4,$5,$6,$6)`,
    [
      id,
      new Date(starts.getTime() - 15000).toISOString(),
      starts.toISOString(),
      new Date(starts.getTime() + 45000).toISOString(),
      crash,
      'a'.repeat(64),
    ]
  );
  return starts.getTime();
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, Math.max(0, ms - Date.now() + 30)));
it('runs the real service admission, replay, manual receipt and credit exactly once', async () => {
  const start = await fixture('manual', 300, 300);
  await service.enter('manual', 'manual', 100, null);
  expect(await service.enter('manual', 'manual', 100, null)).toEqual({
    accepted: true,
    isReplay: true,
  });
  await expect(service.enter('manual', 'manual', 100, 200)).rejects.toThrow('cannot be changed');
  await expect(service.cashout('manual', 'manual')).rejects.toThrow('opens');
  await wait(start + 200);
  const receipt = await service.cashout('manual', 'manual');
  expect(receipt!.payout).toBeGreaterThanOrEqual(100);
  expect(await service.cashout('manual', 'manual')).toEqual(receipt);
  const s = await service.snapshot('manual');
  expect(s.balance).toBe(900 + receipt!.payout);
  expect(s.rounds.find((r) => r.id === 'manual')!.seed).toBeNull();
});
it('restores disconnected auto cashout and a losing tie through snapshots', async () => {
  const start = await fixture('automatic', 250, 300);
  await service.enter('automatic', 'automatic', 100, 101);
  await wait(start + 160);
  const errors: unknown[] = [];
  await service.tick((_id, e) => errors.push(e));
  expect(errors).toEqual([]);
  expect(
    (
      await pg.query<{ payout: number }>(
        "SELECT payout FROM crash_point_tickets WHERE id IN (SELECT id FROM crash_point_tickets WHERE user_id='automatic')"
      )
    ).rows[0].payout
  ).toBe(101);
  expect((await service.snapshot('automatic')).balance).toBe(1001);
  await service.tick();
  expect((await service.snapshot('automatic')).balance).toBe(1001);
  const lossStart = await fixture('tie', 250, 101);
  await service.enter('tie', 'tie', 100, 101);
  await wait(lossStart + 160);
  const result = await service.cashout('tie', 'tie');
  expect(result).toEqual({ payout: 0, paidCents: 0 });
  expect((await service.snapshot('tie')).balance).toBe(900);
});
it('denies a stranger cashout and late admission without debiting', async () => {
  const start = await fixture('late', 100, 100);
  await wait(start);
  await expect(service.enter('late', 'late', 50, null)).rejects.toThrow('closed');
  expect((await service.snapshot('late')).balance).toBe(1000);
  await expect(service.cashout('late', 'manual')).rejects.toThrow('not found');
});
it('publishes bounded anonymous activity without private outcomes or automatic targets', async () => {
  const start = await fixture('public-feed', 300, 300);
  await service.enter('public-feed', 'public-feed', 25, 101);
  const pending = await service.activity('public-feed', 'public-feed');
  expect(pending.totalTickets).toBe(1);
  expect(pending.tickets[0]).toEqual({
    player: expect.stringMatching(/^Player [0-9a-f]{10}$/),
    stake: 25,
    payout: null,
    paidCents: null,
  });
  expect(JSON.stringify(pending)).not.toContain('autoCents');
  expect(JSON.stringify(pending)).not.toContain('seed');
  expect(JSON.stringify(pending)).not.toContain('crashCents');
  await wait(start + 160);
  await service.tick();
  expect((await service.activity('public-feed', 'public-feed')).tickets[0]).toEqual({
    ...pending.tickets[0],
    payout: 25,
    paidCents: 101,
  });
  await expect(service.activity('missing-user', 'public-feed')).rejects.toThrow('active account');
  await expect(service.activity('public-feed', 'missing-round')).rejects.toThrow('not found');
});
it('keeps two slots independent and ranks only settled returns', async () => {
  const start = await fixture('dual', 700, 300);
  await service.enter('dual', 'dual', 100, 101, 1);
  await service.enter('dual', 'dual', 200, 102, 2);
  expect((await service.snapshot('dual')).balance).toBe(700);
  expect(
    (await service.snapshot('dual')).rounds.find((r) => r.id === 'dual')!.tickets
  ).toHaveLength(2);
  await expect(service.enter('dual', 'dual', 25, 101, 3)).rejects.toThrow('Invalid ticket slot');
  await expect(
    pg.query("UPDATE crash_point_tickets SET slot=2 WHERE user_id='dual' AND slot=1")
  ).rejects.toThrow();
  await wait(start + 250);
  await service.tick();
  expect(await service.cashout('dual', 'dual', 1)).toEqual({ payout: 101, paidCents: 101 });
  expect(await service.cashout('dual', 'dual', 2)).toEqual({ payout: 204, paidCents: 102 });
  expect((await service.snapshot('dual')).balance).toBe(1005);
  const leaders = await service.leaderboard('dual');
  expect(leaders.tickets[0].payout).toBeGreaterThanOrEqual(204);
  expect(leaders.tickets.every((t) => t.payout > 0)).toBe(true);
  expect(leaders.tickets.find((t) => t.roundId === 'dual' && t.stake === 200)?.paidCents).toBe(102);
});
