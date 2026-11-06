import { createHash } from 'node:crypto';
import type {
  TogetherGame,
  TogetherGameEvent,
  TogetherOutcome,
  TogetherTicket,
} from '@socialplay/shared';

/** Server-only recording, committed with the draw. Never serialize this whole
 * value before finish. The private seed cannot be reconstructed from a frame. */
export function preparePresentation(
  game: TogetherGame,
  duration: number,
  outcome: TogetherOutcome,
  tickets: TogetherTicket[],
  seed: string
): TogetherGameEvent[] {
  const events: TogetherGameEvent[] = [];
  const at = (i: number, count: number) => Math.round((duration * (i + 1)) / count);
  if (['turbo_keno', 'roulette_keno', 'lucky_six'].includes(game)) {
    outcome.numbers.forEach((value, i, list) =>
      events.push({ kind: 'ball', atMs: at(i, list.length), value })
    );
  } else if (game === 'dice') {
    [...tickets]
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .forEach((ticket, i, list) =>
        events.push({
          kind: 'dice',
          atMs: at(i, list.length),
          entryId: ticket.id,
          values: outcome.numbers.slice(i * 2, i * 2 + 2),
        })
      );
  } else if (game === 'blackjack') {
    // Six automated player hands first; the dealer's completed hand at finish.
    const hands = outcome.hands!;
    const order = [1, 2, 3, 4, 5, 6, 0];
    const count = hands.reduce((sum, cards) => sum + cards.length, 0);
    let index = 0;
    for (const hand of order)
      for (let card = 0; card < hands[hand].length; card++)
        events.push({
          kind: 'hand',
          atMs: at(index++, count),
          hand,
          cards: hands[hand].slice(0, card + 1),
        });
  } else if (game === 'virtual_football_3d') {
    // Three concurrent matches. Goal times are derived privately and persisted;
    // clients only receive the score reached at the current match minute.
    for (let match = 0; match < 3; match++) {
      const score = outcome.football![match];
      const goals: { minute: number; side: 'home' | 'away' }[] = [];
      for (const side of ['home', 'away'] as const)
        for (let i = 0; i < score[side]; i++) {
          const hex = createHash('sha256')
            .update(`${seed}|goal|${match}|${side}|${i}`)
            .digest('hex');
          goals.push({ minute: 1 + (parseInt(hex.slice(0, 8), 16) % 90), side });
        }
      for (let minute = 0; minute <= 90; minute++)
        events.push({
          kind: 'football',
          atMs: Math.round((duration * minute) / 90),
          match,
          minute,
          home: goals.filter((g) => g.minute <= minute && g.side === 'home').length,
          away: goals.filter((g) => g.minute <= minute && g.side === 'away').length,
        });
    }
  } else if (game === 'thunder_derby_3d' || game === 'neon_hounds_3d') {
    for (let second = 0; second <= duration / 1000; second++) {
      const progress = (second * 1000) / duration;
      const positions = Array.from({ length: 8 }, (_, i) => {
        const rank = outcome.numbers.indexOf(i + 1);
        const noise =
          parseInt(
            createHash('sha256').update(`${seed}|race|${i}|${second}`).digest('hex').slice(0, 8),
            16
          ) / 0xffffffff;
        const finish = 1 - rank * 0.008;
        // Early order reveals no final ordering. The last stretch converges to
        // the committed finish; the finishing line is reached only at finish.
        const blend = Math.max(0, (progress - 0.82) / 0.18);
        return Math.max(
          0,
          Math.min(0.999, progress * (1 - 0.01 * noise) * (1 - blend) + progress * finish * blend)
        );
      });
      if (progress === 1) positions[outcome.numbers[0] - 1] = 1;
      events.push({ kind: 'race', atMs: second * 1000, positions });
    }
  }
  return events.sort((a, b) => a.atMs - b.atMs);
}
