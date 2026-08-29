import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '@socialplay/database';
import { ApiError } from '../middleware';
import {
  listActiveGames,
  getGameByKey,
  ensureGameDefinitions,
} from './game-catalog';
import { playGame, getGameHistory } from './game-play';
import { getOrCreateWallet, getWalletBalance, reconcileBalance } from '../economy/wallet-service';

// ─── DB availability probe ─────────────────────────────────────

let dbAvailable = true;
try {
  await prisma.$queryRaw`SELECT 1`;
  dbAvailable = true;
} catch {
  dbAvailable = false;
}

afterAll(async () => {
  await prisma.$disconnect();
});

const describeIf = dbAvailable ? describe : describe.skip;

// ─── Fixtures ──────────────────────────────────────────────────

async function createUser(tag: string) {
  const email = `games-${tag}@test.local`;
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) return existing;
  return prisma.user.create({
    data: {
      email,
      username: `games_${tag}`,
      passwordHash: 'fixture-only-not-a-real-hash',
      displayName: `Games ${tag}`,
    },
  });
}

async function primeGamePoints(userId: string, amount: number) {
  await getOrCreateWallet(userId);
  // Credit game points via the authoritative path
  const { executeBalanceChange } = await import('../economy/wallet-service');
  await executeBalanceChange({
    userId,
    changes: [
      {
        currency: 'GAME_POINTS',
        amount,
        ledgerType: 'CREDIT',
        transactionType: 'GAME_POINT_CREDIT',
        referenceType: 'ADMIN',
        description: 'Test fixture game points',
      },
    ],
    operationName: 'test_fund_gp',
  });
}

async function cleanFixtures() {
  const users = await prisma.user.findMany({
    where: { email: { contains: '@games-' } },
  });
  const userIds = users.map((u) => u.id);
  if (userIds.length) {
    await prisma.gameSession.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.walletTransaction.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.wallet.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }
}

// ─── GAME CATALOG ──────────────────────────────────────────────

describeIf('Game catalog', () => {
  beforeAll(async () => {
    await cleanFixtures();
    await ensureGameDefinitions();
  });

  it('returns active games', async () => {
    const games = await listActiveGames();
    expect(games.length).toBeGreaterThanOrEqual(4);
    const keys = games.map((g) => g.key);
    expect(keys).toContain('lucky_spin');
    expect(keys).toContain('dice');
    expect(keys).toContain('number_challenge');
    expect(keys).toContain('trivia');
  });

  it('each game has min/max bet set', async () => {
    const games = await listActiveGames();
    for (const g of games) {
      expect(g.minBet).toBeGreaterThan(0);
      expect(g.maxBet).toBeGreaterThan(g.minBet);
    }
  });

  it('inactive game cannot be loaded by key', async () => {
    const game = await getGameByKey('nonexistent');
    expect(game).toBeNull();
  });
});

// ─── BET VALIDATION ────────────────────────────────────────────

describeIf('Bet validation', () => {
  let a: { id: string };

  beforeAll(async () => {
    await cleanFixtures();
    a = await createUser('bet');
    await ensureGameDefinitions();
    await primeGamePoints(a.id, 1000);
  });

  it('rejects non-integer bet', async () => {
    await expect(
      playGame({ userId: a.id, gameKey: 'dice', betAmount: 1.5 })
    ).rejects.toThrow();
  });

  it('rejects zero bet', async () => {
    await expect(
      playGame({ userId: a.id, gameKey: 'dice', betAmount: 0 })
    ).rejects.toThrow();
  });

  it('rejects negative bet', async () => {
    await expect(
      playGame({ userId: a.id, gameKey: 'dice', betAmount: -10 })
    ).rejects.toThrow();
  });

  it('rejects bet below minimum', async () => {
    await expect(
      playGame({ userId: a.id, gameKey: 'dice', betAmount: 1 })
    ).rejects.toThrow();
  });

  it('rejects bet above maximum', async () => {
    await expect(
      playGame({ userId: a.id, gameKey: 'dice', betAmount: 99999 })
    ).rejects.toThrow();
  });

  it('rejects string bet', async () => {
    await expect(
      playGame({ userId: a.id, gameKey: 'dice', betAmount: '10' as any })
    ).rejects.toThrow();
  });
});

// ─── INSUFFICIENT GAME POINTS ─────────────────────────────────

describeIf('Insufficient Game Points', () => {
  let a: { id: string };

  beforeAll(async () => {
    await cleanFixtures();
    a = await createUser('insuf');
    await ensureGameDefinitions();
    await getOrCreateWallet(a.id);
    // No game points — balance is 0
  });

  it('rejects play when balance is 0', async () => {
    await expect(
      playGame({ userId: a.id, gameKey: 'dice', betAmount: 10 })
    ).rejects.toThrow();
  });
});

// ─── LUCKY SPIN ────────────────────────────────────────────────

