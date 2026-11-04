import { describe, expect, it } from 'vitest';
import {
  memberGameDestination,
  memberGameLabel,
  memberGameUnavailableDescription,
  type MemberGame,
} from './member-game-catalog';

function game(key: string, overrides: Partial<MemberGame> = {}): MemberGame {
  return {
    id: key,
    key,
    name: key,
    description: null,
    type: key,
    mode: 'WAGER',
    family: 'INSTANT',
    catalogStatus: 'AVAILABLE',
    isActive: true,
    wagerCurrency: 'COINS',
    rewardCurrency: 'COINS',
    currentRulesVersion: null,
    minBet: 0,
    maxBet: 0,
    ...overrides,
  };
}

const futureKeys = [
  'trivia', 'turbo_circuit_3d', 'starfall_nebula',
  'jungle_dash_3d', 'crystal_trail', 'heat_vault', 'strait_rush',
];
const gatedRoutes = [
  ['number_challenge', '/games/number-challenge'],
  ['sky_crash', '/games/sky-crash'],
  ['thunder_derby_3d', '/games/thunder-derby'],
  ['neon_hounds_3d', '/games/dog-racing'],
  ['blackjack', '/games/blackjack'],
  ['lucky_six', '/games/lucky-six'],
  ['roulette_keno', '/games/roulette-keno'],
  ['virtual_football_3d', '/games/virtual-football'],
  ['crash_point', '/games/crash-point'],
  ['dice', '/games/dice'],
  ['spin_win', '/games/spin-win'],
  ['turbo_keno', '/games/turbo-keno'],
] as const;

describe.each(futureKeys)('unfinished %s', (key) => {
  it.each(['COMING_SOON', 'AVAILABLE', 'UNAVAILABLE'])('stays coming soon with API status %s', (catalogStatus) => {
    const entry = game(key, { catalogStatus, practiceAvailable: true });
    expect(memberGameDestination(entry)).toBeUndefined();
    expect(memberGameLabel(entry)).toBe('Coming soon');
    expect(memberGameUnavailableDescription(entry)).toBe('A new experience is on its way.');
  });
  it('keeps retirement precedence', () => {
    const entry = game(key, { catalogStatus: 'RETIRED', practiceAvailable: true });
    expect(memberGameDestination(entry)).toBeUndefined();
    expect(memberGameLabel(entry)).toBe('Unavailable');
  });
});

describe.each(gatedRoutes)('implemented %s', (key, destination) => {
  it.each([undefined, false])('requires explicit practice availability (%s)', (practiceAvailable) => {
    const entry = game(key, { practiceAvailable });
    expect(memberGameDestination(entry)).toBeUndefined();
    expect(memberGameLabel(entry)).toBe('Temporarily unavailable');
  });
  it('keeps its practice destination when the server enables it', () => {
    const entry = game(key, { practiceAvailable: true });
    expect(memberGameDestination(entry)).toBe(destination);
    expect(memberGameLabel(entry)).toBe('Free practice');
  });
  it('does not allow retired entries', () => {
    const entry = game(key, { catalogStatus: 'RETIRED', practiceAvailable: true });
    expect(memberGameDestination(entry)).toBeUndefined();
    expect(memberGameLabel(entry)).toBe('Unavailable');
  });
});

it('does not invent a destination for unknown available games', () => {
  expect(memberGameDestination(game('unknown'))).toBeUndefined();
  expect(memberGameLabel(game('unknown'))).toBe('Unavailable');
});
