import { describe, expect, it } from 'vitest';
import {
  TicketRuleError,
  VF_CLUBS,
  VF_LIMITS,
  VF_RULES_ID,
  combinedOddsCents,
  fixtureOffer,
  linePayout,
  oddsProduct,
  parseTicketInput,
  priceTicket,
  receiptHash,
  settleLine,
  ticketRequestHash,
  type FixtureParams,
  type Outcome,
  type TicketErrorCode,
  type TicketInput,
} from './index.js';

const MW = 'vf-s1-w05';
const fx = (n: number) => `${MW}-f${String(n).padStart(2, '0')}`;
const params: Record<string, FixtureParams> = {};
for (let n = 1; n <= 10; n++) {
  const h = VF_CLUBS[n - 1];
  const a = VF_CLUBS[n + 9];
  params[fx(n)] = {
    homeAttack: h.attack,
    homeDefence: h.defence,
    awayAttack: a.attack,
    awayDefence: a.defence,
  };
}
const lookup = (id: string) => params[id] ?? null;
const odds = (n: number, selection: string) =>
  fixtureOffer(params[fx(n)]).byId.get(selection)!.oddsCents!;
const leg = (n: number, selection: string) => ({
  fixtureId: fx(n),
  selection,
  oddsCents: odds(n, selection),
});
const KEY = 'a1b2c3d4e5f6a7b8c9d0';
const base = (lines: TicketInput['lines']): TicketInput => ({
  idempotencyKey: KEY,
  matchweekId: MW,
  rulesId: VF_RULES_ID,
  lines,
});
const code = (fn: () => unknown): TicketErrorCode | 'NO_ERROR' => {
  try {
    fn();
    return 'NO_ERROR';
  } catch (e) {
    if (e instanceof TicketRuleError) return e.code;
    throw e;
  }
};

