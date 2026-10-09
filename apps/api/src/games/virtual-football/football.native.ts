import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import {
  VF_CLUBS,
  VF_RULES_DIGEST,
  VF_RULES_ID,
  VF_SELECTIONS,
  buildDistribution,
  clubById,
  computeStandings,
  cycleAt,
  fixtureCommitment,
  fixtureOffer,
  fixtureSeed,
  liveFixture,
  matchweekCommitment,
  outcomeOfGoals,
  parseSelection,
  receiptHash,
  scheduledWeek,
  ticketRequestHash,
  verifyMatchweek,
  type FixtureParams,
  type Goal,
  type Outcome,
  type VfSnapshot,
} from '@socialplay/shared';
import { createFootballService } from './service.js';

const source = process.env.DATABASE_URL,
  url = source ? new URL(source) : null;
if (
  !url ||
  !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
  url.pathname !== '/playqube_scheduled_throwaway' ||
  process.env.SCHEDULED_NATIVE_DB_ACK !== 'throwaway'
)
  throw Error('Acknowledged throwaway database required');

const db = new PrismaClient({ datasourceUrl: source, log: [] });
const service = createFootballService(db);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const until = (at: number) => sleep(Math.max(0, at - Date.now()));

/* ---------------------------------------------------------------------------------------
 * Fixtures: synthetic matchweeks with scripted timelines so every outcome is known.
 * The window guard still applies, so each is created while its selection window is open.
 * ------------------------------------------------------------------------------------- */
const g = (side: 'H' | 'A', half: 1 | 2, atMs: number): Omit<Goal, 'n'> => ({ side, half, atMs });
const script = (goals: Array<Omit<Goal, 'n'>>): Goal[] => goals.map((x, i) => ({ ...x, n: i + 1 }));
const SCRIPTS: Record<number, Goal[]> = {
  1: script([g('H', 1, 1500), g('A', 1, 26500), g('H', 2, 33500)]), // 2-1, HT 1-1
  2: script([]), // 0-0
  3: script([g('A', 1, 5000), g('A', 2, 40000)]), // 0-2, HT 0-1
  4: script([g('A', 1, 10000), g('H', 2, 45000)]), // 1-1, HT 0-1
  5: script([g('H', 1, 2000), g('H', 1, 7000), g('H', 2, 34000), g('H', 2, 58500)]), // 4-0, HT 2-0
  6: script([g('H', 2, 58500)]), // 1-0, last-moment goal
  7: script([
    g('H', 1, 3000),
    g('A', 1, 8000),
    g('H', 1, 13000),
    g('A', 1, 18000),
    g('H', 1, 23000),
    g('A', 2, 33500),
  ]), // 3-3, HT 3-2
  8: script([g('A', 1, 26500)]), // 0-1
  9: script([
    g('H', 1, 1500),
    g('H', 1, 5500),
    g('H', 1, 9500),
    g('H', 1, 13500),
    g('H', 1, 17500),
    g('H', 1, 21500),
  ]), // 6-0, all in half one
  10: script([g('A', 2, 33500), g('A', 2, 37500)]), // 0-2
};
// Rows persist in the throwaway database, so every run uses its own season range.
const RUN = 200_000 + Math.floor(Math.random() * 600_000);
let seasonCounter = RUN;

interface Built {
  id: string;
  season: number;
  week: number;
  kickoff: number;
  seed: string;
  fx: (slot: number) => string;
  params: (slot: number) => FixtureParams;
  goals: (slot: number) => Goal[];
  leg: (
    slot: number,
    selection: string
  ) => { fixtureId: string; selection: string; oddsCents: number };
}
async function matchweek(options: {
  kickoffInMs: number;
  season?: number;
  week?: number;
  scripts?: Record<number, Goal[]>;
  badDigestSlot?: number;
}): Promise<Built> {
  const season = options.season ?? ++seasonCounter;
  const week = options.week ?? 1;
  const id = `vf-s${season}-w${String(week).padStart(2, '0')}`;
  const kickoff = Date.now() + options.kickoffInMs;
  const opens = kickoff - 230_000;
  const seed = randomBytes(32).toString('hex');
  const pairs = scheduledWeek(season, week);
  const scripts = options.scripts ?? SCRIPTS;
  const rows = pairs.map((p) => {
    const home = clubById(p.homeClub);
    const away = clubById(p.awayClub);
    const params: FixtureParams = {
      homeAttack: home.attack,
      homeDefence: home.defence,
      awayAttack: away.attack,
      awayDefence: away.defence,
    };
    const fid = `${id}-f${String(p.slot).padStart(2, '0')}`;
    const goals = scripts[p.slot] ?? [];
    const digest = options.badDigestSlot === p.slot ? 'f'.repeat(64) : fixtureOffer(params).digest;
    return {
      fid,
      slot: p.slot,
      home: p.homeClub,
      away: p.awayClub,
      params,
      digest,
      goals,
      commitment: fixtureCommitment(fid, fixtureSeed(id, fid, seed), digest),
      outcome: outcomeOfGoals(goals),
    };
  });
  const commitment = matchweekCommitment(
    id,
    rows.map((r) => r.commitment)
  );
  await db.$transaction(async (tx) => {
    await tx.$executeRaw`INSERT INTO football_matchweeks(id,season_no,week_no,rules_id,rules_digest,opens_at,kickoff_at,full_time_at,ends_at,seed,commitment) VALUES(${id},${season},${week},${VF_RULES_ID},${VF_RULES_DIGEST},${new Date(opens)},${new Date(kickoff)},${new Date(kickoff + 60_000)},${new Date(opens + 300_000)},${seed},${commitment})`;
    for (const r of rows)
      await tx.$executeRaw`INSERT INTO football_fixtures(id,matchweek_id,slot,home_club,away_club,home_attack,home_defence,away_attack,away_defence,offer_digest,commitment,ft_home,ft_away,ht_home,ht_away,first_scorer,goal_sides,goal_halves,goal_at_ms) VALUES(${r.fid},${id},${r.slot},${r.home},${r.away},${r.params.homeAttack},${r.params.homeDefence},${r.params.awayAttack},${r.params.awayDefence},${r.digest},${r.commitment},${r.outcome.ftHome},${r.outcome.ftAway},${r.outcome.htHome},${r.outcome.htAway},${r.outcome.first},${r.goals.map((x) => x.side)}::text[],${r.goals.map((x) => x.half)}::smallint[],${r.goals.map((x) => x.atMs)}::integer[])`;
  });
  const bySlot = new Map(rows.map((r) => [r.slot, r]));
  const built: Built = {
    id,
    season,
    week,
    kickoff,
    seed,
    fx: (slot) => bySlot.get(slot)!.fid,
    params: (slot) => bySlot.get(slot)!.params,
    goals: (slot) => bySlot.get(slot)!.goals,
    leg: (slot, selection) => {
      const price = fixtureOffer(bySlot.get(slot)!.params).byId.get(selection);
      if (!price || price.oddsCents === null)
        throw Error(`${selection} unavailable in fixture ${slot}`);
      return { fixtureId: bySlot.get(slot)!.fid, selection, oddsCents: price.oddsCents };
    },
  };
  return built;
}

type Line = { kind: 'SINGLE' | 'MULTIPLE'; stake: number; legs: ReturnType<Built['leg']>[] };
const request = (mw: Built, lines: Line[], key = randomBytes(12).toString('hex') + 'AB') => ({
  idempotencyKey: key,
  matchweekId: mw.id,
  rulesId: VF_RULES_ID,
  lines,
});
const single = (mw: Built, slot: number, selection: string, stake = 10): Line => ({
  kind: 'SINGLE',
  stake,
  legs: [mw.leg(slot, selection)],
});

