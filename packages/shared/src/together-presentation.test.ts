import { describe, expect, it } from 'vitest';
import { togetherRevealTimeline } from './together-presentation.js';
import type { TogetherRoundView } from './play-together.js';

const paidAt = 1_800_000_000_000;
const round: Pick<TogetherRoundView, 'state' | 'paidAt' | 'outcome'> = {
  state: 'PAID',
  paidAt,
  outcome: { numbers: [3, 1, 2] },
};

describe('shared group reveal clock', () => {
  it.each(['OPEN', 'LOCKED', 'DRAWN'] as const)('does not start a reveal while %s', (state) => {
    expect(togetherRevealTimeline({ ...round, state, paidAt: null }, paidAt + 20000)).toEqual({
      phase: 'awaiting',
      progress: 0,
      startsAt: null,
      endsAt: null,
    });
  });
  it('uses the same published schedule at exact countdown and reveal boundaries', () => {
    const expected = { startsAt: paidAt + 3000, endsAt: paidAt + 15000 };
    expect(togetherRevealTimeline(round, paidAt + 2999)).toEqual({
      ...expected,
      phase: 'scheduled',
      progress: 0,
    });
    expect(togetherRevealTimeline(round, paidAt + 3000)).toEqual({
      ...expected,
      phase: 'revealing',
      progress: 0,
    });
    expect(togetherRevealTimeline(round, paidAt + 9000)).toEqual({
      ...expected,
      phase: 'revealing',
      progress: 0.5,
    });
    expect(togetherRevealTimeline(round, paidAt + 15000)).toEqual({
      ...expected,
      phase: 'complete',
      progress: 1,
    });
  });
  it('joins current progress after reconnect and keeps historical results complete', () => {
    const reloaded = JSON.parse(JSON.stringify(round));
    expect(togetherRevealTimeline(reloaded, paidAt + 12000)).toEqual(
      togetherRevealTimeline(round, paidAt + 12000)
    );
    expect(togetherRevealTimeline(reloaded, paidAt + 12000).progress).toBe(0.75);
    expect(togetherRevealTimeline(reloaded, paidAt + 86400000).progress).toBe(1);
  });
  it('reveals an actual tied draw but never invents a draw for an underfilled refund', () => {
    expect(togetherRevealTimeline({ ...round, state: 'REFUNDED' }, paidAt + 9000).phase).toBe(
      'revealing'
    );
    expect(
      togetherRevealTimeline({ ...round, state: 'REFUNDED', outcome: null }, paidAt + 9000)
    ).toEqual({
      phase: 'complete',
      progress: 1,
      startsAt: null,
      endsAt: null,
    });
  });
  it.each([null, undefined, NaN, Infinity, -1])(
    'shows a static final result without a usable server clock (%s)',
    (serverNow) => {
      expect(togetherRevealTimeline(round, serverNow)).toEqual({
        phase: 'complete',
        progress: 1,
        startsAt: null,
        endsAt: null,
      });
    }
  );
  it.each([null, NaN, -1, Number.MAX_SAFE_INTEGER])(
    'avoids a guessed schedule when payment time is invalid (%s)',
    (time) => {
      expect(togetherRevealTimeline({ ...round, paidAt: time }, paidAt)).toEqual({
        phase: 'complete',
        progress: 1,
        startsAt: null,
        endsAt: null,
      });
    }
  );
});
