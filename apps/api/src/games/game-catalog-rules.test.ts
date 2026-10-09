import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SPIN90_RULES_ID } from '@socialplay/shared';
import { isCoinWagerPaused, listActiveGames } from './game-catalog.js';

const db = vi.hoisted(() => ({ findMany: vi.fn(), findUnique: vi.fn() }));
vi.mock('@socialplay/database', () => ({
  prisma: {
    gameDefinition: { findMany: db.findMany },
    gameRules: { findUnique: db.findUnique },
  },
}));

describe('Spin Win catalog rule identity', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('reads the pinned rule identity so the client can select its payout table', async () => {
    db.findMany.mockResolvedValue([{ id: 'spin', key: 'spin_win', currentRulesVersion: 2 }]);
    db.findUnique.mockResolvedValue({ rules: { rulesId: SPIN90_RULES_ID } });
    expect(await listActiveGames()).toEqual([
      { id: 'spin', key: 'spin_win', currentRulesVersion: 2, currentRulesId: SPIN90_RULES_ID },
    ]);
    expect(db.findUnique).toHaveBeenCalledWith({
      where: { gameId_version: { gameId: 'spin', version: 2 } },
    });
  });

  it('does not invent a rules identity for the disabled seeded game', async () => {
    db.findMany.mockResolvedValue([{ id: 'spin', key: 'spin_win', currentRulesVersion: null }]);
    expect(await listActiveGames()).toEqual([
      { id: 'spin', key: 'spin_win', currentRulesVersion: null, currentRulesId: null },
    ]);
    expect(db.findUnique).not.toHaveBeenCalled();
  });

  it('fails closed when the pinned rules are missing', async () => {
    db.findMany.mockResolvedValue([{ id: 'spin', key: 'spin_win', currentRulesVersion: 2 }]);
    db.findUnique.mockResolvedValue(null);
    expect((await listActiveGames())[0].currentRulesId).toBeNull();
  });
});

it('publishes Sky Crash practice availability only on explicit opt-in and never activates financial play', async () => {
  db.findMany.mockResolvedValue([
    {
      id: 'sky',
      key: 'sky_crash',
      isActive: true,
      catalogStatus: 'AVAILABLE',
      mode: 'WAGER',
      wagerCurrency: 'COINS',
    },
  ]);
  try {
    vi.stubEnv('SKY_CRASH_PRACTICE_ENABLED', 'false');
    expect((await listActiveGames())[0]).toMatchObject({
      isActive: false,
      catalogStatus: 'COMING_SOON',
      practiceAvailable: false,
    });
    vi.stubEnv('SKY_CRASH_PRACTICE_ENABLED', 'true');
    expect((await listActiveGames())[0]).toMatchObject({
      isActive: false,
      catalogStatus: 'COMING_SOON',
      practiceAvailable: true,
    });
  } finally {
    vi.unstubAllEnvs();
  }
});

it.each([
  { mode: 'WAGER', wagerCurrency: 'COINS' },
  { mode: 'WAGER', wagerCurrency: 'GAME_POINTS' },
  { mode: 'BONUS', wagerCurrency: null },
])('refuses generic Sky Crash admission despite catalog edits: %j', (fields) => {
  expect(isCoinWagerPaused({ key: 'sky_crash', ...fields })).toBe(true);
});

it('Thunder Derby never admits Coin wagers even after catalog edits', () => {
  expect(
    isCoinWagerPaused({ key: 'thunder_derby_3d', mode: 'WAGER', wagerCurrency: 'COINS' })
  ).toBe(true);
  expect(isCoinWagerPaused({ key: 'thunder_derby_3d', mode: 'BONUS', wagerCurrency: null })).toBe(
    true
  );
});

describe('Virtual Football 3D catalog gate', () => {
  const row = {
    id: 'vf',
    key: 'virtual_football_3d',
    isActive: true,
    catalogStatus: 'AVAILABLE',
    mode: 'WAGER',
    wagerCurrency: 'COINS',
  };

  it('is public only through the approved-key allowlist', async () => {
    db.findMany.mockResolvedValue([]);
    await listActiveGames();
    expect(db.findMany.mock.calls.at(-1)![0].where.key.in).toContain('virtual_football_3d');
  });

  it('exposes practice availability only for the exact string "true" and never activates play', async () => {
    db.findMany.mockResolvedValue([row]);
    try {
      for (const flag of [undefined, '', 'false', 'TRUE', 'True', '1', 'yes', ' true', 'true ']) {
        if (flag === undefined) vi.unstubAllEnvs();
        else vi.stubEnv('VIRTUAL_FOOTBALL_PRACTICE_ENABLED', flag);
        expect((await listActiveGames())[0], String(flag)).toMatchObject({
          isActive: false,
          catalogStatus: 'COMING_SOON',
          practiceAvailable: false,
        });
      }
      vi.stubEnv('VIRTUAL_FOOTBALL_PRACTICE_ENABLED', 'true');
      expect((await listActiveGames())[0]).toMatchObject({
        isActive: false,
        catalogStatus: 'COMING_SOON',
        practiceAvailable: true,
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('is not enabled by another game practice flag', async () => {
    db.findMany.mockResolvedValue([row]);
    try {
      vi.stubEnv('THUNDER_DERBY_PRACTICE_ENABLED', 'true');
      vi.stubEnv('SKY_CRASH_PRACTICE_ENABLED', 'true');
      expect((await listActiveGames())[0].practiceAvailable).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each([
    { mode: 'WAGER', wagerCurrency: 'COINS' },
    { mode: 'WAGER', wagerCurrency: 'GAME_POINTS' },
    { mode: 'BONUS', wagerCurrency: null },
    { mode: 'BONUS', wagerCurrency: 'COINS' },
  ])('never admits Coin wagers regardless of catalog data: %j', (fields) => {
    expect(isCoinWagerPaused({ key: 'virtual_football_3d', ...fields })).toBe(true);
  });
});
