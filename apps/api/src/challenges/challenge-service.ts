import { prisma } from '@socialplay/database';
import { ApiError } from '../middleware';
import { getOrCreateWallet, applyBalanceChanges } from '../economy/wallet-service';
import { emitToUser } from '../realtime/broadcast';
import { rollDice, generateTarget, evaluateGuess, secureRandomInt } from '../games/game-engine';
import { getGameByKey, ensureGameDefinitions } from '../games/game-catalog';

const CHALLENGE_EXPIRY_HOURS = 48;

export function challengeEvent(challenge: any): any {
  return {
    id: challenge.id,
    challenger: {
      id: challenge.challengerId,
      username: challenge.challenger?.username,
      displayName: challenge.challenger?.displayName,
    },
    challenged: {
      id: challenge.challengedId,
      username: challenge.challenged?.username,
      displayName: challenge.challenged?.displayName,
    },
    gameKey: challenge.game?.key,
    gameName: challenge.game?.name,
    entryAmount: challenge.entryAmount,
    status: challenge.status,
    winnerId: challenge.winnerId,
    createdAt: challenge.createdAt,
    expiresAt: challenge.expiresAt,
    acceptedAt: challenge.acceptedAt,
    completedAt: challenge.completedAt,
  };
}

export async function createChallenge(
  challengerId: string,
  challengedId: string,
  gameKey: string,
  entryAmount: number
) {
  await ensureGameDefinitions();

  const game = await getGameByKey(gameKey);
  if (!game) throw ApiError.notFound('Game not found');
  if (!game.isActive) throw ApiError.badRequest('This game is currently unavailable');
  if (challengerId === challengedId) throw ApiError.badRequest('Cannot challenge yourself');

  if (!Number.isInteger(entryAmount) || entryAmount < 0) {
    throw ApiError.badRequest('Entry amount must be a non-negative integer');
  }

  const challengedUser = await prisma.user.findUnique({ where: { id: challengedId } });
  if (!challengedUser) throw ApiError.notFound('Challenged user not found');

  await getOrCreateWallet(challengerId);
  await getOrCreateWallet(challengedId);

  const expiresAt = new Date(Date.now() + CHALLENGE_EXPIRY_HOURS * 60 * 60 * 1000);

  // Atomically debit challenger entry + create challenge + notify.
  const challenge = await prisma.$transaction(async (tx) => {
    if (entryAmount > 0) {
      const wallet = await tx.wallet.findUnique({
        where: { userId: challengerId },
        select: { gamePointsBalance: true },
      });
      if (!wallet || wallet.gamePointsBalance < entryAmount) {
        throw ApiError.badRequest('Insufficient Game Points for entry');
      }
      await applyBalanceChanges(tx, challengerId, [
        {
          currency: 'GAME_POINTS',
          amount: entryAmount,
          ledgerType: 'DEBIT',
          transactionType: 'GAME_POINT_DEBIT',
          referenceType: 'GAME',
          description: `Challenge entry: ${gameKey}`,
        },
      ]);
    }

    const created = await tx.gameChallenge.create({
      data: {
        challengerId,
        challengedId,
        gameId: game.id,
        entryAmount,
        status: 'PENDING',
        expiresAt,
      },
      include: {
        challenger: { select: { id: true, username: true, displayName: true } },
        challenged: { select: { id: true, username: true, displayName: true } },
        game: { select: { key: true, name: true } },
      },
    });

    await tx.notification.create({
      data: {
        userId: challengedId,
        type: 'CHALLENGE_RECEIVED',
        title: 'New Challenge',
        body: `${created.challenger.displayName || created.challenger.username} challenged you to ${created.game.name}`,
        data: { challengeId: created.id, challengerId, gameKey, entryAmount },
      },
    });

    return created;
  });

  emitToUser(challengedId, 'challenge:created', challengeEvent(challenge));

  return {
    id: challenge.id,
    gameKey: challenge.game.key,
    gameName: challenge.game.name,
    entryAmount,
    status: challenge.status,
    expiresAt,
    createdAt: challenge.createdAt,
  };
}

