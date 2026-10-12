// Historical receipts for retired Coin games. Never used by an API route.
// Uses the real ledger and every database guard; it does not reopen admission.
import { randomUUID } from 'node:crypto';
import { prisma } from '@socialplay/database';
import { settleWagerCoins } from '../economy/coin-ledger-service.js';
import {
  resolveJurisdictionForPlay,
  requirePlayableJurisdiction,
} from '../economy/jurisdiction-service.js';
import { rollDice, generateTarget, evaluateGuess } from '../games/game-engine.js';
import { fingerprintPlay } from '../games/game-fingerprint.js';
import type { PlayGameArgs, PlayResponse, GameResult } from '../games/game-play.js';

export async function historicalWagerFixture(args: PlayGameArgs): Promise<PlayResponse> {
  const url = new URL(process.env.DATABASE_URL!);
  if (
    process.env.NODE_ENV !== 'test' ||
    !/^playqube_[a-z0-9_]+_throwaway$/.test(process.env.TEST_LEDGER_DB_NAME ?? '') ||
    process.env.TEST_LEDGER_DB_NAME !== decodeURIComponent(url.pathname.slice(1)) ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
  )
    throw Error('Historical fixture requires acknowledged local test database');
  const { userId, gameKey, idempotencyKey, betAmount: stake } = args;
  if (
    !['dice', 'number_challenge'].includes(gameKey) ||
    !idempotencyKey ||
    !Number.isSafeInteger(stake) ||
    stake! <= 0
  )
    throw Error('Invalid historical fixture');
  return prisma.$transaction(async (tx) => {
    const game = await tx.gameDefinition.findUniqueOrThrow({ where: { key: gameKey } });
    const jurisdiction = requirePlayableJurisdiction(await resolveJurisdictionForPlay(tx, userId));
    const sessionId = randomUUID(),
      completedAt = new Date().toISOString();
    const selections = gameKey === 'dice' ? {} : { guess: args.clientData?.guess };
    const dice = rollDice(),
      guess = Number(args.clientData?.guess ?? 50),
      target = generateTarget();
    const evaluation = evaluateGuess(guess, target);
    const result =
      gameKey === 'dice' ? { ...dice, threshold: 7 } : { guess, target, ...evaluation };
    const multiplier =
      gameKey === 'dice'
        ? dice.sum >= 7
          ? 2
          : 0
        : evaluation.correct
          ? 5
          : evaluation.away <= 1
            ? 3
            : evaluation.away <= 5
              ? 2
              : evaluation.away <= 10
                ? 1.5
                : 0;
    const rewardAmount = Math.floor(stake! * multiplier);
    const base = {
      sessionId,
      gameKey,
      betAmount: stake!,
      rewardAmount,
      isWin: rewardAmount > 0,
      result,
      completedAt,
      mode: 'WAGER',
      family: 'INSTANT',
      wagerCurrency: 'COINS',
      rewardCurrency: 'COINS',
      rulesVersion: 1,
      resultSchemaVersion: 1,
      playContext: 'SOLO_WAGER',
    } as const;
    const settled = await settleWagerCoins(tx, userId, {
      sessionId,
      gameKey,
      stake: stake!,
      payout: rewardAmount,
      idempotencyKey,
      policy: { id: jurisdiction.policy.id, version: jurisdiction.policy.version },
      responseSnapshot: (balance) => ({ ...base, newBalance: balance }),
    });
    const response: GameResult = { ...base, newBalance: settled.coinsBalance };
    await tx.gameSession.create({
      data: {
        id: sessionId,
        userId,
        gameId: game.id,
        status: 'COMPLETED',
        betAmount: stake!,
        result,
        rewardAmount,
        isWin: base.isWin,
        idempotencyKey,
        completedAt: new Date(completedAt),
        mode: 'WAGER',
        family: 'INSTANT',
        wagerCurrency: 'COINS',
        rewardCurrency: 'COINS',
        rulesVersion: 1,
        resultSchemaVersion: 1,
        playContext: 'SOLO_WAGER',
        settlementDebitCurrency: 'COINS',
        settlementCreditCurrency: rewardAmount > 0 ? 'COINS' : null,
        requestSnapshot: JSON.parse(
          JSON.stringify({ gameKey, rulesVersion: 1, stake, selections })
        ),
        responseSnapshot: JSON.parse(JSON.stringify(response)),
        selections: JSON.parse(JSON.stringify(selections)),
        fingerprint: fingerprintPlay({ gameKey, rulesVersion: 1, stake: stake!, selections }),
      },
    });
    await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
    return { ...response, isReplay: false };
  });
}
