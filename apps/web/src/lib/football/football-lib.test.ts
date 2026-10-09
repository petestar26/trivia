import { describe, expect, it, beforeEach } from 'vitest';
import {
  VF_LIMITS,
  VF_RULES_ID,
  fixtureOffer,
  matchweekId,
  fixtureId,
  type FixtureParams,
  type LiveFixture,
} from '@socialplay/shared';
import { isDefinitiveRefusal, parseFootballError, refusalMessage } from './errors';
import { clearPending, loadPending, newReceiptKey, savePending } from './receipts';
import {
  buildLines,
  emptySlip,
  pickKey,
  previewSlip,
  quoteFor,
  slipReducer,
  stalePicks,
  type Pick,
  type SlipState,
} from './slip';
import { createServerClock } from './clock';
import { displayFixture, GOAL_REVEAL_MS, matchweekRevealAt } from './reveal';
import { formatClock, formatOdds } from './format';

const week = matchweekId(1, 1);
const f = (slot: number) => fixtureId(week, slot);
const params: FixtureParams = {
  homeAttack: 118,
  homeDefence: 112,
  awayAttack: 108,
  awayDefence: 104,
};
const pick = (slot: number, selection: string): Pick => {
  const q = quoteFor(params, selection)!;
  return { fixtureId: f(slot), selection, quotedCents: q.oddsCents!, offerDigest: q.digest };
};
const apply = (state: SlipState, ...actions: Parameters<typeof slipReducer>[1][]) =>
  actions.reduce(slipReducer, state);

describe('error classification', () => {
  const wrap = (status: number, reason?: string) =>
    new Error(
      JSON.stringify({ status, code: 'X', message: 'm', details: reason ? { reason } : undefined })
    );
  it('reads the API error shape', () => {
    expect(parseFootballError(wrap(409, 'CLOSED'))).toMatchObject({
      status: 409,
      reason: 'CLOSED',
    });
    expect(parseFootballError(wrap(409, 'NOT_A_REASON')).reason).toBeNull();
    expect(parseFootballError(new Error('Failed to fetch'))).toMatchObject({
      status: 0,
      reason: null,
    });
    expect(parseFootballError('boom').status).toBe(0);
  });
  it('treats only definitive refusals as safe to discard', () => {
    expect(isDefinitiveRefusal(parseFootballError(wrap(409, 'CLOSED')))).toBe(true);
    expect(isDefinitiveRefusal(parseFootballError(wrap(400, 'STAKE_LIMIT')))).toBe(true);
    expect(isDefinitiveRefusal(parseFootballError(wrap(503, 'RULES_STALE')))).toBe(true);
    expect(isDefinitiveRefusal(parseFootballError(wrap(503)))).toBe(false);
    expect(isDefinitiveRefusal(parseFootballError(wrap(500)))).toBe(false);
    expect(isDefinitiveRefusal(parseFootballError(wrap(429)))).toBe(false);
    expect(isDefinitiveRefusal(parseFootballError(new Error('Request not confirmed')))).toBe(false);
  });
  it('always says whether anything was charged', () => {
    for (const reason of [
      'CLOSED',
      'INSUFFICIENT_CREDITS',
      'PRICE_CHANGED',
      'TICKET_LIMIT',
      'RECEIPT_CONFLICT',
      'STAKE_LIMIT',
    ]) {
      expect(refusalMessage(parseFootballError(wrap(409, reason)))).toMatch(/charged/);
    }
  });
});

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (k) => data.get(k) ?? null,
    key: (i) => [...data.keys()][i] ?? null,
    removeItem: (k) => void data.delete(k),
    setItem: (k, v) => void data.set(k, String(v)),
  };
}
describe('pending receipt store', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      writable: true,
      value: memoryStorage(),
    });
    clearPending('u1');
  });
  const receipt = () => ({
    idempotencyKey: newReceiptKey(),
    matchweekId: week,
    rulesId: VF_RULES_ID,
    lines: [
      {
        kind: 'SINGLE' as const,
        stake: 10,
        legs: [
          { fixtureId: f(1), selection: 'FT:1', oddsCents: quoteFor(params, 'FT:1')!.oddsCents! },
        ],
      },
    ],
  });
  it('round-trips the identical payload per user', () => {
    const r = receipt();
    savePending('u1', r);
    expect(loadPending('u1')).toEqual(r);
    expect(loadPending('u2')).toBeNull();
    clearPending('u1');
    expect(loadPending('u1')).toBeNull();
  });
  it('refuses to guess at a damaged or tampered record', () => {
    localStorage.setItem('playqube.vf3d.pending.u1', JSON.stringify({ ...receipt(), lines: [] }));
    expect(loadPending('u1')).toBe('unreadable');
    expect(loadPending('u1')).toBeNull();
    localStorage.setItem('playqube.vf3d.pending.u1', '{nope');
    expect(loadPending('u1')).toBe('unreadable');
  });
  it('still protects the session when storage is unavailable', () => {
    const real = Object.getOwnPropertyDescriptor(window, 'localStorage')!;
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get: () => {
        throw new Error('blocked');
      },
    });
    try {
      const r = receipt();
      savePending('u1', r);
      expect(loadPending('u1')).toEqual(r);
    } finally {
      Object.defineProperty(window, 'localStorage', real);
    }
  });
  it('makes keys the server accepts, and never repeats', () => {
    const keys = new Set(Array.from({ length: 50 }, newReceiptKey));
    expect(keys.size).toBe(50);
    for (const k of keys) expect(k).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
  });
});