describe('ticket shape', () => {
  it('accepts a bundle of independent singles and multiples with their own stakes', () => {
    const ticket = parseTicketInput(
      base([
        { kind: 'SINGLE', stake: 10, legs: [leg(1, 'FT:1')] },
        { kind: 'SINGLE', stake: 20, legs: [leg(2, 'OU:2.5:O')] },
        {
          kind: 'MULTIPLE',
          stake: 15,
          legs: [leg(1, 'FT:1'), leg(2, 'FT:2'), leg(3, 'BTTS:FT:Y')],
        },
      ])
    );
    expect(ticket.lines).toHaveLength(3);
    const priced = priceTicket(ticket, lookup);
    expect(priced.totalStake).toBe(45);
    expect(priced.lines[2].oddsProduct).toBe(
      oddsProduct(ticket.lines[2].legs.map((l) => l.oddsCents))
    );
  });

  const rejects: Array<[string, TicketErrorCode, unknown]> = [
    ['non-object', 'BAD_SHAPE', 7],
    [
      'extra ticket field',
      'BAD_SHAPE',
      { ...base([{ kind: 'SINGLE', stake: 10, legs: [leg(1, 'FT:1')] }]), userId: 'x' },
    ],
    [
      'short key',
      'BAD_SHAPE',
      { ...base([{ kind: 'SINGLE', stake: 10, legs: [leg(1, 'FT:1')] }]), idempotencyKey: 'short' },
    ],
    [
      'key characters',
      'BAD_SHAPE',
      {
        ...base([{ kind: 'SINGLE', stake: 10, legs: [leg(1, 'FT:1')] }]),
        idempotencyKey: 'a'.repeat(15) + '!',
      },
    ],
    [
      'stale rules id',
      'RULES_MISMATCH',
      { ...base([{ kind: 'SINGLE', stake: 10, legs: [leg(1, 'FT:1')] }]), rulesId: 'old' },
    ],
    [
      'bad matchweek',
      'BAD_SHAPE',
      {
        ...base([{ kind: 'SINGLE', stake: 10, legs: [leg(1, 'FT:1')] }]),
        matchweekId: 'vf-s1-w99',
      },
    ],
    ['no lines', 'BAD_SHAPE', base([])],
    [
      'too many lines',
      'BAD_SHAPE',
      base(
        Array.from({ length: 9 }, (_, i) => ({
          kind: 'SINGLE' as const,
          stake: 5,
          legs: [leg(1, i % 2 ? 'FT:X' : 'FT:2')],
        }))
      ),
    ],
    [
      'fractional stake',
      'BAD_SHAPE',
      base([{ kind: 'SINGLE', stake: 10.5, legs: [leg(1, 'FT:1')] }]),
    ],
    [
      'below minimum stake',
      'STAKE_LIMIT',
      base([{ kind: 'SINGLE', stake: 4, legs: [leg(1, 'FT:1')] }]),
    ],
    [
      'above maximum stake',
      'STAKE_LIMIT',
      base([{ kind: 'SINGLE', stake: 501, legs: [leg(1, 'FT:1')] }]),
    ],
    [
      'ticket stake above bound',
      'STAKE_LIMIT',
      base([
        { kind: 'SINGLE', stake: 500, legs: [leg(1, 'FT:1')] },
        { kind: 'SINGLE', stake: 500, legs: [leg(2, 'FT:1')] },
        { kind: 'SINGLE', stake: 5, legs: [leg(3, 'FT:1')] },
      ]),
    ],
    [
      'single with two legs',
      'MULTIPLE_SHAPE',
      base([{ kind: 'SINGLE', stake: 10, legs: [leg(1, 'FT:1'), leg(2, 'FT:1')] }]),
    ],
    [
      'multiple with one leg',
      'MULTIPLE_SHAPE',
      base([{ kind: 'MULTIPLE', stake: 10, legs: [leg(1, 'FT:1')] }]),
    ],
    [
      'six-leg multiple',
      'MULTIPLE_SHAPE',
      base([{ kind: 'MULTIPLE', stake: 10, legs: [1, 2, 3, 4, 5, 6].map((n) => leg(n, 'FT:1')) }]),
    ],
    [
      'two selections from one match',
      'DUPLICATE_LEG',
      base([{ kind: 'MULTIPLE', stake: 10, legs: [leg(1, 'FT:1'), leg(1, 'OU:2.5:O')] }]),
    ],
    [
      'same selection twice',
      'DUPLICATE_LEG',
      base([{ kind: 'MULTIPLE', stake: 10, legs: [leg(1, 'FT:1'), leg(1, 'FT:1')] }]),
    ],
    [
      'duplicate single lines',
      'DUPLICATE_LINE',
      base([
        { kind: 'SINGLE', stake: 10, legs: [leg(1, 'FT:1')] },
        { kind: 'SINGLE', stake: 20, legs: [leg(1, 'FT:1')] },
      ]),
    ],
    [
      'duplicate multiples in another order',
      'DUPLICATE_LINE',
      base([
        { kind: 'MULTIPLE', stake: 10, legs: [leg(1, 'FT:1'), leg(2, 'FT:2')] },
        { kind: 'MULTIPLE', stake: 10, legs: [leg(2, 'FT:2'), leg(1, 'FT:1')] },
      ]),
    ],
    [
      'leg from another matchweek',
      'STALE_FIXTURE',
      base([
        { kind: 'SINGLE', stake: 10, legs: [{ ...leg(1, 'FT:1'), fixtureId: 'vf-s1-w06-f01' }] },
      ]),
    ],
    [
      'unknown selection',
      'UNAVAILABLE_SELECTION',
      base([{ kind: 'SINGLE', stake: 10, legs: [{ ...leg(1, 'FT:1'), selection: 'FT:H' }] }]),
    ],
    [
      'odds as string',
      'BAD_SHAPE',
      base([
        {
          kind: 'SINGLE',
          stake: 10,
          legs: [{ ...leg(1, 'FT:1'), oddsCents: '200' as unknown as number }],
        },
      ]),
    ],
    [
      'extra leg field',
      'BAD_SHAPE',
      base([{ kind: 'SINGLE', stake: 10, legs: [{ ...leg(1, 'FT:1'), payout: 99999 } as never] }]),
    ],
    [
      'too many legs overall',
      'BAD_SHAPE',
      base([
        ...['FT:1', 'FT:X', 'FT:2', 'HT:1'].map((sel): TicketInput['lines'][number] => ({
          kind: 'MULTIPLE',
          stake: 5,
          legs: [1, 2, 3, 4, 5].map((n) => leg(n, sel)),
        })),
        { kind: 'SINGLE', stake: 5, legs: [leg(6, 'FT:1')] },
      ]),
    ],
  ];
  it.each(rejects)('rejects %s', (_name, expected, input) => {
    expect(code(() => parseTicketInput(input))).toBe(expected);
  });
});

