import { prisma, Prisma } from '@socialplay/database';
import { ApiError } from '../middleware';
import { getOrCreateWallet, applyBalanceChanges } from '../economy/wallet-service';
import { assertGroupRole, assertActiveMember, getGroupMembership } from '../realtime/chat-service';
import { emitToGroup } from '../realtime/broadcast';
import { rollDice, generateTarget, evaluateGuess, secureRandomInt } from '../games/game-engine';
import { getGameByKey, ensureGameDefinitions } from '../games/game-catalog';

const MANAGER_ROLES = ['OWNER', 'ADMIN'];

export interface CreateCompetitionArgs {
  groupId: string;
  gameKey: string;
  title: string;
  description?: string;
  startsAt: string;
  endsAt: string;
  entryAmount?: number;
  maxParticipants?: number;
  rewardGamePoints?: number;
  rewardCoins?: number;
}

function validateCompetitionInput(args: CreateCompetitionArgs) {
  if (!args.title || typeof args.title !== 'string' || args.title.trim().length === 0) {
    throw ApiError.badRequest('Title is required');
  }
  const startsAt = new Date(args.startsAt);
  const endsAt = new Date(args.endsAt);
  if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime())) {
    throw ApiError.badRequest('Invalid start/end time');
  }
  if (endsAt <= startsAt) {
    throw ApiError.badRequest('End time must be after start time');
  }
  const entry = args.entryAmount ?? 0;
  if (!Number.isInteger(entry) || entry < 0) {
    throw ApiError.badRequest('Entry amount must be a non-negative integer');
  }
  if (args.maxParticipants !== undefined && (!Number.isInteger(args.maxParticipants) || args.maxParticipants < 2)) {
    throw ApiError.badRequest('Max participants must be an integer >= 2');
  }
  const rGP = args.rewardGamePoints ?? 0;
  const rCoins = args.rewardCoins ?? 0;
  if (!Number.isInteger(rGP) || rGP < 0 || !Number.isInteger(rCoins) || rCoins < 0) {
    throw ApiError.badRequest('Rewards must be non-negative integers');
  }
  return { startsAt, endsAt, entry, maxParticipants: args.maxParticipants, rGP, rCoins };
}

function scoringForGame(gameType: string): any {
  switch (gameType) {
    case 'DICE':
      return 'DICE_SUM' as const;
    case 'NUMBER_CHALLENGE':
      return 'NUMBER_DISTANCE' as const;
    case 'TRIVIA':
      return 'TRIVIA_CORRECT' as const;
    case 'LUCKY_SPIN':
      return 'SPIN_MULTIPLIER' as const;
    default:
      throw ApiError.badRequest('Unsupported competition game');
  }
}

export async function createCompetition(creatorId: string, args: CreateCompetitionArgs) {
  await assertGroupRole(args.groupId, creatorId, MANAGER_ROLES);
  await ensureGameDefinitions();

  const game = await getGameByKey(args.gameKey);
  if (!game) throw ApiError.notFound('Game not found');
  if (!game.isActive) throw ApiError.badRequest('This game is currently unavailable');

  const { startsAt, endsAt, entry, maxParticipants, rGP, rCoins } = validateCompetitionInput(args);
  const scoring = scoringForGame(game.type);

  await getOrCreateWallet(creatorId);

  const competition = await prisma.groupCompetition.create({
    data: {
      groupId: args.groupId,
      gameId: game.id,
      title: args.title.trim(),
      description: args.description?.trim() ?? null,
      status: 'SCHEDULED',
      scoring,
      entryAmount: entry,
      maxParticipants,
      rewardGamePoints: rGP,
      rewardCoins: rCoins,
      startsAt,
      endsAt,
      createdBy: creatorId,
    },
    include: { group: { select: { id: true, name: true } }, game: { select: { key: true, name: true } } },
  });

  emitToGroup(args.groupId, 'competition:created', {
    id: competition.id,
    title: competition.title,
    gameKey: game.key,
    gameName: game.name,
    status: competition.status,
    startsAt: competition.startsAt,
    endsAt: competition.endsAt,
  });

  return competition;
}

