import { randomBytes, randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient } from '@socialplay/database';
import {
  VF_CLUBS,
  VF_LIMITS,
  VF_RULES_DIGEST,
  VF_RULES_ID,
  VF_TIMING,
  clubById,
  computeStandings,
  cycleAt,
  cycleBySeasonWeek,
  fixtureCommitment,
  fixtureId,
  fixtureOffer,
  fixtureSeed,
  generateTimeline,
  liveFixture,
  matchweekCommitment,
  matchweekId,
  parseSelection,
  parseTicketInput,
  phaseAt,
  priceTicket,
  receiptHash,
  scheduledWeek,
  settleLine,
  ticketRequestHash,
  TicketRuleError,
  type FinishedMatch,
  type FixtureParams,
  type Goal,
  type Outcome,
  type Side,
  type TicketErrorCode,
  type VfAdmission,
  type VfFixtureView,
  type VfLegResult,
  type VfMatchweekView,
  type VfSnapshot,
  type VfTicketView,
  type VfViewedWeek,
} from '@socialplay/shared';
import { ApiError } from '../../middleware/api-error.js';

type Tx = Prisma.TransactionClient;

interface MatchweekRow {
  id: string;
  season_no: number;
  week_no: number;
  rules_id: string;
  rules_digest: string;
  opens_at: Date;
  kickoff_at: Date;
  full_time_at: Date;
  ends_at: Date;
  seed: string;
  commitment: string;
}
interface FixtureRow {
  id: string;
  matchweek_id: string;
  slot: number;
  home_club: number;
  away_club: number;
  home_attack: number;
  home_defence: number;
  away_attack: number;
  away_defence: number;
  offer_digest: string;
  commitment: string;
  goal_sides: string[];
  goal_halves: number[];
  goal_at_ms: number[];
}
interface TicketRow {
  id: string;
  user_id: string;
  matchweek_id: string;
  idempotency_key: string;
  request_hash: string;
  receipt_hash: string;
  rules_id: string;
  rules_digest: string;
  line_count: number;
  leg_count: number;
  total_stake: number;
  total_return: number | null;
  settled_at: Date | null;
  created_at: Date;
}
interface LineRow {
  ticket_id: string;
  line_no: number;
  kind: 'SINGLE' | 'MULTIPLE';
  stake: number;
  leg_count: number;
  odds_product: { toFixed(digits: number): string };
  max_return: number;
  payout: number | null;
}

/** Machine-readable reason carried in `error.details.reason` for the client. */
export type FootballReason =
  | TicketErrorCode
  | 'CLOSED'
  | 'INSUFFICIENT_CREDITS'
  | 'RECEIPT_CONFLICT'
  | 'MATCHWEEK_NOT_FOUND'
  | 'TICKET_LIMIT'
  | 'RULES_STALE';

const STATUS_BY_CODE: Record<TicketErrorCode, 400 | 409 | 422> = {
  BAD_SHAPE: 400,
  STAKE_LIMIT: 400,
  MULTIPLE_SHAPE: 400,
  DUPLICATE_LEG: 400,
  DUPLICATE_LINE: 400,
  RULES_MISMATCH: 409,
  PRICE_CHANGED: 409,
  STALE_FIXTURE: 409,
  UNAVAILABLE_SELECTION: 409,
  ODDS_LIMIT: 422,
  RETURN_LIMIT: 422,
};
const reasoned = (status: number, message: string, reason: FootballReason) => {
  const details = { reason };
  switch (status) {
    case 400:
      return ApiError.badRequest(message, details);
    case 404:
      return ApiError.notFound(message, details);
    case 409:
      return ApiError.conflict(message, details);
    case 422:
      return ApiError.unprocessableEntity(message, details);
    default:
      return ApiError.serviceUnavailable(message, details);
  }
};
export function ruleError(error: TicketRuleError) {
  return reasoned(STATUS_BY_CODE[error.code], error.message, error.code);
}

