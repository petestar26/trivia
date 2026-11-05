import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, afterAll, expect, it } from 'vitest';
import {
  bjTotal,
  bjCategory,
  bjResult,
  bjValidate,
  bjWon,
  bjKey,
  type BlackjackEntry,
} from '@socialplay/shared';
import { advanceHands, priceHands } from './engine.js';
import { createBlackjackService } from './service.js';
let db: PGlite,
  service: ReturnType<typeof createBlackjackService>,
  base = Date.UTC(2026, 10, 6);
// Execute the migration and service SQL with only the clock injected. No tables,
// rules, guards, grants or payout expressions are replaced by fixture logic.
const clockSQL = (s: string) => s.replaceAll('clock_timestamp()', 'public.bj_fixture_clock()');
const sql = (s: TemplateStringsArray) =>
  clockSQL(s.reduce((q, p, i) => q + (i ? `$${i}` : '') + p, ''));
const adapter = (c: any): any => ({
  $queryRaw: async (s: TemplateStringsArray, ...v: unknown[]) => (await c.query(sql(s), v)).rows,
  $executeRaw: async (s: TemplateStringsArray, ...v: unknown[]) =>
    (await c.query(sql(s), v)).affectedRows,
});
beforeAll(async () => {
  db = new PGlite();
  await db.exec(
    `CREATE TABLE fixture_clock(t timestamptz); INSERT INTO fixture_clock VALUES('2026-11-06T00:00:00Z'); CREATE FUNCTION bj_fixture_clock() RETURNS timestamptz LANGUAGE sql AS 'SELECT t FROM public.fixture_clock'; CREATE TABLE users(id text PRIMARY KEY,status text); CREATE TABLE wallets(balance integer); INSERT INTO wallets VALUES(7281); CREATE TABLE game_definitions(id text,key text UNIQUE,name text,description text,type text CHECK(type='TURBO_KENO'),mode text,family text,"catalogStatus" text,"isActive" boolean,"minBet" integer,"maxBet" integer,"wagerCurrency" text,"rewardCurrency" text,configuration jsonb,"updatedAt" timestamptz); CREATE ROLE salem_practice_worker_20261104 NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT NOBYPASSRLS; COMMENT ON ROLE salem_practice_worker_20261104 IS 'salem-practice-activation-20261104';`
  );
  await db.exec(
    clockSQL(
      readFileSync(
        new URL(
          '../../../../../packages/database/prisma/migrations/20261105180000_blackjack_practice/migration.sql',
          import.meta.url
        ),
        'utf8'
      )
    )
  );
  service = createBlackjackService({
    ...adapter(db),
    $transaction: (fn: any) => db.transaction((tx) => fn(adapter(tx))),
  } as any);
});
afterAll(async () => {
  expect((await db.query('SELECT balance FROM wallets')).rows).toEqual([{ balance: 7281 }]);
  await db.close();
});
const time = async (t: number) => {
  await db.query('UPDATE fixture_clock SET t=$1', [new Date(t)]);
};
async function user() {
  const id = randomUUID();
  await db.query("INSERT INTO users VALUES($1,'ACTIVE')", [id]);
  await service.snapshot(id);
  return id;
}
async function fixture() {
  base += 160000;
  await time(base + 1);
  const owner = await user(),
    roundId = `bj-${base / 160000}`;
  const hands = [[0], [1], [2], [3], [4], [5], [6]],
    quotes = {
      '1:WIN': 185,
      '1:LOSE': 220,
      '1:DRAW': 910,
      '1:P17': 1100,
      '2:WIN': 172,
      '2:LOSE': 205,
    };
  await db.query('INSERT INTO bj_rounds(id,opens_at,stage,hands,quotes) VALUES($1,$2,0,$3,$4)', [
    roundId,
    new Date(base),
    JSON.stringify(hands),
    JSON.stringify(quotes),
  ]);
  return {
    owner,
    roundId,
    opens: base,
    hands,
    entry: {
      roundId,
      slot: 1,
      stage: 0,
      seat: 1,
      market: 'WIN',
      amount: 10,
      odds: 185,
    } as BlackjackEntry,
  };
}
async function advance(f: Awaited<ReturnType<typeof fixture>>, stage: number) {
  let r = (await db.query<any>('SELECT * FROM bj_rounds WHERE id=$1', [f.roundId])).rows[0];
  await time(f.opens + stage * 40000);
  const hands = advanceHands(r.hands, stage),
    quotes = stage === 3 ? {} : priceHands(hands, stage, 500);
  await db.query('UPDATE bj_rounds SET stage=$2,hands=$3,quotes=$4 WHERE id=$1', [
    f.roundId,
    stage,
    JSON.stringify(hands),
    JSON.stringify(quotes),
  ]);
  return hands;
}
it('scores soft aces, naturals, multi-card 21 and bust precedence', () => {
  expect(bjTotal([0, 13, 8])).toMatchObject({ total: 21, soft: true, blackjack: false });
  expect(bjTotal([0, 9])).toMatchObject({ total: 21, blackjack: true });
  expect(bjTotal([0, 13, 9])).toMatchObject({ total: 12, soft: false });
  expect(bjCategory([0, 9])).toBe('BLACKJACK');
  expect(bjCategory([5, 6, 7])).toBe('P21');
  expect(bjResult([0, 9], [5, 6, 7])).toBe('WIN');
  expect(bjResult([5, 6, 7], [0, 9])).toBe('LOSE');
  expect(bjResult([9, 10, 11], [22, 23, 24])).toBe('LOSE');
  expect(bjResult([0, 9], [13, 22])).toBe('DRAW');
  expect(() => bjCategory([0])).toThrow('complete');
});
it('deals a valid six-deck shoe with immutable prefixes and no hits on soft 17', () => {
  for (let i = 0; i < 100; i++) {
    let h = Array.from({ length: 7 }, () => [] as number[]);
    for (let stage = 0; stage <= 3; stage++) {
      const next = advanceHands(h, stage);
      expect(new Set(next.flat()).size).toBe(next.flat().length);
      for (let s = 0; s < 7; s++) {
        expect(next[s].slice(0, h[s].length)).toEqual(h[s]);
        if (stage >= 2 && bjTotal(h[s]).total >= 17) expect(next[s]).toEqual(h[s]);
      }
      h = next;
    }
    expect(h.every((x) => bjTotal(x).total >= 17)).toBe(true);
  }
  const h = [[0, 5], ...[1, 2, 3, 4, 6, 7].map((x) => [x, 13 + x])];
  expect(advanceHands(h, 2)[0]).toEqual([0, 5]);
});
it('produces prices from visible cards only and closes already decided markets', () => {
  const h = [
    [0, 9],
    [1, 8],
    [2, 7],
    [3, 6],
    [4, 5],
    [13, 22],
    [14, 21],
  ];
  const quotes = priceHands(h, 1, 500);
  expect(quotes['0:BLACKJACK']).toBeUndefined();
  expect(quotes['5:BLACKJACK']).toBeUndefined();
  expect(quotes['5:DRAW']).toBeUndefined();
  expect(Object.values(quotes).every((n) => Number.isInteger(n) && n >= 101 && n <= 20000)).toBe(
    true
  );
  const start = performance.now();
  const real = priceHands([[0], [1], [2], [3], [4], [5], [6]], 0);
  expect(Object.keys(real).length).toBeGreaterThan(30);
  expect(performance.now() - start).toBeLessThan(8000);
});
it.each([
  { slot: 0 },
  { slot: 11 },
  { stage: 3 },
  { seat: 7 },
  { seat: 0, market: 'WIN' },
  { market: 'JACKPOT' },
  { amount: 7 },
  { amount: 501 },
  { odds: 100 },
  { odds: 20001 },
  { roundId: '' },
])('rejects invalid input %#', (patch) =>
  expect(() =>
    bjValidate({
      roundId: 'r',
      slot: 1,
      stage: 0,
      seat: 1,
      market: 'WIN',
      amount: 10,
      odds: 185,
      ...patch,
    } as BlackjackEntry)
  ).toThrow()
);
it('keeps ten independent tickets and retries exactly without charging twice', async () => {
  const f = await fixture();
  const res = await Promise.all([service.enter(f.owner, f.entry), service.enter(f.owner, f.entry)]);
  expect(res.filter((x) => x.isReplay)).toHaveLength(1);
  for (let slot = 2; slot <= 10; slot++)
    await service.enter(f.owner, { ...f.entry, slot, amount: 5 });
  const snap = await service.snapshot(f.owner);
  expect(snap.balance).toBe(945);
  expect(snap.rounds.find((r) => r.id === f.roundId)?.tickets).toHaveLength(10);
  await expect(service.enter(f.owner, { ...f.entry, seat: 2, odds: 172 })).rejects.toThrow(
    'different confirmed'
  );
  for (const patch of [{ odds: 186 }, { stage: 1 }, { market: 'BUST' as const }])
    await expect(service.enter(f.owner, { ...f.entry, slot: 10, ...patch })).rejects.toThrow();
});
it('serializes overspending, hides other players receipts and rejects inactive accounts', async () => {
  const f = await fixture();
  const res = await Promise.allSettled(
    [1, 2, 3].map((slot) => service.enter(f.owner, { ...f.entry, slot, amount: 500 }))
  );
  expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
  expect((await service.snapshot(f.owner)).balance).toBe(0);
  const other = await user();
  expect((await service.snapshot(other)).rounds.find((r) => r.id === f.roundId)?.tickets).toEqual(
    []
  );
  await db.query("UPDATE users SET status='SUSPENDED' WHERE id=$1", [f.owner]);
  await expect(service.snapshot(f.owner)).rejects.toThrow('active');
});
it('rejects stale stages and tampered quotes, but resolves an exact retry after cutoff', async () => {
  const f = await fixture();
  await expect(service.enter(f.owner, { ...f.entry, odds: 999 })).rejects.toThrow('price');
  await service.enter(f.owner, f.entry);
  await time(f.opens + 40000);
  await expect(service.enter(f.owner, { ...f.entry, slot: 2 })).rejects.toThrow('closed');
  expect((await service.enter(f.owner, f.entry)).isReplay).toBe(true);
  expect((await service.snapshot(f.owner)).rounds.find((r) => r.id === f.roundId)?.hands).toEqual(
    f.hands
  );
});
it('enforces immutable cards, safe dealing, ticket prices and ledger reconciliation in SQL', async () => {
  const f = await fixture();
  await service.enter(f.owner, f.entry);
  for (const q of [
    'UPDATE bj_tickets SET odds=999 WHERE user_id=$1',
    'UPDATE bj_tickets SET payout_cents=1 WHERE user_id=$1',
    'DELETE FROM bj_tickets WHERE user_id=$1',
    'UPDATE bj_accounts SET balance_cents=200000 WHERE user_id=$1',
  ])
    await expect(db.query(q, [f.owner])).rejects.toThrow();
  await expect(db.exec('TRUNCATE bj_tickets')).rejects.toThrow('immutable');
  await expect(
    db.query('UPDATE bj_rounds SET stage=1,hands=$2 WHERE id=$1', [
      f.roundId,
      JSON.stringify(advanceHands(f.hands, 1)),
    ])
  ).rejects.toThrow('early');
  await time(f.opens + 40000);
  await expect(
    db.query('UPDATE bj_rounds SET stage=1,hands=$2 WHERE id=$1', [
      f.roundId,
      JSON.stringify(f.hands.map((h, i) => [h[0], i === 1 ? 0 : 52 + i])),
    ])
  ).rejects.toThrow('shoe');
  await expect(
    db.query('UPDATE bj_rounds SET stage=1,hands=$2 WHERE id=$1', [
      f.roundId,
      JSON.stringify(f.hands.map((h, i) => [h[0] + 52, 104 + i])),
    ])
  ).rejects.toThrow('change');
});
it('stores visible cards only, runs all stages, settles locked prices once, and keeps old receipts', async () => {
  const f = await fixture();
  await service.enter(f.owner, f.entry);
  await service.enter(f.owner, { ...f.entry, slot: 2, market: 'LOSE', odds: 220, amount: 25 });
  await service.enter(f.owner, { ...f.entry, slot: 3, market: 'DRAW', odds: 910, amount: 15 });
  expect(
    (await service.snapshot(f.owner)).rounds
      .find((r) => r.id === f.roundId)
      ?.hands.every((h) => h.length === 1)
  ).toBe(true);
  for (let stage = 1; stage <= 3; stage++) {
    await time(f.opens + stage * 40000 + 1);
    await service.tick((_, e) => {
      throw e;
    });
    const r = (await service.snapshot(f.owner)).rounds.find((r) => r.id === f.roundId)!;
    expect(r.stage).toBe(stage);
    if (stage < 3) {
      expect(r.tickets.every((t) => t.payout === null)).toBe(true);
      expect(r.hands.every((h) => h.length <= stage + 1)).toBe(true);
    }
  }
  const snap = await service.snapshot(f.owner),
    r = snap.rounds.find((r) => r.id === f.roundId)!;
  expect(Object.keys(r.quotes)).toHaveLength(0);
  const total = r.tickets.reduce((sum, t) => {
    expect(t.payout).toBe(bjWon(t.seat, t.market, r.hands) ? (t.amount * t.odds) / 100 : 0);
    return sum + t.payout!;
  }, 0);
  expect(snap.balance).toBe(950 + total);
  await time(f.opens + 150000);
  await service.tick((_, e) => {
    throw e;
  });
  expect((await service.snapshot(f.owner)).balance).toBe(snap.balance);
  expect((await service.enter(f.owner, f.entry)).isReplay).toBe(true);
});
it('checks every market against independent SQL settlement, including natural 21 and bust-bust', async () => {
  const f = await fixture();
  // Complete legal hands: dealer natural, seat 1 natural, seat 2 normal 21,
  // seat 3 standing 20, seat 4 bust, seat 5 17, seat 6 18.
  const initial = [[0], [13], [5], [22], [35], [6], [7]],
    second = [
      [0, 9],
      [13, 10],
      [5, 19],
      [22, 23],
      [35, 14],
      [6, 48],
      [7, 49],
    ],
    third = second.map((h) => [...h]);
  third[2].push(20);
  third[4].push(24);
  // Allocate a separate round and explicitly priced fixture markets.
  const id = randomUUID(),
    q: Record<string, number> = {};
  for (let seat = 0; seat < 7; seat++)
    for (const m of [
      'WIN',
      'DRAW',
      'LOSE',
      'P17',
      'P18',
      'P19',
      'P20',
      'P21',
      'BLACKJACK',
      'BUST',
    ] as const)
      if (seat || !['WIN', 'DRAW', 'LOSE'].includes(m)) q[bjKey(seat, m)] = 350;
  await db.query('INSERT INTO bj_rounds(id,opens_at,stage,hands,quotes) VALUES($1,$2,0,$3,$4)', [
    id,
    new Date(f.opens + 1),
    JSON.stringify(initial),
    JSON.stringify(q),
  ]);
  await time(f.opens + 2);
  for (let seat = 0; seat < 7; seat++) {
    const owner = await user();
    let slot = 0;
    for (const m of [
      'WIN',
      'DRAW',
      'LOSE',
      'P17',
      'P18',
      'P19',
      'P20',
      'P21',
      'BLACKJACK',
      'BUST',
    ] as const) {
      if (!seat && ['WIN', 'DRAW', 'LOSE'].includes(m)) continue;
      await service.enter(owner, {
        roundId: id,
        slot: ++slot,
        stage: 0,
        seat,
        market: m,
        amount: 5,
        odds: 350,
      });
    }
  }
  for (const [stage, h] of [
    [1, second],
    [2, third],
    [3, third],
  ] as const) {
    await time(f.opens + 1 + stage * 40000);
    await db.query('UPDATE bj_rounds SET stage=$2,hands=$3,quotes=$4 WHERE id=$1', [
      id,
      stage,
      JSON.stringify(h),
      JSON.stringify(stage === 3 ? {} : q),
    ]);
  }
  await service.tick((_, e) => {
    throw e;
  });
  const tickets = (await db.query<any>('SELECT * FROM bj_tickets WHERE round_id=$1', [id])).rows;
  expect(tickets).toHaveLength(67);
  for (const t of tickets) expect(t.payout_cents).toBe(bjWon(t.seat, t.market, third) ? 1750 : 0);
});
it('grants only practice data and helper functions to the existing worker', async () => {
  expect(
    (
      await db.query(
        "SELECT has_table_privilege('salem_practice_worker_20261104','bj_rounds','SELECT,INSERT,UPDATE') AS allowed, has_table_privilege('salem_practice_worker_20261104','wallets','UPDATE') AS money, has_function_privilege('salem_practice_worker_20261104','bj_total(jsonb)','EXECUTE') AS helpers"
      )
    ).rows
  ).toEqual([{ allowed: true, money: false, helpers: true }]);
  expect((await db.query('SELECT key,"isActive" FROM game_definitions')).rows).toEqual([
    { key: 'blackjack', isActive: false },
  ]);
});