export async function acceptChallenge(userId: string, challengeId: string) {
  const existing = await prisma.gameChallenge.findUnique({
    where: { id: challengeId },
    include: { game: true },
  });

  if (!existing) throw ApiError.notFound('Challenge not found');
  if (existing.challengedId !== userId) throw ApiError.forbidden('Not your challenge');
  if (existing.status !== 'PENDING') throw ApiError.badRequest('Challenge is not pending');
  if (existing.expiresAt < new Date()) throw ApiError.badRequest('Challenge has expired');

  await getOrCreateWallet(userId);

  const updated = await prisma.$transaction(async (tx) => {
    // Re-verify status within the transaction to prevent double-accept races.
    const fresh = await tx.gameChallenge.findUnique({ where: { id: challengeId } });
    if (!fresh) throw ApiError.notFound('Challenge not found');
    if (fresh.status !== 'PENDING') throw ApiError.badRequest('Challenge is not pending');
    if (fresh.expiresAt < new Date()) throw ApiError.badRequest('Challenge has expired');

    if (fresh.entryAmount > 0) {
      const wallet = await tx.wallet.findUnique({
        where: { userId },
        select: { gamePointsBalance: true },
      });
      if (!wallet || wallet.gamePointsBalance < fresh.entryAmount) {
        throw ApiError.badRequest('Insufficient Game Points for entry');
      }
      await applyBalanceChanges(tx, userId, [
        {
          currency: 'GAME_POINTS',
          amount: fresh.entryAmount,
          ledgerType: 'DEBIT',
          transactionType: 'GAME_POINT_DEBIT',
          referenceType: 'GAME',
          description: `Challenge entry: ${existing.game.key}`,
        },
      ]);
    }

    const accepted = await tx.gameChallenge.update({
      where: { id: challengeId },
      data: { status: 'ACTIVE', acceptedAt: new Date() },
      include: {
        challenger: { select: { id: true, username: true, displayName: true } },
        challenged: { select: { id: true, username: true, displayName: true } },
      },
    });

    await tx.notification.create({
      data: {
        userId: accepted.challengerId,
        type: 'CHALLENGE_ACCEPTED',
        title: 'Challenge Accepted',
        body: `${accepted.challenged.displayName || accepted.challenged.username} accepted your challenge`,
        data: { challengeId, gameKey: existing.game.key },
      },
    });

    return accepted;
  });

  emitToUser(updated.challengerId, 'challenge:accepted', challengeEvent(updated));

  return { id: updated.id, status: updated.status, acceptedAt: updated.acceptedAt };
}

export async function declineChallenge(userId: string, challengeId: string) {
  const existing = await prisma.gameChallenge.findUnique({ where: { id: challengeId } });
  if (!existing) throw ApiError.notFound('Challenge not found');
  if (existing.challengedId !== userId) throw ApiError.forbidden('Not your challenge');
  if (existing.status !== 'PENDING') throw ApiError.badRequest('Challenge is not pending');

  const updated = await prisma.$transaction(async (tx) => {
    if (existing.entryAmount > 0) {
      await applyBalanceChanges(tx, existing.challengerId, [
        {
          currency: 'GAME_POINTS',
          amount: existing.entryAmount,
          ledgerType: 'CREDIT',
          transactionType: 'GAME_POINT_CREDIT',
          referenceType: 'GAME',
          description: 'Challenge declined — entry refund',
        },
      ]);
    }
    const d = await tx.gameChallenge.update({
      where: { id: challengeId },
      data: { status: 'DECLINED' },
      include: { challenger: true, challenged: true },
    });
    return d;
  });

  emitToUser(updated.challengerId, 'challenge:declined', challengeEvent(updated));
  return { id: updated.id, status: updated.status };
}

export async function cancelChallenge(userId: string, challengeId: string) {
  const existing = await prisma.gameChallenge.findUnique({ where: { id: challengeId } });
  if (!existing) throw ApiError.notFound('Challenge not found');
  if (existing.challengerId !== userId) throw ApiError.forbidden('Not your challenge');
  if (!['PENDING', 'ACTIVE'].includes(existing.status)) {
    throw ApiError.badRequest('Challenge cannot be cancelled');
  }

  await prisma.$transaction(async (tx) => {
    if (existing.entryAmount > 0) {
      await applyBalanceChanges(tx, existing.challengerId, [
        {
          currency: 'GAME_POINTS',
          amount: existing.entryAmount,
          ledgerType: 'CREDIT',
          transactionType: 'GAME_POINT_CREDIT',
          referenceType: 'GAME',
          description: 'Challenge cancelled — entry refund',
        },
      ]);
      if (existing.status === 'ACTIVE') {
        await applyBalanceChanges(tx, existing.challengedId, [
          {
            currency: 'GAME_POINTS',
            amount: existing.entryAmount,
            ledgerType: 'CREDIT',
            transactionType: 'GAME_POINT_CREDIT',
            referenceType: 'GAME',
            description: 'Challenge cancelled — entry refund',
          },
        ]);
      }
    }
    await tx.gameChallenge.update({
      where: { id: challengeId },
      data: { status: 'CANCELLED' },
    });
  });

  emitToUser(existing.challengedId, 'challenge:cancelled', { challengeId });
  return { id: challengeId, status: 'CANCELLED' };
}

