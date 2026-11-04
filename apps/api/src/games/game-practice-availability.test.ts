import { afterEach, expect, it, vi } from 'vitest';
const db = vi.hoisted(() => ({ findMany: vi.fn() }));
vi.mock('@socialplay/database', () => ({ prisma: { gameDefinition: { findMany: db.findMany } } }));
import { isCoinWagerPaused, listActiveGames } from './game-catalog.js';

afterEach(() => { vi.unstubAllEnvs(); });

it.each([
  ['dice', 'SYSTEM_DICE_PRACTICE_ENABLED'],
  ['crash_point', 'CRASH_POINT_PRACTICE_ENABLED'],
  ['turbo_keno', 'SYSTEM_KENO_PRACTICE_ENABLED'],
])('publishes exact practice admission state for %s without activating Coin play', async (key, flag) => {
  const row = {
    key, mode: 'WAGER', wagerCurrency: 'COINS', catalogStatus: 'COMING_SOON', isActive: false,
  };
  db.findMany.mockResolvedValue([row]);
  for (const value of [undefined, '', 'false', 'TRUE', '1', ' true', 'true ']) {
    vi.stubEnv(flag, value ?? '');
    if (value === undefined) delete process.env[flag];
    expect((await listActiveGames())[0].practiceAvailable, String(value)).toBe(false);
  }
  vi.stubEnv('VIRTUAL_FOOTBALL_PRACTICE_ENABLED', 'true');
  vi.stubEnv(flag, 'false');
  expect((await listActiveGames())[0].practiceAvailable).toBe(false);
  vi.stubEnv(flag, 'true');
  expect((await listActiveGames())[0]).toMatchObject({ practiceAvailable: true, isActive: false, catalogStatus: 'COMING_SOON' });
  expect(row).toEqual({ key, mode: 'WAGER', wagerCurrency: 'COINS', catalogStatus: 'COMING_SOON', isActive: false });
  if (key !== 'turbo_keno') expect(isCoinWagerPaused(row)).toBe(true);
});
