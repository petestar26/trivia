import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '@socialplay/database';
import {
  createChallenge,
  acceptChallenge,
  declineChallenge,
  cancelChallenge,
  playChallengeTurn,
  getUserChallenges,
  getChallengeById,
} from './challenge-service';
import { getOrCreateWallet, getWalletBalance, executeBalanceChange } from '../economy/wallet-service';
import { ensureGameDefinitions } from '../games/game-catalog';

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
  const email = `chal-${tag}@test.local`;
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) return existing;
  return prisma.user.create({
    data: {
      email,
      username: `chal_${tag}`,
      passwordHash: 'fixture-only-not-a-real-hash',
      displayName: `Chal ${tag}`,
    },
  });
}

async function primeGamePoints(userId: string, amount: number) {
  await getOrCreateWallet(userId);
  await executeBalanceChange({
    userId,
    changes: [{
      currency: 'GAME_POINTS',
      amount,
      ledgerType: 'CREDIT',
      transactionType: 'GAME_POINT_CREDIT',
      referenceType: 'ADMIN',
      description: 'Test fixture game points',
    }],
    operationName: 'test_fund_gp',
  });
}

async function cleanChalFixtures() {
  const users = await prisma.user.findMany({ where: { email: { contains: '@chal-' } } });
  const userIds = users.map((u) => u.id);

  if (userIds.length) {
    await prisma.gameChallenge.deleteMany({
      where: { OR: [{ challengerId: { in: userIds } }, { challengedId: { in: userIds } }] },
    });
    await prisma.rewardClaim.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.gameSession.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.walletTransaction.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.wallet.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }
}

// ─── CREATE CHALLENGE ──────────────────────────────────────────

describeIf('Create challenge', () => {
  let a: { id: string };
  let b: { id: string };

  beforeAll(async () => {
    await cleanChalFixtures();
    a = await createUser('a');
    b = await createUser('b');
    await ensureGameDefinitions();
    await primeGamePoints(a.id, 500);
  });

  it('creates a pending challenge', async () => {
    const result = await createChallenge(a.id, b.id, 'dice', 50);
    expect(result.status).toBe('PENDING');
    expect(result.gameKey).toBe('dice');
    expect(result.entryAmount).toBe(50);
  });

  it('rejects self-challenge', async () => {
    await expect(createChallenge(a.id, a.id, 'dice', 50)).rejects.toThrow();
  });

  it('rejects invalid entry amount', async () => {
    await expect(createChallenge(a.id, b.id, 'dice', -1)).rejects.toThrow();
  });

  it('rejects unknown game', async () => {
    await expect(createChallenge(a.id, b.id, 'nonexistent', 50)).rejects.toThrow();
  });
});

// ─── CHALLENGE IDOR PROTECTION ─────────────────────────────────

describeIf('Challenge authorization', () => {
  let a: { id: string };
  let b: { id: string };
  let c: { id: string };

  beforeAll(async () => {
    await cleanChalFixtures();
    a = await createUser('auth_a');
    b = await createUser('auth_b');
    c = await createUser('auth_c');
    await ensureGameDefinitions();
    await primeGamePoints(a.id, 500);
  });

  it('another user cannot accept a challenge not addressed to them', async () => {
    const { id } = await createChallenge(a.id, b.id, 'dice', 10);
    await expect(acceptChallenge(c.id, id)).rejects.toThrow();
  });

  it('another user cannot view challenge detail', async () => {
    const { id } = await createChallenge(a.id, b.id, 'dice', 10);
    await expect(getChallengeById(id, c.id)).rejects.toThrow();
  });

  it('another user cannot play a challenge they are not part of', async () => {
    const { id } = await createChallenge(a.id, b.id, 'dice', 10);
    await expect(playChallengeTurn(c.id, id)).rejects.toThrow();
  });
});

// ─── ACCEPT CHALLENGE ──────────────────────────────────────────

