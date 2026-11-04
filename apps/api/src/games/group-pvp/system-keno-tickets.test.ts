import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { beforeEach, afterEach, expect, it } from 'vitest';
import { createSystemKenoService } from './system-keno.js';
let db: PGlite, service: ReturnType<typeof createSystemKenoService>;
const sql = (s: TemplateStringsArray) => s.reduce((q, p, i) => q + (i ? `$${i}` : '') + p, '');
const adapter = (c: any): any => ({
  $queryRaw: async (s: TemplateStringsArray, ...v: unknown[]) => (await c.query(sql(s), v)).rows,
  $executeRaw: async (s: TemplateStringsArray, ...v: unknown[]) =>
    (await c.query(sql(s), v)).affectedRows,
});
const migration = (name: string) =>
  readFileSync(
    new URL(
      `../../../../../packages/database/prisma/migrations/${name}/migration.sql`,
      import.meta.url
    ),
    'utf8'
  );
beforeEach(async () => {
  db = new PGlite();
  await db.exec(
    'CREATE TABLE users(id text PRIMARY KEY,status text); CREATE TABLE wallets(balance integer); INSERT INTO wallets VALUES(7281); CREATE TABLE system_dice_practice_tickets(user_id text,retry_at timestamptz,round_id text,id text,payout integer);'
  );
  await db.exec(migration('20261003150000_system_keno_practice'));
  await db.exec(migration('20261003203000_practice_review_guards'));
  await db.exec(migration('20261003230000_keno_guard_invariant_path'));
  await db.exec(migration('20261104140000_keno_practice_multi_ticket'));
  service = createSystemKenoService({
    ...adapter(db),
    $transaction: (fn: any) => db.transaction((tx) => fn(adapter(tx))),
  } as any);
});
afterEach(async () => {
  expect((await db.query('SELECT balance FROM wallets')).rows).toEqual([{ balance: 7281 }]);
  await db.close();
});
async function fixture(closeIn = 40000) {
  const user = randomUUID(),
    round = randomUUID();
  await db.query("INSERT INTO users VALUES($1,'ACTIVE')", [user]);
  await service.snapshot(user);
  const close = new Date(Date.now() + closeIn);
  await db.query(
    'INSERT INTO system_keno_practice_rounds(id,opens_at,closes_at,ends_at) VALUES($1,$2,$3,$4)',
    [round, new Date(+close - 45000), close, new Date(+close + 15000)]
  );
  return { user, round };
}
it('supports ten independently priced tickets and exposes legacy ticket 1', async () => {
  const { user, round } = await fixture();
  for (let slot = 1; slot <= 10; slot++) await service.enter(user, round, [slot], slot * 5, slot);
  const s = await service.snapshot(user);
  expect(s.maxTickets).toBe(10);
  expect(s.balance).toBe(725);
  expect(s.rounds[0].tickets?.map((t) => t.slot)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  expect(s.rounds[0].ticket?.picks).toEqual([1]);
  await expect(service.enter(user, round, [12], 5, 11)).rejects.toThrow('1 to 10');
});
it('replays the same slot once and rejects changing its payload', async () => {
  const { user, round } = await fixture();
  const results = await Promise.all([
    service.enter(user, round, [3, 1], 10, 2),
    service.enter(user, round, [1, 3], 10, 2),
  ]);
  expect(results.map((r) => r.isReplay)).toEqual([false, true]);
  await expect(service.enter(user, round, [2], 10, 2)).rejects.toThrow('confirmed');
  expect((await service.snapshot(user)).balance).toBe(980);
});
it('keeps omitted slots compatible with old clients', async () => {
  const { user, round } = await fixture();
  await service.enter(user, round, [7], 5);
  expect((await service.enter(user, round, [7], 5, 1)).isReplay).toBe(true);
  expect((await service.snapshot(user)).rounds[0].tickets?.[0].slot).toBe(1);
});
it('prevents overspending across multiple serialized admissions', async () => {
  const { user, round } = await fixture();
  const results = await Promise.allSettled(
    [1, 2, 3].map((slot) => service.enter(user, round, [1], 480, slot))
  );
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
  expect((await service.snapshot(user)).balance).toBe(40);
});
it.each([0, 11, 1.5, NaN])('rejects invalid slot %s', async (slot) => {
  const { user, round } = await fixture();
  await expect(service.enter(user, round, [1], 5, slot)).rejects.toThrow();
  expect((await service.snapshot(user)).balance).toBe(1000);
});
it('rejects duplicate picks, invalid amounts and inactive accounts', async () => {
  const { user, round } = await fixture();
  await expect(service.enter(user, round, [1, 1], 5, 2)).rejects.toThrow();
  await expect(service.enter(user, round, [1], 7, 2)).rejects.toThrow();
  await expect(service.enter(user, round, [1, 2], 480, 2)).rejects.toThrow();
  await db.query("UPDATE users SET status='BANNED' WHERE id=$1", [user]);
  await expect(service.enter(user, round, [1], 5, 2)).rejects.toThrow('active');
});
it('settles each ticket exactly once against the same immutable draw and retains replay after cutoff', async () => {
  const { user, round } = await fixture(700);
  await service.enter(user, round, [1, 2, 80], 10, 1);
  await service.enter(user, round, [3, 79], 5, 2);
  await new Promise((r) => setTimeout(r, 750));
  await db.query('UPDATE system_keno_practice_rounds SET outcome=$1::jsonb WHERE id=$2', [
    JSON.stringify(Array.from({ length: 20 }, (_, i) => i + 1)),
    round,
  ]);
  const errors: unknown[] = [];
  await service.tick((_, e) => errors.push(e));
  await service.tick((_, e) => errors.push(e));
  expect(errors).toEqual([]);
  const s = await service.snapshot(user);
  expect(s.balance).toBe(1050);
  expect(s.rounds.find((r) => r.id === round)?.tickets?.map((t) => t.payout)).toEqual([72, 18]);
  expect((await service.enter(user, round, [1, 2, 80], 10, 1)).isReplay).toBe(true);
  await expect(service.enter(user, round, [4], 5, 3)).rejects.toThrow('closed');
});
it('rejects slot and balance tampering with database guards', async () => {
  const { user, round } = await fixture();
  await service.enter(user, round, [1], 5, 2);
  await expect(
    db.query('UPDATE system_keno_practice_tickets SET slot=3 WHERE round_id=$1', [round])
  ).rejects.toThrow('immutable');
  await expect(
    db.query('UPDATE system_keno_practice_accounts SET balance=balance+1 WHERE user_id=$1', [user])
  ).rejects.toThrow('balance');
});
it('accepts legacy inserts with slot 1 and the same balance proof', async () => {
  // A legacy insert after the additive upgrade still gets the same slot and balance proof.
  const { user, round } = await fixture();
  await db.transaction(async (tx) => {
    await tx.query(
      "INSERT INTO system_keno_practice_tickets(id,round_id,user_id,picks,stake_per_number,stake) VALUES($1,$2,$3,'[8]',5,5)",
      [randomUUID(), round, user]
    );
    await tx.query('UPDATE system_keno_practice_accounts SET balance=balance-5 WHERE user_id=$1', [
      user,
    ]);
  });
  expect((await service.snapshot(user)).rounds[0].ticket?.picks).toEqual([8]);
  expect((await service.snapshot(user)).balance).toBe(995);
});