function resolveChallengeOutcome(
  gameType: string,
  config: Record<string, unknown>,
  clientData?: Record<string, unknown>
): Promise<{ result: Record<string, unknown>; score: number }> {
  const range = (config.range as { min: number; max: number }) ?? { min: 1, max: 100 };

  switch (gameType) {
    case 'DICE': {
      const { die1, die2, sum } = rollDice();
      return Promise.resolve({ result: { die1, die2, sum }, score: sum });
    }
    case 'LUCKY_SPIN': {
      const outcomes = (config.outcomes as Array<{ name: string; multiplier: number }>) ?? [
        { name: 'LOSE', multiplier: 0 },
      ];
      const idx = secureRandomInt(0, outcomes.length - 1);
      const outcome = outcomes[idx];
      return Promise.resolve({
        result: { name: outcome.name, multiplier: outcome.multiplier },
        score: outcome.multiplier,
      });
    }
    case 'NUMBER_CHALLENGE': {
      const target = generateTarget(range.min, range.max);
      const guess = typeof clientData?.guess === 'number' ? clientData.guess : 50;
      const { correct, away } = evaluateGuess(guess, target);
      const score = correct ? 1000 : Math.max(0, 100 - away);
      return Promise.resolve({ result: { guess, target, away, correct }, score });
    }
    default:
      return Promise.reject(ApiError.badRequest('Unsupported challenge game'));
  }
}