const paramsOf = (f: FixtureRow): FixtureParams => ({
  homeAttack: f.home_attack,
  homeDefence: f.home_defence,
  awayAttack: f.away_attack,
  awayDefence: f.away_defence,
});
const goalsOf = (f: FixtureRow): Goal[] =>
  f.goal_sides.map((side, i) => ({
    n: i + 1,
    side: side as Side,
    half: f.goal_halves[i] as 1 | 2,
    atMs: f.goal_at_ms[i],
  }));

export function createFootballService(db: PrismaClient) {
  const clock = async (tx: Tx | PrismaClient) =>
    (await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`)[0].now;

  // Fixture rows are immutable once written, so reading them through a small cache is safe.
  const fixtureCache = new Map<string, FixtureRow[]>();
  async function fixturesOf(tx: Tx, id: string): Promise<FixtureRow[]> {
    const hit = fixtureCache.get(id);
    if (hit) return hit;
    const rows = await tx.$queryRaw<FixtureRow[]>`SELECT id,matchweek_id,slot,home_club,away_club,home_attack,home_defence,away_attack,away_defence,offer_digest,commitment,goal_sides,goal_halves::integer[] AS goal_halves,goal_at_ms FROM football_fixtures WHERE matchweek_id=${id} ORDER BY slot`;
    if (rows.length === 10) {
      if (fixtureCache.size >= 64) fixtureCache.delete(fixtureCache.keys().next().value as string);
      fixtureCache.set(id, rows);
    }
    return rows;
  }

  async function account(tx: Tx, userId: string) {
    const [user] = await tx.$queryRaw<{ status: string }[]>`SELECT status::text FROM users WHERE id=${userId} FOR SHARE`;
    if (user?.status !== 'ACTIVE') throw ApiError.forbidden('An active account is required');
    await tx.$executeRaw`INSERT INTO football_accounts(user_id) VALUES(${userId}) ON CONFLICT DO NOTHING`;
  }

  async function flush(tx: Tx) {
    const names =
      'public.football_account_balance, public.football_ticket_balance, public.football_ticket_integrity_t, public.football_ticket_integrity_l, public.football_ticket_integrity_g';
    await tx.$executeRawUnsafe(`SET CONSTRAINTS ${names} IMMEDIATE`);
    await tx.$executeRawUnsafe(`SET CONSTRAINTS ${names} DEFERRED`);
  }

  /**
   * Creates the current matchweek (seed, commitments, ten priced fixtures) only while its
   * own selection window is open. A week whose window passed without a row is a missed
   * week: it is never created retroactively and the database guard refuses it.
   */
  async function ensureMatchweek(): Promise<void> {
    const now = await clock(db);
    const cycle = cycleAt(now.getTime());
    if (!cycle || now.getTime() >= cycle.kickoffAt) return;
    const id = matchweekId(cycle.seasonNo, cycle.weekNo);
    const [exists] = await db.$queryRaw<{ id: string }[]>`SELECT id FROM football_matchweeks WHERE id=${id}`;
    if (exists) return;
    const seed = randomBytes(32).toString('hex');
    const fixtures = scheduledWeek(cycle.seasonNo, cycle.weekNo).map((slot) => {
      const home = clubById(slot.homeClub);
      const away = clubById(slot.awayClub);
      const params: FixtureParams = {
        homeAttack: home.attack,
        homeDefence: home.defence,
        awayAttack: away.attack,
        awayDefence: away.defence,
      };
      const fid = fixtureId(id, slot.slot);
      const offer = fixtureOffer(params);
      const derived = fixtureSeed(id, fid, seed);
      return {
        id: fid,
        slot: slot.slot,
        home: slot.homeClub,
        away: slot.awayClub,
        params,
        offer: offer.digest,
        commitment: fixtureCommitment(fid, derived, offer.digest),
        timeline: generateTimeline(derived, params),
      };
    });
    const commitment = matchweekCommitment(id, fixtures.map((f) => f.commitment));
    try {
      await db.$transaction(async (tx) => {
        const inserted = await tx.$executeRaw`INSERT INTO football_matchweeks(id,season_no,week_no,rules_id,rules_digest,opens_at,kickoff_at,full_time_at,ends_at,seed,commitment) VALUES(${id},${cycle.seasonNo},${cycle.weekNo},${VF_RULES_ID},${VF_RULES_DIGEST},${new Date(cycle.opensAt)},${new Date(cycle.kickoffAt)},${new Date(cycle.fullTimeAt)},${new Date(cycle.endsAt)},${seed},${commitment}) ON CONFLICT DO NOTHING`;
        if (inserted === 0) return;
        for (const f of fixtures) {
          const t = f.timeline;
          await tx.$executeRaw`INSERT INTO football_fixtures(id,matchweek_id,slot,home_club,away_club,home_attack,home_defence,away_attack,away_defence,offer_digest,commitment,ft_home,ft_away,ht_home,ht_away,first_scorer,goal_sides,goal_halves,goal_at_ms) VALUES(${f.id},${id},${f.slot},${f.home},${f.away},${f.params.homeAttack},${f.params.homeDefence},${f.params.awayAttack},${f.params.awayDefence},${f.offer},${f.commitment},${t.ftHome},${t.ftAway},${t.htHome},${t.htAway},${t.first},${t.goals.map((g) => g.side)}::text[],${t.goals.map((g) => g.half)}::smallint[],${t.goals.map((g) => g.atMs)}::integer[])`;
        }
      });
    } catch (error) {
      // The window closed between the check and the insert: the week is missed, not forged.
      if (error instanceof Error && /selection window/.test(error.message)) return;
      throw error;
    }
  }

  /* ---------------------------------------------------------------------------------- *
   * Views. Every fixture view is built by liveFixture(), the single elapsed-only gate.
   * ---------------------------------------------------------------------------------- */
  function fixtureView(f: FixtureRow, mw: MatchweekRow, nowMs: number): VfFixtureView {
    return {
      id: f.id,
      slot: f.slot,
      homeClub: f.home_club,
      awayClub: f.away_club,
      params: paramsOf(f),
      offerDigest: f.offer_digest,
      commitment: f.commitment,
      live: liveFixture(goalsOf(f), nowMs - mw.kickoff_at.getTime()),
    };
  }
  function matchweekView(mw: MatchweekRow, fixtures: FixtureRow[], nowMs: number): VfMatchweekView {
    const kickoffAt = mw.kickoff_at.getTime();
    return {
      id: mw.id,
      seasonNo: mw.season_no,
      weekNo: mw.week_no,
      opensAt: mw.opens_at.getTime(),
      kickoffAt,
      halftimeAt: kickoffAt + VF_TIMING.firstHalfMs,
      secondHalfAt: kickoffAt + VF_TIMING.firstHalfMs + VF_TIMING.halftimeMs,
      fullTimeAt: mw.full_time_at.getTime(),
      endsAt: mw.ends_at.getTime(),
      commitment: mw.commitment,
      seed: nowMs >= mw.full_time_at.getTime() ? mw.seed : null,
      fixtures: fixtures.map((f) => fixtureView(f, mw, nowMs)),
    };
  }

  async function ticketViews(tx: Tx, userId: string, now: Date, only?: string): Promise<VfTicketView[]> {
    const tickets = only
      ? await tx.$queryRaw<TicketRow[]>`SELECT * FROM football_tickets WHERE user_id=${userId} AND id=${only}`
      : await tx.$queryRaw<TicketRow[]>`SELECT * FROM football_tickets WHERE user_id=${userId} ORDER BY created_at DESC,id DESC LIMIT 20`;
    if (!tickets.length) return [];
    const ids = tickets.map((t) => t.id);
    const lines = await tx.$queryRaw<LineRow[]>`SELECT * FROM football_ticket_lines WHERE ticket_id=ANY(${ids}::text[]) ORDER BY ticket_id,line_no`;
    // Results are nulled in SQL until full time, so an unfinished score cannot leak here.
    const legs = await tx.$queryRaw<
      { ticket_id: string; line_no: number; leg_no: number; fixture_id: string; selection: string; odds_cents: number; ft_home: number | null; ft_away: number | null; ht_home: number | null; ht_away: number | null; first_scorer: string | null }[]
    >`SELECT g.ticket_id,g.line_no,g.leg_no,g.fixture_id,g.selection,g.odds_cents,
        CASE WHEN m.full_time_at<=${now} THEN f.ft_home END AS ft_home, CASE WHEN m.full_time_at<=${now} THEN f.ft_away END AS ft_away,
        CASE WHEN m.full_time_at<=${now} THEN f.ht_home END AS ht_home, CASE WHEN m.full_time_at<=${now} THEN f.ht_away END AS ht_away,
        CASE WHEN m.full_time_at<=${now} THEN f.first_scorer END AS first_scorer
      FROM football_ticket_legs g JOIN football_fixtures f ON f.id=g.fixture_id JOIN football_matchweeks m ON m.id=f.matchweek_id
      WHERE g.ticket_id=ANY(${ids}::text[]) ORDER BY g.ticket_id,g.line_no,g.leg_no`;
    return tickets.map((t) => ({
      id: t.id,
      matchweekId: t.matchweek_id,
      rulesId: t.rules_id,
      rulesDigest: t.rules_digest,
      requestHash: t.request_hash,
      receiptHash: t.receipt_hash,
      totalStake: t.total_stake,
      totalReturn: t.total_return,
      createdAt: t.created_at.getTime(),
      settledAt: t.settled_at?.getTime() ?? null,
      lines: lines
        .filter((l) => l.ticket_id === t.id)
        .map((l) => {
          const lineLegs = legs.filter((g) => g.ticket_id === t.id && g.line_no === l.line_no);
          const product = BigInt(l.odds_product.toFixed(0));
          return {
            lineNo: l.line_no,
            kind: l.kind,
            stake: l.stake,
            oddsProduct: product.toString(),
            combinedOddsCents: Number(product / 100n ** BigInt(l.leg_count - 1)),
            maxReturn: l.max_return,
            payout: l.payout,
            legs: lineLegs.map((g) => {
              let result: VfLegResult = 'PENDING';
              if (g.ft_home !== null) {
                const o: Outcome = { ftHome: g.ft_home, ftAway: g.ft_away!, htHome: g.ht_home!, htAway: g.ht_away!, first: g.first_scorer as Outcome['first'] };
                result = parseSelection(g.selection)!.test(o) ? 'WON' : 'LOST';
              }
              return { fixtureId: g.fixture_id, selection: g.selection, oddsCents: g.odds_cents, result };
            }),
          };
        }),
    }));
  }

  /* ---------------------------------------------------------------------------------- *
   * Settlement: one ticket, one transaction, exactly once.
   * ---------------------------------------------------------------------------------- */
  async function settleTicket(ticketId: string): Promise<boolean> {
    return db.$transaction(async (tx) => {
      const [t] = await tx.$queryRaw<TicketRow[]>`SELECT * FROM football_tickets WHERE id=${ticketId} FOR UPDATE`;
      if (!t || t.settled_at !== null) return false;
      const [mw] = await tx.$queryRaw<MatchweekRow[]>`SELECT * FROM football_matchweeks WHERE id=${t.matchweek_id}`;
      if (!mw || (await clock(tx)) < mw.full_time_at) return false;
      await tx.$queryRaw`SELECT user_id FROM football_accounts WHERE user_id=${t.user_id} FOR UPDATE`;
      const lines = await tx.$queryRaw<LineRow[]>`SELECT * FROM football_ticket_lines WHERE ticket_id=${ticketId} ORDER BY line_no`;
      const legs = await tx.$queryRaw<
        { line_no: number; fixture_id: string; selection: string; ft_home: number; ft_away: number; ht_home: number; ht_away: number; first_scorer: string }[]
      >`SELECT g.line_no,g.fixture_id,g.selection,f.ft_home,f.ft_away,f.ht_home,f.ht_away,f.first_scorer FROM football_ticket_legs g JOIN football_fixtures f ON f.id=g.fixture_id WHERE g.ticket_id=${ticketId} ORDER BY g.line_no,g.leg_no`;
      const outcomes = new Map<string, Outcome>(
        legs.map((g) => [g.fixture_id, { ftHome: g.ft_home, ftAway: g.ft_away, htHome: g.ht_home, htAway: g.ht_away, first: g.first_scorer as Outcome['first'] }])
      );
      let total = 0;
      for (const line of lines) {
        const payout = settleLine(
          {
            stake: line.stake,
            oddsProduct: BigInt(line.odds_product.toFixed(0)),
            legs: legs
              .filter((g) => g.line_no === line.line_no)
              .map((g) => ({ fixtureId: g.fixture_id, selection: g.selection })),
          },
          (fixture) => outcomes.get(fixture)!
        );
        await tx.$executeRaw`UPDATE football_ticket_lines SET payout=${payout} WHERE ticket_id=${ticketId} AND line_no=${line.line_no}`;
        total += payout;
      }
      await tx.$executeRaw`UPDATE football_tickets SET total_return=${total},settled_at=${mw.full_time_at} WHERE id=${ticketId}`;
      await tx.$executeRaw`UPDATE football_accounts SET balance=balance+${total} WHERE user_id=${t.user_id}`;
      await flush(tx);
      return true;
    });
  }

  /** Worker pass: create the current week if its window is open, then settle due tickets. */
  async function tick(onError: (id: string, error: unknown) => void = () => {}) {
    try {
      await ensureMatchweek();
    } catch (error) {
      onError('ensure-matchweek', error);
    }
    const rows = await db.$queryRaw<{ id: string }[]>`SELECT t.id FROM football_tickets t JOIN football_matchweeks m ON m.id=t.matchweek_id WHERE t.settled_at IS NULL AND m.full_time_at<=clock_timestamp() ORDER BY m.opens_at,t.id LIMIT 300`;
    for (const row of rows)
      try {
        await settleTicket(row.id);
      } catch (error) {
        onError(row.id, error);
      }
  }

  /* ---------------------------------------------------------------------------------- *
   * Snapshot
   * ---------------------------------------------------------------------------------- */
  async function snapshot(userId: string, view?: { seasonNo: number; weekNo: number }): Promise<VfSnapshot> {
    // Authenticate before any recovery or creation work.
    await db.$transaction((tx) => account(tx, userId));
    try {
      await ensureMatchweek();
    } catch {
      // A creation failure must not hide existing results; the worker retries and reports it.
    }
    const pending = await db.$queryRaw<{ id: string }[]>`SELECT t.id FROM football_tickets t JOIN football_matchweeks m ON m.id=t.matchweek_id WHERE t.user_id=${userId} AND t.settled_at IS NULL AND m.full_time_at<=clock_timestamp() ORDER BY m.opens_at,t.id LIMIT 50`;
    for (const row of pending) await settleTicket(row.id);

    return db.$transaction(async (tx) => {
      await account(tx, userId);
      const [wallet] = await tx.$queryRaw<{ balance: bigint }[]>`SELECT balance FROM football_accounts WHERE user_id=${userId} FOR SHARE`;
      const now = await clock(tx);
      const nowMs = now.getTime();
      const cycle = cycleAt(nowMs);
      if (!cycle) throw reasoned(503, 'The league has not started', 'CLOSED');
      const [currentRow] = await tx.$queryRaw<MatchweekRow[]>`SELECT * FROM football_matchweeks WHERE id=${matchweekId(cycle.seasonNo, cycle.weekNo)}`;
      const [latestRow] = await tx.$queryRaw<MatchweekRow[]>`SELECT * FROM football_matchweeks WHERE full_time_at<=${now} ORDER BY opens_at DESC LIMIT 1`;
      const current = currentRow ? matchweekView(currentRow, await fixturesOf(tx, currentRow.id), nowMs) : null;
      const latestCompleted = latestRow ? matchweekView(latestRow, await fixturesOf(tx, latestRow.id), nowMs) : null;

      let viewed: VfViewedWeek | null = null;
      if (view) {
        const target = cycleBySeasonWeek(view.seasonNo, view.weekNo);
        const scheduled = scheduledWeek(view.seasonNo, view.weekNo);
        const [row] = await tx.$queryRaw<MatchweekRow[]>`SELECT * FROM football_matchweeks WHERE id=${matchweekId(view.seasonNo, view.weekNo)}`;
        viewed = {
          seasonNo: view.seasonNo,
          weekNo: view.weekNo,
          opensAt: target.opensAt,
          scheduled,
          // The stored row is authoritative. Without one, a future cycle is "future" and an
          // elapsed (or closed) cycle was never committed, i.e. missed and never fabricated.
          state: row ? 'AVAILABLE' : target.opensAt > nowMs ? 'FUTURE' : 'NOT_PLAYED',
          matchweek: row ? matchweekView(row, await fixturesOf(tx, row.id), nowMs) : null,
        };
      }

      const seasonNo = viewed?.seasonNo ?? cycle.seasonNo;
      const throughWeek = viewed?.weekNo ?? 38;
      const results = await tx.$queryRaw<{ home_club: number; away_club: number; ft_home: number; ft_away: number; match_id: string }[]>`SELECT f.home_club,f.away_club,f.ft_home,f.ft_away,m.id AS match_id FROM football_fixtures f JOIN football_matchweeks m ON m.id=f.matchweek_id WHERE m.season_no=${seasonNo} AND m.week_no<=${throughWeek} AND m.full_time_at<=${now}`;
      const finished: FinishedMatch[] = results.map((r) => ({ homeClub: r.home_club, awayClub: r.away_club, ftHome: r.ft_home, ftAway: r.ft_away }));
      const seasons = await tx.$queryRaw<{ season_no: number; weeks: bigint }[]>`SELECT season_no,count(*) FILTER (WHERE full_time_at<=${now}) AS weeks FROM football_matchweeks GROUP BY season_no ORDER BY season_no DESC LIMIT 20`;
      return {
        rulesId: VF_RULES_ID,
        rulesDigest: VF_RULES_DIGEST,
        serverTime: nowMs,
        balance: Number(wallet.balance),
        cycle: { ...cycle, phase: phaseAt(cycle, nowMs) as VfSnapshot['cycle']['phase'] },
        current,
        latestCompleted,
        viewed,
        standings: { seasonNo, weeksCompleted: new Set(results.map((r) => r.match_id)).size, rows: computeStandings(finished) },
        seasons: seasons.map((s) => ({ seasonNo: s.season_no, weeksCompleted: Number(s.weeks) })),
        tickets: await ticketViews(tx, userId, now),
      };
    });
  }

  /* ---------------------------------------------------------------------------------- *
   * Admission
   * ---------------------------------------------------------------------------------- */
  async function admit(userId: string, body: unknown): Promise<VfAdmission> {
    let input;
    try {
      input = parseTicketInput(body);
    } catch (error) {
      if (error instanceof TicketRuleError) throw ruleError(error);
      throw error;
    }
    const requestHash = ticketRequestHash(input);
    return db.$transaction(async (tx) => {
      await account(tx, userId);
      // Serialises this member's admissions and settlements: no cross-fixture overspend.
      const [wallet] = await tx.$queryRaw<{ balance: bigint }[]>`SELECT balance FROM football_accounts WHERE user_id=${userId} FOR UPDATE`;
      const [prior] = await tx.$queryRaw<TicketRow[]>`SELECT * FROM football_tickets WHERE user_id=${userId} AND idempotency_key=${input.idempotencyKey}`;
      if (prior) {
        if (prior.request_hash !== requestHash)
          throw reasoned(409, 'This receipt key was used for a different ticket', 'RECEIPT_CONFLICT');
        const [ticket] = await ticketViews(tx, userId, await clock(tx), prior.id);
        return { accepted: true as const, isReplay: true, ticket };
      }
      const [mw] = await tx.$queryRaw<MatchweekRow[]>`SELECT * FROM football_matchweeks WHERE id=${input.matchweekId}`;
      if (!mw) throw reasoned(404, 'Matchweek not found', 'MATCHWEEK_NOT_FOUND');
      const fixtures = await fixturesOf(tx, mw.id);
      const byId = new Map(fixtures.map((f) => [f.id, f]));
      // The stored price digest must equal what this code computes, or rules have drifted.
      for (const f of fixtures)
        if (fixtureOffer(paramsOf(f)).digest !== f.offer_digest)
          throw reasoned(503, 'Prices are being updated. Please refresh.', 'RULES_STALE');
      if (mw.rules_id !== VF_RULES_ID || mw.rules_digest !== VF_RULES_DIGEST)
        throw reasoned(503, 'Prices are being updated. Please refresh.', 'RULES_STALE');
      const opened = await clock(tx);
      if (opened < mw.opens_at || opened >= mw.kickoff_at) throw reasoned(409, 'Selections have closed for this matchweek', 'CLOSED');
      let priced;
      try {
        priced = priceTicket(input, (id) => {
          const f = byId.get(id);
          return f ? paramsOf(f) : null;
        });
      } catch (error) {
        if (error instanceof TicketRuleError) throw ruleError(error);
        throw error;
      }
      if (wallet.balance < BigInt(priced.totalStake)) throw reasoned(400, 'Insufficient practice credits', 'INSUFFICIENT_CREDITS');
      const [{ count }] = await tx.$queryRaw<{ count: bigint }[]>`SELECT count(*) AS count FROM football_tickets WHERE user_id=${userId} AND matchweek_id=${mw.id}`;
      if (Number(count) >= VF_LIMITS.maxTicketsPerMatchweek) throw reasoned(409, 'Ticket limit reached for this matchweek', 'TICKET_LIMIT');
      const used = [...new Set(priced.lines.flatMap((l) => l.legs.map((g) => g.fixtureId)))];
      const ticketId = randomUUID();
      const receipt = receiptHash({
        requestHash,
        matchweekId: mw.id,
        totalStake: priced.totalStake,
        offerDigests: Object.fromEntries(used.map((id) => [id, byId.get(id)!.offer_digest])),
      });
      const legCount = priced.lines.reduce((n, l) => n + l.legs.length, 0);
      await tx.$executeRaw`INSERT INTO football_tickets(id,user_id,matchweek_id,idempotency_key,request_hash,receipt_hash,rules_id,rules_digest,line_count,leg_count,total_stake) VALUES(${ticketId},${userId},${mw.id},${input.idempotencyKey},${requestHash},${receipt},${VF_RULES_ID},${VF_RULES_DIGEST},${priced.lines.length},${legCount},${priced.totalStake})`;
      for (const [index, line] of priced.lines.entries()) {
        await tx.$executeRaw`INSERT INTO football_ticket_lines(ticket_id,line_no,kind,stake,leg_count,odds_product,max_return) VALUES(${ticketId},${index + 1},${line.kind},${line.stake},${line.legs.length},${line.oddsProduct.toString()}::numeric,${line.maxReturn})`;
        for (const [legIndex, leg] of line.legs.entries())
          await tx.$executeRaw`INSERT INTO football_ticket_legs(ticket_id,line_no,leg_no,fixture_id,selection,odds_cents) VALUES(${ticketId},${index + 1},${legIndex + 1},${leg.fixtureId},${leg.selection},${leg.oddsCents})`;
      }
      await tx.$executeRaw`UPDATE football_accounts SET balance=balance-${priced.totalStake} WHERE user_id=${userId}`;
      // Re-check the cutoff after every write and lock wait, on the database clock.
      if ((await clock(tx)) >= mw.kickoff_at) throw reasoned(409, 'Selections have closed for this matchweek', 'CLOSED');
      await flush(tx);
      const [ticket] = await ticketViews(tx, userId, await clock(tx), ticketId);
      return { accepted: true as const, isReplay: false, ticket };
    });
  }

  return { snapshot, admit, tick, ensureMatchweek, settleTicket, clubs: VF_CLUBS };
}