describe('pricing and limits', () => {
  it('refuses a moved price, an unavailable selection and foreign fixtures', () => {
    const t = parseTicketInput(
      base([
        {
          kind: 'SINGLE',
          stake: 10,
          legs: [{ ...leg(1, 'FT:1'), oddsCents: odds(1, 'FT:1') + 1 }],
        },
      ])
    );
    expect(code(() => priceTicket(t, lookup))).toBe('PRICE_CHANGED');
    // At least one fixture has a selection priced below the minimum: it must be refused, not re-priced.
    const blocked = Object.keys(params)
      .map((id) => ({
        id,
        price: [...fixtureOffer(params[id]).byId.values()].find((p) => p.oddsCents === null),
      }))
      .find((x) => x.price);
    expect(blocked).toBeDefined();
    const bad: TicketInput = base([
      {
        kind: 'SINGLE',
        stake: 10,
        legs: [{ fixtureId: blocked!.id, selection: blocked!.price!.id, oddsCents: 200 }],
      },
    ]);
    expect(code(() => priceTicket(bad, lookup))).toBe('UNAVAILABLE_SELECTION');
    const ok = parseTicketInput(base([{ kind: 'SINGLE', stake: 10, legs: [leg(1, 'FT:1')] }]));
    expect(code(() => priceTicket(ok, () => null))).toBe('STALE_FIXTURE');
  });

  it('computes returns in integers with one floor and no intermediate rounding', () => {
    expect(linePayout(10, 250n, 1)).toBe(25n);
    expect(linePayout(10, 333n, 1)).toBe(33n); // 33.3 -> 33
    // Two legs 3.33 * 2.51 = 8.3583; stake 10 -> 83.583 -> 83 (single floor).
    expect(linePayout(10, 333n * 251n, 2)).toBe(83n);
    expect(combinedOddsCents(333n * 251n, 2)).toBe(835n); // displayed, rounded down
    expect(linePayout(7, 123n * 456n * 789n, 3)).toBe((7n * 123n * 456n * 789n) / 1_000_000n);
    expect(oddsProduct([])).toBe(1n);
  });

  it('rejects over-long odds and returns before any debit instead of capping', () => {
    const longshots = ['SCORE:6-0', 'SCORE:5-1', 'SCORE:0-6', 'SCORE:1-5', 'SCORE:0-5'];
    const legs = longshots.map((s, i) => leg(i + 1, s));
    const t = parseTicketInput(base([{ kind: 'MULTIPLE', stake: 5, legs }]));
    expect(code(() => priceTicket(t, lookup))).toBe('ODDS_LIMIT');
    const single = parseTicketInput(
      base([{ kind: 'SINGLE', stake: 500, legs: [leg(1, 'SCORE:0-6')] }])
    );
    const p = fixtureOffer(params[fx(1)]).byId.get('SCORE:0-6')!.oddsCents!;
    expect(500 * p).toBeGreaterThan(VF_LIMITS.maxLineReturn * 100);
    expect(code(() => priceTicket(single, lookup))).toBe('RETURN_LIMIT');
    // Lines that each fit under the line bound but together exceed the ticket bound.
    const lineOdds = (n: number, sel: string) => odds(n, sel);
    const stakeFor = (o: number) => Math.floor((VF_LIMITS.maxLineReturn * 100) / o);
    const picks: Array<[number, string]> = [
      [1, 'SCORE:0-6'],
      [2, 'SCORE:0-6'],
      [3, 'SCORE:0-6'],
    ];
    const together = parseTicketInput(
      base(
        picks.map(([n, sel]) => ({
          kind: 'SINGLE' as const,
          stake: Math.min(500, stakeFor(lineOdds(n, sel))),
          legs: [leg(n, sel)],
        }))
      )
    );
    for (const l of together.lines)
      expect(Number(linePayout(l.stake, BigInt(l.legs[0].oddsCents), 1))).toBeLessThanOrEqual(
        VF_LIMITS.maxLineReturn
      );
    const sum = together.lines.reduce(
      (n, l) => n + Number(linePayout(l.stake, BigInt(l.legs[0].oddsCents), 1)),
      0
    );
    expect(sum).toBeGreaterThan(VF_LIMITS.maxTicketReturn);
    expect(code(() => priceTicket(together, lookup))).toBe('RETURN_LIMIT');
  });

  it('keeps a valid maximum-size ticket within every documented bound', () => {
    const t = parseTicketInput(
      base([
        {
          kind: 'MULTIPLE',
          stake: 5,
          legs: [
            leg(1, 'FT:1'),
            leg(2, 'FT:2'),
            leg(3, 'HT:X'),
            leg(4, 'BTTS:FT:N'),
            leg(5, 'OU:2.5:U'),
          ],
        },
        { kind: 'SINGLE', stake: 5, legs: [leg(1, 'FT:X')] },
      ])
    );
    const priced = priceTicket(t, lookup);
    for (const line of priced.lines) {
      expect(line.maxReturn).toBeLessThanOrEqual(VF_LIMITS.maxLineReturn);
      expect(line.combinedOddsCents).toBeLessThanOrEqual(VF_LIMITS.maxCombinedOddsCents);
    }
    expect(priced.totalMaxReturn).toBeLessThanOrEqual(VF_LIMITS.maxTicketReturn);
  });
});

