import { randomUUID } from 'crypto';
import { prisma } from '@socialplay/database';
import { ApiError } from '../middleware';
import { applyBalanceChanges, getOrCreateWallet } from '../economy/wallet-service.js';
import { resolveJurisdictionForPlay, requirePlayableJurisdiction } from '../economy/jurisdiction-service.js';
import { allocateWagerDebit, createPayoutProvenance, isQualifyingWager } from '../economy/provenance-service.js';
import { getGameByKey } from './game-catalog.js';
import { fingerprintPlay } from './game-fingerprint.js';
import { lockUserForPlay, lockGameForPlay } from './game-locks.js';
import type { BalanceChange } from '../economy/wallet-service.js';
import type { GameCurrencyValue } from './game-catalog.js';
import type { LockedGame } from './game-locks.js';
import {
  pickLuckySpinOutcome,
  rollDice,
  generateTarget,
  evaluateGuess,
  checkTriviaAnswer,
  calculateGameReward,
} from './game-engine.js';

export type PlayModeValue = 'WAGER' | 'BONUS';
export type PlayFamilyValue = 'INSTANT' | 'SCHEDULED_DRAW' | 'SCHEDULED_RACE';
export type PlayContextValue = 'SOLO_WAGER' | 'COMPETITION_ROUND' | 'CHALLENGE_ROUND' | 'BONUS';

export interface PlayGameArgs {
  userId: string;
  gameKey: string;
  /** WAGER games require a stake. BONUS games (trivia) MUST omit it. */
  betAmount?: number;
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
  completedAt: string; // ISO-8601 (kept as string so replay snapshots round-trip)
  newBalance: number; // authoritative COINS balance after play
  mode: PlayModeValue;
  family: PlayFamilyValue;
  wagerCurrency: GameCurrencyValue | null;
  rewardCurrency: GameCurrencyValue;
  rulesVersion: number | null;
  resultSchemaVersion: number | null;
  playContext: PlayContextValue;
}

export type PlayResponse = GameResult & { isReplay: boolean };

// ─── Idempotency Key Validation ────────────────────────────────

// Printable ASCII only (0x21-0x7E): no spaces, controls or non-ASCII,
// 1-128 chars. Validated BEFORE any transaction work.
const IDEMPOTENCY_KEY_PATTERN = /^[\x21-\x7E]{1,128}$/;

export function validateIdempotencyKey(key: string | null | undefined): string {
  if (typeof key !== 'string' || !IDEMPOTENCY_KEY_PATTERN.test(key)) {
    throw ApiError.badRequest(
      'Idempotency key is required and must be 1-128 visible ASCII characters'
    );
  }
  return key;
}

// ─── Bet Validation ────────────────────────────────────────────

function validateWagerBet(amount: unknown, minBet: number, maxBet: number): number {
  if (typeof amount !== 'number') throw ApiError.badRequest('Bet must be a number');
  if (!Number.isInteger(amount)) throw ApiError.badRequest('Bet must be an integer');
  if (amount <= 0) throw ApiError.badRequest('Bet must be positive');
  if (amount < minBet) throw ApiError.badRequest(`Minimum bet is ${minBet}`);
  if (amount > maxBet) throw ApiError.badRequest(`Maximum bet is ${maxBet}`);
  return amount;
}

// ─── Game Result Generators (server-authoritative) ─────────────
// The `config` passed in is the IMMUTABLE rules row for the version being
// played — never the mutable game definition configuration.

function generateLuckySpinResult(
  stake: number,
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
  const { rewardAmount, isWin } = calculateGameReward(stake, outcome.multiplier);
  return {
    result: { name: outcome.name, multiplier: outcome.multiplier, index: outcome.index },
    rewardAmount,
    isWin,
  };
}

function generateDiceResult(
  stake: number,
  config: Record<string, unknown>
): { result: Record<string, unknown>; rewardAmount: number; isWin: boolean } {
  const { die1, die2, sum } = rollDice();
  const threshold = (config.winThreshold as number) ?? 7;
  const multiplier = (config.multiplier as number) ?? 2;
  const isWin = sum >= threshold;
  const { rewardAmount } = calculateGameReward(stake, isWin ? multiplier : 0);
  return {
    result: { die1, die2, sum, threshold },
    rewardAmount,
    isWin,
  };
}

function generateNumberChallengeResult(
  stake: number,
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

  const { rewardAmount, isWin } = calculateGameReward(stake, multiplier);
  return {
    result: { guess, target, away, correct },
    rewardAmount,
    isWin,
  };
}

// ─── Selections Extractor ──────────────────────────────────────