describe('slip reducer', () => {
  const base = emptySlip(week);
  it('adds, toggles off, and gives each pick a default single stake', () => {
    const a = apply(base, { type: 'toggle', pick: pick(1, 'FT:1') });
    expect(a.picks).toHaveLength(1);
    expect(buildLines(a)).toMatchObject([{ kind: 'SINGLE', stake: 10 }]);
    expect(apply(a, { type: 'toggle', pick: pick(1, 'FT:1') }).picks).toHaveLength(0);
  });
  it('builds a multiple only from distinct fixtures within 2–5 legs', () => {
    let s = apply(
      base,
      ...[1, 2, 3, 4, 5, 6].map((n) => ({ type: 'toggle' as const, pick: pick(n, 'FT:1') })),
      { type: 'toggle', pick: pick(1, 'OU:2.5:O') }
    );
    const keys = (slots: number[]) => slots.map((n) => pickKey(pick(n, 'FT:1')));
    expect(apply(s, { type: 'addMultiple', keys: keys([1]) }).multiples).toHaveLength(0);
    expect(
      apply(s, { type: 'addMultiple', keys: keys([1, 2, 3, 4, 5, 6]) }).multiples
    ).toHaveLength(0);
    expect(
      apply(s, {
        type: 'addMultiple',
        keys: [pickKey(pick(1, 'FT:1')), pickKey(pick(1, 'OU:2.5:O'))],
      }).multiples
    ).toHaveLength(0);
    s = apply(s, { type: 'addMultiple', keys: keys([1, 2, 3]) });
    expect(s.multiples).toHaveLength(1);
    expect(buildLines(s).filter((l) => l.kind === 'MULTIPLE')[0].legs).toHaveLength(3);
  });
  it('dissolves a multiple that loses selections instead of keeping it invalid', () => {
    let s = apply(
      base,
      { type: 'toggle', pick: pick(1, 'FT:1') },
      { type: 'toggle', pick: pick(2, 'FT:1') }
    );
    s = apply(s, {
      type: 'addMultiple',
      keys: [pickKey(pick(1, 'FT:1')), pickKey(pick(2, 'FT:1'))],
    });
    expect(s.multiples).toHaveLength(1);
    expect(apply(s, { type: 'remove', key: pickKey(pick(2, 'FT:1')) }).multiples).toHaveLength(0);
  });
  it('previews returns with the same pricing function the server uses', () => {
    let s = apply(
      base,
      { type: 'toggle', pick: pick(1, 'FT:1') },
      { type: 'toggle', pick: pick(2, 'FT:2') }
    );
    s = apply(s, { type: 'addMultiple', keys: s.picks.map(pickKey) });
    const preview = previewSlip(s, () => params);
    expect(preview.error).toBeNull();
    expect(preview.totalStake).toBe(30);
    const [a, b] = [quoteFor(params, 'FT:1')!.oddsCents!, quoteFor(params, 'FT:2')!.oddsCents!];
    const expected =
      Math.floor((10 * a) / 100) +
      Math.floor((10 * b) / 100) +
      Number((10n * BigInt(a) * BigInt(b)) / 10000n);
    expect(preview.totalMaxReturn).toBe(expected);
  });
  it('reports limits instead of clamping', () => {
    let s = apply(base, { type: 'toggle', pick: pick(1, 'FT:1') });
    s = apply(s, {
      type: 'single',
      key: pickKey(pick(1, 'FT:1')),
      stake: VF_LIMITS.maxLineStake + 1,
    });
    expect(previewSlip(s, () => params).error).toMatch(/stake/i);
    s = apply(s, { type: 'single', key: pickKey(pick(1, 'FT:1')), stake: null });
    expect(previewSlip(s, () => params).error).toMatch(/stake/i);
  });
  it('flags stale quotes and refreshes them only on request', () => {
    const s = apply(base, { type: 'toggle', pick: pick(1, 'FT:1') });
    const same = (fx: string, sel: string) =>
      quoteFor(params, sel) && {
        ...quoteFor(params, sel)!,
        oddsCents: quoteFor(params, sel)!.oddsCents,
      };
    expect(stalePicks(s, same)).toHaveLength(0);
    const moved = () => ({ oddsCents: s.picks[0].quotedCents + 1, digest: s.picks[0].offerDigest });
    expect(stalePicks(s, moved)).toHaveLength(1);
    expect(
      stalePicks(s, () => ({ oddsCents: s.picks[0].quotedCents, digest: 'other' }))
    ).toHaveLength(1);
    expect(stalePicks(s, () => null)).toHaveLength(1);
    const accepted = apply(s, { type: 'acceptPrices', quote: moved });
    expect(accepted.picks[0].quotedCents).toBe(s.picks[0].quotedCents + 1);
    expect(apply(s, { type: 'acceptPrices', quote: () => null }).picks).toHaveLength(0);
  });
  it('caps the slip at the ticket leg limit', () => {
    let s = base;
    const sels = [...fixtureOffer(params).prices]
      .filter((p) => p.oddsCents !== null)
      .slice(0, VF_LIMITS.maxTicketLegs + 3);
    for (const p of sels) s = apply(s, { type: 'toggle', pick: pick(1, p.id) });
    expect(s.picks).toHaveLength(VF_LIMITS.maxTicketLegs);
  });
});