describeIf('Accept challenge', () => {
  let a: { id: string };
  let b: { id: string };

  beforeAll(async () => {
    await cleanChalFixtures();
    a = await createUser('acc_a');
    b = await createUser('acc_b');
    await ensureGameDefinitions();
    await primeGamePoints(a.id, 500);
    await primeGamePoints(b.id, 500);
  });

  it('accepts a challenge and debits both entries', async () => {
    const chal = await createChallenge(a.id, b.id, 'dice', 40);

    const bBefore = (await getWalletBalance(b.id)).gamePointsBalance;
    const result = await acceptChallenge(b.id, chal.id);
    expect(result.status).toBe('ACTIVE');

    const bAfter = (await getWalletBalance(b.id)).gamePointsBalance;
    expect(bAfter).toBe(bBefore - 40);
  });

  it('cannot accept a non-pending challenge', async () => {
    const chal = await createChallenge(a.id, b.id, 'dice', 10);
    await acceptChallenge(b.id, chal.id);
    await expect(acceptChallenge(b.id, chal.id)).rejects.toThrow();
  });
});

// ─── DECLINE CHALLENGE ─────────────────────────────────────────

describeIf('Decline challenge', () => {
  let a: { id: string };
  let b: { id: string };

  beforeAll(async () => {
    await cleanChalFixtures();
    a = await createUser('dec_a');
    b = await createUser('dec_b');
    await ensureGameDefinitions();
    await primeGamePoints(a.id, 500);
  });

  it('declines and refunds challenger entry', async () => {
    const chal = await createChallenge(a.id, b.id, 'dice', 30);
    const aBefore = (await getWalletBalance(a.id)).gamePointsBalance;

    const result = await declineChallenge(b.id, chal.id);
    expect(result.status).toBe('DECLINED');

    const aAfter = (await getWalletBalance(a.id)).gamePointsBalance;
    expect(aAfter).toBe(aBefore + 30);
  });
});

// ─── PLAY CHALLENGE (COMPLETE FLOW) ────────────────────────────

describeIf('Play challenge full flow', () => {
  let a: { id: string };
  let b: { id: string };

  beforeAll(async () => {
    await cleanChalFixtures();
    a = await createUser('play_a');
    b = await createUser('play_b');
    await ensureGameDefinitions();
    await primeGamePoints(a.id, 500);
    await primeGamePoints(b.id, 500);
  });

  it('completes the challenge and credits winner the pot', async () => {
    const chal = await createChallenge(a.id, b.id, 'dice', 50);
    await acceptChallenge(b.id, chal.id);

    const aBefore = (await getWalletBalance(a.id)).gamePointsBalance;

    // Player A plays first — likely "waiting for opponent"
    const first = await playChallengeTurn(a.id, chal.id);
    if (!first.challengeComplete) {
      expect(first.message).toBe('Waiting for opponent');
    }

    // Player B plays — completes the challenge
    const second = await playChallengeTurn(b.id, chal.id);
    expect(second.challengeComplete).toBe(true);
    expect(typeof second.winnerId).toBe('string');

    const aAfter = (await getWalletBalance(a.id)).gamePointsBalance;

    if (second.winnerId === a.id) {
      expect(aAfter).toBe(aBefore + 100); // pot doubled
    } else {
      expect(aAfter).toBe(aBefore);
    }
  });

  it('challenge status becomes COMPLETED', async () => {
    const chal = await createChallenge(a.id, b.id, 'dice', 10);
    await acceptChallenge(b.id, chal.id);
    await playChallengeTurn(a.id, chal.id);
    await playChallengeTurn(b.id, chal.id);

    const detail = await getChallengeById(chal.id, a.id);
    expect(detail.status).toBe('COMPLETED');
    expect(detail.winnerId).toBeTruthy();
  });
});

// ─── LIST USER CHALLENGES ──────────────────────────────────────

describeIf('List user challenges', () => {
  let a: { id: string };
  let b: { id: string };

  beforeAll(async () => {
    await cleanChalFixtures();
    a = await createUser('list_a');
    b = await createUser('list_b');
    await ensureGameDefinitions();
    await primeGamePoints(a.id, 500);
  });

  it('returns only challenges involving the user', async () => {
    await createChallenge(a.id, b.id, 'dice', 10);
    const mine = await getUserChallenges(a.id);
    expect(mine.length).toBeGreaterThanOrEqual(1);
    for (const c of mine) {
      expect(c.challenger.id === a.id || c.challenged.id === a.id).toBe(true);
    }
  });
});