export async function updateCompetition(
  actorId: string,
  competitionId: string,
  args: Partial<CreateCompetitionArgs>
) {
  const comp = await prisma.groupCompetition.findUnique({ where: { id: competitionId } });
  if (!comp) throw ApiError.notFound('Competition not found');
  await assertGroupRole(comp.groupId, actorId, MANAGER_ROLES);
  if (comp.status !== 'SCHEDULED') throw ApiError.badRequest('Only scheduled competitions can be edited');

  const data: any = {};
  if (args.title !== undefined) data.title = args.title.trim();
  if (args.description !== undefined) data.description = args.description?.trim() ?? null;
  if (args.entryAmount !== undefined) {
    if (!Number.isInteger(args.entryAmount) || args.entryAmount < 0) throw ApiError.badRequest('Invalid entry');
    data.entryAmount = args.entryAmount;
  }
  if (args.rewardGamePoints !== undefined) data.rewardGamePoints = args.rewardGamePoints;
  if (args.rewardCoins !== undefined) data.rewardCoins = args.rewardCoins;
  if (args.startsAt && args.endsAt) {
    const s = new Date(args.startsAt);
    const e = new Date(args.endsAt);
    if (e <= s) throw ApiError.badRequest('End time must be after start time');
    data.startsAt = s;
    data.endsAt = e;
  }

  return prisma.groupCompetition.update({ where: { id: competitionId }, data });
}

export async function cancelCompetition(actorId: string, competitionId: string) {
  const comp = await prisma.groupCompetition.findUnique({ where: { id: competitionId } });
  if (!comp) throw ApiError.notFound('Competition not found');
  await assertGroupRole(comp.groupId, actorId, MANAGER_ROLES);
  if (!['SCHEDULED', 'ACTIVE'].includes(comp.status)) {
    throw ApiError.badRequest('Competition cannot be cancelled');
  }

  await prisma.$transaction(async (tx) => {
    // Refund all entrants' entries.
    if (comp.entryAmount > 0) {
      const participants = await tx.competitionParticipant.findMany({
        where: { competitionId },
        select: { userId: true },
      });
      for (const p of participants) {
        await applyBalanceChanges(tx, p.userId, [
          {
            currency: 'GAME_POINTS',
            amount: comp.entryAmount,
            ledgerType: 'CREDIT',
            transactionType: 'GAME_POINT_CREDIT',
            referenceType: 'GAME',
            description: 'Competition cancelled — entry refund',
          },
        ]);
      }
    }
    await tx.groupCompetition.update({
      where: { id: competitionId },
      data: { status: 'CANCELLED' },
    });
  });

  return { id: competitionId, status: 'CANCELLED' };
}

export async function joinCompetition(userId: string, competitionId: string) {
  const comp = await prisma.groupCompetition.findUnique({ where: { id: competitionId } });
  if (!comp) throw ApiError.notFound('Competition not found');
  await assertActiveMember(comp.groupId, userId);

  if (!['SCHEDULED', 'ACTIVE'].includes(comp.status)) {
    throw ApiError.badRequest('Competition is not open for participation');
  }
  const now = new Date();
  if (now < comp.startsAt) throw ApiError.badRequest('Competition has not started yet');
  if (now > comp.endsAt) throw ApiError.badRequest('Competition has ended');

  await getOrCreateWallet(userId);

  return prisma.$transaction(async (tx) => {
    const existing = await tx.competitionParticipant.findUnique({
      where: { competitionId_userId: { competitionId, userId } },
    });
    if (existing) throw ApiError.badRequest('Already joined this competition');

    if (comp.maxParticipants !== null && comp.maxParticipants !== undefined) {
      const count = await tx.competitionParticipant.count({ where: { competitionId } });
      if (count >= comp.maxParticipants) {
        throw ApiError.badRequest('Competition is full');
      }
    }

    if (comp.entryAmount > 0) {
      await applyBalanceChanges(tx, userId, [
        {
          currency: 'GAME_POINTS',
          amount: comp.entryAmount,
          ledgerType: 'DEBIT',
          transactionType: 'GAME_POINT_DEBIT',
          referenceType: 'GAME',
          description: `Competition entry: ${comp.title}`,
        },
      ]);
    }

    return tx.competitionParticipant.create({
      data: { competitionId, userId },
    });
  });
}

