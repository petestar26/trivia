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
import { getOrCreateWallet, getWalletBalance, executeBalanceChange, applyBalanceChanges } from '../economy/wallet-service';
import { ensureGameDefinitions } from '../games/game-catalog';
import { ApiError } from '../middleware';

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
  const users = await prisma.user.findMany({ where: { email: { startsWith: 'chal-' } } });
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

// ─── Ledger-count helpers ───────────────────────────────────────
// The accept/decline/cancel race assertions must never rely on balances
// alone: the exact number of matching ledger rows proves whether a refund
// or entry debit happened exactly once (0 or 1 for a fresh fixture user).

const CHALLENGE_REFUND_DESCRIPTIONS = [
  'Challenge cancelled — entry refund',
  'Challenge declined — entry refund',
];

function countChallengeRefunds(userId: string) {
  return prisma.walletTransaction.count({
    where: { userId, description: { in: CHALLENGE_REFUND_DESCRIPTIONS } },
  });
}

function countChallengeEntries(userId: string, gameKey: string) {
  return prisma.walletTransaction.count({
    where: { userId, description: `Challenge entry: ${gameKey}` },
  });
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
    // A tie is a legal outcome (winnerId === null) and the service refunds
    // both entries in that case. This previously asserted the winner was
    // always a string and that a non-winning A ended flat, which only held
    // because of the DEFECT #3 scoring bug that made ties unreachable.
    expect([a.id, b.id, null]).toContain(second.winnerId);

    const aAfter = (await getWalletBalance(a.id)).gamePointsBalance;

    if (second.winnerId === a.id) {
      expect(aAfter).toBe(aBefore + 100); // won the pot (2 x 50)
    } else if (second.winnerId === b.id) {
      expect(aAfter).toBe(aBefore); // lost; entry already debited
    } else {
      expect(aAfter).toBe(aBefore + 50); // tie — own entry refunded
    }
  });

  it('challenge status becomes COMPLETED', async () => {
    const chal = await createChallenge(a.id, b.id, 'dice', 10);
    await acceptChallenge(b.id, chal.id);
    await playChallengeTurn(a.id, chal.id);
    await playChallengeTurn(b.id, chal.id);

    const detail = await getChallengeById(chal.id, a.id);
    expect(detail.status).toBe('COMPLETED');
    // winnerId is legitimately NULL on a tie, and the service handles that
    // case explicitly (both entries refunded). This previously asserted
    // toBeTruthy(), which only held because of the DEFECT #3 scoring bug:
    // the opponent's score always read back as 0, so the second submitter
    // effectively always "won" and a tie was practically unreachable. With
    // scoring fixed, two equal dice sums are a real outcome (~11% for 2d6),
    // so the correct assertion is that the challenge resolved to one of the
    // three legal terminal outcomes.
    expect([a.id, b.id, null]).toContain(detail.winnerId);
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

// ═══════════════════════════════════════════════════════════════
// P1/P2 CONCURRENCY + WINNER-CORRECTNESS REGRESSION
//
// Covers three defects found during the full-application audit:
//
//   DEFECT #1 (P2) — playChallengeTurn took no lock on the GameChallenge
//   row, so two players submitting their final turns concurrently could
//   BOTH insert their own GameSession (different userId ⇒ no unique-key
//   contention) and BOTH fail to see the opponent's still-uncommitted
//   session, each returning "waiting for opponent". The challenge stayed
//   ACTIVE forever with both entry fees debited and no payout or refund.
//
//   DEFECT #3 (P1) — resolveChallengeOutcome returns { result, score } as
//   two separate values, but only `result` was persisted while the opponent
//   lookup read the score back as `session.result.score`. That key was
//   always undefined, so the first player's score always read as 0 and the
//   SECOND submitter won every wagered challenge regardless of outcome.
//
//   (cancelChallenge's lock was added for lock-ordering; see the service.)
// ═══════════════════════════════════════════════════════════════

describeIf('Challenge concurrency + winner correctness (P1/P2 regression)', () => {
  let a: { id: string };
  let b: { id: string };

  beforeAll(async () => {
    a = await createUser('race_a');
    b = await createUser('race_b');
    await ensureGameDefinitions();
    await primeGamePoints(a.id, 100_000);
    await primeGamePoints(b.id, 100_000);
  });

  // ── DEFECT #3 ────────────────────────────────────────────────
  it('persists `score` inside the session result (DEFECT #3 root cause)', async () => {
    const chal = await createChallenge(a.id, b.id, 'dice', 10);
    await acceptChallenge(b.id, chal.id);
    await playChallengeTurn(a.id, chal.id);
    await playChallengeTurn(b.id, chal.id);

    const sessions = await prisma.gameSession.findMany({ where: { challengeId: chal.id } });
    expect(sessions.length).toBe(2);
    for (const s of sessions) {
      const r = s.result as Record<string, unknown>;
      // Before the fix this key was absent, which is what made every
      // opponent score read back as 0.
      expect(r).toHaveProperty('score');
      expect(typeof r.score).toBe('number');
    }
  });

  it('declares the HIGHER scorer the winner, not whoever submitted second', async () => {
    // Dice is random, so rather than forcing an outcome we assert the
    // relationship that must hold for ANY outcome: the declared winner is
    // exactly the player whose persisted score is strictly higher (or a tie
    // when the scores are equal). Under DEFECT #3 the second submitter won
    // unconditionally, which breaks this for every non-tied, non-favourable
    // roll.
    for (let i = 0; i < 8; i++) {
      const chal = await createChallenge(a.id, b.id, 'dice', 10);
      await acceptChallenge(b.id, chal.id);
      await playChallengeTurn(a.id, chal.id);
      await playChallengeTurn(b.id, chal.id);

      const sessions = await prisma.gameSession.findMany({ where: { challengeId: chal.id } });
      const scoreOf = (uid: string) =>
        ((sessions.find((s) => s.userId === uid)!.result as Record<string, unknown>).score as number);
      const aScore = scoreOf(a.id);
      const bScore = scoreOf(b.id);

      const detail = await prisma.gameChallenge.findUnique({ where: { id: chal.id } });
      const expectedWinner = aScore > bScore ? a.id : bScore > aScore ? b.id : null;
      expect(detail!.winnerId).toBe(expectedWinner);
    }
  });

  // ── DEFECT #1 ────────────────────────────────────────────────
  it('concurrent final turns still complete the challenge exactly once (DEFECT #1)', async () => {
    const ENTRY = 25;

    for (let i = 0; i < 6; i++) {
      const chal = await createChallenge(a.id, b.id, 'dice', ENTRY);
      await acceptChallenge(b.id, chal.id);

      // Both entries are now escrowed. Capture the post-escrow totals.
      const aBefore = (await getWalletBalance(a.id)).gamePointsBalance;
      const bBefore = (await getWalletBalance(b.id)).gamePointsBalance;

      // THE RACE: both players submit their only turn simultaneously.
      const results = await Promise.allSettled([
        playChallengeTurn(a.id, chal.id),
        playChallengeTurn(b.id, chal.id),
      ]);

      // Neither turn may fail outright — the lock serializes them, it does
      // not reject one of them.
      for (const r of results) {
        expect(r.status).toBe('fulfilled');
      }

      // The challenge MUST reach its terminal state. Under DEFECT #1 it
      // could remain ACTIVE forever here.
      const detail = await prisma.gameChallenge.findUnique({ where: { id: chal.id } });
      expect(detail!.status).toBe('COMPLETED');
      expect(detail!.completedAt).not.toBeNull();

      // Exactly one turn per player, never duplicated.
      const sessions = await prisma.gameSession.findMany({ where: { challengeId: chal.id } });
      expect(sessions.length).toBe(2);

      // FUNDS CONSERVED, PAID EXACTLY ONCE. Both players were debited ENTRY
      // at create/accept; the pot (2 * ENTRY) must be returned in full —
      // either entirely to one winner or split back on a tie. Never zero
      // (stranded) and never more than the pot (double payout).
      const aAfter = (await getWalletBalance(a.id)).gamePointsBalance;
      const bAfter = (await getWalletBalance(b.id)).gamePointsBalance;
      expect(aAfter + bAfter).toBe(aBefore + bBefore + ENTRY * 2);

      // And the payout matches the recorded winner.
      if (detail!.winnerId === a.id) {
        expect(aAfter).toBe(aBefore + ENTRY * 2);
        expect(bAfter).toBe(bBefore);
      } else if (detail!.winnerId === b.id) {
        expect(bAfter).toBe(bBefore + ENTRY * 2);
        expect(aAfter).toBe(aBefore);
      } else {
        // Tie — both refunded their own entry.
        expect(aAfter).toBe(aBefore + ENTRY);
        expect(bAfter).toBe(bBefore + ENTRY);
      }
    }
  });

  it('a duplicate concurrent turn from the SAME player never double-pays', async () => {
    const ENTRY = 15;
    const chal = await createChallenge(a.id, b.id, 'dice', ENTRY);
    await acceptChallenge(b.id, chal.id);

    const aBefore = (await getWalletBalance(a.id)).gamePointsBalance;
    const bBefore = (await getWalletBalance(b.id)).gamePointsBalance;

    // Player A double-submits while B plays once.
    await Promise.allSettled([
      playChallengeTurn(a.id, chal.id),
      playChallengeTurn(a.id, chal.id),
      playChallengeTurn(b.id, chal.id),
    ]);

    const sessions = await prisma.gameSession.findMany({ where: { challengeId: chal.id } });
    expect(sessions.length).toBe(2); // one per player, enforced by the unique constraint

    const aAfter = (await getWalletBalance(a.id)).gamePointsBalance;
    const bAfter = (await getWalletBalance(b.id)).gamePointsBalance;
    expect(aAfter + bAfter).toBe(aBefore + bBefore + ENTRY * 2);
  });

  it('cancel racing a final turn leaves funds conserved and one terminal state', async () => {
    // Exercises the lock-ordering fix: cancelChallenge and playChallengeTurn
    // now take the GameChallenge row lock before touching any wallet, so the
    // two serialize instead of deadlocking or double-refunding.
    const ENTRY = 20;
    const chal = await createChallenge(a.id, b.id, 'dice', ENTRY);
    await acceptChallenge(b.id, chal.id);

    const aBefore = (await getWalletBalance(a.id)).gamePointsBalance;
    const bBefore = (await getWalletBalance(b.id)).gamePointsBalance;

    await Promise.allSettled([
      cancelChallenge(a.id, chal.id),
      playChallengeTurn(b.id, chal.id),
    ]);

    const detail = await prisma.gameChallenge.findUnique({ where: { id: chal.id } });
    expect(['CANCELLED', 'ACTIVE', 'COMPLETED']).toContain(detail!.status);

    const aAfter = (await getWalletBalance(a.id)).gamePointsBalance;
    const bAfter = (await getWalletBalance(b.id)).gamePointsBalance;

    // Whichever operation won, the combined balance never exceeds the fully
    // returned pot and never loses more than the escrow that is still held.
    const combinedBefore = aBefore + bBefore;
    const combinedAfter = aAfter + bAfter;
    expect(combinedAfter).toBeGreaterThanOrEqual(combinedBefore);
    expect(combinedAfter).toBeLessThanOrEqual(combinedBefore + ENTRY * 2);

    // If it settled terminally, the full pot must have been returned.
    if (detail!.status === 'CANCELLED' || detail!.status === 'COMPLETED') {
      expect(combinedAfter).toBe(combinedBefore + ENTRY * 2);
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// CHALLENGE ACCEPT/DECLINE RACE HARDENING
//
// The status re-check and the state write must happen under the challenge
// row lock, in the same challenge-then-wallet order as cancel/play. Before
// the fix, declineChallenge refunded and wrote DECLINED with no row lock
// and a status-unconditional update, so a racing cancel/accept could leave
// a double refund, a stale overwrite of the terminal state, or stranded
// funds. acceptChallenge had the same unlocked-read gap.
// ═══════════════════════════════════════════════════════════════

describeIf('Challenge accept/decline race hardening', () => {
  beforeAll(async () => {
    await ensureGameDefinitions();
  });

  // ── Deterministic held-lock: decline vs an in-flight cancel ──
  it('a decline blocked on a held cancel refunds once and never overwrites CANCELLED', async () => {
    const ENTRY = 20;
    const challenger = await createUser('held_cl');
    const challenged = await createUser('held_cd');
    await primeGamePoints(challenger.id, 1000);

    const chal = await createChallenge(challenger.id, challenged.id, 'dice', ENTRY);
    const escrowBalance = (await getWalletBalance(challenger.id)).gamePointsBalance;
    const challengedBefore = (await getWalletBalance(challenged.id)).gamePointsBalance;

    // Simulate a cancel that is mid-flight: lock the challenge row, refund
    // the challenger, set CANCELLED, and hold it all uncommitted while the
    // decline runs and blocks.
    const outcome: { decline?: { ok: boolean; error?: unknown } } = {};
    await prisma.$transaction(async (ctlTx) => {
      await ctlTx.$queryRaw`SELECT "status" FROM "game_challenges" WHERE "id" = ${chal.id} FOR UPDATE`;
      await applyBalanceChanges(ctlTx, challenger.id, [
        {
          currency: 'GAME_POINTS',
          amount: ENTRY,
          ledgerType: 'CREDIT',
          transactionType: 'GAME_POINT_CREDIT',
          referenceType: 'GAME',
          description: 'Challenge cancelled — entry refund',
        },
      ]);
      await ctlTx.gameChallenge.update({ where: { id: chal.id }, data: { status: 'CANCELLED' } });

      outcome.decline = declineChallenge(challenged.id, chal.id)
        .then(() => ({ ok: true as const }))
        .catch((error: unknown) => ({ ok: false as const, error }));

      await new Promise((resolve) => setTimeout(resolve, 300));
    });

    // The decline MUST be rejected by the status re-check under the row lock
    // ('Challenge is not pending'), never by a wallet version conflict (the
    // un-locked pre-fix path) and never by silently succeeding.
    const declineResult = await outcome.decline!;
    expect(declineResult.ok).toBe(false);
    expect((declineResult.error as ApiError).message).toBe('Challenge is not pending');

    const detail = await prisma.gameChallenge.findUnique({ where: { id: chal.id } });
    expect(detail!.status).toBe('CANCELLED');

    const refunds = await prisma.walletTransaction.findMany({
      where: { userId: challenger.id, description: { in: CHALLENGE_REFUND_DESCRIPTIONS } },
    });
    expect(refunds.length).toBe(1);
    expect(refunds[0].description).toBe('Challenge cancelled — entry refund');
    expect(refunds[0].amount).toBe(ENTRY);

    const challengerAfter = (await getWalletBalance(challenger.id)).gamePointsBalance;
    expect(challengerAfter).toBe(escrowBalance + ENTRY);
    const challengedAfter = (await getWalletBalance(challenged.id)).gamePointsBalance;
    expect(challengedAfter).toBe(challengedBefore);
  });

  // ── decline vs cancel: realistic race, 5 fresh rounds ──
  it('decline racing cancel settles with exactly one refund and one terminal state (5 rounds)', async () => {
    const ENTRY = 20;

    for (let i = 0; i < 5; i++) {
      const challenger = await createUser(`rc8_c${i}`);
      const challenged = await createUser(`rc8_d${i}`);
      await primeGamePoints(challenger.id, 1000);
      await primeGamePoints(challenged.id, 1000);

      const chal = await createChallenge(challenger.id, challenged.id, 'dice', ENTRY);
      const escrowBalance = (await getWalletBalance(challenger.id)).gamePointsBalance;
      const challengedBefore = (await getWalletBalance(challenged.id)).gamePointsBalance;

      const results = await Promise.allSettled([
        declineChallenge(challenged.id, chal.id),
        cancelChallenge(challenger.id, chal.id),
      ]);

      // Exactly one operation wins; the other is rejected by the status
      // re-check under the row lock.
      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');
      expect(fulfilled.length).toBe(1);
      expect(rejected.length).toBe(1);

      // No terminal-state overwrite: the challenge lands on exactly one of
      // the two winning terminals, and the refund that actually happened must
      // match that terminal (never both movements, never a stale overwrite).
      const detail = await prisma.gameChallenge.findUnique({ where: { id: chal.id } });
      expect(['DECLINED', 'CANCELLED']).toContain(detail!.status);

      const refunds = await prisma.walletTransaction.findMany({
        where: { userId: challenger.id, description: { in: CHALLENGE_REFUND_DESCRIPTIONS } },
      });
      expect(refunds.length).toBe(1);
      const expectedRefund =
        detail!.status === 'CANCELLED'
          ? 'Challenge cancelled — entry refund'
          : 'Challenge declined — entry refund';
      expect(refunds[0].description).toBe(expectedRefund);

      const challengerAfter = (await getWalletBalance(challenger.id)).gamePointsBalance;
      expect(challengerAfter).toBe(escrowBalance + ENTRY);
      const challengedAfter = (await getWalletBalance(challenged.id)).gamePointsBalance;
      expect(challengedAfter).toBe(challengedBefore);
    }
  });

  // ── decline vs accept: realistic race, 5 fresh funded rounds ──
  it('decline racing accept settles with one winner and no stranded funds (5 rounds)', async () => {
    const ENTRY = 20;

    for (let i = 0; i < 5; i++) {
      const challenger = await createUser(`ra9_c${i}`);
      const challenged = await createUser(`ra9_cd${i}`);
      await primeGamePoints(challenger.id, 1000);
      await primeGamePoints(challenged.id, 1000);

      const chal = await createChallenge(challenger.id, challenged.id, 'dice', ENTRY);
      const escrowBalance = (await getWalletBalance(challenger.id)).gamePointsBalance;
      const challengedBefore = (await getWalletBalance(challenged.id)).gamePointsBalance;

      const results = await Promise.allSettled([
        declineChallenge(challenged.id, chal.id),
        acceptChallenge(challenged.id, chal.id),
      ]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');
      expect(fulfilled.length).toBe(1);
      expect(rejected.length).toBe(1);

      const detail = await prisma.gameChallenge.findUnique({ where: { id: chal.id } });
      expect(['DECLINED', 'ACTIVE']).toContain(detail!.status);

      const challengerRefunds = await countChallengeRefunds(challenger.id);
      const challengerEntries = await countChallengeEntries(challenger.id, 'dice');
      const challengedEntries = await countChallengeEntries(challenged.id, 'dice');

      if (detail!.status === 'DECLINED') {
        // Challenge never started: challenger stake fully refunded, challenged
        // never paid, acceptedAt stays null.
        expect(challengerRefunds).toBe(1);
        expect(challengerEntries).toBe(1);
        expect(challengedEntries).toBe(0);
        const challengerAfter = (await getWalletBalance(challenger.id)).gamePointsBalance;
        expect(challengerAfter).toBe(escrowBalance + ENTRY);
        const challengedAfter = (await getWalletBalance(challenged.id)).gamePointsBalance;
        expect(challengedAfter).toBe(challengedBefore);
        expect(detail!.acceptedAt).toBeNull();
        // Zero stranded funds: both players are back to their pre-challenge
        // starting balances.
        expect(challengerAfter + challengedAfter).toBe(2000);
      } else {
        // Challenge accepted: each player holds exactly one entry debit, the
        // challenger's stake stays escrowed (no refund), acceptedAt is set.
        expect(challengerRefunds).toBe(0);
        expect(challengerEntries).toBe(1);
        expect(challengedEntries).toBe(1);
        const challengerAfter = (await getWalletBalance(challenger.id)).gamePointsBalance;
        expect(challengerAfter).toBe(escrowBalance);
        const challengedAfter = (await getWalletBalance(challenged.id)).gamePointsBalance;
        expect(challengedAfter).toBe(challengedBefore - ENTRY);
        expect(detail!.acceptedAt).not.toBeNull();
        // Zero stranded funds: exactly the 2 x ENTRY pot is escrowed in-game.
        expect(challengerAfter + challengedAfter).toBe(1960);
      }
    }
  });

  // ── Atomicity: a failing refund rolls the whole decline back ──
  it('a failed decline refund rolls back atomically and never mutates state', async () => {
    const ENTRY = 20;
    const MAX_BALANCE = 1_000_000_000;

    const challenger = await createUser('roll_cl');
    const challenged = await createUser('roll_cd');
    // Put the challenger exactly at the MAX_BALANCE guard.
    await primeGamePoints(challenger.id, MAX_BALANCE);
    await primeGamePoints(challenged.id, 1000);

    const chal = await createChallenge(challenger.id, challenged.id, 'dice', ENTRY);
    // Top the challenger back up to MAX_BALANCE so a decline refund of ENTRY
    // would exceed the guard and fail.
    await primeGamePoints(challenger.id, ENTRY);
    const challengedBefore = (await getWalletBalance(challenged.id)).gamePointsBalance;

    await expect(declineChallenge(challenged.id, chal.id)).rejects.toThrow();

    const detail = await prisma.gameChallenge.findUnique({ where: { id: chal.id } });
    expect(detail!.status).toBe('PENDING');

    // The refund ledger row must not persist — refund and state transition
    // are one atomic transaction.
    expect(await countChallengeRefunds(challenger.id)).toBe(0);

    const challengedAfter = (await getWalletBalance(challenged.id)).gamePointsBalance;
    expect(challengedAfter).toBe(challengedBefore);
  });
});
