import { prisma } from '@socialplay/database';
import { ApiError } from '../middleware';
import { getOrCreateWallet, applyBalanceChanges, BalanceChange } from '../economy/wallet-service';
import {
  pickLuckySpinOutcome,
  rollDice,
  generateTarget,
  evaluateGuess,
  checkTriviaAnswer,
  calculateGameReward,
} from './game-engine';
import { getGameByKey, ensureGameDefinitions } from './game-catalog';

export interface PlayGameArgs {
  userId: string;
  gameKey: string;
  betAmount: number;
  idempotencyKey?: string;
  clientData?: Record<string, unknown>;
}

export interface GameResult {
  sessionId: string;
  gameKey: string;
  betAmount: number;
  rewardAmount: number;
  isWin: boolean;
  result: Record<string, unknown>;
  completedAt: Date;
}

// ─── Bet Validation ────────────────────────────────────────────

function validateBet(amount: unknown, minBet: number, maxBet: number): number {
  if (typeof amount !== 'number') throw ApiError.badRequest('Bet must be a number');
  if (!Number.isInteger(amount)) throw ApiError.badRequest('Bet must be an integer');
  if (amount <= 0) throw ApiError.badRequest('Bet must be positive');
  if (amount < minBet) throw ApiError.badRequest(`Minimum bet is ${minBet}`);
  if (amount > maxBet) throw ApiError.badRequest(`Maximum bet is ${maxBet}`);
  return amount;
}

// ─── Game Result Generators (server-authoritative) ─────────────

function generateLuckySpinResult(
  betAmount: number,
  config: Record<string, unknown>
): { result: Record<string, unknown>; rewardAmount: number; isWin: boolean } {
  const outcomes = (config.outcomes as Array<{ name: string; multiplier: number; probability: number }>) ?? [
    { name: 'LOSE', multiplier: 0, probability: 0.45 },
    { name: 'SMALL_WIN', multiplier: 1.5, probability: 0.25 },
    { name: 'MEDIUM_WIN', multiplier: 3, probability: 0.15 },
    { name: 'LARGE_WIN', multiplier: 5, probability: 0.10 },
    { name: 'JACKPOT', multiplier: 10, probability: 0.05 },
  ];

  const { outcome } = pickLuckySpinOutcome({ outcomes });
  const { rewardAmount, isWin } = calculateGameReward(betAmount, outcome.multiplier);
  return {
    result: { name: outcome.name, multiplier: outcome.multiplier, index: outcome.index },
    rewardAmount,
    isWin,
  };
}

function generateDiceResult(
  betAmount: number,
  config: Record<string, unknown>
): { result: Record<string, unknown>; rewardAmount: number; isWin: boolean } {
  const { die1, die2, sum } = rollDice();
  const threshold = (config.winThreshold as number) ?? 7;
  const multiplier = (config.multiplier as number) ?? 2;
  const isWin = sum >= threshold;
  const { rewardAmount } = calculateGameReward(betAmount, isWin ? multiplier : 0);
  return {
    result: { die1, die2, sum, threshold },
    rewardAmount,
    isWin,
  };
}

function generateNumberChallengeResult(
  betAmount: number,
  config: Record<string, unknown>,
  guess: number | undefined
): { result: Record<string, unknown>; rewardAmount: number; isWin: boolean } {
  if (guess === undefined || guess === null) throw ApiError.badRequest('Guess is required');
  if (!Number.isInteger(guess)) throw ApiError.badRequest('Guess must be an integer');

  const range = (config.range as { min: number; max: number }) ?? { min: 1, max: 100 };
  const target = generateTarget(range.min, range.max);
  const { correct, away } = evaluateGuess(guess, target);

  const rewards = (config.rewards as Record<string, number>) ?? { exact: 5, within1: 3, within5: 2, within10: 1.5 };
  let multiplier = 0;
  if (correct) multiplier = rewards.exact ?? 5;
  else if (away <= 1) multiplier = rewards.within1 ?? 3;
  else if (away <= 5) multiplier = rewards.within5 ?? 2;
  else if (away <= 10) multiplier = rewards.within10 ?? 1.5;

  const { rewardAmount, isWin } = calculateGameReward(betAmount, multiplier);
  return {
    result: { guess, target, away, correct },
    rewardAmount,
    isWin,
  };
}

async function generateTriviaResult(
  betAmount: number,
  config: Record<string, unknown>,
  questionId: string | undefined,
  answerIndex: number | undefined
): Promise<{ result: Record<string, unknown>; rewardAmount: number; isWin: boolean; questionId: string }> {
  if (!questionId) throw ApiError.badRequest('Question ID is required');
  if (answerIndex === undefined || answerIndex === null) throw ApiError.badRequest('Answer index is required');

  const question = await prisma.triviaQuestion.findUnique({ where: { id: questionId } });
  if (!question || !question.isActive) throw ApiError.badRequest('Invalid question');

  const { correct } = checkTriviaAnswer(answerIndex, question.correctIndex);
  const correctMultiplier = (config.correctMultiplier as number) ?? 3;
  const { rewardAmount, isWin } = calculateGameReward(betAmount, correct ? correctMultiplier : 0);

  return {
    result: {
      questionId: question.id,
      submittedAnswer: answerIndex,
      correctIndex: question.correctIndex,
      correct,
    },
    rewardAmount,
    isWin,
    questionId: question.id,
  };
}

// ─── Main Play Handler ─────────────────────────────────────────

