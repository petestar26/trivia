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
    // ── LOCK the challenge row FIRST, before any wallet mutation ──
    // Two reasons, both required:
    //   1. LOCK ORDERING. playChallengeTurn now takes this same row lock
    //      before it touches wallets. If cancel kept locking wallets first
    //      and this row last, the two could deadlock (cancel holding a
    //      wallet lock while waiting for the challenge row; play holding the
    //      challenge row while waiting for that same wallet). Using the
    //      identical challenge-then-wallet order everywhere removes the cycle.
    //   2. CORRECTNESS. The status check before this transaction is a plain,
    //      unlocked read. `existing.status` can already be stale by the time
    //      the refunds run — most importantly, the opponent may have ACCEPTED
    //      (PENDING -> ACTIVE, debiting their own entry) in between, in which
    //      case refunding only the challenger would strand the opponent's
    //      entry fee. Re-reading the status under the lock and branching on
    //      THAT value refunds exactly the parties who actually paid.
    const lockedRows = await tx.$queryRaw<{ status: string }[]>`
      SELECT "status" FROM "game_challenges" WHERE "id" = ${challengeId} FOR UPDATE
    `;
    const locked = lockedRows[0];
    if (!locked) throw ApiError.notFound('Challenge not found');
    if (!['PENDING', 'ACTIVE'].includes(locked.status)) {
      throw ApiError.badRequest('Challenge cannot be cancelled');
    }

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
      if (locked.status === 'ACTIVE') {
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

  // Idempotent fast path: if this user already submitted their turn for this
  // challenge, return the recorded result instead of erroring. This makes the
  // endpoint safe for double-clicks, network retries, and client re-sends.
  // The unique constraint on GameSession (challengeId, userId) is the
  // authoritative guarantee — see the P2002 handling below for the
  // concurrent-race case this pre-check cannot see.
  const alreadyPlayed = await prisma.gameSession.findUnique({
    where: { challengeId_userId: { challengeId, userId } },
  });
  if (alreadyPlayed) {
    return buildChallengeTurnResponse(alreadyPlayed, challenge, userId);
  }

  const config = (challenge.game.configuration as Record<string, unknown>) ?? {};
  const { result, score } = await resolveChallengeOutcome(challenge.game.type, config, clientData);

  let output;

  try {
    output = await prisma.$transaction(async (tx) => {
      // ── LOCK the challenge row FIRST ──────────────────────────────
      // A plain findUnique here was NOT sufficient. Under READ COMMITTED it
      // takes no row lock, so two players submitting their FINAL turns
      // concurrently could both:
      //   1. read the challenge as ACTIVE,
      //   2. insert their own GameSession (different userId, so the
      //      (challengeId, userId) unique constraint creates no contention
      //      between them, and the FK's FOR KEY SHARE locks are mutually
      //      compatible), and
      //   3. fail to see the opponent's still-uncommitted session in the
      //      lookup below,
      // each returning "waiting for opponent" and committing. The challenge
      // would then stay ACTIVE forever with BOTH entry fees already debited
      // and no winner, payout, or refund — permanently stranded funds.
      //
      // SELECT ... FOR UPDATE serializes the two turns: the second player
      // blocks until the first commits, then reads the first player's
      // COMMITTED session and completes the challenge normally. This is the
      // same discipline the group-competition play path already uses.
      //
      // Lock ordering: cancelChallenge also takes this lock before touching
      // any wallet, so challenge-then-wallet is the single ordering used by
      // every operation that can run concurrently on an ACTIVE challenge —
      // no deadlock cycle exists.
      const lockedRows = await tx.$queryRaw<
        { status: string; challengerId: string; challengedId: string }[]
      >`SELECT "status", "challengerId", "challengedId" FROM "game_challenges" WHERE "id" = ${challengeId} FOR UPDATE`;
      const fresh = lockedRows[0];
      if (!fresh) throw ApiError.notFound('Challenge not found');
      if (fresh.status !== 'ACTIVE') throw ApiError.badRequest('Challenge is not active');
      if (fresh.challengerId !== userId && fresh.challengedId !== userId) {
        throw ApiError.forbidden('Not your challenge');
      }

      // The session is explicitly associated with this challenge. The unique
      // constraint (challengeId, userId) guarantees at most one turn per user
      // per challenge at the database level: a concurrent duplicate insert
      // fails with P2002 and is handled as an idempotent retry below. A
      // normal solo game session has challengeId = NULL and is never matched
      // by the opponent lookup below.
      const session = await tx.gameSession.create({
        data: {
          userId,
          gameId: challenge.gameId,
          challengeId,
          betAmount: challenge.entryAmount,
          // `score` MUST be persisted inside `result`. resolveChallengeOutcome
          // returns { result, score } as two separate values, but the opponent
          // lookup below (and buildChallengeTurnResponse) read the score back
          // as `session.result.score`. Persisting bare `result` left that key
          // undefined, so the first player's score always read back as 0 and
          // the SECOND submitter won every wagered challenge regardless of the
          // actual outcome. GameSession has no dedicated score column, and the
          // readers already expect it here, so this is where it belongs.
          result: { ...result, score } as any,
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
          challengeId,
          userId: opponentId,
          status: 'COMPLETED',
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
  } catch (err) {
    // A concurrent duplicate turn for the same (challenge, user) won the race:
    // the unique constraint rejected this insert. Respond idempotently with
    // the committed turn's result — never with an unhandled error, and never
    // with a second payout.
    if ((err as { code?: string }).code === 'P2002') {
      const committedSession = await prisma.gameSession.findUnique({
        where: { challengeId_userId: { challengeId, userId } },
      });
      const freshChallenge = await prisma.gameChallenge.findUnique({
        where: { id: challengeId },
      });
      if (committedSession && freshChallenge) {
        return buildChallengeTurnResponse(committedSession, freshChallenge, userId);
      }
    }
    throw err;
  }

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

/**
 * Builds the response for an already-recorded challenge turn (idempotent
 * retry). Derives completeness/winner from the authoritative challenge state
 * rather than any client-supplied data, and never re-triggers payouts or
 * realtime events.
 */
function buildChallengeTurnResponse(
  session: { id: string; result: unknown },
  challenge: { status: string; winnerId: string | null },
  userId: string
) {
  const result = (session.result ?? {}) as Record<string, unknown>;
  const score = (result as { score?: number }).score ?? 0;
  const complete = challenge.status === 'COMPLETED';

  const message = !complete
    ? 'Waiting for opponent'
    : challenge.winnerId === userId
      ? 'You won the challenge!'
      : challenge.winnerId === null
        ? 'The challenge was a tie!'
        : 'You lost the challenge';

  return {
    sessionId: session.id,
    result,
    score,
    challengeComplete: complete,
    winnerId: complete ? challenge.winnerId : undefined,
    message,
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
