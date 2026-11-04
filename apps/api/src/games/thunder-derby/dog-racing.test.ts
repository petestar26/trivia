import { PGlite, type Transaction } from '@electric-sql/pglite';
import type { PrismaClient } from '@socialplay/database';
import { readFile } from 'node:fs/promises';
import { beforeAll, afterAll, expect, it } from 'vitest';
import { createDerbyService } from './service.js';
import { DOG_RACING_RULES, DERBY_RULES } from '@socialplay/shared';
import { derbyCommitment, derbyOrder } from './math.js';
let pg: PGlite,
  hounds: ReturnType<typeof createDerbyService>,
  derby: ReturnType<typeof createDerbyService>;
function wrap(tx: Pick<Transaction, 'query'>) {
  const query = (s: TemplateStringsArray, ...values: unknown[]) =>
    tx.query(
      s.reduce((text, part, i) => text + (i ? `$${i}` : '') + part, ''),
      values.map((v) =>
        v instanceof Date ? v.toISOString() : Array.isArray(v) ? `{${v.join(',')}}` : v
      )
    );
  return {
    $queryRaw: async (s: TemplateStringsArray, ...v: unknown[]) => (await query(s, ...v)).rows,
    $executeRaw: async (s: TemplateStringsArray, ...v: unknown[]) =>
      (await query(s, ...v)).affectedRows,
  };
}
beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(
    `CREATE TABLE users(id text PRIMARY KEY,status text DEFAULT 'ACTIVE'); CREATE TABLE game_definitions(key text,description text,"isActive" boolean,"catalogStatus" text,"updatedAt" timestamptz);`
  );
  await pg.exec(
    await readFile(
      '../../packages/database/prisma/migrations/20261009120000_thunder_derby_practice/migration.sql',
      'utf8'
    )
  );
  const db = {
    ...wrap(pg),
    $transaction: (run: (tx: unknown) => Promise<unknown>) => pg.transaction((tx) => run(wrap(tx))),
  } as unknown as PrismaClient;
  hounds = createDerbyService(db, 'hounds');
  derby = createDerbyService(db);
});
afterAll(() => pg.close());
async function fixture(id: string, startIn = 10000) {
  await pg.query('INSERT INTO users(id) VALUES($1)', [id]);
  const seed = 'c'.repeat(64),
    start = Date.now() + startIn;
  const order = derbyOrder(seed, 6, DOG_RACING_RULES.id);
  await pg.query(
    'INSERT INTO derby_rounds(id,field,opens_at,starts_at,finishes_at,ends_at,finish_order,seed,commitment) VALUES($1,6,$2,$3,$4,$5,$6,$7,$8)',
    [
      `hounds-${id}`,
      new Date(start - 120000).toISOString(),
      new Date(start).toISOString(),
      new Date(start + 45000).toISOString(),
      new Date(start + 60000).toISOString(),
      `{${order.join(',')}}`,
      seed,
      derbyCommitment(`hounds-${id}`, seed, DOG_RACING_RULES.id),
    ]
  );
  return { roundId: `hounds-${id}`, order, start };
}
it('separates race namespaces and commitments while sharing only racing practice credit', async () => {
  const f = await fixture('isolation');
  const dog = await hounds.snapshot('isolation', 6),
    horse = await derby.snapshot('isolation', 6);
  expect(dog.rulesId).toBe(DOG_RACING_RULES.id);
  expect(horse.rulesId).toBe(DERBY_RULES.id);
  expect(dog.rounds.every((r) => r.id.startsWith('hounds-'))).toBe(true);
  expect(horse.rounds.every((r) => !r.id.startsWith('hounds-'))).toBe(true);
  await expect(derby.enter('isolation', f.roundId, 6, 'WIN', [1], 25)).rejects.toThrow('not found');
  await expect(hounds.enter('isolation', horse.rounds[0].id, 6, 'WIN', [1], 25)).rejects.toThrow(
    'not found'
  );
  await hounds.enter('isolation', f.roundId, 6, 'WIN', [1], 25);
  expect((await derby.snapshot('isolation', 6)).balance).toBe(975);
  expect(derbyCommitment('same', 'a'.repeat(64), DOG_RACING_RULES.id)).not.toBe(
    derbyCommitment('same', 'a'.repeat(64))
  );
});
it('confirms once, preserves selection order and never publishes future outcomes', async () => {
  const f = await fixture('receipt');
  expect(await hounds.enter('receipt', f.roundId, 6, 'PERFECTA', [2, 1], 50)).toEqual({
    accepted: true,
    isReplay: false,
  });
  expect(await hounds.enter('receipt', f.roundId, 6, 'PERFECTA', [2, 1], 50)).toEqual({
    accepted: true,
    isReplay: true,
  });
  await expect(hounds.enter('receipt', f.roundId, 6, 'PERFECTA', [1, 2], 50)).rejects.toThrow(
    'cannot be changed'
  );
  const s = await hounds.snapshot('receipt', 6),
    r = s.rounds.find((r) => r.id === f.roundId)!;
  expect(s.balance).toBe(950);
  expect(r.seed).toBeNull();
  expect(r.order).toBeNull();
  expect(r.ticket?.picks).toEqual([2, 1]);
  expect(r.ticket?.oddsCents).toBe(2700);
  await expect(
    pg.query("UPDATE derby_accounts SET balance=balance+1 WHERE user_id='receipt'")
  ).rejects.toThrow('does not match');
});
it('rejects late, invalid, suspended and over-budget entries', async () => {
  const late = await fixture('late', -500);
  await expect(hounds.enter('late', late.roundId, 6, 'WIN', [1], 25)).rejects.toThrow('closed');
  const f = await fixture('validation');
  await expect(hounds.enter('validation', f.roundId, 6, 'WIN', [9], 25)).rejects.toThrow(
    'distinct'
  );
  await expect(hounds.enter('validation', f.roundId, 6, 'PERFECTA', [1, 1], 25)).rejects.toThrow(
    'distinct'
  );
  await expect(hounds.enter('validation', f.roundId, 6, 'WIN', [1], 501)).rejects.toThrow('10–500');
  await pg.query("UPDATE users SET status='SUSPENDED' WHERE id='validation'");
  await expect(hounds.snapshot('validation', 6)).rejects.toThrow('active account');
});
it('settles a real 45-second race once and restores the receipt after reconnect', async () => {
  const f = await fixture('settle', 250);
  await hounds.enter('settle', f.roundId, 6, 'WIN', [f.order[0]], 100);
  await new Promise((r) => setTimeout(r, Math.max(0, f.start + 45050 - Date.now())));
  const settled = await hounds.snapshot('settle', 6),
    r = settled.rounds.find((r) => r.id === f.roundId)!;
  expect(r.order).toEqual(f.order);
  expect(r.ticket?.payout).toBe(540);
  expect(settled.balance).toBe(1440);
  const failures: unknown[] = [];
  await hounds.tick((_id, e) => failures.push(e));
  await hounds.tick((_id, e) => failures.push(e));
  expect(failures).toEqual([]);
  expect((await hounds.snapshot('settle', 6)).balance).toBe(1440);
  expect(derbyCommitment(r.id, r.seed!, DOG_RACING_RULES.id)).toBe(r.commitment);
}, 60000);