export async function playChallengeTurn(
  userId: string,
  challengeId: string,
  clientData?: Record<string, unknown>
) {
  const challenge = await prisma.gameChallenge.findUnique({
    where: { id: challengeId },
    include: { game: true },
  });

  if (!challenge) throw ApiError.notFound('Challenge not found');
  if (challenge.challengerId !== userId && challenge.challengedId !== userId) {
    throw ApiError.forbidden('Not your challenge');
  }
  if (challenge.status !== 'ACTIVE') throw ApiError.badRequest('Challenge is not active');

  const config = (challenge.game.configuration as Record<string, unknown>) ?? {};
  const { result, score } = await resolveChallengeOutcome(challenge.game.type, config, clientData);

  const output = await prisma.$transaction(async (tx) => {
    // Re-verify status inside the transaction to prevent TOCTOU race.
    const fresh = await tx.gameChallenge.findUnique({ where: { id: challengeId } });
    if (!fresh) throw ApiError.notFound('Challenge not found');
    if (fresh.status !== 'ACTIVE') throw ApiError.badRequest('Challenge is not active');
    if (fresh.challengerId !== userId && fresh.challengedId !== userId) {
      throw ApiError.forbidden('Not your challenge');
    }
    const session = await tx.gameSession.create({
      data: {
        userId,
        gameId: challenge.gameId,
        betAmount: challenge.entryAmount,
        result: result as any,
        rewardAmount: 0,
        isWin: false,
        status: 'COMPLETED',
        completedAt: new Date(),
      },
    });

    const opponentId =
      challenge.challengerId === userId ? challenge.challengedId : challenge.challengerId;

    const opponentSession = await tx.gameSession.findFirst({
      where: {
        userId: opponentId,
        gameId: challenge.gameId,
        betAmount: challenge.entryAmount,
        status: 'COMPLETED',
        createdAt: { gte: challenge.createdAt },
      },
      select: { id: true, result: true },
    });

    if (!opponentSession) {
      return { sessionId: session.id, result, score, challengeComplete: false, message: 'Waiting for opponent' };
    }

    const opponentScore = (opponentSession.result as any)?.score ?? 0;
    const challengerScore =
      challenge.challengerId === userId ? score : opponentScore;
    const challengedScore =
      challenge.challengerId === userId ? opponentScore : score;

    const winnerId =
      challengerScore > challengedScore
        ? challenge.challengerId
        : challengedScore > challengerScore
          ? challenge.challengedId
          : null;

    // Resolve pot. Both entries were already debited at create/accept.
    if (challenge.entryAmount > 0) {
      if (winnerId) {
        await applyBalanceChanges(tx, winnerId, [
          {
            currency: 'GAME_POINTS',
            amount: challenge.entryAmount * 2,
            ledgerType: 'CREDIT',
            transactionType: 'GAME_POINT_CREDIT',
            referenceType: 'GAME',
            description: `Challenge win (${challenge.game.key})`,
          },
        ]);
      } else {
        await applyBalanceChanges(tx, challenge.challengerId, [
          {
            currency: 'GAME_POINTS',
            amount: challenge.entryAmount,
            ledgerType: 'CREDIT',
            transactionType: 'GAME_POINT_CREDIT',
            referenceType: 'GAME',
            description: 'Challenge tie — entry refund',
          },
        ]);
        await applyBalanceChanges(tx, challenge.challengedId, [
          {
            currency: 'GAME_POINTS',
            amount: challenge.entryAmount,
            ledgerType: 'CREDIT',
            transactionType: 'GAME_POINT_CREDIT',
            referenceType: 'GAME',
            description: 'Challenge tie — entry refund',
          },
        ]);
      }
    }

    await tx.gameChallenge.update({
      where: { id: challengeId },
      data: {
        status: 'COMPLETED',
        winnerId,
        completedAt: new Date(),
        resultMeta: { challengerScore, challengedScore, winnerId, mySessionId: session.id },
      },
    });

    const message =
      winnerId === userId
        ? 'You won the challenge!'
        : winnerId === null
          ? 'The challenge was a tie!'
          : 'You lost the challenge';

    return {
      sessionId: session.id,
      result,
      score,
      challengeComplete: true,
      winnerId,
      message,
      opponentScore,
      challengerScore,
      challengedScore,
    };
  });

  // Emit realtime events after commit.
  if (output.challengeComplete) {
    const payload = {
      challengeId,
      winnerId: output.winnerId,
      message: output.message,
      scores: {
        challenger: output.challengerScore,
        challenged: output.challengedScore,
      },
    };
    emitToUser(challenge.challengerId, 'challenge:completed', payload);
    emitToUser(challenge.challengedId, 'challenge:completed', payload);
  } else {
    emitToUser(
      challenge.challengerId === userId ? challenge.challengedId : challenge.challengerId,
      'challenge:started',
      { challengeId }
    );
  }

  return {
    sessionId: output.sessionId,
    result: output.result,
    score: output.score,
    challengeComplete: output.challengeComplete,
    winnerId: output.winnerId,
    message: output.message,
  };
}

export async function getUserChallenges(userId: string) {
  const challenges = await prisma.gameChallenge.findMany({
    where: { OR: [{ challengerId: userId }, { challengedId: userId }] },
    include: {
      challenger: { select: { id: true, username: true, displayName: true } },
      challenged: { select: { id: true, username: true, displayName: true } },
      game: { select: { key: true, name: true } },
    },
    orderBy: { createdAt: 'desc' },
  });

  return challenges.map((c) => ({
    id: c.id,
    challenger: c.challenger,
    challenged: c.challenged,
    gameKey: c.game.key,
    gameName: c.game.name,
    entryAmount: c.entryAmount,
    status: c.status,
    winnerId: c.winnerId,
    resultMeta: c.resultMeta,
    createdAt: c.createdAt,
    expiresAt: c.expiresAt,
    acceptedAt: c.acceptedAt,
    completedAt: c.completedAt,
  }));
}

export async function getChallengeById(challengeId: string, userId: string) {
  const challenge = await prisma.gameChallenge.findUnique({
    where: { id: challengeId },
    include: {
      challenger: { select: { id: true, username: true, displayName: true } },
      challenged: { select: { id: true, username: true, displayName: true } },
      game: { select: { key: true, name: true } },
    },
  });

  if (!challenge) throw ApiError.notFound('Challenge not found');
  if (challenge.challengerId !== userId && challenge.challengedId !== userId) {
    throw ApiError.forbidden('Not your challenge');
  }

  return challenge;
}
