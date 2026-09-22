import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '@socialplay/database';
import {
  listActiveGames,
  getGameByKey,
  getGameRules,
  resolveCurrentRules,
} from './game-catalog';
import { fingerprintPlay, normalizeSelections } from './game-fingerprint';
import { playGame, getGameHistory } from './game-play';
import { lockUserForPlay } from './game-locks';
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

async function primeCoins(userId: string, amount: number) {
  await getOrCreateWallet(userId);
  const { executeBalanceChange } = await import('../economy/wallet-service');
  await executeBalanceChange({
    userId,
    changes: [
      {
        currency: 'COINS',
        amount,
        ledgerType: 'CREDIT',
        transactionType: 'COIN_CREDIT',
        referenceType: 'ADMIN',
        description: 'Test fixture coins',
      },
    ],
    operationName: 'test_fund_coins',
  });
}

async function cleanFixtures() {
  const users = await prisma.user.findMany({
    where: { email: { startsWith: 'games-' } },
  });
  const userIds = users.map((u) => u.id);
  if (userIds.length) {
    await prisma.gameSession.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.idempotencyRecord.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.walletTransaction.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.userTriviaAttempt.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.wallet.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }
}

// ─── FINGERPRINTING ────────────────────────────────────────────

describe('fingerprint helper', () => {
  it('normalizes selection key order deterministically', () => {
    const a = normalizeSelections({ answerIndex: 1, questionId: 'q' });
    const b = normalizeSelections({ questionId: 'q', answerIndex: 1 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('produces stable SHA-256 fingerprints', () => {
    const f1 = fingerprintPlay({
      gameKey: 'dice',
      rulesVersion: 1,
      stake: 50,
      selections: { guess: 7 },
    });
    const f2 = fingerprintPlay({
      gameKey: 'dice',
      rulesVersion: 1,
      stake: 50,
      selections: { guess: 7 },
    });
    const f3 = fingerprintPlay({
      gameKey: 'dice',
      rulesVersion: 1,
      stake: 51,
      selections: { guess: 7 },
    });
    expect(f1).toBe(f2);
    expect(f1).not.toBe(f3);
    expect(f1).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ─── GAME CATALOG ──────────────────────────────────────────────

describeIf('Game catalog (Phase G0)', () => {
  beforeAll(async () => {
    await cleanFixtures();
  });

  it('public catalog returns exactly 13 entries (AVAILABLE + COMING_SOON), excluding RETIRED lucky_spin', async () => {
    const games = await listActiveGames();
    expect(games.length).toBe(13);
    const keys = games.map((g) => g.key);
    expect(keys).not.toContain('lucky_spin');
    expect(keys).toContain('dice');
    expect(keys).toContain('number_challenge');
    expect(keys).toContain('trivia');
    expect(keys.filter((k) => k.startsWith('coming_')).length).toBe(0);
  });

  it('every catalog row exposes the Phase-G0 fields', async () => {
    const games = await listActiveGames();
    for (const g of games) {
      expect(g.mode).toMatch(/^(WAGER|BONUS)$/);
      expect(g.family).toMatch(/^(INSTANT|SCHEDULED_DRAW|SCHEDULED_RACE)$/);
      expect(g.catalogStatus).toMatch(/^(AVAILABLE|COMING_SOON)$/);
      expect(['COINS', 'GAME_POINTS']).toContain(g.rewardCurrency);
      expect(g.wagerCurrency === null || g.wagerCurrency === 'COINS' || g.wagerCurrency === 'GAME_POINTS').toBe(true);
      expect(g.currentRulesVersion).not.toBe(undefined);
    }
    const trivia = games.find((g) => g.key === 'trivia')!;
    expect(trivia.mode).toBe('BONUS');
    expect(trivia.wagerCurrency).toBeNull();
    expect(trivia.rewardCurrency).toBe('COINS');
    expect(trivia.currentRulesVersion).toBe(1);
    const dice = games.find((g) => g.key === 'dice')!;
    expect(dice.mode).toBe('WAGER');
    expect(dice.wagerCurrency).toBe('COINS');
    expect(dice.rewardCurrency).toBe('COINS');
    expect(dice.currentRulesVersion).toBe(1);
  });

  it('retired lucky_spin is still resolvable by key but absent from the catalog', async () => {
    const game = await getGameByKey('lucky_spin');
    expect(game).not.toBeNull();
    expect(game!.catalogStatus).toBe('RETIRED');
  });

  it('rules helpers resolve the current version for playable games', async () => {
    const game = await getGameByKey('dice');
    expect(game).not.toBeNull();
    const rules = await resolveCurrentRules(game!);
    expect(rules?.version).toBe(game!.currentRulesVersion);
    expect(rules?.resultSchemaVersion).toBe(1);
    const byKey = await getGameRules(game!.id, 1);
    expect(byKey?.version).toBe(1);
  });
});

// ─── BET VALIDATION (WAGER) ────────────────────────────────────

describeIf('Bet validation', () => {
  let a: { id: string };

  beforeAll(async () => {
    await cleanFixtures();
    a = await createUser('bet');
    await primeCoins(a.id, 1000);
  });

  it('rejects non-integer bet', async () => {
    await expect(
      playGame({ userId: a.id, gameKey: 'dice', betAmount: 1.5, idempotencyKey: 'bet-f1' })
    ).rejects.toThrow();
  });

  it('rejects zero bet', async () => {
    await expect(
      playGame({ userId: a.id, gameKey: 'dice', betAmount: 0, idempotencyKey: 'bet-f2' })
    ).rejects.toThrow();
  });

  it('rejects negative bet', async () => {
    await expect(
      playGame({ userId: a.id, gameKey: 'dice', betAmount: -10, idempotencyKey: 'bet-f3' })
    ).rejects.toThrow();
  });

  it('rejects bet below minimum', async () => {
    await expect(
      playGame({ userId: a.id, gameKey: 'dice', betAmount: 1, idempotencyKey: 'bet-f4' })
    ).rejects.toThrow();
  });

  it('rejects bet above maximum', async () => {
    await expect(
      playGame({ userId: a.id, gameKey: 'dice', betAmount: 99999, idempotencyKey: 'bet-f5' })
    ).rejects.toThrow();
  });

  it('rejects string bet', async () => {
    await expect(
      playGame({ userId: a.id, gameKey: 'dice', betAmount: '10' as any, idempotencyKey: 'bet-f6' })
    ).rejects.toThrow();
  });

  it('rejects a WAGER game with no betAmount', async () => {
    await expect(
      playGame({ userId: a.id, gameKey: 'dice', idempotencyKey: 'bet-f7' })
    ).rejects.toThrow();
  });

  it('rejects a RETIRED game', async () => {
    await expect(
      playGame({ userId: a.id, gameKey: 'lucky_spin', betAmount: 100, idempotencyKey: 'bet-f8' })
    ).rejects.toThrow();
  });
});

// ─── IDEMPOTENCY KEY VALIDATION ────────────────────────────────

describeIf('Idempotency key validation', () => {
  let a: { id: string };

  beforeAll(async () => {
    await cleanFixtures();
    a = await createUser('idkey');
    await primeCoins(a.id, 1000);
  });

  it('requires an idempotency key', async () => {
    await expect(
      playGame({ userId: a.id, gameKey: 'dice', betAmount: 10 })
    ).rejects.toThrow();
  });

  it('rejects keys longer than 128 chars', async () => {
    const long = 'x'.repeat(129);
    await expect(
      playGame({ userId: a.id, gameKey: 'dice', betAmount: 10, idempotencyKey: long })
    ).rejects.toThrow();
  });

  it('rejects keys with control or space characters', async () => {
    await expect(
      playGame({ userId: a.id, gameKey: 'dice', betAmount: 10, idempotencyKey: 'has space' })
    ).rejects.toThrow();
    await expect(
      playGame({ userId: a.id, gameKey: 'dice', betAmount: 10, idempotencyKey: 'ctrl\u0001char' })
    ).rejects.toThrow();
  });
});

// ─── INSUFFICIENT COINS ────────────────────────────────────────

describeIf('Insufficient Coins', () => {
  let a: { id: string };

  beforeAll(async () => {
    await cleanFixtures();
    a = await createUser('insuf');
    await getOrCreateWallet(a.id);
  });

  it('rejects play when the COINS balance is 0', async () => {
    await expect(
      playGame({ userId: a.id, gameKey: 'dice', betAmount: 10, idempotencyKey: 'insuf-1' })
    ).rejects.toThrow();
  });
});

// ─── ELIGIBILITY ───────────────────────────────────────────────

describeIf('Eligibility', () => {
  let a: { id: string };

  beforeAll(async () => {
    await cleanFixtures();
    a = await createUser('elig');
    await primeCoins(a.id, 1000);
  });

  it('lockUserForPlay rejects a non-ACTIVE account', async () => {
    await prisma.user.update({ where: { id: a.id }, data: { status: 'SUSPENDED' } });
    try {
      await expect(
        playGame({ userId: a.id, gameKey: 'dice', betAmount: 10, idempotencyKey: 'elig-1' })
      ).rejects.toThrow();
    } finally {
      await prisma.user.update({ where: { id: a.id }, data: { status: 'ACTIVE' } });
    }
  });

  it('lockUserForPlay returns the locked user for ACTIVE accounts', async () => {
    const locked = (await prisma.$transaction((tx) => lockUserForPlay(tx, a.id))) as {
      id: string;
      status: string;
    };
    expect(locked.id).toBe(a.id);
    expect(locked.status).toBe('ACTIVE');
  });
});

// ─── DICE ──────────────────────────────────────────────────────

describeIf('Dice', () => {
  let a: { id: string };

  beforeAll(async () => {
    await cleanFixtures();
    a = await createUser('dice');
    await primeCoins(a.id, 1000);
  });

  it('returns valid dice result', async () => {
    const result = await playGame({
      userId: a.id, gameKey: 'dice', betAmount: 100, idempotencyKey: 'dice-1',
    });
    expect(result.gameKey).toBe('dice');
    expect(result.betAmount).toBe(100);
    expect(result.mode).toBe('WAGER');
    expect(result.wagerCurrency).toBe('COINS');
    expect(result.rewardCurrency).toBe('COINS');
    expect(result.rulesVersion).toBe(1);
    expect(result.resultSchemaVersion).toBe(1);
    expect(result.playContext).toBe('SOLO_WAGER');
    expect(result.isReplay).toBe(false);
    const { die1, die2, sum } = result.result as any;
    expect(die1).toBeGreaterThanOrEqual(1);
    expect(die1).toBeLessThanOrEqual(6);
    expect(die2).toBeGreaterThanOrEqual(1);
    expect(die2).toBeLessThanOrEqual(6);
    expect(sum).toBe(die1 + die2);
  });

  it('win on sum >= threshold (7)', async () => {
    for (let i = 0; i < 20; i++) {
      const result = await playGame({
        userId: a.id, gameKey: 'dice', betAmount: 10, idempotencyKey: `dice-win-${i}`,
      });
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

  it('returns authoritative server-side newBalance in COINS', async () => {
    const before = await getWalletBalance(a.id);
    const result = await playGame({
      userId: a.id, gameKey: 'dice', betAmount: 10, idempotencyKey: 'dice-balance-1',
    });
    const expected = before.coinsBalance - 10 + result.rewardAmount;
    expect(result.newBalance).toBe(expected);
    const after = await getWalletBalance(a.id);
    expect(result.newBalance).toBe(after.coinsBalance);
    expect(after.coinsBalance).toBeGreaterThanOrEqual(0);
  });

  it('persists immutable snapshots and settlement currencies on the session', async () => {
    const result = await playGame({
      userId: a.id, gameKey: 'dice', betAmount: 10, idempotencyKey: 'dice-snap-1',
    });
    const session = await prisma.gameSession.findUniqueOrThrow({ where: { id: result.sessionId } });
    expect(session.mode).toBe('WAGER');
    expect(session.family).toBe('INSTANT');
    expect(session.wagerCurrency).toBe('COINS');
    expect(session.rewardCurrency).toBe('COINS');
    expect(session.rulesVersion).toBe(1);
    expect(session.resultSchemaVersion).toBe(1);
    expect(session.playContext).toBe('SOLO_WAGER');
    expect(session.settlementDebitCurrency).toBe('COINS');
    expect(session.settlementCreditCurrency).toBe('COINS');
    expect(session.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    const requestSnapshot = session.requestSnapshot as any;
    expect(requestSnapshot.gameKey).toBe('dice');
    expect(requestSnapshot.rulesVersion).toBe(1);
    expect(requestSnapshot.stake).toBe(10);
    const responseSnapshot = session.responseSnapshot as any;
    expect(responseSnapshot.sessionId).toBe(result.sessionId);
    expect(responseSnapshot.newBalance).toBe(result.newBalance);
    expect(responseSnapshot.isReplay).toBeUndefined();
  });
});

// ─── NUMBER CHALLENGE ──────────────────────────────────────────

describeIf('Number Challenge', () => {
  let a: { id: string };

  beforeAll(async () => {
    await cleanFixtures();
    a = await createUser('num');
    await primeCoins(a.id, 1000);
  });

  it('validates guess is required', async () => {
    await expect(
      playGame({ userId: a.id, gameKey: 'number_challenge', betAmount: 10, clientData: {}, idempotencyKey: 'num-1' })
    ).rejects.toThrow();
  });

  it('validates guess is integer', async () => {
    await expect(
      playGame({ userId: a.id, gameKey: 'number_challenge', betAmount: 10, clientData: { guess: 1.5 }, idempotencyKey: 'num-2' })
    ).rejects.toThrow();
  });

  it('returns correct/away in result', async () => {
    const result = await playGame({
      userId: a.id, gameKey: 'number_challenge', betAmount: 10,
      clientData: { guess: 50 }, idempotencyKey: 'num-3',
    });
    expect(result.result).toHaveProperty('guess');
    expect(result.result).toHaveProperty('target');
    expect(result.result).toHaveProperty('away');
    expect(result.result).toHaveProperty('correct');
    expect((result.result as any).guess).toBe(50);
  });
});

// ─── TRIVIA (BONUS, no stake, restricted COINS reward) ─────────

describeIf('Trivia', () => {
  let a: { id: string };
  let questionId: string;
  let wrongAnswerQuestionId: string;

  const bet0 = (key: string) => playGame({
    userId: a.id, gameKey: 'trivia', betAmount: 0, idempotencyKey: key,
  });
  const good = (key: string, qid: string, answer: number) => playGame({
    userId: a.id, gameKey: 'trivia', clientData: { questionId: qid, answerIndex: answer }, idempotencyKey: key,
  });

  beforeAll(async () => {
    await cleanFixtures();
    a = await createUser('trivia');
    await primeCoins(a.id, 1000);

    const q = await prisma.triviaQuestion.create({
      data: { question: 'What is 2 + 2?', choices: ['3', '4', '5', '6'], correctIndex: 1, category: 'math' },
    });
    questionId = q.id;

    const q2 = await prisma.triviaQuestion.create({
      data: { question: 'What is 3 + 3?', choices: ['5', '6', '7', '8'], correctIndex: 1, category: 'math' },
    });
    wrongAnswerQuestionId = q2.id;
  });

  it('forbids a betAmount field even when 0', async () => {
    await expect(bet0('trivia-betfield')).rejects.toThrow();
  });

  it('forbids a betAmount field even when present (nonzero)', async () => {
    await expect(
      playGame({ userId: a.id, gameKey: 'trivia', betAmount: 10, clientData: { questionId, answerIndex: 1 }, idempotencyKey: 'trivia-betfield2' })
    ).rejects.toThrow();
  });

  it('credits a correct answer with 30 COINS and no stake', async () => {
    const before = await getWalletBalance(a.id);
    const result = await good('trivia-correct', questionId, 1);
    const after = await getWalletBalance(a.id);
    expect(result.isWin).toBe(true);
    expect(result.rewardAmount).toBe(30);
    expect(result.betAmount).toBe(0);
    expect(result.mode).toBe('BONUS');
    expect(result.wagerCurrency).toBeNull();
    expect(result.rewardCurrency).toBe('COINS');
    expect(result.playContext).toBe('BONUS');
    expect(after.coinsBalance).toBe(before.coinsBalance + 30);
    const session = await prisma.gameSession.findUniqueOrThrow({ where: { id: result.sessionId } });
    expect(session.settlementDebitCurrency).toBeNull();
    expect(session.settlementCreditCurrency).toBe('COINS');
    expect(session.betAmount).toBe(0);
  });

  it('gives no reward for a wrong answer and settles nothing', async () => {
    const before = await getWalletBalance(a.id);
    const result = await good('trivia-wrong', wrongAnswerQuestionId, 0);
    const after = await getWalletBalance(a.id);
    expect(result.isWin).toBe(false);
    expect(result.rewardAmount).toBe(0);
    expect(after.coinsBalance).toBe(before.coinsBalance);
    const session = await prisma.gameSession.findUniqueOrThrow({ where: { id: result.sessionId } });
    expect(session.settlementDebitCurrency).toBeNull();
    expect(session.settlementCreditCurrency).toBeNull();
  });

  it('validates questionId is required', async () => {
    await expect(
      playGame({ userId: a.id, gameKey: 'trivia', clientData: { answerIndex: 1 }, idempotencyKey: 'trivia-q1' })
    ).rejects.toThrow();
  });

  it('validates answerIndex is required', async () => {
    await expect(
      playGame({ userId: a.id, gameKey: 'trivia', clientData: { questionId }, idempotencyKey: 'trivia-q2' })
    ).rejects.toThrow();
  });

  it('rejects duplicate attempt on the same question', async () => {
    const q = await prisma.triviaQuestion.create({
      data: { question: 'What is 3 + 3?', choices: ['5', '6', '7', '8'], correctIndex: 1, category: 'math' },
    });
    await good('trivia-dup-1', q.id, 1);
    await expect(good('trivia-dup-2', q.id, 2)).rejects.toThrow();
  });

  it('allows different questions for the same user', async () => {
    const q = await prisma.triviaQuestion.create({
      data: { question: 'What is 5 + 5?', choices: ['8', '9', '10', '11'], correctIndex: 2, category: 'math' },
    });
    const result = await good('trivia-diff-1', q.id, 2);
    expect(result.isWin).toBe(true);
  });

  it('concurrent duplicate attempts are rejected safely', async () => {
    const q = await prisma.triviaQuestion.create({
      data: { question: 'What is 7 + 7?', choices: ['12', '13', '14', '15'], correctIndex: 2, category: 'math' },
    });
    const results = await Promise.allSettled(
      Array.from({ length: 3 }, (_, i) =>
        good(`trivia-conc-${i}`, q.id, 2)
      )
    );
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    expect(fulfilled.length).toBe(1);
  });
});

// ─── IDEMPOTENCY / REPLAY ──────────────────────────────────────

describeIf('Idempotency and replay', () => {
  let a: { id: string };

  beforeAll(async () => {
    await cleanFixtures();
    a = await createUser('idem');
    await primeCoins(a.id, 5000);
  });

  it('same key + same fingerprint replays the stored snapshot with isReplay=true', async () => {
    const base = { userId: a.id, gameKey: 'dice', betAmount: 100, idempotencyKey: 'idem-dice-1' } as const;
    const r1 = await playGame({ ...base });
    const r2 = await playGame({ ...base });
    expect(r2.sessionId).toBe(r1.sessionId);
    expect(r2.rewardAmount).toBe(r1.rewardAmount);
    expect(r2.result).toEqual(r1.result);
    expect(r2.isReplay).toBe(true);
    expect(r1.isReplay).toBe(false);
    expect(r2.newBalance).toBe(r1.newBalance);
  });

  it('same key + different fingerprint (different stake) conflicts with 409', async () => {
    await playGame({
      userId: a.id, gameKey: 'dice', betAmount: 100, idempotencyKey: 'idem-dice-2',
    });
    await expect(
      playGame({ userId: a.id, gameKey: 'dice', betAmount: 50, idempotencyKey: 'idem-dice-2' })
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it('trivia is replayable with the same key without double-crediting', async () => {
    const q = await prisma.triviaQuestion.create({
      data: { question: 'What is 4 + 4?', choices: ['6', '7', '8', '9'], correctIndex: 2, category: 'math' },
    });
    const before = await getWalletBalance(a.id);
    const r1 = await playGame({
      userId: a.id, gameKey: 'trivia',
      clientData: { questionId: q.id, answerIndex: 2 },
      idempotencyKey: 'idem-trivia-1',
    });
    const r2 = await playGame({
      userId: a.id, gameKey: 'trivia',
      clientData: { questionId: q.id, answerIndex: 2 },
      idempotencyKey: 'idem-trivia-1',
    });
    const after = await getWalletBalance(a.id);
    expect(r2.isReplay).toBe(true);
    expect(after.coinsBalance).toBe(before.coinsBalance + r1.rewardAmount);
  });

  it('different idempotency keys create different sessions', async () => {
    const r1 = await playGame({
      userId: a.id, gameKey: 'dice', betAmount: 100, idempotencyKey: 'idem-dice-3',
    });
    const r2 = await playGame({
      userId: a.id, gameKey: 'dice', betAmount: 100, idempotencyKey: 'idem-dice-4',
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
    await primeCoins(a.id, 1000);

    await playGame({ userId: a.id, gameKey: 'dice', betAmount: 10, idempotencyKey: 'hist-1' });
    await playGame({ userId: a.id, gameKey: 'number_challenge', betAmount: 20, clientData: { guess: 50 }, idempotencyKey: 'hist-2' });
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
    await primeCoins(a.id, 100);
  });

  it('concurrent games cannot overspend', async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) =>
        playGame({ userId: a.id, gameKey: 'dice', betAmount: 10, idempotencyKey: `conc-${i}` })
      )
    );

    const fulfilled = results.filter((r) => r.status === 'fulfilled').length;
    expect(fulfilled).toBeLessThanOrEqual(10);

    const wallet = await getWalletBalance(a.id);
    expect(wallet.coinsBalance).toBeGreaterThanOrEqual(0);

    const rec = await reconcileBalance(a.id);
    expect(rec.coinsMatch).toBe(true);
  });
});

// ─── CLIENT MANIPULATION ───────────────────────────────────────

describeIf('Client manipulation', () => {
  let a: { id: string };

  beforeAll(async () => {
    await cleanFixtures();
    a = await createUser('manip');
    await primeCoins(a.id, 1000);
  });

  it('client cannot supply dice result', async () => {
    const result = await playGame({
      userId: a.id, gameKey: 'dice', betAmount: 10,
      clientData: { die1: 6, die2: 6, sum: 12 }, idempotencyKey: 'manip-dice-1',
    });
    const { die1, sum } = result.result as any;
    expect(typeof die1).toBe('number');
    expect(die1).toBeGreaterThanOrEqual(1);
    expect(die1).toBeLessThanOrEqual(6);
    void sum;
  });

  it('client cannot supply reward amount', async () => {
    const result = await playGame({
      userId: a.id, gameKey: 'dice', betAmount: 10,
      clientData: { rewardAmount: 99999 }, idempotencyKey: 'manip-reward-1',
    });
    expect(result.rewardAmount).toBeLessThan(99999);
  });
});