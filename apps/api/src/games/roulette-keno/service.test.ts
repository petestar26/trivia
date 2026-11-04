import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, afterAll, expect, it } from 'vitest';
import { rkColor, rkNumbers, rkPayout, rkValidate, RK_MARKETS } from '@socialplay/shared';
import { createRouletteKenoService, drawRouletteKeno } from './service.js';
let db: PGlite, service: ReturnType<typeof createRouletteKenoService>;
const sql = (s: TemplateStringsArray) => s.reduce((q, p, i) => q + (i ? `$${i}` : '') + p, '');
const adapter = (c: any): any => ({
  $queryRaw: async (s: TemplateStringsArray, ...v: unknown[]) => (await c.query(sql(s), v)).rows,
  $executeRaw: async (s: TemplateStringsArray, ...v: unknown[]) =>
    (await c.query(sql(s), v)).affectedRows,
});
beforeAll(async () => {
  db = new PGlite();
  await db.exec(`CREATE TABLE users(id text PRIMARY KEY,status text);
    CREATE TABLE wallets(balance integer); INSERT INTO wallets VALUES(7281);
    CREATE TABLE game_definitions(id text,key text UNIQUE,name text,description text,type text CHECK(type='TURBO_KENO'),mode text,family text,"catalogStatus" text,"isActive" boolean,"minBet" integer,"maxBet" integer,"wagerCurrency" text,"rewardCurrency" text,configuration jsonb,"updatedAt" timestamptz);
    CREATE ROLE salem_practice_worker_20261104 NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT NOBYPASSRLS;
    COMMENT ON ROLE salem_practice_worker_20261104 IS 'salem-practice-activation-20261104';`);
  await db.exec(
    readFileSync(
      new URL(
        '../../../../../packages/database/prisma/migrations/20261104160000_roulette_keno_practice/migration.sql',
        import.meta.url
      ),
      'utf8'
    )
  );
  service = createRouletteKenoService({
    ...adapter(db),
    $transaction: (fn: any) => db.transaction((tx) => fn(adapter(tx))),
  } as any);
});
afterAll(async () => {
  expect((await db.query('SELECT balance FROM wallets')).rows).toEqual([{ balance: 7281 }]);
  await db.close();
});
async function fixture(closeIn = 40000) {
  const user = randomUUID(),
    roundId = randomUUID(),
    close = new Date(Date.now() + closeIn);
  await db.query("INSERT INTO users VALUES($1,'ACTIVE')", [user]);
  await service.snapshot(user);
  await db.query('INSERT INTO rk_rounds(id,opens_at,closes_at,ends_at) VALUES($1,$2,$3,$4)', [
    roundId,
    new Date(+close - 60000),
    close,
    new Date(+close + 30000),
  ]);
  return { user, roundId, close };
}
it('draws 18 unique numbers within 1–72', () => {
  for (let i = 0; i < 100; i++) {
    const d = drawRouletteKeno();
    expect(new Set(d).size).toBe(18);
    expect(d.every((n) => n >= 1 && n <= 72)).toBe(true);
  }
});
it('balances colors independently of parity and prices every outside selection at 90%', () => {
  expect(rkNumbers('COLOR', 1)).toHaveLength(36);
  expect(rkColor(12)).toBe('RED');
  expect(rkColor(2)).toBe('BLACK');
  for (const market of RK_MARKETS.filter((m) => m !== 'NUMBERS')) {
    const max = market === 'ROW' ? 6 : market === 'COLUMN' ? 4 : 2;
    for (let choice = 1; choice <= max; choice++) {
      const total = Array.from({ length: 72 }, (_, i) =>
        rkPayout({ market, picks: [choice], amount: 10 }, [i + 1])
      ).reduce((a, b) => a + b, 0);
      expect(total / 72).toBe(9);
    }
  }
  expect(rkPayout({ market: 'NUMBERS', picks: [1, 2, 72], amount: 5 }, [1, 72])).toBe(36);
  expect(0.25 * 3.6).toBe(0.9);
});
it.each([
  ['NUMBERS', [0], 5],
  ['NUMBERS', [73], 5],
  ['NUMBERS', [1, 1], 5],
  ['NUMBERS', [1, 2], 500],
  ['NUMBERS', [1], 6],
  ['COLOR', [3], 5],
  ['ROW', [7], 5],
  ['COLUMN', [5], 5],
  ['PARITY', [1, 2], 5],
  ['OTHER', [1], 5],
])('rejects invalid market selection %#', (market, picks, amount) =>
  expect(() => rkValidate(market, picks, amount)).toThrow()
);
it('accepts independently priced bets, replays exactly, and rejects changes and overspending', async () => {
  const { user, roundId } = await fixture();
  const entry = { roundId, slot: 1, market: 'NUMBERS' as const, picks: [3, 1], amount: 100 };
  expect((await service.enter(user, entry)).isReplay).toBe(false);
  expect((await service.enter(user, { ...entry, picks: [1, 3] })).isReplay).toBe(true);
  await expect(service.enter(user, { ...entry, picks: [2] })).rejects.toThrow(
    'different confirmed'
  );
  for (let slot = 2; slot <= 10; slot++)
    await service.enter(user, { roundId, slot, market: 'COLOR', picks: [1], amount: 5 });
  const s = await service.snapshot(user),
    r = s.rounds.find((r) => r.id === roundId)!;
  expect(r.tickets).toHaveLength(10);
  expect(s.balance).toBe(755);
  await expect(service.enter(user, { ...entry, slot: 11 })).rejects.toThrow();
  const other = await fixture();
  await service.enter(other.user, { ...entry, roundId: other.roundId, picks: [1], amount: 500 });
  await service.enter(other.user, {
    ...entry,
    roundId: other.roundId,
    slot: 2,
    picks: [1],
    amount: 500,
  });
  await expect(
    service.enter(other.user, { ...entry, roundId: other.roundId, slot: 3, picks: [1], amount: 5 })
  ).rejects.toThrow('Insufficient');
});
it('rejects inactive accounts, unknown rounds and closed admission', async () => {
  const f = await fixture(-1000),
    entry = { roundId: f.roundId, slot: 1, market: 'NUMBERS' as const, picks: [1], amount: 5 };
  await expect(service.enter(f.user, entry)).rejects.toThrow('closed');
  await expect(service.enter(f.user, { ...entry, roundId: 'unknown' })).rejects.toThrow(
    'not found'
  );
  await db.query("UPDATE users SET status='SUSPENDED' WHERE id=$1", [f.user]);
  await expect(service.snapshot(f.user)).rejects.toThrow('active');
});
it('enforces immutable receipts and balance conservation in SQL', async () => {
  const { user, roundId } = await fixture();
  await service.enter(user, { roundId, slot: 1, market: 'ROW', picks: [2], amount: 10 });
  await expect(db.query('UPDATE rk_tickets SET slot=2 WHERE user_id=$1', [user])).rejects.toThrow();
  await expect(
    db.query('UPDATE rk_tickets SET payout=54 WHERE user_id=$1', [user])
  ).rejects.toThrow();
  await expect(db.query('DELETE FROM rk_tickets WHERE user_id=$1', [user])).rejects.toThrow();
  await expect(
    db.query('UPDATE rk_accounts SET balance=2000 WHERE user_id=$1', [user])
  ).rejects.toThrow('receipts');
  await expect(
    db.query('UPDATE rk_rounds SET outcome=$2::jsonb WHERE id=$1', [
      roundId,
      JSON.stringify(Array.from({ length: 18 }, (_, i) => i + 1)),
    ])
  ).rejects.toThrow('early');
  await expect(db.exec('TRUNCATE rk_tickets')).rejects.toThrow('immutable');
});
it('grants the marked worker only the new practice tables and keeps catalog cash-disabled', async () => {
  expect(
    (
      await db.query(
        "SELECT has_table_privilege('salem_practice_worker_20261104','rk_rounds','SELECT,INSERT,UPDATE') AS allowed, has_table_privilege('salem_practice_worker_20261104','wallets','UPDATE') AS money"
      )
    ).rows
  ).toEqual([{ allowed: true, money: false }]);
  expect(
    (await db.query('SELECT key,"isActive","catalogStatus" FROM game_definitions')).rows
  ).toEqual([{ key: 'roulette_keno', isActive: false, catalogStatus: 'COMING_SOON' }]);
});
it('reveals only released balls, then settles all six markets exactly once', async () => {
  const { user, roundId, close } = await fixture(1000);
  const entries = [
    { market: 'NUMBERS' as const, picks: [1, 12, 72] },
    { market: 'COLOR' as const, picks: [1] },
    { market: 'PARITY' as const, picks: [2] },
    { market: 'RANGE' as const, picks: [1] },
    { market: 'ROW' as const, picks: [1] },
    { market: 'COLUMN' as const, picks: [1] },
  ].map((v, i) => ({ ...v, roundId, slot: i + 1, amount: 5 }));
  for (const e of entries) await service.enter(user, e);
  const draw = [12, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 14, 15, 16, 17, 18];
  await new Promise((r) => setTimeout(r, Math.max(0, +close - Date.now() + 40)));
  await expect(
    db.query('UPDATE rk_rounds SET outcome=$2::jsonb WHERE id=$1', [
      roundId,
      JSON.stringify(Array(18).fill(1)),
    ])
  ).rejects.toThrow('Invalid draw');
  await db.query('UPDATE rk_rounds SET outcome=$2::jsonb WHERE id=$1', [
    roundId,
    JSON.stringify(draw),
  ]);
  let s = await service.snapshot(user),
    r = s.rounds.find((r) => r.id === roundId)!;
  expect(r.revealed).toEqual([]);
  expect(r.complete).toBe(false);
  expect(s.balance).toBe(960);
  await service.tick((_, e) => {
    throw e;
  });
  expect((await service.snapshot(user)).balance).toBe(960);
  await new Promise((r) => setTimeout(r, Math.max(0, +close + 1200 - Date.now())));
  r = (await service.snapshot(user)).rounds.find((r) => r.id === roundId)!;
  expect(r.revealed).toEqual([12]);
  expect(r.tickets.every((t) => t.payout === null)).toBe(true);
  await new Promise((r) => setTimeout(r, Math.max(0, +close + 18100 - Date.now())));
  await service.tick((_, e) => {
    throw e;
  });
  s = await service.snapshot(user);
  r = s.rounds.find((r) => r.id === roundId)!;
  const returns = entries.map((e) => rkPayout(e, draw));
  expect(r.complete).toBe(true);
  expect(r.revealed).toEqual(draw);
  expect(r.tickets.map((t) => t.payout)).toEqual(returns);
  expect(s.balance).toBe(960 + returns.reduce((a, b) => a + b, 0));
  await service.tick((_, e) => {
    throw e;
  });
  expect((await service.snapshot(user)).balance).toBe(s.balance);
  expect((await service.enter(user, entries[0])).isReplay).toBe(true);
  await expect(
    db.query('UPDATE rk_rounds SET outcome=$2::jsonb WHERE id=$1', [
      roundId,
      JSON.stringify([...draw].reverse()),
    ])
  ).rejects.toThrow('immutable');
});