describe('server clock', () => {
  it('advances by the monotonic timer and never runs backwards', () => {
    let now = 1000;
    const clock = createServerClock(() => now);
    expect(clock.now()).toBeNull();
    clock.sync(50_000, 900, 1000); // 100 ms round trip → server time 50 ms older than receipt
    expect(clock.now()).toBe(50_050);
    now = 1500;
    expect(clock.now()).toBe(50_550);
    // A slow response would pull the clock back; it is ignored.
    clock.sync(50_400, 1400, 1500);
    expect(clock.now()!).toBeGreaterThanOrEqual(50_550);
    clock.sync(55_000, 1500, 1500);
    expect(clock.now()).toBe(55_000);
  });
  it('stops trusting itself after a stall until a fresh snapshot arrives', () => {
    let now = 0;
    const clock = createServerClock(() => now);
    expect(clock.age()).toBe(Infinity);
    clock.sync(10_000, 0, 0);
    now = 3000;
    expect(clock.age()).toBe(3000);
    clock.invalidate();
    expect(clock.age()).toBe(Infinity);
    // A resync after a stall replaces the base even if it is "earlier" than the stalled projection.
    clock.sync(9_000, 3000, 3000);
    expect(clock.now()).toBe(9_000);
    expect(clock.age()).toBe(0);
  });
});

describe('goal reveal', () => {
  const live = (over: Partial<LiveFixture>): LiveFixture => ({
    status: 'SECOND_HALF',
    elapsedMs: 40_000,
    score: { home: 1, away: 0 },
    halfTime: { home: 1, away: 0 },
    fullTime: null,
    events: [{ n: 1, side: 'H', half: 1, atMs: 10_000, minute: 16 }],
    ...over,
  });
  it('holds a goal back until the ball is in the net on screen', () => {
    expect(displayFixture(live({ elapsedMs: 10_500 }), 10_500).score).toEqual({ home: 0, away: 0 });
    expect(displayFixture(live({ elapsedMs: 10_500 }), 10_500).scoring).toBe(true);
    expect(displayFixture(live({}), 10_000 + GOAL_REVEAL_MS).score).toEqual({ home: 1, away: 0 });
  });
  it('shows full time only after the last goal has been revealed', () => {
    const late = live({
      status: 'FULL_TIME',
      elapsedMs: 60_000,
      score: { home: 1, away: 1 },
      fullTime: { home: 1, away: 1 },
      events: [
        { n: 1, side: 'H', half: 1, atMs: 10_000, minute: 16 },
        { n: 2, side: 'A', half: 2, atMs: 59_500, minute: 90 },
      ],
    });
    const at = displayFixture(late, 60_100);
    expect(at.fullTime).toBeNull();
    expect(at.minute).toBe('90+');
    expect(at.score).toEqual({ home: 1, away: 0 });
    const done = displayFixture(late, 59_500 + GOAL_REVEAL_MS);
    expect(done.fullTime).toEqual({ home: 1, away: 1 });
    expect(done.minute).toBe('FT');
  });
  it('is a pure time rule, so a reload after the goal shows it at once', () => {
    expect(displayFixture(live({}), 45_000).events).toHaveLength(1);
    expect(
      displayFixture(
        {
          status: 'SCHEDULED',
          elapsedMs: 0,
          score: null,
          halfTime: null,
          fullTime: null,
          events: [],
        },
        -5000
      ).score
    ).toBeNull();
  });
  it('knows when a whole matchweek may show results', () => {
    const fixtures = [
      { live: live({ events: [{ n: 1, side: 'H', half: 2, atMs: 59_900, minute: 90 }] }) },
    ] as never;
    expect(matchweekRevealAt({ kickoffAt: 1000, fullTimeAt: 61_000, fixtures })).toBe(
      1000 + 59_900 + GOAL_REVEAL_MS
    );
    expect(matchweekRevealAt({ kickoffAt: 1000, fullTimeAt: 61_000, fixtures: [] })).toBe(61_000);
  });
});

describe('formatting', () => {
  it('truncates odds and renders clocks', () => {
    expect(formatOdds(1999)).toBe('19.99');
    expect(formatOdds(110)).toBe('1.10');
    expect(formatOdds(null)).toBe('—');
    expect(formatClock(230_000)).toBe('3:50');
    expect(formatClock(-5)).toBe('0:00');
    expect(formatClock(1)).toBe('0:01');
  });
});
