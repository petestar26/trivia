import { describe, expect, it, vi } from 'vitest';
import {
  VF_RULES_DIGEST,
  VF_RULES_ID,
  VF_TIMING,
  cycleByIndex,
  fixtureOffer,
  ticketRequestHash,
} from '@socialplay/shared';
import { createFootballService } from './service.js';

/** A fake database whose clock we control; any insert path would call $transaction. */
function fakeDb(nowMs: number, existing = false) {
  const transaction = vi.fn(async () => undefined);
  const queryRaw = vi.fn(async (parts: TemplateStringsArray) => {
    const sql = parts.join('?');
    if (sql.includes('clock_timestamp')) return [{ now: new Date(nowMs) }];
    if (sql.includes('FROM football_matchweeks WHERE id=')) return existing ? [{ id: 'x' }] : [];
    return [];
  });
  return { db: { $queryRaw: queryRaw, $transaction: transaction } as never, transaction, queryRaw };
}
const cycle = cycleByIndex(100);

describe('matchweek creation window', () => {
  it('creates nothing before the league anchor', async () => {
    const { db, transaction } = fakeDb(VF_TIMING.anchorMs - 1);
    await createFootballService(db).ensureMatchweek();
    expect(transaction).not.toHaveBeenCalled();
  });

  it.each([
    ['exactly at kickoff', cycle.kickoffAt],
    ['during the first half', cycle.kickoffAt + 5_000],
    ['at half-time', cycle.halftimeAt],
    ['in the second half', cycle.secondHalfAt + 10_000],
    ['at full time', cycle.fullTimeAt],
    ['in the results window', cycle.fullTimeAt + 5_000],
    ['at the last millisecond of the cycle', cycle.endsAt - 1],
  ])('never creates a missed week %s (no retroactive commitment)', async (_name, at) => {
    const { db, transaction } = fakeDb(at);
    await createFootballService(db).ensureMatchweek();
    expect(transaction).not.toHaveBeenCalled();
  });

  it.each([
    ['the instant the window opens', cycle.opensAt],
    ['mid-window', cycle.opensAt + 100_000],
    ['the last millisecond before kickoff', cycle.kickoffAt - 1],
  ])('attempts creation %s', async (_name, at) => {
    const { db, transaction } = fakeDb(at);
    await createFootballService(db).ensureMatchweek();
    expect(transaction).toHaveBeenCalledOnce();
  });

  it('does not try again once the week already exists', async () => {
    const { db, transaction } = fakeDb(cycle.opensAt + 1_000, true);
    await createFootballService(db).ensureMatchweek();
    expect(transaction).not.toHaveBeenCalled();
  });

  it('treats a window that closed during the insert as a missed week, but surfaces real failures', async () => {
    const closed = fakeDb(cycle.kickoffAt - 1);
    closed.transaction.mockRejectedValueOnce(
      new Error('Football matchweek can only be committed during its selection window')
    );
    await expect(createFootballService(closed.db).ensureMatchweek()).resolves.toBeUndefined();
    const broken = fakeDb(cycle.opensAt + 1_000);
    broken.transaction.mockRejectedValueOnce(new Error('connection refused'));
    await expect(createFootballService(broken.db).ensureMatchweek()).rejects.toThrow(
      'connection refused'
    );
  });

  it('reports a creation failure from the worker tick without stopping settlement', async () => {
    const { db, transaction } = fakeDb(cycle.opensAt + 1_000);
    transaction.mockRejectedValueOnce(new Error('boom'));
    const errors: string[] = [];
    await createFootballService(db).tick((id) => errors.push(id));
    expect(errors).toEqual(['ensure-matchweek']);
  });
});