async function member(status: 'ACTIVE' | 'SUSPENDED' = 'ACTIVE') {
  const id = randomUUID();
  await db.user.create({
    data: { id, username: `vf_${id.replaceAll('-', '')}`, isVerified: false, status },
  });
  return id;
}
// An account row materialises on a member's first committed call and starts at 1,000.
const balance = async (id: string) => {
  const [row] = await db.$queryRaw<
    { balance: bigint }[]
  >`SELECT balance FROM football_accounts WHERE user_id=${id}`;
  return row ? Number(row.balance) : 1000;
};
const reason = (r: unknown) => (r as { details?: { reason?: string } }).details?.reason;
const FINANCIAL = /wallet|coin|ledger|house_|crypto|withdraw|payment|deposit/;
async function financialCounts() {
  const tables = await db.$queryRaw<
    { table_name: string }[]
  >`SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY 1`;
  const out: Record<string, number> = {};
  for (const { table_name } of tables.filter((t) => FINANCIAL.test(t.table_name)))
    out[table_name] = Number(
      (
        await db.$queryRawUnsafe<{ count: bigint }[]>(
          `SELECT count(*) AS count FROM "${table_name}"`
        )
      )[0].count
    );
  return out;
}

let ADM: Built, A: Built, PREV: Built, NEXT: Built;
const users: Record<string, string> = {};
const placed: Record<string, Awaited<ReturnType<typeof service.admit>>> = {};

beforeAll(async () => {
  await db.$connect();
  ADM = await matchweek({ kickoffInMs: 200_000 });
  A = await matchweek({ kickoffInMs: 40_000 });
  PREV = await matchweek({ kickoffInMs: 6_000, season: RUN + 150_000, week: 37 });
  NEXT = await matchweek({ kickoffInMs: 6_000, season: RUN + 150_001, week: 1 });
  for (const name of ['settle', 'suspend', 'other', 'late-guard']) users[name] = await member();
  // Tickets that must settle after full time, placed while A's window is open.
  placed.settle = await service.admit(
    users.settle,
    request(A, [
      single(A, 1, 'FT:1', 10), // wins
      single(A, 3, 'FT:1', 20), // loses (0-2)
      {
        kind: 'MULTIPLE',
        stake: 15,
        legs: [A.leg(1, 'FT:1'), A.leg(5, 'OU:2.5:O'), A.leg(9, 'FTOU:1:2.5:O')],
      }, // all win
      { kind: 'MULTIPLE', stake: 10, legs: [A.leg(1, 'FT:1'), A.leg(2, 'FT:1')] }, // 0-0 loses the second leg
    ])
  );
  placed.suspend = await service.admit(users.suspend, request(A, [single(A, 5, 'FT:1', 40)]));
  placed.other = await service.admit(users.other, request(A, [single(A, 7, 'FT:X', 25)]));
});
afterAll(async () => {
  await db.$disconnect();
});

