import { expect, it } from 'vitest';
import { classifyProviderGame } from './game-categories.js';

it.each([
  ['Turbo Keno 80', 'instant', 'Instant Win', 'keno'],
  ['Ducky Power Ball Keno', 'slots', 'Video Slots', 'keno'],
  ['Keno Pop1', 'slots', 'Slots', 'keno'],
  ['Instant Keno', 'slots', 'Slots', 'keno'],
  ['Burning Keno', 'slots', 'Slots', 'keno'],
  ['Roulette Classic', 'slots', 'Slots', 'table'],
  ['Virtual Roulette', 'slots', 'Slots', 'table'],
  ['Super Video Poker', 'slots', 'Slots', 'table'],
  ['Speed BlackJack C', 'slots', 'Slots', 'table'],
  ['Bingo', 'slots', 'Slots', 'bingo'],
  ['JetX3', 'slots', 'Slots', 'crash'],
  ['Spaceman', 'live', 'Live Casino', 'live'],
  ['Unknown title', 'VIDEO_SLOTS', undefined, 'slots'],
  ['Unknown title', null, 'Fishing Games', 'fishing'],
  ['Unknown title', 'unrecognized', undefined, 'other'],
  ['Unknown title', 'constructor', undefined, 'other'],
  ['Unknown title', null, '__proto__', 'other'],
])(
  'classifies %s using catalogue metadata and clear genre names',
  (name, game_type, type, expected) => {
    expect(classifyProviderGame({ name, game_type, type }).category).toBe(expected);
  }
);

it('makes live tables and live bingo discoverable in both applicable categories', () => {
  expect(classifyProviderGame({ name: 'Live Roulette', game_type: 'live' }).categories).toEqual([
    'live',
    'table',
    'spin',
  ]);
  expect(classifyProviderGame({ name: 'The Bingo Spot', game_type: 'live' }).categories).toEqual([
    'live',
    'bingo',
  ]);
});

it.each([
  ['Mega Wheel', 'Pragmatic Play', 'live'],
  ['Mega Wheel', 'Popok', 'slots'],
  ['Lucky Spin', 'Popok', 'slots'],
  ['Wheel', 'InOut Games', 'slots'],
  ['Avia Wheel', 'InOut Games', 'instant'],
  ['European Roulette', 'Studio', 'table'],
])(
  'adds wheel/spinner discovery without removing %s from its existing genre',
  (name, provider_name, game_type) => {
    const result = classifyProviderGame({ name, provider_name, game_type });
    expect(result.category).toBe(game_type);
    expect(result.categories).toContain('spin');
    expect(result.categories).toContain(game_type);
  }
);

it.each([
  'Twin Spin',
  'Ultra Hold and Spin',
  'Ultra Wheel',
  'Zodiac Wheel',
  'Wheel Out',
  'Spin Of The Dead',
])('does not confuse slots or a rolling-wheel crash theme with spin games: %s', (name) =>
  expect(
    classifyProviderGame({ name, game_type: 'slots', provider_name: 'Popok' }).categories
  ).not.toContain('spin')
);

it('honors explicit wheel metadata and scopes reviewed titles to their studio', () => {
  expect(classifyProviderGame({ name: 'New Game', game_type: 'wheel_games' }).categories).toEqual([
    'spin',
  ]);
  expect(
    classifyProviderGame({ name: 'New Game', game_type: 'live', type: 'Money Wheel' }).categories
  ).toEqual(['live', 'spin']);
  expect(
    classifyProviderGame({ name: 'Mega Wheel', game_type: 'slots', provider_name: 'Other Studio' })
      .categories
  ).toEqual(['slots']);
  expect(
    classifyProviderGame({ name: 'Lucky Spin', game_type: 'slots', provider: 'popok' }).categories
  ).toContain('spin');
});

it.each(['Fishin Reels', 'Fishing Frenzy', 'CoyoteCrash', 'Kenozoic Adventure', 'Aviatrix Mines'])(
  'does not infer a game mechanic from a themed slot: %s',
  (name) => {
    expect(classifyProviderGame({ name, game_type: 'slots' }).category).toBe('slots');
  }
);

it('keeps sportsbook classification out of casino regardless of misleading names or casing', () => {
  expect(classifyProviderGame({ name: 'Keno', game_type: 'SportsBook' }).category).toBe(
    'sportsbook'
  );
  expect(
    classifyProviderGame({ name: 'Roulette', game_type: 'slots', type: 'SportsBook' }).category
  ).toBe('sportsbook');
});