function computeScore(
  scoring: string,
  gameType: string,
  config: Record<string, unknown>,
  clientData?: Record<string, unknown>
): { score: number; result: Record<string, unknown> } {
  const range = (config.range as { min: number; max: number }) ?? { min: 1, max: 100 };

  switch (gameType) {
    case 'DICE': {
      const { die1, die2, sum } = rollDice();
      return { score: sum, result: { die1, die2, sum } };
    }
    case 'NUMBER_CHALLENGE': {
      const target = generateTarget(range.min, range.max);
      const guess = typeof clientData?.guess === 'number' ? clientData.guess : 50;
      const { correct, away } = evaluateGuess(guess, target);
      return {
        score: correct ? 1000 : Math.max(0, 100 - away),
        result: { guess, target, away, correct },
      };
    }
    case 'TRIVIA': {
      // Score determined externally by trivia; fallback here is a caution.
      throw ApiError.badRequest('Trivia competition scoring is managed by play route');
    }
    case 'LUCKY_SPIN': {
      const outcomes = (config.outcomes as Array<{ name: string; multiplier: number }>) ?? [];
      if (outcomes.length === 0) throw ApiError.badRequest('Invalid spin config');
      const idx = secureRandomInt(0, outcomes.length - 1);
      const outcome = outcomes[idx];
      return {
        score: outcome.multiplier,
        result: { name: outcome.name, multiplier: outcome.multiplier },
      };
    }
    default:
      throw ApiError.badRequest('Unsupported competition game');
  }
}

export async function playCompetition(
  userId: string,
  competitionId: string,
  clientData?: Record<string, unknown>
) {
  const comp = await prisma.groupCompetition.findUnique({
    where: { id: competitionId },
    include: { game: true },
  });
  if (!comp) throw ApiError.notFound('Competition not found');
  await assertActiveMember(comp.groupId, userId);

  const now = new Date();
  if (now < comp.startsAt) throw ApiError.badRequest('Competition has not started yet');
  if (now > comp.endsAt) throw ApiError.badRequest('Competition has ended');
  if (comp.status !== 'ACTIVE' && comp.status !== 'SCHEDULED') {
    throw ApiError.badRequest('Competition is not playable');
  }

  const participant = await prisma.competitionParticipant.findUnique({
    where: { competitionId_userId: { competitionId, userId } },
  });
  if (!participant) throw ApiError.forbidden('Join the competition before playing');

  const config = (comp.game.configuration as Record<string, unknown>) ?? {};

  if (comp.game.type === 'TRIVIA') {
    // For trivia competitions, the client answers a server-provided question
    // and the score is computed from correctness.
    if (comp.scoring !== 'TRIVIA_CORRECT') throw ApiError.badRequest('Invalid scoring');
    const questions = await prisma.triviaQuestion.findMany({
      where: { isActive: true },
      take: 1,
      orderBy: { id: 'asc' },
    });
    if (questions.length === 0) throw ApiError.badRequest('No trivia questions available');
    const q = questions[0];
    const answerIndex = clientData?.answerIndex as number | undefined;
    if (answerIndex === undefined || !Number.isInteger(answerIndex)) {
      throw ApiError.badRequest('Answer required');
    }
    const correct = answerIndex === q.correctIndex;
    const score = correct ? 1000 : 0;
    const result = { questionId: q.id, answerIndex, correct };

    await prisma.$transaction(async (tx) => {
      await tx.competitionParticipant.update({
        where: { competitionId_userId: { competitionId, userId } },
        data: {
          score: { increment: score },
          gamesPlayed: { increment: 1 },
        },
      });
      await tx.gameSession.create({
        data: {
          userId,
          gameId: comp.gameId,
          betAmount: comp.entryAmount,
          result,
          rewardAmount: 0,
          isWin: correct,
          status: 'COMPLETED',
          completedAt: new Date(),
        },
      });
    });

    return { score, result, accumulatedScore: participant.score + score, gamesPlayed: participant.gamesPlayed + 1 };
  }

  const { score, result } = computeScore(comp.scoring as string, comp.game.type, config, clientData);

  await prisma.$transaction(async (tx) => {
    await tx.competitionParticipant.update({
      where: { competitionId_userId: { competitionId, userId } },
      data: { score: { increment: score }, gamesPlayed: { increment: 1 } },
    });
    await tx.gameSession.create({
      data: {
        userId,
        gameId: comp.gameId,
        betAmount: comp.entryAmount,
        result: result as any,
        rewardAmount: 0,
        isWin: score > 0,
        status: 'COMPLETED',
        completedAt: new Date(),
      },
    });
  });

  return {
    score,
    result,
    accumulatedScore: participant.score + score,
    gamesPlayed: participant.gamesPlayed + 1,
  };
}