function buildSelections(
  gameType: string,
  clientData: Record<string, unknown>
): Record<string, unknown> {
  switch (gameType) {
    case 'NUMBER_CHALLENGE':
      return { guess: clientData.guess };
    case 'TRIVIA':
      return { questionId: clientData.questionId, answerIndex: clientData.answerIndex };
    default:
      return {};
  }
}

function toCurrency(value: unknown, fallback: GameCurrencyValue): GameCurrencyValue {
  return value === 'COINS' || value === 'GAME_POINTS' ? value : fallback;
}

// ─── Main Play Handler ─────────────────────────────────────────
//
// Ordering invariant (why each step is where it is):
//   1-2. Advisory lock + user eligibility — unconditional, cheapest checks.
//   3. Replay detection — an existing idempotency key returns the stored
//      snapshot WITHOUT resolving current rules/availability and WITHOUT
//      any write (no wallet touch, no provenance, no session row). Only
//      `game.type` (immutable per key) is used, from the pre-tx fail-fast
//      read, to recompute the comparison fingerprint.
//   4. Jurisdiction gate — fail-closed, BEFORE any wallet/session write.
//   5. NEW-session path only: lock the GameDefinition row (FOR SHARE) and
//      re-validate availability/bet shape against THAT locked read, never
//      the pre-tx snapshot — a concurrent catalogStatus/currentRulesVersion
//      change must commit before this lock or wait behind it.
//   6. Wallet creation — INSIDE the transaction, AFTER eligibility and
//      jurisdiction, so a rejected play (bad account, bad jurisdiction)
//      never creates a wallet row.
//   7. Resolve current rules using the SAME tx client and the locked game's
//      currentRulesVersion.
//   8. Outcome generation, settlement (wallet debit/credit via the sole
//      authoritative path), wager-debit provenance allocation, conservative
//      payout-restriction provenance, session row.
export async function playGame(args: PlayGameArgs): Promise<PlayResponse> {
  const { userId, betAmount, clientData = {} } = args;

  // Fail fast: idempotency key is REQUIRED and validated before any tx.
  const idempotencyKey = validateIdempotencyKey(args.idempotencyKey);

  const gameKey = args.gameKey.trim().toLowerCase();
  if (!gameKey) throw ApiError.badRequest('Game key is required');

  // Fast, NON-AUTHORITATIVE pre-tx read: fail obviously-bad requests (unknown
  // key, betAmount shape) before opening a transaction at all, and supply
  // the immutable `type` field the replay path needs. Never used to decide
  // availability, bet bounds, or rules for a NEW play — that decision is
  // made again, authoritatively, under lock inside the transaction (step 5
  // below), so a game that changed between this read and the transaction
  // can never be played (or replay-fingerprinted) against stale state.
  const preCheckGame = await getGameByKey(gameKey);
  if (!preCheckGame) throw ApiError.notFound('Game not found');
  const preCheckIsBonus = preCheckGame.mode === 'BONUS';
  if (preCheckIsBonus) {
    if (betAmount !== undefined) {
      throw ApiError.badRequest('BONUS games do not accept a betAmount');
    }
  } else {
    validateWagerBet(betAmount, preCheckGame.minBet, preCheckGame.maxBet);
  }

  // Pre-generate the session id so settlement ledger entries can reference it.
  const sessionId = randomUUID();

  return prisma.$transaction(async (tx) => {
    // 1. Advisory lock: serialize concurrent plays for (user, idempotencyKey) so
    //    replay detection and balance settlement cannot race. The outer
    //    SELECT hides the void return of pg_advisory_xact_lock, which
    //    Prisma's $queryRaw cannot deserialize.
    await tx.$queryRaw`SELECT 1 FROM (SELECT pg_advisory_xact_lock(hashtextextended('game_play:' || ${userId} || ':' || ${idempotencyKey}, 0))) AS lock_wait`;

    // 2. Eligibility: FOR SHARE on the user, require ACTIVE status.
    await lockUserForPlay(tx, userId);

    // 3. Replay detection: same idempotency key. NO writes, NO rules/
    //    availability resolution on this path — only the pre-tx snapshot's
    //    immutable `type` is used to recompute the comparison fingerprint.
    const existing = await tx.gameSession.findFirst({
      where: { userId, idempotencyKey },
    });
    if (existing) {
      // Same key + same fingerprint -> replay the stored response.
      // Use the STORED rulesVersion (the version the original session was
      // settled under) with the CURRENT request's stake/selections to compute
      // the comparison fingerprint.
      const stakeForFingerprint = preCheckIsBonus ? 0 : (betAmount as number);
      const currentSelections = buildSelections(preCheckGame.type, clientData);
      const currentFingerprint = fingerprintPlay({
        gameKey,
        rulesVersion: existing.rulesVersion,
        stake: stakeForFingerprint,
        selections: currentSelections,
      });
      if (existing.fingerprint === currentFingerprint && existing.responseSnapshot) {
        const snapshot = existing.responseSnapshot as unknown as GameResult;
        return { ...snapshot, isReplay: true };
      }
      // Same key but different request -> hard conflict.
      throw ApiError.conflict(
        'This idempotency key was already used for a different play request'
      );
    }

    // 4. Jurisdiction gate (fail-closed): resolve the user's verified country
    //    and active enabled policy, LOCKING both rows for the rest of this
    //    transaction. Missing, unresolved, or disabled jurisdiction throws
    //    FORBIDDEN BEFORE any wallet/session writes.
    const jurisdiction = requirePlayableJurisdiction(
      await resolveJurisdictionForPlay(tx, userId)
    );
    const playthroughMultiplier = jurisdiction.policy.playthroughMultiplier;

    // 5. NEW SESSION — authoritative, locked read of the game row. Re-checks
    //    availability and bet shape against the FRESH, locked state; a
    //    concurrent update to catalogStatus/currentRulesVersion must commit
    //    before this lock or wait behind this transaction.
    const game: LockedGame | null = await lockGameForPlay(tx, gameKey);
    if (!game) throw ApiError.notFound('Game not found');
    if (game.catalogStatus !== 'AVAILABLE') {
      throw ApiError.badRequest('This game is not available to play');
    }

    const isBonus = game.mode === 'BONUS';
    if (isBonus) {
      if (betAmount !== undefined) {
        throw ApiError.badRequest('BONUS games do not accept a betAmount');
      }
    } else {
      validateWagerBet(betAmount, game.minBet, game.maxBet);
    }
    const stake = isBonus ? 0 : (betAmount as number);

    // 6. Ensure a wallet exists — INSIDE the transaction, using the SAME tx
    //    client, and only now that eligibility and jurisdiction have both
    //    passed. A rejected play never creates a wallet row.
    await getOrCreateWallet(userId, tx);

    // 7. Resolve current rules using the SAME transaction client and the
    //    LOCKED game's currentRulesVersion (never the pre-tx snapshot).
    if (!game.currentRulesVersion) throw ApiError.badRequest('This game has no active rules');
    const rules = await tx.gameRules.findUnique({
      where: { gameId_version: { gameId: game.id, version: game.currentRulesVersion } },
    });
    if (!rules) throw ApiError.badRequest('This game has no active rules');

    const wagerCurrency = isBonus ? null : toCurrency(game.wagerCurrency, 'COINS');
    const rewardCurrency = toCurrency(game.rewardCurrency, 'COINS');
    const rulesVersion = rules.version;
    const resultSchemaVersion = rules.resultSchemaVersion;
    const family = (game.family as PlayFamilyValue) ?? 'INSTANT';
    const rulesConfig = (rules.rules as Record<string, unknown>) ?? {};
    const selections = buildSelections(game.type, clientData);
    const playContext: PlayContextValue = isBonus ? 'BONUS' : 'SOLO_WAGER';

    const fingerprint = fingerprintPlay({
      gameKey,
      rulesVersion,
      stake,
      selections,
    });

    // 8. Server-authoritative outcome.
    let resultData: Record<string, unknown>;
    let rewardAmount = 0;
    let isWin = false;

    switch (game.type) {
      case 'DICE':
        ({ result: resultData, rewardAmount, isWin } = generateDiceResult(stake, rulesConfig));
        break;
      case 'NUMBER_CHALLENGE':
        ({ result: resultData, rewardAmount, isWin } = generateNumberChallengeResult(
          stake, rulesConfig, clientData.guess as number | undefined
        ));
        break;
      case 'LUCKY_SPIN':
        // Retired legacy game — unreachable via the catalog, kept so the
        // generator exists for historical sessions/diagnostics.
        ({ result: resultData, rewardAmount, isWin } = generateLuckySpinResult(stake, rulesConfig));
        break;
      case 'TRIVIA': {
        const triviaQuestionId = clientData.questionId as string | undefined;
        const triviaAnswerIndex = clientData.answerIndex as number | undefined;

        if (!triviaQuestionId) throw ApiError.badRequest('Question ID is required');
        if (triviaAnswerIndex === undefined || triviaAnswerIndex === null) {
          throw ApiError.badRequest('Answer index is required');
        }

        // Friendly pre-check (serialized by the advisory lock above; the
        // unique constraint below remains the authoritative backstop).
        const priorAttempt = await tx.userTriviaAttempt.findUnique({
          where: {
            userId_questionId: { userId, questionId: triviaQuestionId },
          },
        });
        if (priorAttempt) {
          throw ApiError.badRequest('You have already answered this question');
        }

        const question = await tx.triviaQuestion.findUnique({ where: { id: triviaQuestionId } });
        if (!question || !question.isActive) throw ApiError.badRequest('Invalid question');

        // Claim the attempt atomically with the play. On P2002 (a concurrent
        // request already claimed this question) throw immediately — NO query
        // inside the aborted transaction; recovery happens on rollback.
        try {
          await tx.userTriviaAttempt.create({
            data: { userId, questionId: question.id },
          });
        } catch (err) {
          if ((err as { code?: string }).code === 'P2002') {
            throw ApiError.badRequest('You have already answered this question');
          }
          throw err;
        }

        const { correct } = checkTriviaAnswer(triviaAnswerIndex, question.correctIndex);
        const correctPoints = (rulesConfig.correctPoints as number) ?? 30;
        rewardAmount = correct ? correctPoints : 0;
        isWin = correct;
        resultData = {
          questionId: question.id,
          submittedAnswer: triviaAnswerIndex,
          correct,
        };
        break;
      }
      default:
        throw ApiError.badRequest('Unknown game type');
    }

    // 9. Settlement currencies and wallet changes.
    const changes: BalanceChange[] = [];
    let settlementDebitCurrency: GameCurrencyValue | null = null;
    let settlementCreditCurrency: GameCurrencyValue | null = null;

    if (isBonus) {
      // Trivia: NO debit, COINS credit only (restricted reward coins).
      settlementDebitCurrency = null;
      if (rewardAmount > 0) {
        changes.push({
          currency: rewardCurrency,
          amount: rewardAmount,
          ledgerType: 'CREDIT',
          transactionType: rewardCurrency === 'COINS' ? 'COIN_CREDIT' : 'GAME_POINT_CREDIT',
          referenceType: 'GAME',
          referenceId: sessionId,
          description: 'Trivia reward',
        });
        settlementCreditCurrency = rewardCurrency;
      }
    } else {
      // WAGER: COINS debit + COINS credit via the authoritative path.
      settlementDebitCurrency = wagerCurrency;
      settlementCreditCurrency = rewardCurrency;
      changes.push({
        currency: wagerCurrency!,
        amount: stake,
        ledgerType: 'DEBIT',
        transactionType: wagerCurrency === 'COINS' ? 'COIN_DEBIT' : 'GAME_POINT_DEBIT',
        referenceType: 'GAME',
        referenceId: sessionId,
        description: `Game bet: ${gameKey}`,
      });
      if (rewardAmount > 0) {
        changes.push({
          currency: rewardCurrency,
          amount: rewardAmount,
          ledgerType: 'CREDIT',
          transactionType: rewardCurrency === 'COINS' ? 'COIN_CREDIT' : 'GAME_POINT_CREDIT',
          referenceType: 'GAME',
          referenceId: sessionId,
          description: `Game reward: ${gameKey}`,
        });
      }
    }

    // Wallet debit/credit — the sole authoritative wallet-mutation path.
    // Provenance (CoinAllocation.gameSessionId is a real foreign key to
    // GameSession) is recorded further below, AFTER the GameSession row
    // exists — see step 12.
    let walletResult: Awaited<ReturnType<typeof applyBalanceChanges>> | null = null;
    if (changes.length > 0) {
      walletResult = await applyBalanceChanges(tx, userId, changes, {
        idempotencyKey,
        operationName: 'game_play',
      });
    }

    // 10. Authoritative post-play balance (COINS since every G0 game settles in COINS).
    const walletAfter = await tx.wallet.findUnique({
      where: { userId },
      select: { coinsBalance: true, gamePointsBalance: true },
    });
    const newBalance =
      (rewardCurrency === 'COINS'
        ? walletAfter?.coinsBalance
        : walletAfter?.gamePointsBalance) ?? 0;

    // 11. Response + immutable snapshots.
    const responseBody: GameResult = {
      sessionId,
      gameKey,
      betAmount: stake,
      rewardAmount,
      isWin,
      result: resultData,
      completedAt: new Date().toISOString(),
      newBalance,
      mode: game.mode as PlayModeValue,
      family,
      wagerCurrency,
      rewardCurrency,
      rulesVersion,
      resultSchemaVersion,
      playContext,
    };

    const requestSnapshot = JSON.parse(
      JSON.stringify({
        gameKey,
        rulesVersion: rulesVersion ?? null,
        stake,
        selections,
      })
    );

    const responseSnapshot = JSON.parse(JSON.stringify(responseBody));

    try {
      await tx.gameSession.create({
        data: {
          id: sessionId,
          userId,
          gameId: game.id,
          status: 'COMPLETED',
          betAmount: stake,
          result: JSON.parse(JSON.stringify(resultData)),
          rewardAmount,
          isWin,
          idempotencyKey,
          completedAt: new Date(),
          mode: game.mode as PlayModeValue,
          family,
          wagerCurrency,
          rewardCurrency,
          rulesVersion,
          resultSchemaVersion,
          settlementDebitCurrency,
          settlementCreditCurrency,
          requestSnapshot,
          responseSnapshot,
          fingerprint,
          selections: JSON.parse(JSON.stringify(selections)),
          playContext,
        },
      });
    } catch (err) {
      // P2002 on (userId, idempotencyKey) means a concurrent request took the
      // key in the interval between our replay check and create. Throw
      // immediately (no query inside the aborted tx); rollback undoes any
      // wallet settlement already applied in this tx.
      if ((err as { code?: string }).code === 'P2002') {
        throw ApiError.conflict(
          'This idempotency key was already used for a different play request'
        );
      }
      throw err;
    }

    // 12. NOW that the GameSession row exists, record provenance —
    // CoinAllocation.gameSessionId is a real foreign key to GameSession, so
    // every allocation created here must come after the row above commits
    // to this same transaction. If anything below throws, the WHOLE
    // transaction (wallet changes, the session row, and any provenance
    // already written in this block) rolls back together — there is no
    // window where a session or wallet change persists without its
    // provenance, or vice versa.
    let fundedByRestricted = false;
    if (walletResult) {
      if (isBonus && rewardAmount > 0) {
        // Trivia reward: always restricted coins — a fresh grant, never
        // funded by anything, so there is no provenance to allocate.
        const creditTx = walletResult.transactions.find(
          (t) => t.ledgerType === 'CREDIT' && t.currency === 'COINS'
        );
        if (creditTx) {
          await tx.coinProvenance.create({
            data: {
              userId,
              walletTransactionId: creditTx.id,
              amount: rewardAmount,
              provenanceType: 'TRIVIA_REWARD',
              restrictionStatus: 'RESTRICTED',
              originalSource: 'TRIVIA_REWARD',
              countryPolicyId: jurisdiction.policy.id,
              countryPolicyVersion: jurisdiction.policy.version,
              requiredPlaythrough: Math.round(rewardAmount * playthroughMultiplier),
            },
          });
        }
      } else if (!isBonus) {
        // WAGER: allocate the stake debit across the user's provenance lots
        // (deterministic FIFO, locked) — this is what decides whether ANY
        // restricted coin funded this wager, NOT the win/loss outcome.
        // Must run AFTER applyBalanceChanges: the debit already proved the
        // wallet could afford this stake; this call only explains
        // provenance for a debit that has already happened.
        if (wagerCurrency === 'COINS') {
          const qualifies = isQualifyingWager(
            {
              qualifyingGames: jurisdiction.policy.qualifyingGames,
              maxQualifyingStake: jurisdiction.policy.maxQualifyingStake,
            },
            gameKey,
            stake
          );
          const allocation = await allocateWagerDebit({
            tx,
            userId,
            amount: stake,
            gameSessionId: sessionId,
            isQualifyingWager: qualifies,
            policy: { id: jurisdiction.policy.id, version: jurisdiction.policy.version },
          });
          fundedByRestricted = allocation.fundedByRestricted;
        }

        if (rewardAmount > 0 && rewardCurrency === 'COINS') {
          // Payout provenance is CONSERVATIVE: restricted the moment any
          // funding lot was restricted, never assumed unrestricted just
          // because the wager won.
          const creditTx = walletResult.transactions.find(
            (t) => t.ledgerType === 'CREDIT' && t.currency === 'COINS'
          );
          if (creditTx) {
            await createPayoutProvenance({
              tx,
              userId,
              walletTransactionId: creditTx.id,
              amount: rewardAmount,
              fundedByRestricted,
              policy: {
                id: jurisdiction.policy.id,
                version: jurisdiction.policy.version,
                playthroughMultiplier,
              },
            });
          }
        }
      }
    }

    return { ...responseBody, isReplay: false };
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
        mode: true,
        family: true,
        wagerCurrency: true,
        rewardCurrency: true,
        rulesVersion: true,
        playContext: true,
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