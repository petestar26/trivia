import { describe, expect, it } from 'vitest';
import type { SkyCrashLeaderboard } from '@socialplay/shared';
import { parseDashboardReturns, topDashboardReturns } from './dashboard-returns';

const receipt = (overrides: Record<string, unknown> = {}) => ({
  player: 'Player abcdef0123',
  roundId: 'sky-minute-29800000',
  stake: 25,
  payout: 50,
  paidCents: 200,
  ...overrides,
});
const feed = (tickets: unknown[] = [receipt()]) => ({ period: '24h', tickets });

describe('dashboard return feed', () => {
  it('accepts an empty rolling 24-hour feed', () => {
    expect(parseDashboardReturns(feed([]))).toEqual({ period: '24h', tickets: [] });
  });

  it('clones the public projection without retaining additive account fields', () => {
    const input = {
      ...feed([receipt({ userId: 'private', autoCents: 200, seed: 'private' })]),
      future: true,
    };
    const parsed = parseDashboardReturns(input);
    expect(parsed).toEqual(feed());
    expect(parsed).not.toBe(input);
    expect(parsed.tickets).not.toBe(input.tickets);
    expect(parsed.tickets[0]).not.toBe(input.tickets[0]);
    Object.assign(input.tickets[0] as object, { payout: 999 });
    expect(parsed.tickets[0].payout).toBe(50);
  });

  it.each([
    { stake: 10, payout: 10, paidCents: 100 },
    { stake: 500, payout: 10000, paidCents: 2000 },
    { payout: Number.MAX_SAFE_INTEGER },
  ])('accepts inclusive protocol bounds %j', (bounds) => {
    expect(parseDashboardReturns(feed([receipt(bounds)])).tickets).toHaveLength(1);
  });

  it('accepts exactly fifty tickets without modifying server order', () => {
    const input = feed(
      Array.from({ length: 50 }, (_, index) => receipt({ roundId: `round-${index}` }))
    );
    expect(parseDashboardReturns(input).tickets).toEqual(input.tickets);
  });

  it.each([
    null,
    undefined,
    [],
    'feed',
    {},
    { period: '24h' },
    { tickets: [] },
    { period: 'today', tickets: [] },
    { period: '1m', tickets: [] },
    { period: '24h', tickets: null },
    { period: '24h', tickets: {} },
    feed(Array.from({ length: 51 }, (_, index) => receipt({ roundId: `round-${index}` }))),
    feed([null]),
    feed([[]]),
    feed([{}]),
  ])('rejects a malformed feed %j', (input) => {
    expect(() => parseDashboardReturns(input)).toThrow('Top returns response');
  });

  it.each([
    { player: '' },
    { player: ' ' },
    { player: ' Player abcd' },
    { player: 'Player abcd ' },
    { player: 'p'.repeat(81) },
    { player: 'Player\n123' },
    { player: 7 },
    { roundId: '' },
    { roundId: 'r'.repeat(65) },
    { roundId: '\tround' },
    { roundId: null },
    { stake: 9 },
    { stake: 501 },
    { stake: 10.5 },
    { stake: '25' },
    { stake: NaN },
    { payout: 0 },
    { payout: -1 },
    { payout: 1.5 },
    { payout: Infinity },
    { payout: Number.MAX_SAFE_INTEGER + 1 },
    { payout: '50' },
    { payout: null },
    { paidCents: 99 },
    { paidCents: 2001 },
    { paidCents: 100.5 },
    { paidCents: '200' },
  ])('rejects malformed ticket fields %j', (changes) => {
    expect(() => parseDashboardReturns(feed([receipt(changes)]))).toThrow('Top returns response');
  });

  it.each(['player', 'roundId', 'stake', 'payout', 'paidCents'])(
    'requires the %s field',
    (field) => {
      const incomplete: Record<string, unknown> = receipt();
      delete incomplete[field];
      expect(() => parseDashboardReturns(feed([incomplete]))).toThrow();
    }
  );

  it('rejects the entire feed if a later receipt is malformed', () => {
    expect(() =>
      parseDashboardReturns(feed([receipt(), receipt({ roundId: 'later', payout: null })]))
    ).toThrow();
  });

  it('rejects duplicate round/pseudonym receipt identities', () => {
    expect(() => parseDashboardReturns(feed([receipt(), receipt({ payout: 100 })]))).toThrow(
      'duplicate tickets'
    );
  });

  it('does not treat equal pseudonyms across rounds or multiple receipts in a round as one player', () => {
    expect(
      parseDashboardReturns(
        feed([
          receipt(),
          receipt({ roundId: 'another-round' }),
          receipt({ player: 'Player 9876543210' }),
        ])
      ).tickets
    ).toHaveLength(3);
  });
});

describe('dashboard top returns', () => {
  it('takes ten greatest returns and preserves the server order for ties', () => {
    const input = parseDashboardReturns(
      feed(
        Array.from({ length: 15 }, (_, index) =>
          receipt({
            roundId: `round-${index}`,
            payout: index % 3 === 0 ? 100 : 50,
          })
        )
      )
    );
    const original = structuredClone(input);
    const top = topDashboardReturns(input);
    expect(top).toHaveLength(10);
    expect(top.map((ticket) => ticket.roundId)).toEqual([
      'round-0',
      'round-3',
      'round-6',
      'round-9',
      'round-12',
      'round-1',
      'round-2',
      'round-4',
      'round-5',
      'round-7',
    ]);
    expect(input).toEqual(original);
    top[0].payout = 1;
    expect(input.tickets[0].payout).toBe(100);
  });

  it('handles empty and short feeds without creating winners', () => {
    expect(topDashboardReturns({ period: '24h', tickets: [] })).toEqual([]);
    const input = parseDashboardReturns(feed());
    expect(topDashboardReturns(input)).toEqual(input.tickets);
  });

  it('sorts a typed feed without reordering or retaining its entry objects', () => {
    const input: SkyCrashLeaderboard = {
      period: '24h',
      tickets: [receipt({ payout: 25 }), receipt({ roundId: 'other', payout: 100 })],
    };
    const top = topDashboardReturns(input);
    expect(top.map((ticket) => ticket.payout)).toEqual([100, 25]);
    expect(input.tickets.map((ticket) => ticket.payout)).toEqual([25, 100]);
    expect(top[0]).not.toBe(input.tickets[1]);
  });
});