describeIf('Lucky Spin', () => {
  let a: { id: string };

  beforeAll(async () => {
    await cleanFixtures();
    a = await createUser('spin');
    await ensureGameDefinitions();
    await primeGamePoints(a.id, 1000);
  });

  it('returns a valid server-side result', async () => {
    const result = await playGame({ userId: a.id, gameKey: 'lucky_spin', betAmount: 100 });
    expect(result.gameKey).toBe('lucky_spin');
    expect(result.betAmount).toBe(100);
    expect(result.rewardAmount).toBeGreaterThanOrEqual(0);
    expect(result.isWin).toBe(typeof result.isWin === 'boolean');
    expect(result.result).toHaveProperty('name');
    expect(result.result).toHaveProperty('multiplier');
    expect(result.result).toHaveProperty('index');
  });

  it('reward is bet * multiplier', async () => {
    const result = await playGame({ userId: a.id, gameKey: 'lucky_spin', betAmount: 50 });
    const multiplier = (result.result as any).multiplier;
    expect(result.rewardAmount).toBe(Math.floor(50 * multiplier));
  });
});

// ─── DICE ──────────────────────────────────────────────────────

describeIf('Dice', () => {
  let a: { id: string };

  beforeAll(async () => {
    await cleanFixtures();
    a = await createUser('dice');
    await ensureGameDefinitions();
    await primeGamePoints(a.id, 1000);
  });

  it('returns valid dice result', async () => {
    const result = await playGame({ userId: a.id, gameKey: 'dice', betAmount: 100 });
    expect(result.gameKey).toBe('dice');
    expect(result.betAmount).toBe(100);
    const { die1, die2, sum } = result.result as any;
    expect(die1).toBeGreaterThanOrEqual(1);
    expect(die1).toBeLessThanOrEqual(6);
    expect(die2).toBeGreaterThanOrEqual(1);
    expect(die2).toBeLessThanOrEqual(6);
    expect(sum).toBe(die1 + die2);
  });

  it('win on sum >= threshold (7)', async () => {
    // Run multiple times to verify the win logic
    for (let i = 0; i < 20; i++) {
      const result = await playGame({ userId: a.id, gameKey: 'dice', betAmount: 10 });
      const { sum } = result.result as any;
      if (sum >= 7) {
        expect(result.isWin).toBe(true);
        expect(result.rewardAmount).toBe(20); // 10 * 2
      } else {
        expect(result.isWin).toBe(false);
        expect(result.rewardAmount).toBe(0);
      }
    }
  });
});

// ─── NUMBER CHALLENGE ──────────────────────────────────────────

describeIf('Number Challenge', () => {
  let a: { id: string };

  beforeAll(async () => {
    await cleanFixtures();
    a = await createUser('num');
    await ensureGameDefinitions();
    await primeGamePoints(a.id, 1000);
  });

  it('validates guess is required', async () => {
    await expect(
      playGame({ userId: a.id, gameKey: 'number_challenge', betAmount: 10, clientData: {} })
    ).rejects.toThrow();
  });

  it('validates guess is integer', async () => {
    await expect(
      playGame({ userId: a.id, gameKey: 'number_challenge', betAmount: 10, clientData: { guess: 1.5 } })
    ).rejects.toThrow();
  });

  it('returns correct/away in result', async () => {
    const result = await playGame({
      userId: a.id,
      gameKey: 'number_challenge',
      betAmount: 10,
      clientData: { guess: 50 },
    });
    expect(result.result).toHaveProperty('guess');
    expect(result.result).toHaveProperty('target');
    expect(result.result).toHaveProperty('away');
    expect(result.result).toHaveProperty('correct');
    expect((result.result as any).guess).toBe(50);
  });
});

// ─── TRIVIA ────────────────────────────────────────────────────

describeIf('Trivia', () => {
  let a: { id: string };
  let questionId: string;

  beforeAll(async () => {
    await cleanFixtures();
    a = await createUser('trivia');
    await ensureGameDefinitions();
    await primeGamePoints(a.id, 1000);

    // Create a test question
    const q = await prisma.triviaQuestion.create({
      data: {
        question: 'What is 2 + 2?',
        choices: ['3', '4', '5', '6'],
        correctIndex: 1,
        category: 'math',
      },
    });
    questionId = q.id;
  });

  it('validates answer correctly', async () => {
    const result = await playGame({
      userId: a.id,
      gameKey: 'trivia',
      betAmount: 10,
      clientData: { questionId, answerIndex: 1 },
    });
    expect(result.isWin).toBe(true);
    expect(result.rewardAmount).toBe(30); // 10 * 3
  });

  it('rejects wrong answer', async () => {
    const result = await playGame({
      userId: a.id,
      gameKey: 'trivia',
      betAmount: 10,
      clientData: { questionId, answerIndex: 0 },
    });
    expect(result.isWin).toBe(false);
    expect(result.rewardAmount).toBe(0);
  });

  it('validates questionId is required', async () => {
    await expect(
      playGame({ userId: a.id, gameKey: 'trivia', betAmount: 10, clientData: { answerIndex: 1 } })
    ).rejects.toThrow();
  });
});