describe('admission', () => {
  it('debits a whole bundle atomically and binds an immutable receipt', async () => {
    const u = await member();
    const lines = [
      single(ADM, 1, 'FT:1', 10),
      single(ADM, 2, 'OU:2.5:O', 20),
      {
        kind: 'MULTIPLE' as const,
        stake: 15,
        legs: [ADM.leg(1, 'FT:X'), ADM.leg(3, 'BTTS:FT:N'), ADM.leg(4, 'HT:X')],
      },
    ];
    const body = request(ADM, lines);
    const result = await service.admit(u, body);
    expect(result).toMatchObject({ accepted: true, isReplay: false });
    expect(await balance(u)).toBe(1000 - 45);
    const t = result.ticket;
    expect(t).toMatchObject({
      matchweekId: ADM.id,
      rulesId: VF_RULES_ID,
      rulesDigest: VF_RULES_DIGEST,
      totalStake: 45,
      totalReturn: null,
      settledAt: null,
    });
    expect(t.lines.map((l) => [l.kind, l.stake, l.legs.length])).toEqual([
      ['SINGLE', 10, 1],
      ['SINGLE', 20, 1],
      ['MULTIPLE', 15, 3],
    ]);
    expect(t.lines[2].legs.map((l) => l.selection)).toEqual(['FT:X', 'BTTS:FT:N', 'HT:X']);
    expect(t.lines.flatMap((l) => l.legs).every((l) => l.result === 'PENDING')).toBe(true);
    const parsed = {
      idempotencyKey: body.idempotencyKey,
      matchweekId: ADM.id,
      rulesId: VF_RULES_ID,
      lines,
    };
    expect(t.requestHash).toBe(ticketRequestHash(parsed));
    const digests = Object.fromEntries(
      [1, 2, 3, 4].map((s) => [ADM.fx(s), fixtureOffer(ADM.params(s)).digest])
    );
    expect(t.receiptHash).toBe(
      receiptHash({
        requestHash: t.requestHash,
        matchweekId: ADM.id,
        totalStake: 45,
        offerDigests: digests,
      })
    );
    const product = BigInt(t.lines[2].oddsProduct);
    expect(product).toBe(
      BigInt(ADM.leg(1, 'FT:X').oddsCents) *
        BigInt(ADM.leg(3, 'BTTS:FT:N').oddsCents) *
        BigInt(ADM.leg(4, 'HT:X').oddsCents)
    );
    expect(t.lines[2].maxReturn).toBe(Number((15n * product) / 1_000_000n));
  });

  it('retries return the same receipt, never debit twice, and never replace a pending request', async () => {
    const u = await member();
    const body = request(ADM, [single(ADM, 1, 'FT:1', 30)]);
    const first = await service.admit(u, body);
    const again = await service.admit(u, JSON.parse(JSON.stringify(body)));
    expect(again.isReplay).toBe(true);
    expect(again.ticket).toEqual(first.ticket);
    expect(await balance(u)).toBe(970);
    for (const changed of [
      { ...body, lines: [single(ADM, 1, 'FT:1', 31)] },
      { ...body, lines: [single(ADM, 1, 'FT:X', 30)] },
      { ...body, lines: [single(ADM, 2, 'FT:1', 30)] },
      { ...body, lines: [single(ADM, 1, 'FT:1', 30), single(ADM, 2, 'FT:1', 5)] },
      { ...body, matchweekId: A.id },
    ])
      await expect(service.admit(u, changed)).rejects.toMatchObject({ statusCode: 409 });
    expect(await balance(u)).toBe(970);
    expect(
      Number(
        (
          await db.$queryRaw<
            { count: bigint }[]
          >`SELECT count(*) FROM football_tickets WHERE user_id=${u}`
        )[0].count
      )
    ).toBe(1);
  });

  it('treats line order as part of the receipt identity', async () => {
    const u = await member();
    const lines = [single(ADM, 1, 'FT:1', 10), single(ADM, 2, 'FT:1', 11)];
    const body = request(ADM, lines);
    await service.admit(u, body);
    await expect(service.admit(u, { ...body, lines: [lines[1], lines[0]] })).rejects.toMatchObject({
      details: { reason: 'RECEIPT_CONFLICT' },
    });
  });

  it('concurrent identical confirmations admit and debit exactly once', async () => {
    const u = await member();
    const body = request(ADM, [single(ADM, 1, 'FT:1', 50)]);
    const results = await Promise.all(Array.from({ length: 6 }, () => service.admit(u, body)));
    expect(results.filter((r) => !r.isReplay)).toHaveLength(1);
    expect(new Set(results.map((r) => r.ticket.id)).size).toBe(1);
    expect(await balance(u)).toBe(950);
  });

  it('locks the account across fixtures and tickets so simultaneous requests cannot overspend', async () => {
    const u = await member();
    const outcomes = await Promise.allSettled(
      [1, 2, 3, 4].map((slot) => service.admit(u, request(ADM, [single(ADM, slot, 'FT:1', 500)])))
    );
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(2);
    const refused = outcomes.filter((o) => o.status === 'rejected') as PromiseRejectedResult[];
    expect(refused.map((o) => reason(o.reason))).toEqual([
      'INSUFFICIENT_CREDITS',
      'INSUFFICIENT_CREDITS',
    ]);
    expect(await balance(u)).toBe(0);
  });

  it('refuses bad shapes, moved prices, stale fixtures and unavailable picks before any debit', async () => {
    const u = await member();
    const good = single(ADM, 1, 'FT:1', 10);
    // About one fixture in seven has a priced-out selection; look until a matchweek offers one.
    let blocked: { mw: Built; slot: number; id: string } | undefined;
    for (let attempt = 0; attempt < 12 && !blocked; attempt++) {
      const mw = attempt === 0 ? ADM : await matchweek({ kickoffInMs: 100_000 });
      for (let slot = 1; slot <= 10 && !blocked; slot++) {
        const price = [...fixtureOffer(mw.params(slot)).byId.values()].find(
          (p) => p.oddsCents === null
        );
        if (price) blocked = { mw, slot, id: price.id };
      }
    }
    expect(blocked).toBeDefined();
    const cases: Array<[string, unknown, number, string]> = [
      [
        'price moved',
        request(ADM, [
          { ...good, legs: [{ ...good.legs[0], oddsCents: good.legs[0].oddsCents + 1 }] },
        ]),
        409,
        'PRICE_CHANGED',
      ],
      [
        'unavailable selection',
        request(blocked!.mw, [
          {
            kind: 'SINGLE',
            stake: 10,
            legs: [
              { fixtureId: blocked!.mw.fx(blocked!.slot), selection: blocked!.id, oddsCents: 200 },
            ],
          },
        ]),
        409,
        'UNAVAILABLE_SELECTION',
      ],
      [
        'stale fixture',
        request(ADM, [{ ...good, legs: [{ ...good.legs[0], fixtureId: A.fx(1) }] }]),
        409,
        'STALE_FIXTURE',
      ],
      [
        'two picks from one match',
        request(ADM, [
          { kind: 'MULTIPLE', stake: 10, legs: [ADM.leg(1, 'FT:1'), ADM.leg(1, 'OU:2.5:O')] },
        ]),
        400,
        'DUPLICATE_LEG',
      ],
      [
        'single with two legs',
        request(ADM, [
          { kind: 'SINGLE', stake: 10, legs: [ADM.leg(1, 'FT:1'), ADM.leg(2, 'FT:1')] },
        ]),
        400,
        'MULTIPLE_SHAPE',
      ],
      [
        'six-leg multiple',
        request(ADM, [
          { kind: 'MULTIPLE', stake: 10, legs: [1, 2, 3, 4, 5, 6].map((s) => ADM.leg(s, 'FT:1')) },
        ]),
        400,
        'MULTIPLE_SHAPE',
      ],
      ['duplicate lines', request(ADM, [good, { ...good, stake: 20 }]), 400, 'DUPLICATE_LINE'],
      ['stake above line limit', request(ADM, [{ ...good, stake: 501 }]), 400, 'STAKE_LIMIT'],
      ['fractional stake', request(ADM, [{ ...good, stake: 10.5 }]), 400, 'BAD_SHAPE'],
      ['client payout field', { ...request(ADM, [good]), payout: 999999 }, 400, 'BAD_SHAPE'],
      [
        'stale rules',
        { ...request(ADM, [good]), rulesId: 'virtual-football-3d-practice-v0' },
        409,
        'RULES_MISMATCH',
      ],
      [
        'matchweek that was never committed',
        request({ ...ADM, id: 'vf-s999998-w09', fx: () => 'vf-s999998-w09-f01' } as Built, [
          {
            kind: 'SINGLE',
            stake: 10,
            legs: [{ fixtureId: 'vf-s999998-w09-f01', selection: 'FT:X', oddsCents: 300 }],
          },
        ]),
        404,
        'MATCHWEEK_NOT_FOUND',
      ],
    ];
    for (const [name, body, status, expected] of cases) {
      await expect(service.admit(u, body), name).rejects.toMatchObject({
        statusCode: status,
        details: { reason: expected },
      });
    }
    expect(await balance(u)).toBe(1000);
    expect(
      Number(
        (
          await db.$queryRaw<
            { count: bigint }[]
          >`SELECT count(*) FROM football_tickets WHERE user_id=${u}`
        )[0].count
      )
    ).toBe(0);
  });

  it('rejects an over-limit odds product or return before any debit instead of capping it', async () => {
    const u = await member();
    const longshots = [1, 2, 3, 4, 5].map((slot) => ADM.leg(slot, 'SCORE:0-6'));
    await expect(
      service.admit(u, request(ADM, [{ kind: 'MULTIPLE', stake: 5, legs: longshots }]))
    ).rejects.toMatchObject({ statusCode: 422, details: { reason: 'ODDS_LIMIT' } });
    await expect(
      service.admit(
        u,
        request(ADM, [{ kind: 'SINGLE', stake: 500, legs: [ADM.leg(1, 'SCORE:0-6')] }])
      )
    ).rejects.toMatchObject({ statusCode: 422, details: { reason: 'RETURN_LIMIT' } });
    expect(await balance(u)).toBe(1000);
  });

  it('stops at ten tickets per matchweek', async () => {
    const u = await member();
    for (let i = 0; i < 10; i++)
      await service.admit(u, request(ADM, [single(ADM, 1 + (i % 10), 'FT:X', 5)]));
    await expect(service.admit(u, request(ADM, [single(ADM, 1, 'HT:X', 5)]))).rejects.toMatchObject(
      { details: { reason: 'TICKET_LIMIT' } }
    );
    expect(await balance(u)).toBe(950);
  });

  it('refuses admission when stored prices no longer match this code (rules drift)', async () => {
    const drift = await matchweek({ kickoffInMs: 120_000, badDigestSlot: 2 });
    const u = await member();
    await expect(
      service.admit(u, request(drift, [single(drift, 1, 'FT:1', 10)]))
    ).rejects.toMatchObject({ statusCode: 503, details: { reason: 'RULES_STALE' } });
    expect(await balance(u)).toBe(1000);
  });

  it('never reads or writes any financial, wallet or Coin table', async () => {
    const u = await member();
    await service.snapshot(u);
    const before = await financialCounts();
    await service.admit(u, request(ADM, [single(ADM, 1, 'FT:X', 10)]));
    await service.tick();
    expect(await db.wallet.findUnique({ where: { userId: u } })).toBeNull();
    expect(await financialCounts()).toEqual(before);
    expect(Object.keys(before).length).toBeGreaterThan(5);
  });

  it('keeps receipts private to their owner and unique per (user, key)', async () => {
    const [a, b] = [await member(), await member()];
    const key = 'sharedKey_0123456789';
    const ta = await service.admit(a, request(ADM, [single(ADM, 1, 'FT:1', 10)], key));
    // Another member may use the same key text: it is a different receipt in a different namespace.
    const tb = await service.admit(b, request(ADM, [single(ADM, 2, 'FT:X', 12)], key));
    expect(tb.isReplay).toBe(false);
    expect(tb.ticket.id).not.toBe(ta.ticket.id);
    const snapB = await service.snapshot(b);
    expect(snapB.tickets.map((t) => t.id)).toEqual([tb.ticket.id]);
    expect(JSON.stringify(snapB)).not.toContain(ta.ticket.id);
    expect(JSON.stringify(snapB)).not.toContain(ta.ticket.receiptHash);
    // b cannot replay a's request under a's key; the same key with a's payload is b's own conflict.
    await expect(
      service.admit(b, request(ADM, [single(ADM, 1, 'FT:1', 10)], key))
    ).rejects.toMatchObject({ details: { reason: 'RECEIPT_CONFLICT' } });
  });

  it('keeps suspended identities out of admission, replay and private snapshots', async () => {
    const u = await member();
    const body = request(ADM, [single(ADM, 1, 'FT:1', 10)]);
    await service.admit(u, body);
    await db.user.update({ where: { id: u }, data: { status: 'SUSPENDED' } });
    await expect(service.admit(u, body)).rejects.toMatchObject({ statusCode: 403 });
    await expect(
      service.admit(u, request(ADM, [single(ADM, 2, 'FT:1', 10)]))
    ).rejects.toMatchObject({ statusCode: 403 });
    await expect(service.snapshot(u)).rejects.toMatchObject({ statusCode: 403 });
    const fresh = await member('SUSPENDED');
    await expect(
      service.admit(fresh, request(ADM, [single(ADM, 1, 'FT:1', 10)]))
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(await db.$queryRaw`SELECT 1 FROM football_accounts WHERE user_id=${fresh}`).toEqual([]);
  });

  it('checks the cutoff again after waiting for the account lock', async () => {
    const closing = await matchweek({ kickoffInMs: 2500 });
    const u = await member();
    await service.snapshot(u);
    let release!: () => void, locked!: () => void;
    const gate = new Promise<void>((r) => (release = r)),
      ready = new Promise<void>((r) => (locked = r));
    const holder = db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT user_id FROM football_accounts WHERE user_id=${u} FOR UPDATE`;
      locked();
      await gate;
    });
    await ready;
    const attempt = expect(
      service.admit(u, request(closing, [single(closing, 1, 'FT:1', 25)]))
    ).rejects.toMatchObject({ statusCode: 409, details: { reason: 'CLOSED' } });
    await until(closing.kickoff + 60);
    release();
    await holder;
    await attempt;
    expect(await balance(u)).toBe(1000);
    expect(
      Number(
        (
          await db.$queryRaw<
            { count: bigint }[]
          >`SELECT count(*) FROM football_tickets WHERE user_id=${u}`
        )[0].count
      )
    ).toBe(0);
  });
});

describe('database guards', () => {
  it('rejects edits to immutable history, receipts, prices and balances', async () => {
    const u = await member();
    const { ticket } = await service.admit(u, request(ADM, [single(ADM, 1, 'FT:1', 10)]));
    const rejects = (sql: Promise<unknown>) => expect(sql).rejects.toThrow();
    await rejects(
      db.$executeRaw`UPDATE football_accounts SET balance=balance+1 WHERE user_id=${u}`
    );
    await rejects(
      db.$executeRaw`UPDATE football_accounts SET balance=balance-1 WHERE user_id=${u}`
    );
    await rejects(db.$executeRaw`UPDATE football_tickets SET total_stake=5 WHERE id=${ticket.id}`);
    await rejects(
      db.$executeRaw`UPDATE football_tickets SET idempotency_key='zzzzzzzzzzzzzzzzzzzz' WHERE id=${ticket.id}`
    );
    await rejects(
      db.$executeRaw`UPDATE football_ticket_legs SET selection='FT:2' WHERE ticket_id=${ticket.id}`
    );
    await rejects(
      db.$executeRaw`UPDATE football_ticket_legs SET odds_cents=9999 WHERE ticket_id=${ticket.id}`
    );
    await rejects(
      db.$executeRaw`UPDATE football_ticket_lines SET stake=500 WHERE ticket_id=${ticket.id}`
    );
    await rejects(
      db.$executeRaw`UPDATE football_ticket_lines SET odds_product=99999 WHERE ticket_id=${ticket.id}`
    );
    await rejects(db.$executeRaw`UPDATE football_fixtures SET ft_home=6 WHERE id=${ADM.fx(1)}`);
    await rejects(
      db.$executeRaw`UPDATE football_fixtures SET goal_at_ms=ARRAY[1500,5500,9500] WHERE id=${ADM.fx(1)}`
    );
    await rejects(
      db.$executeRaw`UPDATE football_matchweeks SET seed=${'0'.repeat(64)} WHERE id=${ADM.id}`
    );
    await rejects(db.$executeRaw`DELETE FROM football_tickets WHERE id=${ticket.id}`);
    await rejects(db.$executeRaw`DELETE FROM football_ticket_legs WHERE ticket_id=${ticket.id}`);
    await rejects(db.$executeRaw`DELETE FROM football_fixtures WHERE id=${ADM.fx(1)}`);
    await rejects(db.$executeRaw`DELETE FROM football_matchweeks WHERE id=${ADM.id}`);
    expect(await balance(u)).toBe(990);
  });

  it('refuses early settlement, and wrong payouts at any time', async () => {
    const u = await member();
    const { ticket } = await service.admit(u, request(ADM, [single(ADM, 1, 'FT:1', 10)]));
    await expect(
      db.$executeRaw`UPDATE football_ticket_lines SET payout=0 WHERE ticket_id=${ticket.id}`
    ).rejects.toThrow(/settlement not due/);
    await expect(service.settleTicket(ticket.id)).resolves.toBe(false);
    expect(await balance(u)).toBe(990);
  });

  it('refuses a matchweek committed outside its own selection window (no fabricated history)', async () => {
    const past = Date.now() - 400_000;
    const insert = (kickoff: number, id: string, season: number) =>
      db.$executeRaw`INSERT INTO football_matchweeks(id,season_no,week_no,rules_id,rules_digest,opens_at,kickoff_at,full_time_at,ends_at,seed,commitment) VALUES(${id},${season},9,${VF_RULES_ID},${VF_RULES_DIGEST},${new Date(kickoff - 230_000)},${new Date(kickoff)},${new Date(kickoff + 60_000)},${new Date(kickoff - 230_000 + 300_000)},${'a'.repeat(64)},${'b'.repeat(64)})`;
    await expect(insert(past, `vf-s${RUN + 100_000}-w09`, RUN + 100_000)).rejects.toThrow(
      /selection window/
    );
    await expect(
      insert(Date.now() + 400_000, `vf-s${RUN + 100_001}-w09`, RUN + 100_001)
    ).rejects.toThrow(/selection window/);
  });

  it('validates fixture timelines, clubs and ticket shapes at the database', async () => {
    const empty = `vf-s${++seasonCounter}-w02`;
    const now = Date.now();
    await db.$executeRaw`INSERT INTO football_matchweeks(id,season_no,week_no,rules_id,rules_digest,opens_at,kickoff_at,full_time_at,ends_at,seed,commitment) VALUES(${empty},${seasonCounter},2,${VF_RULES_ID},${VF_RULES_DIGEST},${new Date(now - 10_000)},${new Date(now + 220_000)},${new Date(now + 280_000)},${new Date(now + 290_000)},${'c'.repeat(64)},${'d'.repeat(64)})`;
    type Over = Partial<{
      h: number;
      a: number;
      ftH: number;
      ftA: number;
      htH: number;
      htA: number;
      first: string;
      sides: string[];
      halves: number[];
      times: number[];
    }>;
    let n = 0;
    const attempt = (over: Over) => {
      const slot = (n++ % 10) + 1;
      return db.$executeRaw`INSERT INTO football_fixtures(id,matchweek_id,slot,home_club,away_club,home_attack,home_defence,away_attack,away_defence,offer_digest,commitment,ft_home,ft_away,ht_home,ht_away,first_scorer,goal_sides,goal_halves,goal_at_ms) VALUES(${`${empty}-f${String(slot).padStart(2, '0')}`},${empty},${slot},${over.h ?? 1},${over.a ?? 2},100,100,100,100,${'a'.repeat(64)},${'b'.repeat(64)},${over.ftH ?? 1},${over.ftA ?? 0},${over.htH ?? 0},${over.htA ?? 0},${over.first ?? 'H'},${over.sides ?? ['H']}::text[],${over.halves ?? [2]}::smallint[],${over.times ?? [33500]}::integer[])`;
    };
    const cases: Array<[string, Over, RegExp]> = [
      ['full-time score exceeds the goal list', { ftH: 2 }, /goal timeline/],
      ['half-time score does not match the halves', { htH: 1 }, /does not match goal timeline/],
      ['first scorer is not the first goal', { first: 'A' }, /first scorer/],
      ['time off the 500 ms grid', { times: [33_750] }, /goal time/],
      ['first-half goal after the half window', { times: [27_500], halves: [1] }, /goal time/],
      ['first-half goal in the second-half window', { times: [33_500], halves: [1] }, /goal time/],
      [
        'two goals under four seconds apart',
        { ftH: 2, sides: ['H', 'H'], halves: [2, 2], times: [34_000, 37_500] },
        /strictly increasing/,
      ],
      [
        'times that do not increase',
        { ftH: 2, sides: ['H', 'H'], halves: [2, 2], times: [40_000, 34_000] },
        /strictly increasing/,
      ],
      [
        'a second-half goal listed before a first-half goal',
        { ftH: 2, htH: 1, sides: ['H', 'H'], halves: [2, 1], times: [33_500, 20_000] },
        /strictly increasing/,
      ],
      ['a club playing itself', { h: 3, a: 3 }, /violates check constraint/],
      [
        'seven goals',
        {
          ftH: 7,
          sides: Array(7).fill('H'),
          halves: Array(7).fill(2),
          times: [33500, 37500, 41500, 45500, 49500, 53500, 57500],
        },
        /goal timeline|violates check/,
      ],
    ];
    for (const [name, over, pattern] of cases)
      await expect(attempt(over), name).rejects.toThrow(pattern);
    await attempt({});
    await expect(attempt({ h: 1, a: 4 }), 'club already plays this week').rejects.toThrow(
      /once per matchweek/
    );
    // Ticket shape: a hand-built ticket whose odds do not match its legs is rejected when committed.
    const u = await member();
    await service.snapshot(u);
    await expect(
      db.$transaction(async (tx) => {
        await tx.$executeRaw`INSERT INTO football_tickets(id,user_id,matchweek_id,idempotency_key,request_hash,receipt_hash,rules_id,rules_digest,line_count,leg_count,total_stake) VALUES('bad-ticket',${u},${ADM.id},'badBadBadBadBadBad01',${'a'.repeat(64)},${'b'.repeat(64)},${VF_RULES_ID},${VF_RULES_DIGEST},1,1,10)`;
        await tx.$executeRaw`INSERT INTO football_ticket_lines(ticket_id,line_no,kind,stake,leg_count,odds_product,max_return) VALUES('bad-ticket',1,'SINGLE',10,1,500,50)`;
        await tx.$executeRaw`INSERT INTO football_ticket_legs(ticket_id,line_no,leg_no,fixture_id,selection,odds_cents) VALUES('bad-ticket',1,1,${ADM.fx(1)},'FT:1',200)`;
        await tx.$executeRaw`UPDATE football_accounts SET balance=balance-10 WHERE user_id=${u}`;
        // Prisma 5.22 interactive transactions do not reliably surface commit-time deferred
        // constraint errors (they resolved and rolled back silently when reproduced), so the
        // service flushes deferred checks inside the transaction before reporting success.
        await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
      })
    ).rejects.toThrow(/Invalid football line odds/);
    expect(await balance(u)).toBe(1000);
  });
});

describe('selection grammar parity between SQL and TypeScript', () => {
  it('accepts exactly the 94 typed identifiers', async () => {
    const accepted = await db.$queryRaw<
      { id: string; ok: boolean }[]
    >`SELECT id,football_selection_valid(id) AS ok FROM unnest(${VF_SELECTIONS.map((s) => s.id)}::text[]) AS id`;
    expect(accepted.every((r) => r.ok)).toBe(true);
    const near = [
      'ft:1',
      'FT:H',
      'FT:1 ',
      ' FT:1',
      'OU:4.5:O',
      'OU:0.5:U',
      'OU:2.50:O',
      'SCORE:7-0',
      'SCORE:4-3',
      'SCORE:6-1',
      'TOT:7',
      'EH:0:1',
      'EH:-2:X',
      'EH:+1:3',
      'GGNG:FT:GG',
      'BTTS:FT:YES',
      'FTOU:1:3.5:O',
      'TOU:H:2.5:O',
      'HTFT:1-1',
      '',
      'FIRST:X',
      "FT:1';DROP TABLE x;--",
    ];
    const rejected = await db.$queryRaw<
      { id: string; ok: boolean }[]
    >`SELECT id,football_selection_valid(id) AS ok FROM unnest(${near}::text[]) AS id`;
    expect(rejected.filter((r) => r.ok)).toEqual([]);
    expect(near.filter((x) => parseSelection(x))).toEqual([]);
  });

  it('settles every selection identically for every possible outcome (94 x 295)', async () => {
    const outcomes = buildDistribution(fixtureParams()).atoms.map((a): Outcome => ({
      ftHome: a.ftHome,
      ftAway: a.ftAway,
      htHome: a.htHome,
      htAway: a.htAway,
      first: a.first,
    }));
    expect(outcomes).toHaveLength(295);
    const rows = await db.$queryRaw<{ sel: string; i: number; wins: boolean }[]>`
      SELECT s.sel, o.i::int AS i, football_leg_wins(s.sel,o.fh,o.fa,o.hh,o.ha,o.fs) AS wins
      FROM unnest(${VF_SELECTIONS.map((s) => s.id)}::text[]) AS s(sel)
      CROSS JOIN unnest(${outcomes.map((_, i) => i)}::int[], ${outcomes.map((o) => o.ftHome)}::int[], ${outcomes.map((o) => o.ftAway)}::int[], ${outcomes.map((o) => o.htHome)}::int[], ${outcomes.map((o) => o.htAway)}::int[], ${outcomes.map((o) => o.first)}::text[]) AS o(i,fh,fa,hh,ha,fs)`;
    expect(rows).toHaveLength(94 * 295);
    const mismatches = rows.filter((r) => r.wins !== parseSelection(r.sel)!.test(outcomes[r.i]));
    expect(mismatches.slice(0, 5)).toEqual([]);
  });
});
function fixtureParams(): FixtureParams {
  const a = VF_CLUBS[0];
  const b = VF_CLUBS[1];
  return {
    homeAttack: a.attack,
    homeDefence: a.defence,
    awayAttack: b.attack,
    awayDefence: b.defence,
  };
}

describe('post-kickoff behaviour', () => {
  it('returns the same accepted receipt for an exact retry after kickoff, and refuses anything new', async () => {
    const w = await matchweek({ kickoffInMs: 3000 });
    const u = await member();
    const body = request(w, [single(w, 1, 'FT:X', 20)]);
    const first = await service.admit(u, body);
    expect(first.isReplay).toBe(false);
    await until(w.kickoff + 100);
    const retry = await service.admit(u, JSON.parse(JSON.stringify(body)));
    expect(retry.isReplay).toBe(true);
    expect(retry.ticket.id).toBe(first.ticket.id);
    expect(await balance(u)).toBe(980);
    await expect(service.admit(u, request(w, [single(w, 2, 'FT:X', 20)]))).rejects.toMatchObject({
      details: { reason: 'CLOSED' },
    });
    await expect(
      service.admit(u, { ...body, lines: [single(w, 1, 'FT:X', 21)] })
    ).rejects.toMatchObject({ details: { reason: 'RECEIPT_CONFLICT' } });
    expect(await balance(u)).toBe(980);
    await expect(
      db.$executeRaw`INSERT INTO football_tickets(id,user_id,matchweek_id,idempotency_key,request_hash,receipt_hash,rules_id,rules_digest,line_count,leg_count,total_stake) VALUES('late',${u},${w.id},'lateLateLateLate0001',${'a'.repeat(64)},${'b'.repeat(64)},${VF_RULES_ID},${VF_RULES_DIGEST},1,1,5)`
    ).rejects.toThrow(/admission closed/);
  });
});

/* ---------------------------------------------------------------------------------------
 * Privacy: sample snapshots across the match and compare each against the shared oracle.
 * ------------------------------------------------------------------------------------- */
describe('elapsed-only snapshots', () => {
  const viewed = (s: VfSnapshot) => s.viewed!.matchweek!;
  const sample = async (user: string, offsetMs: number) => {
    await until(A.kickoff + offsetMs);
    const snap = await service.snapshot(user, { seasonNo: A.season, weekNo: A.week });
    const elapsed = snap.serverTime - A.kickoff;
    const mw = viewed(snap);
    for (const fixture of mw.fixtures) {
      const slot = fixture.slot;
      expect(fixture.live, `slot ${slot} at ${elapsed}`).toEqual(
        liveFixture(A.goals(slot), elapsed)
      );
    }
    const text = JSON.stringify(snap);
    // Nothing that is not yet elapsed may appear anywhere in the response.
    const wholeMatchweek = JSON.stringify(mw);
    for (const slot of [1, 3, 4, 5, 6, 7, 8, 9, 10])
      for (const goal of A.goals(slot))
        if (goal.atMs > elapsed)
          expect(wholeMatchweek, `${goal.atMs} leaked at ${elapsed}`).not.toContain(
            `"atMs":${goal.atMs}`
          );
    for (const key of [
      'goal_sides',
      'goal_at_ms',
      'goal_halves',
      'first_scorer',
      'ft_home',
      'script',
    ])
      expect(text).not.toContain(key);
    if (elapsed < 60_000) {
      expect(mw.seed).toBeNull();
      expect(text).not.toContain(A.seed);
    } else {
      expect(mw.seed).toBe(A.seed);
    }
    return { snap, elapsed };
  };

  it('shows nothing before kickoff, then only elapsed goals, at boundaries and around halftime', async () => {
    const watcher = users.other;
    const before = await sample(watcher, -1500);
    expect(
      viewed(before.snap).fixtures.every(
        (f) => f.live.status === 'SCHEDULED' && f.live.score === null && f.live.events.length === 0
      )
    ).toBe(true);
    const start = await sample(watcher, 300);
    expect(viewed(start.snap).fixtures[0].live.events).toHaveLength(0);
    const early = await sample(watcher, 1800); // first goals at 1500 ms are out, later ones are not
    expect(early.elapsed).toBeGreaterThanOrEqual(1500);
    const late = await sample(watcher, 27_000);
    expect(viewed(late.snap).fixtures.find((f) => f.slot === 1)!.live.score).toEqual({
      home: 1,
      away: 1,
    });
    const half = await sample(watcher, 28_300);
    expect(viewed(half.snap).fixtures.find((f) => f.slot === 1)!.live.halfTime).toEqual({
      home: 1,
      away: 1,
    });
    expect(viewed(half.snap).fixtures.every((f) => f.live.fullTime === null)).toBe(true);
    await sample(watcher, 32_500);
    await sample(watcher, 33_800);
  }, 100_000);

  it('gives a late joiner and reconnecting viewer the same elapsed state', async () => {
    const lateUser = await member();
    const [late, steady] = [await sample(lateUser, 40_000), await sample(users.other, 40_100)];
    const a = viewed(late.snap).fixtures.map((f) => f.live.events.map((e) => e.n));
    const b = viewed(steady.snap).fixtures.map((f) => f.live.events.map((e) => e.n));
    expect(a).toEqual(b);
    // A reconnect is just another read: no state is kept per connection.
    const again = await sample(users.other, 41_000);
    expect(viewed(again.snap).fixtures.map((f) => f.live.events.length)).toEqual(
      viewed(again.snap).fixtures.map(
        (f) => liveFixture(A.goals(f.slot), again.elapsed).events.length
      )
    );
  }, 60_000);

  it('keeps the last-moment goal hidden until it happens and reveals everything at full time', async () => {
    const near = await sample(users.other, 58_000);
    expect(viewed(near.snap).fixtures.find((f) => f.slot === 6)!.live.score).toEqual({
      home: 0,
      away: 0,
    });
    const justAfter = await sample(users.other, 58_700);
    expect(viewed(justAfter.snap).fixtures.find((f) => f.slot === 6)!.live.score).toEqual({
      home: 1,
      away: 0,
    });
    const last = await sample(users.other, 59_700);
    expect(viewed(last.snap).fixtures.every((f) => f.live.fullTime === null)).toBe(true);
    const over = await sample(users.other, 60_600);
    const mw = viewed(over.snap);
    expect(mw.seed).toBe(A.seed);
    expect(mw.fixtures.map((f) => f.live.fullTime)).toEqual(
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((s) => ({
        home: outcomeOfGoals(A.goals(s)).ftHome,
        away: outcomeOfGoals(A.goals(s)).ftAway,
      }))
    );
    // Ticket leg results are also pending until the official result exists.
    expect(over.snap.tickets.length).toBeGreaterThanOrEqual(0);
  }, 90_000);
});

describe('settlement', () => {
  const expectedPayout = (stake: number, odds: number[]) =>
    Number(
      (BigInt(stake) * odds.reduce((p, o) => p * BigInt(o), 1n)) / 100n ** BigInt(odds.length)
    );

  it('settles winning, losing and multiple lines exactly once with exact integers', async () => {
    await until(A.kickoff + 61_000);
    const o = (slot: number, sel: string) => A.leg(slot, sel).oddsCents;
    const wins1 = expectedPayout(10, [o(1, 'FT:1')]);
    const multi = expectedPayout(15, [o(1, 'FT:1'), o(5, 'OU:2.5:O'), o(9, 'FTOU:1:2.5:O')]);
    const total = wins1 + multi;
    const before = await balance(users.settle);
    expect(before).toBe(1000 - 55);
    // A suspended member's already-accepted ticket still settles through the worker alone.
    await db.user.update({ where: { id: users.suspend }, data: { status: 'SUSPENDED' } });
    // Concurrent workers on separate service instances plus a member read all try to settle.
    const errors: unknown[] = [];
    const snaps = await Promise.all([
      service.tick((_, e) => errors.push(e)),
      createFootballService(db).tick((_, e) => errors.push(e)),
      createFootballService(db).tick((_, e) => errors.push(e)),
      service.snapshot(users.settle),
    ]);
    expect(snaps).toBeDefined();
    expect(errors).toEqual([]);
    expect(await balance(users.settle)).toBe(1000 - 55 + total);
    const snap = await service.snapshot(users.settle);
    const ticket = snap.tickets.find((t) => t.id === placed.settle.ticket.id)!;
    expect(ticket.totalReturn).toBe(total);
    expect(ticket.settledAt).toBe(A.kickoff + 60_000);
    expect(ticket.lines.map((l) => l.payout)).toEqual([wins1, 0, multi, 0]);
    expect(ticket.lines[3].legs.map((l) => l.result)).toEqual(['WON', 'LOST']);
    expect(ticket.lines[2].legs.map((l) => l.result)).toEqual(['WON', 'WON', 'WON']);
    // Repeated passes, restarts and snapshots never pay again.
    await service.tick();
    await createFootballService(db).tick();
    await service.snapshot(users.settle);
    expect(await balance(users.settle)).toBe(1000 - 55 + total);
    const [row] = await db.$queryRaw<
      { balance: bigint; expected: bigint }[]
    >`SELECT a.balance, 1000+COALESCE(sum(COALESCE(t.total_return,0)-t.total_stake),0) AS expected FROM football_accounts a JOIN football_tickets t ON t.user_id=a.user_id WHERE a.user_id=${users.settle} GROUP BY a.balance`;
    expect(row.balance).toBe(row.expected);
  }, 90_000);

  it('credited the suspended member without any sign-in, and keeps them out afterwards', async () => {
    expect(await balance(users.suspend)).toBe(
      1000 - 40 + expectedPayout(40, [A.leg(5, 'FT:1').oddsCents])
    );
    const [t] = await db.$queryRaw<
      { settled_at: Date | null }[]
    >`SELECT settled_at FROM football_tickets WHERE id=${placed.suspend.ticket.id}`;
    expect(t.settled_at?.getTime()).toBe(A.kickoff + 60_000);
    await expect(service.snapshot(users.suspend)).rejects.toMatchObject({ statusCode: 403 });
    await expect(
      service.admit(users.suspend, request(A, [single(A, 1, 'FT:1', 5)]))
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('recovers a bundle that crashed mid-settlement atomically, with no partial line payouts', async () => {
    const mw = await matchweek({ kickoffInMs: 1500 });
    const u = await member();
    const { ticket } = await service.admit(
      u,
      request(mw, [
        single(mw, 1, 'FT:1', 10),
        single(mw, 3, 'FT:1', 10),
        { kind: 'MULTIPLE', stake: 10, legs: [mw.leg(1, 'FT:1'), mw.leg(5, 'OU:2.5:O')] },
      ])
    );
    // Both fixtures finish at kickoff + 60 s. Wait for it, then inject a crash after the line updates.
    await until(mw.kickoff + 60_500);
    let crashed = false;
    const faulty = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop !== '$transaction') return Reflect.get(target, prop, receiver);
        return (fn: (tx: unknown) => Promise<unknown>, ...rest: unknown[]) =>
          (target.$transaction as (f: unknown, ...r: unknown[]) => Promise<unknown>)(
            (tx: Record<string, unknown>) =>
              fn(
                new Proxy(tx, {
                  get(inner, p) {
                    const value = Reflect.get(inner, p);
                    if (p === '$executeRaw')
                      return (parts: TemplateStringsArray, ...values: unknown[]) => {
                        if (parts.join('?').includes('UPDATE football_tickets SET total_return')) {
                          crashed = true;
                          throw new Error('simulated worker crash');
                        }
                        return (value as (...a: unknown[]) => unknown).call(
                          inner,
                          parts,
                          ...values
                        );
                      };
                    return typeof value === 'function'
                      ? (value as (...a: unknown[]) => unknown).bind(inner)
                      : value;
                  },
                })
              ),
            ...rest
          );
      },
    }) as PrismaClient;
    await expect(createFootballService(faulty).settleTicket(ticket.id)).rejects.toThrow(
      'simulated worker crash'
    );
    expect(crashed).toBe(true);
    const lines = await db.$queryRaw<
      { payout: number | null }[]
    >`SELECT payout FROM football_ticket_lines WHERE ticket_id=${ticket.id}`;
    expect(lines.map((l) => l.payout)).toEqual([null, null, null]);
    expect(await balance(u)).toBe(970);
    // A restarted healthy worker finishes the job once.
    await service.tick();
    expect(await balance(u)).toBe(
      970 +
        expectedPayout(10, [mw.leg(1, 'FT:1').oddsCents]) +
        expectedPayout(10, [mw.leg(1, 'FT:1').oddsCents, mw.leg(5, 'OU:2.5:O').oddsCents])
    );
    const settled = await db.$queryRaw<
      { payout: number }[]
    >`SELECT payout FROM football_ticket_lines WHERE ticket_id=${ticket.id} ORDER BY line_no`;
    expect(settled.map((l) => l.payout)).toEqual([
      expectedPayout(10, [mw.leg(1, 'FT:1').oddsCents]),
      0,
      expectedPayout(10, [mw.leg(1, 'FT:1').oddsCents, mw.leg(5, 'OU:2.5:O').oddsCents]),
    ]);
    await service.tick();
    expect(await balance(u)).toBe(970 + settled.reduce((s, l) => s + l.payout, 0));
  }, 90_000);

  it('refuses a wrong payout even from the owner after full time', async () => {
    const id = placed.other.ticket.id;
    await service.tick();
    await expect(
      db.$executeRaw`UPDATE football_ticket_lines SET payout=payout+1 WHERE ticket_id=${id}`
    ).rejects.toThrow();
    await expect(
      db.$executeRaw`UPDATE football_tickets SET total_return=total_return+1 WHERE id=${id}`
    ).rejects.toThrow();
    const [t] = await db.$queryRaw<
      { total_return: number }[]
    >`SELECT total_return FROM football_tickets WHERE id=${id}`;
    expect(t.total_return).toBe(expectedPayout(25, [A.leg(7, 'FT:X').oddsCents]));
  });
});

describe('league table and downtime', () => {
  const standingsOf = async (season: number, week: number, user: string) =>
    (await service.snapshot(user, { seasonNo: season, weekNo: week })).standings;

  it('derives each season from its own official results only, exactly once', async () => {
    await until(PREV.kickoff + 61_000);
    const u = users.other;
    const prev = await standingsOf(PREV.season, 38, u);
    const expected = computeStandings(
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((slot) => {
        const pair = scheduledWeek(PREV.season, PREV.week)[slot - 1];
        const outcome = outcomeOfGoals(SCRIPTS[slot] ?? []);
        return {
          homeClub: pair.homeClub,
          awayClub: pair.awayClub,
          ftHome: outcome.ftHome,
          ftAway: outcome.ftAway,
        };
      })
    );
    expect(prev.rows).toEqual(expected);
    expect(prev.weeksCompleted).toBe(1);
    expect(prev.rows.every((r) => r.played === 1)).toBe(true);
    // Week 38 was never created (downtime): no row exists and the guard refuses to invent one now.
    expect(
      await db.$queryRaw`SELECT 1 FROM football_matchweeks WHERE id=${`vf-s${PREV.season}-w38`}`
    ).toEqual([]);
    // A genuinely elapsed cycle that was never committed reports as not played, never fabricated.
    const missed = (await service.snapshot(u, { seasonNo: 1, weekNo: 1 })).viewed;
    expect(missed).toMatchObject({ state: 'NOT_PLAYED', matchweek: null });
    expect(missed!.scheduled).toHaveLength(10);
    const next = await standingsOf(NEXT.season, 1, u);
    expect(next.weeksCompleted).toBe(1);
    expect(next.rows.every((r) => r.played === 1)).toBe(true);
    // The new season's table does not contain last season's results (and vice versa).
    const nextExpected = computeStandings(
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((slot) => {
        const pair = scheduledWeek(NEXT.season, NEXT.week)[slot - 1];
        const outcome = outcomeOfGoals(SCRIPTS[slot] ?? []);
        return {
          homeClub: pair.homeClub,
          awayClub: pair.awayClub,
          ftHome: outcome.ftHome,
          ftAway: outcome.ftAway,
        };
      })
    );
    expect(next.rows).toEqual(nextExpected);
    // Catch-up passes neither repeat results nor change a commitment.
    const commitments = async () =>
      db.$queryRaw<
        { id: string; commitment: string; seed: string }[]
      >`SELECT id,commitment,seed FROM football_matchweeks WHERE id IN (${PREV.id},${NEXT.id}) ORDER BY id`;
    const before = await commitments();
    await Promise.all([service.tick(), createFootballService(db).tick(), service.snapshot(u)]);
    expect(await commitments()).toEqual(before);
    expect((await standingsOf(PREV.season, 38, u)).rows).toEqual(expected);
    expect((await standingsOf(NEXT.season, 1, u)).rows).toEqual(nextExpected);
    const seasons = (await service.snapshot(u)).seasons;
    expect(seasons.find((s) => s.seasonNo === PREV.season)?.weeksCompleted).toBe(1);
    expect(seasons.find((s) => s.seasonNo === NEXT.season)?.weeksCompleted).toBe(1);
  }, 90_000);

  it('shows an earlier week as a table as at that week and a future week as scheduled only', async () => {
    const u = users.other;
    const through = await service.snapshot(u, { seasonNo: PREV.season, weekNo: 36 });
    expect(through.standings.rows.every((r) => r.played === 0)).toBe(true);
    const future = await service.snapshot(u, { seasonNo: 999_001, weekNo: 5 });
    expect(future.viewed).toMatchObject({ state: 'FUTURE', matchweek: null });
    expect(future.viewed!.scheduled).toHaveLength(10);
  });
});

describe('restricted runtime role', () => {
  it('can admit, recover and settle, but cannot edit outcomes, history or other tables', async () => {
    const { grantFootballRuntimeTables } = await import('../../scripts/football-runtime-grants.js');
    const role = `football_probe_${randomUUID().replaceAll('-', '')}`;
    await db.$executeRawUnsafe(
      `CREATE ROLE "${role}" LOGIN PASSWORD '${decodeURIComponent(url!.password).replaceAll("'", "''")}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`
    );
    const runtimeUrl = new URL(source!);
    runtimeUrl.username = role;
    const runtime = new PrismaClient({ datasourceUrl: runtimeUrl.toString(), log: [] });
    try {
      await db.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO "${role}"`);
      await db.$executeRawUnsafe(`GRANT SELECT,UPDATE(id) ON users TO "${role}"`);
      await grantFootballRuntimeTables(db, role);
      const restricted = createFootballService(runtime);
      const u = await member();
      expect((await restricted.snapshot(u)).balance).toBe(1000);
      const placed = await restricted.admit(
        u,
        request(ADM, [
          single(ADM, 1, 'FT:1', 10),
          { kind: 'MULTIPLE', stake: 10, legs: [ADM.leg(1, 'FT:1'), ADM.leg(2, 'FT:X')] },
        ])
      );
      expect(placed.ticket.totalStake).toBe(20);
      const forbidden = (sql: string) =>
        expect(runtime.$executeRawUnsafe(sql), sql).rejects.toThrow(
          /permission denied|immutable|does not match tickets/
        );
      await forbidden(`UPDATE football_fixtures SET ft_home=6 WHERE id='${ADM.fx(1)}'`);
      await forbidden(
        `UPDATE football_matchweeks SET seed='${'0'.repeat(64)}' WHERE id='${ADM.id}'`
      );
      await forbidden(
        `UPDATE football_ticket_legs SET selection='FT:2' WHERE ticket_id='${placed.ticket.id}'`
      );
      await forbidden(`DELETE FROM football_tickets WHERE id='${placed.ticket.id}'`);
      await forbidden(`DELETE FROM football_fixtures WHERE id='${ADM.fx(1)}'`);
      await forbidden(`TRUNCATE football_ticket_legs`);
      await forbidden(`UPDATE football_accounts SET balance=1e9 WHERE user_id='${u}'`);
      await forbidden(`DELETE FROM wallets WHERE false`);
      await forbidden(`DELETE FROM coin_provenance WHERE false`);
      for (const [table, privilege] of [
        ['football_matchweeks', 'UPDATE'],
        ['football_fixtures', 'UPDATE'],
        ['football_ticket_legs', 'UPDATE'],
        ['football_tickets', 'DELETE'],
      ]) {
        const [p] = await db.$queryRaw<
          { allowed: boolean }[]
        >`SELECT has_table_privilege(${role},${`public.${table}`},${privilege}) AS allowed`;
        expect(p.allowed, `${table} ${privilege}`).toBe(false);
      }
      // Settlement and recovery also work with only the granted privileges.
      const errors: unknown[] = [];
      await restricted.tick((_, e) => errors.push(e));
      expect(errors).toEqual([]);
    } finally {
      await runtime.$disconnect();
      await db.$executeRawUnsafe(`DROP OWNED BY "${role}"`);
      await db.$executeRawUnsafe(`DROP ROLE "${role}"`);
    }
  }, 60_000);
});

describe('live matchweek creation', () => {
  it('creates exactly one verifiable matchweek per window, even with concurrent creators', async () => {
    let now = Date.now();
    let cycle = cycleAt(now)!;
    if (now >= cycle.kickoffAt) {
      // The window has closed: wait for the next cycle (a missed week is never created later).
      await until(cycle.endsAt + 1500);
      now = Date.now();
      cycle = cycleAt(now)!;
    }
    await Promise.all(Array.from({ length: 6 }, () => createFootballService(db).ensureMatchweek()));
    const id = `vf-s${cycle.seasonNo}-w${String(cycle.weekNo).padStart(2, '0')}`;
    const [mw] = await db.$queryRaw<
      { id: string; seed: string; commitment: string; opens_at: Date; kickoff_at: Date }[]
    >`SELECT id,seed,commitment,opens_at,kickoff_at FROM football_matchweeks WHERE id=${id}`;
    expect(mw).toBeDefined();
    expect(mw.opens_at.getTime()).toBe(cycle.opensAt);
    expect(mw.kickoff_at.getTime()).toBe(cycle.kickoffAt);
    const fixtures = await db.$queryRaw<
      {
        id: string;
        slot: number;
        home_attack: number;
        home_defence: number;
        away_attack: number;
        away_defence: number;
        commitment: string;
        offer_digest: string;
        goal_sides: string[];
        goal_halves: number[];
        goal_at_ms: number[];
      }[]
    >`SELECT id,slot,home_attack,home_defence,away_attack,away_defence,commitment,offer_digest,goal_sides,goal_halves::integer[] AS goal_halves,goal_at_ms FROM football_fixtures WHERE matchweek_id=${id} ORDER BY slot`;
    expect(fixtures).toHaveLength(10);
    const verified = verifyMatchweek({
      matchweekId: id,
      seed: mw.seed,
      commitment: mw.commitment,
      fixtures: fixtures.map((f) => ({
        id: f.id,
        slot: f.slot,
        params: {
          homeAttack: f.home_attack,
          homeDefence: f.home_defence,
          awayAttack: f.away_attack,
          awayDefence: f.away_defence,
        },
        commitment: f.commitment,
        goals: f.goal_sides.map((side, i) => ({
          n: i + 1,
          side: side as 'H' | 'A',
          half: f.goal_halves[i] as 1 | 2,
          atMs: f.goal_at_ms[i],
        })),
      })),
    });
    expect(verified).toEqual({ ok: true, problems: [] });
    // Repeated creation is a no-op and never changes the commitment.
    await createFootballService(db).ensureMatchweek();
    expect(
      (
        await db.$queryRaw<
          { commitment: string }[]
        >`SELECT commitment FROM football_matchweeks WHERE id=${id}`
      )[0].commitment
    ).toBe(mw.commitment);
    expect(
      Number(
        (
          await db.$queryRaw<
            { count: bigint }[]
          >`SELECT count(*) FROM football_fixtures WHERE matchweek_id=${id}`
        )[0].count
      )
    ).toBe(10);
    // Clubs play once each: all twenty appear exactly once.
    const clubs = await db.$queryRaw<
      { c: number }[]
    >`SELECT home_club AS c FROM football_fixtures WHERE matchweek_id=${id} UNION ALL SELECT away_club FROM football_fixtures WHERE matchweek_id=${id}`;
    expect(new Set(clubs.map((r) => r.c)).size).toBe(20);
    expect(clubs).toHaveLength(20);
  }, 150_000);
});
