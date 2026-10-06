import { expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ findMany: vi.fn() }));
vi.mock('@socialplay/database', () => ({ prisma: { gameDefinition: { findMany: m.findMany } } }));
import { isCoinWagerPaused, listActiveGames } from './game-catalog.js';
it('blocks unapproved Coin payout models independently of catalog flags', () => {
  for (const key of ['number_challenge', 'dice']) {
    expect(isCoinWagerPaused({ key, mode: 'WAGER', wagerCurrency: 'COINS' })).toBe(true);
    expect(isCoinWagerPaused({ key, mode: 'WAGER', wagerCurrency: 'GAME_POINTS' })).toBe(false);
  }
  expect(isCoinWagerPaused({ key: 'trivia', mode: 'BONUS', wagerCurrency: null })).toBe(false);
});

it('presents paused Coin games as coming soon even when persisted flags say available', async () => {
  const rows = ['number_challenge', 'dice'].map((key) => ({
    key,
    mode: 'WAGER',
    wagerCurrency: 'COINS',
    catalogStatus: 'AVAILABLE',
  }));
  m.findMany.mockResolvedValue(rows);
  expect((await listActiveGames()).map((game) => game.catalogStatus)).toEqual([
    'COMING_SOON',
    'COMING_SOON',
  ]);
  expect(rows.every((game) => game.catalogStatus === 'AVAILABLE')).toBe(true);
});