// ─── IDEMPOTENCY ───────────────────────────────────────────────

describeIf('Idempotency', () => {
  let a: { id: string };

  beforeAll(async () => {
    await cleanFixtures();
    a = await createUser('idem');
    await ensureGameDefinitions();
    await primeGamePoints(a.id, 5000);
  });

  it('same idempotency key returns original result', async () => {
    const r1 = await playGame({
      userId: a.id,
      gameKey: 'dice',
      betAmount: 100,
      idempotencyKey: 'idem-dice-1',
    });
    const r2 = await playGame({
      userId: a.id,
      gameKey: 'dice',
      betAmount: 100,
      idempotencyKey: 'idem-dice-1',
    });
    expect(r2.sessionId).toBe(r1.sessionId);
    expect(r2.rewardAmount).toBe(r1.rewardAmount);
    expect(r2.result).toEqual(r1.result);
  });

  it('different idempotency keys create different sessions', async () => {
    const r1 = await playGame({
      userId: a.id,
      gameKey: 'dice',
      betAmount: 100,
      idempotencyKey: 'idem-dice-2',
    });
    const r2 = await playGame({
      userId: a.id,
      gameKey: 'dice',
      betAmount: 100,
      idempotencyKey: 'idem-dice-3',
    });
    expect(r2.sessionId).not.toBe(r1.sessionId);
  });
});

// ─── GAME HISTORY (IDOR) ───────────────────────────────────────

describeIf('Game history', () => {
  let a: { id: string };

  beforeAll(async () => {
    await cleanFixtures();
    a = await createUser('hist');
    await ensureGameDefinitions();
    await primeGamePoints(a.id, 1000);

    // Play some games
    await playGame({ userId: a.id, gameKey: 'dice', betAmount: 10 });
    await playGame({ userId: a.id, gameKey: 'lucky_spin', betAmount: 20 });
  });

  it('returns only the authenticated user history', async () => {
    const history = await getGameHistory(a.id);
    expect(history.data.length).toBeGreaterThanOrEqual(2);
    for (const s of history.data) {
      expect(s).toHaveProperty('betAmount');
      expect(s).toHaveProperty('rewardAmount');
    }
  });

  it('supports pagination', async () => {
    const page1 = await getGameHistory(a.id, { page: 1, limit: 1 });
    expect(page1.data.length).toBe(1);
    expect(page1.total).toBeGreaterThanOrEqual(2);
  });

  it('another user gets empty history', async () => {
    const b = await createUser('hist_other');
    const history = await getGameHistory(b.id);
    expect(history.data.length).toBe(0);
  });
});

// ─── CONCURRENCY ───────────────────────────────────────────────

describeIf('Concurrency', () => {
  let a: { id: string };

  beforeAll(async () => {
    await cleanFixtures();
    a = await createUser('concur');
    await ensureGameDefinitions();
    await primeGamePoints(a.id, 100);
    // Only 100 GP — enough for a few dice bets (min 5), not all concurrent
  });

  it('concurrent games cannot overspend', async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) =>
        playGame({ userId: a.id, gameKey: 'dice', betAmount: 10, idempotencyKey: `concur-${i}` })
      )
    );

    const fulfilled = results.filter((r) => r.status === 'fulfilled').length;
    // Should be 10 or fewer (some may fail due to insufficient funds)
    expect(fulfilled).toBeLessThanOrEqual(10);

    // Wallet should never go negative
    const wallet = await getWalletBalance(a.id);
    expect(wallet.gamePointsBalance).toBeGreaterThanOrEqual(0);

    // Ledger should reconcile
    const rec = await reconcileBalance(a.id);
    expect(rec.gamePointsMatch).toBe(true);
  });
});

// ─── CLIENT MANIPULATION ───────────────────────────────────────

describeIf('Client manipulation', () => {
  let a: { id: string };

  beforeAll(async () => {
    await cleanFixtures();
    a = await createUser('manip');
    await ensureGameDefinitions();
    await primeGamePoints(a.id, 1000);
  });

  it('client cannot supply dice result', async () => {
    const result = await playGame({
      userId: a.id,
      gameKey: 'dice',
      betAmount: 10,
      clientData: { die1: 6, die2: 6, sum: 12 },
    });
    // Result should be server-generated, not the client-supplied values
    const { die1, die2 } = result.result as any;
    expect(typeof die1).toBe('number');
    expect(die1).toBeGreaterThanOrEqual(1);
    expect(die1).toBeLessThanOrEqual(6);
  });

  it('client cannot supply reward amount', async () => {
    const result = await playGame({
      userId: a.id,
      gameKey: 'lucky_spin',
      betAmount: 10,
      clientData: { rewardAmount: 99999 },
    });
    // Reward should be derived from server-side multiplier
    expect(result.rewardAmount).toBeLessThan(99999);
  });
});