export async function finalizeCompetition(actorId: string, competitionId: string) {
  const comp = await prisma.groupCompetition.findUnique({
    where: { id: competitionId },
    include: { game: true },
  });
  if (!comp) throw ApiError.notFound('Competition not found');
  await assertGroupRole(comp.groupId, actorId, MANAGER_ROLES);

  if (comp.status === 'CANCELLED') throw ApiError.badRequest('Competition is cancelled');
  if (comp.status === 'COMPLETED' && comp.finalizedAt) {
    return { id: comp.id, status: comp.status, result: comp.result, alreadyFinalized: true };
  }
  const now = new Date();
  if (now < comp.endsAt && comp.status !== 'ACTIVE') {
    throw ApiError.badRequest('Competition has not ended');
  }

  // Compute leaderboard, distribute rewards, and mark final inside a single
  // transaction. The idempotency guarantee works on two levels:
  //   1. The outer status check + unique RewardClaim prevents double-reward.
  //   2. The P2002 catch ensures a concurrent finalizer that slips past the
  //      read-committed window still does not double-award.
  // Realtime events are emitted ONLY after this transaction commits successfully.
  let finalizedResult: {
    id: string;
    status: string;
    result: unknown;
    alreadyFinalized: boolean;
    winnerIds: string[];
  };

  try {
    finalizedResult = await prisma.$transaction(async (tx) => {
      const fresh = await tx.groupCompetition.findUnique({ where: { id: competitionId } });
      if (!fresh) throw ApiError.notFound('Competition not found');
      if (fresh.status === 'COMPLETED' && fresh.finalizedAt) {
        return { id: fresh.id, status: fresh.status, result: fresh.result, alreadyFinalized: true, winnerIds: [] };
      }
      if (fresh.status !== 'ACTIVE' && fresh.status !== 'SCHEDULED') {
        throw ApiError.badRequest('Competition cannot be finalized');
      }

      const participants = await tx.competitionParticipant.findMany({
        where: { competitionId },
        orderBy: [{ score: 'desc' }, { gamesPlayed: 'desc' }],
      });

      const result = {
        scoredAt: new Date().toISOString(),
        participants: participants.map((p, i) => ({
          rank: i + 1,
          userId: p.userId,
          score: p.score,
          gamesPlayed: p.gamesPlayed,
        })),
      };

      const topScore = participants[0]?.score;
      const winners = participants.filter((p) => p.score === topScore && topScore !== undefined);
      const winnerIds = winners.map((w) => w.userId);

      if (winners.length > 0 && (fresh.rewardGamePoints > 0 || fresh.rewardCoins > 0)) {
        const perGP = Math.floor(fresh.rewardGamePoints / winners.length);
        const perCoins = Math.floor(fresh.rewardCoins / winners.length);

        for (const w of winners) {
          const alreadyClaimed = await tx.rewardClaim.findUnique({
            where: {
              userId_sourceType_sourceId: {
                userId: w.userId,
                sourceType: 'COMPETITION',
                sourceId: competitionId,
              },
            },
          });
          if (alreadyClaimed) continue;

          if (perGP > 0) {
            await applyBalanceChanges(tx, w.userId, [
              {
                currency: 'GAME_POINTS',
                amount: perGP,
                ledgerType: 'CREDIT',
                transactionType: 'GAME_POINT_CREDIT',
                referenceType: 'REWARD',
                description: `Competition reward: ${fresh.title}`,
              },
            ]);
          }
          if (perCoins > 0) {
            await applyBalanceChanges(tx, w.userId, [
              {
                currency: 'COINS',
                amount: perCoins,
                ledgerType: 'CREDIT',
                transactionType: 'COIN_CREDIT',
                referenceType: 'REWARD',
                description: `Competition reward: ${fresh.title}`,
              },
            ]);
          }

          await tx.rewardClaim.create({
            data: {
              userId: w.userId,
              sourceType: 'COMPETITION',
              sourceId: competitionId,
              xpReward: 0,
              coinReward: perCoins,
              gamePointReward: perGP,
            },
          });
        }
      }

      const finalized = await tx.groupCompetition.update({
        where: { id: competitionId },
        data: {
          status: 'COMPLETED',
          finalizedAt: new Date(),
          finalizerId: actorId,
          result,
        },
      });

      for (const wId of winnerIds) {
        await tx.notification.create({
          data: {
            userId: wId,
            type: 'COMPETITION_RESULT',
            title: 'Competition Result',
            body: `You won "${fresh.title}"!`,
            data: {
              competitionId,
              rank: 1,
              rewardGamePoints: fresh.rewardGamePoints,
              rewardCoins: fresh.rewardCoins,
            },
          },
        });
      }

      return { id: finalized.id, status: finalized.status, result, alreadyFinalized: false, winnerIds };
    });
  } catch (err) {
    if ((err as Prisma.PrismaClientKnownRequestError).code === 'P2002') {
      const existing = await prisma.groupCompetition.findUnique({
        where: { id: competitionId },
        select: { id: true, status: true, result: true, finalizedAt: true },
      });
      if (existing?.status === 'COMPLETED' && existing?.finalizedAt) {
        return { id: existing.id, status: existing.status, result: existing.result, alreadyFinalized: true, winnerIds: [] };
      }
      throw ApiError.conflict('Competition is being finalized concurrently');
    }
    throw err;
  }

  // Emit realtime events ONLY after the transaction has successfully committed.
  // Never emit on rollback/failure — the catch block above handles errors.
  if (!finalizedResult.alreadyFinalized) {
    emitToGroup(comp.groupId, 'competition:ended', {
      competitionId,
      groupId: comp.groupId,
      title: comp.title,
      status: 'COMPLETED',
      result: finalizedResult.result,
      winnerIds: finalizedResult.winnerIds,
    });
  }

  return finalizedResult;
}

export async function getCompetitionForGroup(groupId: string, competitionId: string, userId: string) {
  const membership = await getGroupMembership(groupId, userId);
  if (!membership || membership.status !== 'ACTIVE') {
    throw ApiError.forbidden('You are not a member of this group');
  }
  const comp = await prisma.groupCompetition.findUnique({
    where: { id: competitionId },
    include: {
      game: { select: { key: true, name: true } },
      participants: {
        orderBy: [{ score: 'desc' }],
        select: { userId: true, score: true, gamesPlayed: true },
      },
    },
  });
  if (!comp || comp.groupId !== groupId) throw ApiError.notFound('Competition not found');
  return comp;
}

export async function listCompetitionsForGroup(groupId: string, userId: string) {
  const membership = await getGroupMembership(groupId, userId);
  if (!membership || membership.status !== 'ACTIVE') {
    throw ApiError.forbidden('You are not a member of this group');
  }
  const comps = await prisma.groupCompetition.findMany({
    where: { groupId },
    include: { game: { select: { key: true, name: true } } },
    orderBy: { createdAt: 'desc' },
  });
  return comps;
}