/** Exercise the real admission path while advancing the database clock during awaited work. */
function admissionDb(options: {
  crossesAt?: 'flush' | 'receipt';
  offset?: number;
  replay?: boolean;
}) {
  const id = 'vf-s1-w01',
    fixtureId = `${id}-f01`,
    params = { homeAttack: 100, homeDefence: 100, awayAttack: 100, awayDefence: 100 },
    offer = fixtureOffer(params),
    oddsCents = offer.byId.get('FT:1')!.oddsCents!;
  const body = {
    idempotencyKey: 'admissionProbeKey0001',
    matchweekId: id,
    rulesId: VF_RULES_ID,
    lines: [
      { kind: 'SINGLE' as const, stake: 10, legs: [{ fixtureId, selection: 'FT:1', oddsCents }] },
    ],
  };
  const kickoff = cycle.kickoffAt;
  let now = options.replay ? kickoff + 1000 : kickoff - 10;
  const ticket = {
    id: 'accepted-ticket',
    user_id: 'member',
    matchweek_id: id,
    request_hash: ticketRequestHash(body),
    receipt_hash: 'b'.repeat(64),
    rules_id: VF_RULES_ID,
    rules_digest: VF_RULES_DIGEST,
    line_count: 1,
    leg_count: 1,
    total_stake: 10,
    total_return: null,
    settled_at: null,
    created_at: new Date(kickoff - 1000),
  };
  const tx = {
    $queryRaw: vi.fn(async (parts: TemplateStringsArray) => {
      const sql = parts.join('?');
      if (sql.includes('clock_timestamp')) return [{ now: new Date(now) }];
      if (sql.includes('FROM users')) return [{ status: 'ACTIVE' }];
      if (sql.includes('SELECT balance')) return [{ balance: 1000n }];
      if (sql.includes('idempotency_key=')) return options.replay ? [ticket] : [];
      if (sql.includes('FROM football_matchweeks'))
        return [
          {
            id,
            rules_id: VF_RULES_ID,
            rules_digest: VF_RULES_DIGEST,
            opens_at: new Date(cycle.opensAt),
            kickoff_at: new Date(kickoff),
          },
        ];
      if (sql.includes('FROM football_fixtures'))
        return [
          {
            id: fixtureId,
            home_attack: 100,
            home_defence: 100,
            away_attack: 100,
            away_defence: 100,
            offer_digest: offer.digest,
          },
        ];
      if (sql.includes('count(*) AS count')) return [{ count: 0n }];
      if (sql.includes('SELECT * FROM football_tickets')) return [ticket];
      if (sql.includes('FROM football_ticket_lines'))
        return [
          {
            ticket_id: ticket.id,
            line_no: 1,
            kind: 'SINGLE',
            stake: 10,
            leg_count: 1,
            odds_product: { toFixed: () => String(oddsCents) },
            max_return: Math.floor((10 * oddsCents) / 100),
            payout: null,
          },
        ];
      if (sql.includes('FROM football_ticket_legs')) {
        if (options.crossesAt === 'receipt') now = kickoff + (options.offset ?? 0);
        return [
          {
            ticket_id: ticket.id,
            line_no: 1,
            leg_no: 1,
            fixture_id: fixtureId,
            selection: 'FT:1',
            odds_cents: oddsCents,
            ft_home: null,
            ft_away: null,
            ht_home: null,
            ht_away: null,
            first_scorer: null,
          },
        ];
      }
      throw new Error(`Unexpected admission query: ${sql}`);
    }),
    $executeRaw: vi.fn(async (_parts: TemplateStringsArray, ..._values: unknown[]) => 1),
    $executeRawUnsafe: vi.fn(async (sql: string) => {
      if (options.crossesAt === 'flush' && sql.endsWith('IMMEDIATE'))
        now = kickoff + (options.offset ?? 0);
      return 0;
    }),
  };
  const state = { committed: false, rolledBack: false };
  const transaction = vi.fn(async (fn: (value: typeof tx) => Promise<unknown>) => {
    try {
      const result = await fn(tx);
      state.committed = true;
      return result;
    } catch (error) {
      state.rolledBack = true;
      throw error;
    }
  });
  return { db: { $transaction: transaction } as never, tx, state, body };
}

describe('final admission cutoff', () => {
  it.each([
    ['flush', 0],
    ['flush', 1],
    ['receipt', 0],
    ['receipt', 1],
  ] as const)('rejects when %s work finishes %i ms after kickoff', async (crossesAt, offset) => {
    const { db, state, body } = admissionDb({ crossesAt, offset });
    await expect(createFootballService(db).admit('member', body)).rejects.toMatchObject({
      statusCode: 409,
      details: { reason: 'CLOSED' },
    });
    // The refusal occurs inside the transaction, so writes cannot be committed as a success.
    expect(state).toEqual({ committed: false, rolledBack: true });
  });

  it('accepts when the final receipt read still finishes before kickoff', async () => {
    const { db, body } = admissionDb({ crossesAt: 'receipt', offset: -1 });
    await expect(createFootballService(db).admit('member', body)).resolves.toMatchObject({
      accepted: true,
      isReplay: false,
    });
  });

  it('preserves an accepted exact replay after kickoff without another ticket or debit', async () => {
    const { db, tx, body } = admissionDb({ replay: true });
    await expect(createFootballService(db).admit('member', body)).resolves.toMatchObject({
      accepted: true,
      isReplay: true,
      ticket: { id: 'accepted-ticket', requestHash: ticketRequestHash(body) },
    });
    const writes = tx.$executeRaw.mock.calls.map(([parts]) =>
      (parts as TemplateStringsArray).join('?')
    );
    expect(writes).not.toEqual(
      expect.arrayContaining([expect.stringContaining('INSERT INTO football_tickets')])
    );
    expect(writes).not.toEqual(
      expect.arrayContaining([expect.stringContaining('UPDATE football_accounts')])
    );
    expect(tx.$executeRawUnsafe).not.toHaveBeenCalled();
  });
});