export async function playGame(args: PlayGameArgs): Promise<GameResult> {
  const { userId, gameKey, betAmount: rawBet, idempotencyKey, clientData } = args;

  // 1. Ensure game definitions exist
  await ensureGameDefinitions();

  // 2. Load game definition
  const game = await getGameByKey(gameKey);
  if (!game) throw ApiError.notFound('Game not found');
  if (!game.isActive) throw ApiError.badRequest('This game is currently unavailable');

  // 3. Validate bet
  const betAmount = validateBet(rawBet, game.minBet, game.maxBet);

  // 4. Ensure wallets exist
  await getOrCreateWallet(userId);

  // 5. Execute atomic game transaction
  return prisma.$transaction(async (tx) => {
    // 5a. Idempotency check
    if (idempotencyKey) {
      const existing = await tx.gameSession.findFirst({
        where: { userId, idempotencyKey },
      });

      if (existing) {
        if (existing.status === 'COMPLETED') {
          return {
            sessionId: existing.id,
            gameKey,
            betAmount: existing.betAmount,
            rewardAmount: existing.rewardAmount,
            isWin: existing.isWin,
            result: existing.result as Record<string, unknown>,
            completedAt: existing.completedAt ?? existing.createdAt,
          };
        }
        throw ApiError.conflict('Game session in progress');
      }
    }

    // 5b. Check wallet balance
    const wallet = await tx.wallet.findUnique({
      where: { userId },
      select: { id: true, gamePointsBalance: true, version: true },
    });
    if (!wallet) throw ApiError.internal('Wallet not found');
    if (wallet.gamePointsBalance < betAmount) {
      throw ApiError.badRequest(
        `Insufficient Game Points: have ${wallet.gamePointsBalance}, need ${betAmount}`
      );
    }

    // 5c. Generate server-side result (NEVER trust client data)
    const config = (game.configuration as Record<string, unknown>) ?? {};
    let resultData: Record<string, unknown>;
    let rewardAmount: number;
    let isWin: boolean;

    switch (game.type) {
      case 'LUCKY_SPIN':
        ({ result: resultData, rewardAmount, isWin } = generateLuckySpinResult(betAmount, config));
        break;
      case 'DICE':
        ({ result: resultData, rewardAmount, isWin } = generateDiceResult(betAmount, config));
        break;
      case 'NUMBER_CHALLENGE':
        ({ result: resultData, rewardAmount, isWin } = generateNumberChallengeResult(
          betAmount, config, clientData?.guess as number | undefined
        ));
        break;
      case 'TRIVIA': {
        const triviaResult = await generateTriviaResult(
          betAmount, config,
          clientData?.questionId as string | undefined,
          clientData?.answerIndex as number | undefined
        );
        resultData = triviaResult.result;
        rewardAmount = triviaResult.rewardAmount;
        isWin = triviaResult.isWin;
        break;
      }
      default:
        throw ApiError.badRequest('Unknown game type');
    }

    // 5d. Build wallet changes
    const changes: BalanceChange[] = [
      {
        currency: 'GAME_POINTS',
        amount: betAmount,
        ledgerType: 'DEBIT',
        transactionType: 'GAME_POINT_DEBIT',
        referenceType: 'GAME',
        description: `Game bet: ${gameKey}`,
      },
    ];

    if (rewardAmount > 0) {
      changes.push({
        currency: 'GAME_POINTS',
        amount: rewardAmount,
        ledgerType: 'CREDIT',
        transactionType: 'GAME_POINT_CREDIT',
        referenceType: 'GAME',
        description: `Game reward: ${gameKey}`,
      });
    }

    // 5e. Apply wallet changes via authoritative path
    await applyBalanceChanges(tx, userId, changes, {
      idempotencyKey,
      operationName: 'game_play',
    });

    // 5f. Create game session
    const session = await tx.gameSession.create({
      data: {
        userId,
        gameId: game.id,
        status: 'COMPLETED',
        betAmount,
        result: resultData,
        rewardAmount,
        isWin,
        idempotencyKey: idempotencyKey ?? null,
        completedAt: new Date(),
      },
    });

    // 5g. Record idempotency for game session
    // (already done via applyBalanceChanges, but also create a separate record
    // for the game session idempotency in case the wallet path doesn't use it)

    return {
      sessionId: session.id,
      gameKey,
      betAmount,
      rewardAmount,
      isWin,
      result: resultData,
      completedAt: session.completedAt ?? session.createdAt,
    };
  });
}

// ─── Game History ──────────────────────────────────────────────

export async function getGameHistory(
  userId: string,
  options: { page?: number; limit?: number; gameKey?: string } = {}
) {
  const { page = 1, limit = 20, gameKey } = options;

  const where: Record<string, unknown> = { userId, status: 'COMPLETED' };
  if (gameKey) {
    const game = await prisma.gameDefinition.findUnique({ where: { key: gameKey } });
    if (game) where.gameId = game.id;
  }

  const [sessions, total] = await Promise.all([
    prisma.gameSession.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
      select: {
        id: true,
        game: { select: { key: true, name: true } },
        betAmount: true,
        rewardAmount: true,
        isWin: true,
        result: true,
        createdAt: true,
        completedAt: true,
      },
    }),
    prisma.gameSession.count({ where }),
  ]);

  return {
    data: sessions,
    total,
    page,
    totalPages: Math.ceil(total / limit),
  };
}
