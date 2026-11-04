import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, afterAll, expect, it } from 'vitest';
import {
  lsColor,
  lsColorNumbers,
  lsCompletion,
  lsPayout,
  lsValidate,
  LS_SIX_TENTHS,
  LS_MARKETS,
  type LuckySixEntry,
} from '@socialplay/shared';
import { createLuckySixService, drawLuckySix } from './service.js';
let db: PGlite, service: ReturnType<typeof createLuckySixService>;
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
        '../../../../../packages/database/prisma/migrations/20261105140000_lucky_six_practice/migration.sql',
        import.meta.url
      ),
      'utf8'
    )
  );
  service = createLuckySixService({
    ...adapter(db),
    $transaction: (fn: any) => db.transaction((tx) => fn(adapter(tx))),
  } as any);
});
afterAll(async () => {
  expect((await db.query('SELECT balance FROM wallets')).rows).toEqual([{ balance: 7281 }]);
  await db.close();
});
async function user() {
  const id = randomUUID();
  await db.query("INSERT INTO users VALUES($1,'ACTIVE')", [id]);
  await service.snapshot(id);
  return id;
}
async function fixture(closeIn = 40000) {
  const id = await user(),
    roundId = randomUUID(),
    close = new Date(Date.now() + closeIn);
  await db.query('INSERT INTO ls_rounds(id,opens_at,closes_at,ends_at) VALUES($1,$2,$3,$4)', [
    roundId,
    new Date(+close - 210000),
    close,
    new Date(+close + 90000),
  ]);
  return { user: id, roundId, close };
}
it('draws 35 unique valid balls and maintains eight disjoint six-ball colors', () => {
  for (let i = 0; i < 100; i++) {
    const d = drawLuckySix();
    expect(new Set(d).size).toBe(35);
    expect(d.every((n) => n >= 1 && n <= 48)).toBe(true);
  }
  const groups = Array.from({ length: 8 }, (_, i) => lsColorNumbers(i));
  expect(new Set(groups.flat()).size).toBe(48);
  groups.forEach((g, i) => {
    expect(g).toHaveLength(6);
    expect(g.every((n) => lsColor(n) === i)).toBe(true);
  });
});
it('requires all six, pays the sixth match position, and publishes a descending gross table', () => {
  const draw = Array.from({ length: 35 }, (_, i) => i + 1);
  expect(lsCompletion([1, 2, 3, 4, 5, 36], draw)).toBeNull();
  expect(lsPayout({ market: 'SIX', picks: [1, 2, 3, 4, 5, 36], amount: 5 }, draw)).toBe(0);
  expect(lsPayout({ market: 'SIX', picks: [1, 2, 3, 4, 5, 6], amount: 5 }, draw)).toBe(75000);
  expect(lsPayout({ market: 'SIX', picks: [1, 2, 3, 4, 5, 35], amount: 5 }, draw)).toBe(9);
  expect(() =>
    lsPayout({ market: 'FIRST_COLOR', picks: [1], amount: 5 }, draw.slice(0, 5))
  ).toThrow('complete');
  expect(() =>
    lsPayout({ market: 'SIX', picks: [1, 2, 3, 4, 5, 6], amount: 5 }, Array(35).fill(1))
  ).toThrow('complete');
  const choose = (n: number, k: number) => {
    let x = 1;
    for (let i = 1; i <= k; i++) x = (x * (n - i + 1)) / i;
    return x;
  };
  expect(
    LS_SIX_TENTHS.reduce((total, m, i) => total + ((choose(i + 5, 5) / choose(48, 6)) * m) / 10, 0)
  ).toBeCloseTo(0.9217694771, 9);
  expect(LS_SIX_TENTHS.every((v, i) => i === 0 || v <= LS_SIX_TENTHS[i - 1])).toBe(true);
});
it('prices an all-colors bundle once per line and refunds all most-color bets on a tie', () => {
  expect(lsValidate('ALL_COLORS', [1], 5).stake).toBe(40);
  expect(lsValidate('ALL_COLORS', [1], 60).stake).toBe(480);
  const tie = Array.from({ length: 35 }, (_, i) => i + 1);
  for (let c = 1; c <= 8; c++)
    expect(lsPayout({ market: 'MOST_COLOR', picks: [c], amount: 5 }, tie)).toBe(5);
});
it.each([
  ['SIX', [1, 2, 3, 4, 5], 5],
  ['SIX', [1, 2, 3, 4, 5, 5], 5],
  ['SIX', [1, 2, 3, 4, 5, 49], 5],
  ['SIX', [1, 2, 3, 4, 5, 6, 7], 5],
  ['PRE_NUMBER', [0], 5],
  ['PRE_NUMBER', [1, 2], 5],
  ['FIRST_COLOR', [9], 5],
  ['FIRST_RANGE', [3], 5],
  ['ALL_COLORS', [2], 5],
  ['ALL_COLORS', [1], 65],
  ['SIX', [1, 2, 3, 4, 5, 6], 6],
  ['MOST_COLOR', [1], 505],
  ['JACKPOT', [1], 5],
])('rejects invalid selections or amounts %#', (m, p, a) =>
  expect(() => lsValidate(m, p, a)).toThrow()
);
it('keeps ten independent immutable receipts, retries exactly, and rejects overspending', async () => {
  const f = await fixture(),
    entry = {
      roundId: f.roundId,
      slot: 1,
      market: 'SIX' as const,
      picks: [6, 5, 4, 3, 2, 1],
      amount: 100,
    };
  const retries = await Promise.all([
    service.enter(f.user, entry),
    service.enter(f.user, { ...entry, picks: [1, 2, 3, 4, 5, 6] }),
  ]);
  expect(retries.filter((r) => !r.isReplay)).toHaveLength(1);
  await expect(service.enter(f.user, { ...entry, picks: [2, 3, 4, 5, 6, 7] })).rejects.toThrow(
    'different confirmed'
  );
  for (let slot = 2; slot <= 10; slot++)
    await service.enter(f.user, { ...entry, slot, market: 'FIRST_COLOR', picks: [1], amount: 5 });
  expect((await service.snapshot(f.user)).balance).toBe(855);
  await expect(service.enter(f.user, { ...entry, slot: 11 })).rejects.toThrow();
  const other = await fixture();
  const outcomes = await Promise.allSettled(
    [1, 2, 3, 4].map((slot) =>
      service.enter(other.user, { ...entry, roundId: other.roundId, slot, amount: 300 })
    )
  );
  expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(3);
  expect((await service.snapshot(other.user)).balance).toBe(100);
});
it('rejects closed and inactive admission and direct SQL tampering', async () => {
  const f = await fixture(),
    entry = { roundId: f.roundId, slot: 1, market: 'FIRST_COLOR' as const, picks: [2], amount: 10 };
  await service.enter(f.user, entry);
  for (const q of [
    'UPDATE ls_tickets SET slot=2 WHERE user_id=$1',
    'UPDATE ls_tickets SET payout=72 WHERE user_id=$1',
    'DELETE FROM ls_tickets WHERE user_id=$1',
    'UPDATE ls_accounts SET balance=2000 WHERE user_id=$1',
  ])
    await expect(db.query(q, [f.user])).rejects.toThrow();
  await expect(db.exec('TRUNCATE ls_tickets')).rejects.toThrow('immutable');
  await expect(
    db.query('UPDATE ls_rounds SET outcome=$2::jsonb WHERE id=$1', [
      f.roundId,
      JSON.stringify(Array.from({ length: 35 }, (_, i) => i + 1)),
    ])
  ).rejects.toThrow('early');
  const closed = await fixture(-1000);
  await expect(service.enter(closed.user, { ...entry, roundId: closed.roundId })).rejects.toThrow(
    'closed'
  );
  await db.query("UPDATE users SET status='SUSPENDED' WHERE id=$1", [f.user]);
  await expect(service.snapshot(f.user)).rejects.toThrow('active');
});
it('grants only the new practice tables and keeps cash admission disabled', async () => {
  expect(
    (
      await db.query(
        "SELECT has_table_privilege('salem_practice_worker_20261104','ls_rounds','SELECT,INSERT,UPDATE') AS allowed, has_table_privilege('salem_practice_worker_20261104','wallets','UPDATE') AS money"
      )
    ).rows
  ).toEqual([{ allowed: true, money: false }]);
  expect(
    (await db.query('SELECT key,"isActive","catalogStatus" FROM game_definitions')).rows
  ).toEqual([{ key: 'lucky_six', isActive: false, catalogStatus: 'COMING_SOON' }]);
});
it('releases on time and settles every market, all six-completion positions, and both most-color outcomes exactly once', async () => {
  const f = await fixture(8000),
    second = await fixture(+f.close - Date.now());
  const draws = [
    Array.from({ length: 35 }, (_, i) => i + 1),
    [
      ...lsColorNumbers(0),
      ...Array.from({ length: 48 }, (_, i) => i + 1)
        .filter((n) => lsColor(n) !== 0)
        .slice(0, 29),
    ],
  ];
  const entries: { user: string; entry: LuckySixEntry; draw: number[] }[] = [];
  const choices: { market: LuckySixEntry['market']; picks: number[] }[] = [];
  for (let k = 6; k <= 35; k++) choices.push({ market: 'SIX', picks: [1, 2, 3, 4, 5, k] });
  for (const market of LS_MARKETS.filter((m) => m !== 'SIX')) {
    const max =
      market === 'PRE_NUMBER' ? 48 : market.endsWith('COLOR') ? 8 : market === 'ALL_COLORS' ? 1 : 2;
    for (let c = 1; c <= max; c++) choices.push({ market, picks: [c] });
  }
  let owner = f.user;
  for (let i = 0; i < choices.length; i++) {
    if (i > 0 && i % 10 === 0) owner = await user();
    const entry = { ...choices[i], roundId: f.roundId, slot: (i % 10) + 1, amount: 5 };
    await service.enter(owner, entry);
    entries.push({ user: owner, entry, draw: draws[0] });
  }
  for (let c = 1; c <= 8; c++) {
    const entry: LuckySixEntry = {
      roundId: second.roundId,
      slot: c,
      market: 'MOST_COLOR',
      picks: [c],
      amount: 5,
    };
    await service.enter(second.user, entry);
    entries.push({ user: second.user, entry, draw: draws[1] });
  }
  const bundle: LuckySixEntry = {
    roundId: second.roundId,
    slot: 9,
    market: 'ALL_COLORS',
    picks: [1],
    amount: 5,
  };
  await service.enter(second.user, bundle);
  entries.push({ user: second.user, entry: bundle, draw: draws[1] });
  await new Promise((r) => setTimeout(r, Math.max(0, +f.close - Date.now() + 50)));
  await expect(
    db.query('UPDATE ls_rounds SET outcome=$2::jsonb WHERE id=$1', [
      f.roundId,
      JSON.stringify(Array(35).fill(1)),
    ])
  ).rejects.toThrow('Invalid draw');
  for (const [i, fx] of [f, second].entries())
    await db.query('UPDATE ls_rounds SET outcome=$2::jsonb WHERE id=$1', [
      fx.roundId,
      JSON.stringify(draws[i]),
    ]);
  let snap = await service.snapshot(f.user),
    r = snap.rounds.find((r) => r.id === f.roundId)!;
  expect(r.revealed).toEqual([]);
  expect(r.complete).toBe(false);
  await service.tick((_, e) => {
    throw e;
  });
  expect((await service.snapshot(f.user)).balance).toBe(950);
  await new Promise((r) => setTimeout(r, Math.max(0, +f.close + 2150 - Date.now())));
  r = (await service.snapshot(f.user)).rounds.find((r) => r.id === f.roundId)!;
  expect(r.revealed).toEqual([1]);
  expect(r.tickets.every((t) => t.payout === null)).toBe(true);
  await expect(
    db.query('UPDATE ls_tickets SET payout=75000 WHERE round_id=$1 AND slot=1', [f.roundId])
  ).rejects.toThrow('incomplete');
  // This real clock wait exceeds a tool yield; the test process runs in the background.
  await new Promise((r) => setTimeout(r, Math.max(0, +f.close + 70100 - Date.now())));
  await service.tick((_, e) => {
    throw e;
  });
  const byUser = new Map<string, number>();
  for (const { user, entry, draw } of entries) {
    const payout = lsPayout(entry, draw),
      cost = entry.amount * (entry.market === 'ALL_COLORS' ? 8 : 1);
    const row = (
      await db.query<{ payout: number }>(
        'SELECT payout FROM ls_tickets WHERE round_id=$1 AND user_id=$2 AND slot=$3',
        [entry.roundId, user, entry.slot]
      )
    ).rows[0];
    expect(row.payout).toBe(payout);
    byUser.set(user, (byUser.get(user) ?? 1000) - cost + payout);
  }
  for (const [user, balance] of byUser)
    expect((await service.snapshot(user)).balance).toBe(balance);
  const before = (await service.snapshot(f.user)).balance;
  await service.tick((_, e) => {
    throw e;
  });
  expect((await service.snapshot(f.user)).balance).toBe(before);
  expect((await service.enter(f.user, entries[0].entry)).isReplay).toBe(true);
  await expect(
    db.query('UPDATE ls_rounds SET outcome=$2::jsonb WHERE id=$1', [
      f.roundId,
      JSON.stringify([...draws[0]].reverse()),
    ])
  ).rejects.toThrow('immutable');
});
