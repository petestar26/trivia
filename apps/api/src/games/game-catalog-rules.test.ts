import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SPIN90_RULES_ID } from '@socialplay/shared';
import { listActiveGames } from './game-catalog.js';

const db = vi.hoisted(() => ({ findMany: vi.fn(), findUnique: vi.fn() }));
vi.mock('@socialplay/database', () => ({
  prisma: {
    gameDefinition: { findMany: db.findMany },
    gameRules: { findUnique: db.findUnique },
  },
}));

describe('Spin Win catalog rule identity', () => {
  beforeEach(() => { vi.resetAllMocks(); });

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