describe('canonical identity and settlement', () => {
  const a = parseTicketInput(
    base([
      { kind: 'SINGLE', stake: 10, legs: [leg(1, 'FT:1')] },
      { kind: 'SINGLE', stake: 12, legs: [leg(2, 'FT:2')] },
    ])
  );

  it('hashes the request independent of the key, but sensitive to order, stakes, picks and prices', () => {
    const h = ticketRequestHash(a);
    expect(ticketRequestHash({ ...a, idempotencyKey: 'ffffffffffffffffffff' })).toBe(h);
    expect(ticketRequestHash({ ...a, lines: [a.lines[1], a.lines[0]] })).not.toBe(h);
    expect(ticketRequestHash({ ...a, lines: [{ ...a.lines[0], stake: 11 }, a.lines[1]] })).not.toBe(
      h
    );
    expect(
      ticketRequestHash({ ...a, lines: [{ ...a.lines[0], legs: [leg(1, 'FT:X')] }, a.lines[1]] })
    ).not.toBe(h);
    expect(
      ticketRequestHash({
        ...a,
        lines: [
          {
            ...a.lines[0],
            legs: [{ ...a.lines[0].legs[0], oddsCents: a.lines[0].legs[0].oddsCents + 1 }],
          },
          a.lines[1],
        ],
      })
    ).not.toBe(h);
    expect(ticketRequestHash({ ...a, matchweekId: 'vf-s1-w06' })).not.toBe(h);
  });

  it('binds receipts to the request, totals and every fixture offer digest', () => {
    const digests = {
      [fx(1)]: fixtureOffer(params[fx(1)]).digest,
      [fx(2)]: fixtureOffer(params[fx(2)]).digest,
    };
    const r = receiptHash({
      requestHash: ticketRequestHash(a),
      matchweekId: MW,
      totalStake: 22,
      offerDigests: digests,
    });
    expect(r).toMatch(/^[a-f0-9]{64}$/);
    expect(
      receiptHash({
        requestHash: ticketRequestHash(a),
        matchweekId: MW,
        totalStake: 23,
        offerDigests: digests,
      })
    ).not.toBe(r);
    expect(
      receiptHash({
        requestHash: ticketRequestHash(a),
        matchweekId: MW,
        totalStake: 22,
        offerDigests: { ...digests, [fx(2)]: 'x' },
      })
    ).not.toBe(r);
  });

  it('settles a line only if every selection wins, with the exact integer payout', () => {
    const outcomes: Record<string, Outcome> = {
      [fx(1)]: { ftHome: 2, ftAway: 0, htHome: 1, htAway: 0, first: 'H' },
      [fx(2)]: { ftHome: 0, ftAway: 0, htHome: 0, htAway: 0, first: 'N' },
      [fx(3)]: { ftHome: 1, ftAway: 3, htHome: 1, htAway: 1, first: 'H' },
    };
    const line = (
      legs: Array<{ fixtureId: string; selection: string }>,
      stake: number,
      o: number[]
    ) => ({ stake, oddsProduct: oddsProduct(o), legs });
    expect(
      settleLine(line([{ fixtureId: fx(1), selection: 'FT:1' }], 10, [250]), (id) => outcomes[id])
    ).toBe(25);
    expect(
      settleLine(
        line(
          [
            { fixtureId: fx(1), selection: 'FT:1' },
            { fixtureId: fx(2), selection: 'FT:X' },
          ],
          10,
          [250, 300]
        ),
        (id) => outcomes[id]
      )
    ).toBe(75);
    expect(
      settleLine(
        line(
          [
            { fixtureId: fx(1), selection: 'FT:1' },
            { fixtureId: fx(2), selection: 'FT:1' },
          ],
          10,
          [250, 300]
        ),
        (id) => outcomes[id]
      )
    ).toBe(0);
    expect(
      settleLine(
        line([{ fixtureId: fx(3), selection: 'HTFT:X/2' }], 10, [800]),
        (id) => outcomes[id]
      )
    ).toBe(80);
    expect(() =>
      settleLine(line([{ fixtureId: fx(3), selection: 'NOPE' }], 10, [800]), (id) => outcomes[id])
    ).toThrow();
  });
});
