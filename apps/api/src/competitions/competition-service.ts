import { prisma, Prisma } from '@socialplay/database';
import { ApiError } from '../middleware';
import { getOrCreateWallet, applyBalanceChanges, BalanceChange } from '../economy/wallet-service';
import { assertGroupRole, assertActiveMember, getGroupMembership } from '../realtime/chat-service';
import { emitToGroup } from '../realtime/broadcast';
import { rollDice, generateTarget, evaluateGuess, secureRandomInt } from '../games/game-engine';
import { getGameByKey, ensureGameDefinitions } from '../games/game-catalog';

const MANAGER_ROLES = ['OWNER', 'ADMIN'];

// Maximum number of scored rounds a participant may play in a NON-TRIVIA
// competition game (DICE, NUMBER_CHALLENGE, LUCKY_SPIN).
//
// NOTE: this is a NEWLY INTRODUCED product rule, not a rediscovered one — the
// repository has no existing per-round cap, config field, schema constraint,
// or frontend play-counter for these game types (unlike trivia, whose natural
// cap is the finite pool of not-yet-attempted active questions, enforced via
// CompetitionTriviaAttempt's per-question uniqueness). Before Phase 6K, an
// unlimited replay of playCompetition was cosmetic — score was never backed by
// real funds. Phase 6K made rewardGamePoints/rewardCoins a real, creator-funded
// escrow, which turned unlimited replay into a path to drain another
// participant's funded prize by inflating score.
//
// 5 was chosen as the smallest value that still supports a genuine "best
// score across a few attempts" competition format, rather than degrading
// every non-trivia competition to a single coin-flip (which a cap of 1 would
// do). This value has no basis in existing product signal and should be
// confirmed by product before relying on it in a real economy.
const MAX_NON_TRIVIA_PLAYS_PER_COMPETITION = 5;

// Upper bound for a single competition prize pool, per currency. Prize funds are
// escrowed from the creator's wallet at creation time, so the creator's actual
// balance is the real ceiling; this constant is defence-in-depth so an absurd
// value can never reach the ledger.
const MAX_COMPETITION_REWARD = 1_000_000;

/**
 * Strictly validates a client-supplied reward amount. Rejects — never silently
 * coerces — non-numbers, NaN, Infinity, non-integers, unsafe integers,
 * negatives, and values above the business maximum.
 *
 * Used by BOTH createCompetition and updateCompetition so that the update path
 * cannot bypass creation-time validation.
 */
function validateRewardAmount(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw ApiError.badRequest(`${field} must be a finite number`);
  }
  if (!Number.isInteger(value) || !Number.isSafeInteger(value)) {
    throw ApiError.badRequest(`${field} must be an integer`);
  }
  if (value < 0) {
    throw ApiError.badRequest(`${field} must be non-negative`);
  }
  if (value > MAX_COMPETITION_REWARD) {
    throw ApiError.badRequest(`${field} exceeds the maximum of ${MAX_COMPETITION_REWARD}`);
  }
  return value;
}

/**
 * Builds the wallet ledger entries that move a competition's prize pool into or
 * out of escrow.
 *
 * Competition prizes are CREATOR-FUNDED, mirroring the friend-challenge pattern
 * (entry debited at create/accept, pot paid at resolve, refunded on cancel).
 * They are NOT platform-funded: unlike task/achievement rewards — whose amounts
 * come from server-side definition rows — competition prize amounts are supplied
 * by the client, so they must be collected before they can ever be paid out.
 *
 * The invariant this enforces is:
 *   total competition payouts <= funded (escrowed) competition prize
 * with any unpaid remainder always returned to the funder.
 */
function prizeEscrowChanges(
  gamePoints: number,
  coins: number,
  ledgerType: 'DEBIT' | 'CREDIT',
  competitionId: string,
  description: string
): BalanceChange[] {
  const changes: BalanceChange[] = [];
  if (gamePoints > 0) {
    changes.push({
      currency: 'GAME_POINTS',
      amount: gamePoints,
      ledgerType,
      transactionType: ledgerType === 'DEBIT' ? 'GAME_POINT_DEBIT' : 'GAME_POINT_CREDIT',
      referenceType: 'REWARD',
      referenceId: competitionId,
      description,
    });
  }
  if (coins > 0) {
    changes.push({
      currency: 'COINS',
      amount: coins,
      ledgerType,
      transactionType: ledgerType === 'DEBIT' ? 'COIN_DEBIT' : 'COIN_CREDIT',
      referenceType: 'REWARD',
      referenceId: competitionId,
      description,
    });
  }
  return changes;
}

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
  const rGP = validateRewardAmount(args.rewardGamePoints ?? 0, 'rewardGamePoints');
  const rCoins = validateRewardAmount(args.rewardCoins ?? 0, 'rewardCoins');
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

  // Create the competition and escrow its prize pool from the creator in ONE
  // transaction. The prize is collected up front, so a competition can never
  // promise more than has actually been funded — this is what prevents the
  // finalizer from minting unbacked currency. If the creator cannot cover the
  // prize, applyBalanceChanges throws and the competition is never created.
  const competition = await prisma.$transaction(async (tx) => {
    const created = await tx.groupCompetition.create({
      data: {
        groupId: args.groupId,
        gameId: game.id,
        title: args.title.trim(),
        description: args.description?.trim() ?? null,
        status: 'SCHEDULED',
        scoring,
        entryAmount: entry,
        maxParticipants,
        participantCount: 0,
        rewardGamePoints: rGP,
        rewardCoins: rCoins,
        startsAt,
        endsAt,
        createdBy: creatorId,
      },
      include: { group: { select: { id: true, name: true } }, game: { select: { key: true, name: true } } },
    });

    const funding = prizeEscrowChanges(
      rGP,
      rCoins,
      'DEBIT',
      created.id,
      `Competition prize funding: ${created.title}`
    );
    if (funding.length > 0) {
      await applyBalanceChanges(tx, creatorId, funding);
    }

    return created;
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
  // Rewards go through the SAME strict validation as creation, so this path
  // cannot be used to smuggle a negative/NaN/oversized prize past the
  // creation-time rules.
  const newGP =
    args.rewardGamePoints !== undefined
      ? validateRewardAmount(args.rewardGamePoints, 'rewardGamePoints')
      : undefined;
  const newCoins =
    args.rewardCoins !== undefined
      ? validateRewardAmount(args.rewardCoins, 'rewardCoins')
      : undefined;
  if (newGP !== undefined) data.rewardGamePoints = newGP;
  if (newCoins !== undefined) data.rewardCoins = newCoins;
  if (args.startsAt && args.endsAt) {
    const s = new Date(args.startsAt);
    const e = new Date(args.endsAt);
    if (e <= s) throw ApiError.badRequest('End time must be after start time');
    data.startsAt = s;
    data.endsAt = e;
  }

  const prizeChanged =
    (newGP !== undefined && newGP !== comp.rewardGamePoints) ||
    (newCoins !== undefined && newCoins !== comp.rewardCoins);

  // entryAmount is what joinCompetition debits and records into each new
  // participant's entryPaid at the moment they join. Because cancelCompetition
  // correctly refunds each participant's OWN entryPaid rather than this live
  // field, changing entryAmount can no longer mint or destroy currency on its
  // own — but it must still be locked once anyone has joined, or a manager
  // could otherwise advertise one entry price to early joiners and a
  // different one to later joiners of the SAME competition, which is a
  // fairness/product-integrity problem even though it is no longer an
  // accounting one.
  const entryAmountChanged =
    args.entryAmount !== undefined && data.entryAmount !== comp.entryAmount;

  if (!prizeChanged && !entryAmountChanged) {
    // No escrowed funds move here, but the write is still guarded on the
    // lifecycle so a concurrent finalize/cancel cannot be overwritten by a
    // late edit.
    return prisma.$transaction(async (tx) => {
      const applied = await tx.groupCompetition.updateMany({
        where: { id: competitionId, status: 'SCHEDULED', finalizedAt: null },
        data,
      });
      if (applied.count === 0) {
        throw ApiError.badRequest('Only scheduled competitions can be edited');
      }
      const updated = await tx.groupCompetition.findUnique({ where: { id: competitionId } });
      if (!updated) throw ApiError.notFound('Competition not found');
      return updated;
    });
  }

  // A prize change moves real escrowed funds, so it must be atomic with the
  // row update, and the escrow always settles against the ORIGINAL funder
  // (comp.createdBy) — not whichever manager happens to be editing. An
  // entryAmount-only change moves no escrow, but is routed through this same
  // guarded path so it shares the identical participant-join lock.
  await getOrCreateWallet(comp.createdBy);

  return prisma.$transaction(async (tx) => {
    const before = await tx.groupCompetition.findUnique({ where: { id: competitionId } });
    if (!before) throw ApiError.notFound('Competition not found');
    if (before.status !== 'SCHEDULED') throw ApiError.badRequest('Only scheduled competitions can be edited');

    const targetGP = newGP ?? before.rewardGamePoints;
    const targetCoins = newCoins ?? before.rewardCoins;
    const deltaGP = targetGP - before.rewardGamePoints;
    const deltaCoins = targetCoins - before.rewardCoins;

    // ── ATOMIC CLAIM (compare-and-swap on prize AND entry amount) ─
    // Applies the edit and takes the competition row lock in ONE statement,
    // BEFORE any escrow moves. The status/finalizedAt predicates make this
    // mutually exclusive with finalize and cancel; the reward/entry predicates
    // make it mutually exclusive with another concurrent edit, so two updates
    // can never both compute a delta from the same starting amounts.
    const claim = await tx.groupCompetition.updateMany({
      where: {
        id: competitionId,
        status: 'SCHEDULED',
        finalizedAt: null,
        rewardGamePoints: before.rewardGamePoints,
        rewardCoins: before.rewardCoins,
        entryAmount: before.entryAmount,
      },
      data,
    });
    if (claim.count === 0) {
      throw ApiError.conflict('Competition changed concurrently — please retry');
    }

    // The row lock is now held, so a concurrent join cannot slip in behind
    // this check: join must claim the same row to reserve its seat. This is
    // the sole guard preventing entryAmount (and the prize) from changing
    // after money has already been collected under the prior terms.
    const joined = await tx.competitionParticipant.count({ where: { competitionId } });
    if (joined > 0) {
      throw ApiError.badRequest(
        'Entry amount and prize cannot be changed after participants have joined'
      );
    }

    // Increase → collect the difference; decrease → return the difference.
    // Both directions keep escrow exactly equal to the advertised prize.
    const topUp = prizeEscrowChanges(
      Math.max(0, deltaGP),
      Math.max(0, deltaCoins),
      'DEBIT',
      competitionId,
      `Competition prize increase: ${before.title}`
    );
    if (topUp.length > 0) {
      await applyBalanceChanges(tx, before.createdBy, topUp);
    }

    const release = prizeEscrowChanges(
      Math.max(0, -deltaGP),
      Math.max(0, -deltaCoins),
      'CREDIT',
      competitionId,
      `Competition prize reduction — escrow release: ${before.title}`
    );
    if (release.length > 0) {
      await applyBalanceChanges(tx, before.createdBy, release);
    }

    const updated = await tx.groupCompetition.findUnique({ where: { id: competitionId } });
    if (!updated) throw ApiError.notFound('Competition not found');
    return updated;
  });
}

export async function cancelCompetition(actorId: string, competitionId: string) {
  const comp = await prisma.groupCompetition.findUnique({ where: { id: competitionId } });
  if (!comp) throw ApiError.notFound('Competition not found');
  await assertGroupRole(comp.groupId, actorId, MANAGER_ROLES);
  if (!['SCHEDULED', 'ACTIVE'].includes(comp.status)) {
    throw ApiError.badRequest('Competition cannot be cancelled');
  }

  await getOrCreateWallet(comp.createdBy);

  await prisma.$transaction(async (tx) => {
    // Claim the cancellation atomically FIRST. Only the transaction that
    // actually flips the status issues refunds, so concurrent cancels can
    // never refund the same entries or the same prize escrow twice.
    const claimed = await tx.groupCompetition.updateMany({
      where: { id: competitionId, status: { in: ['SCHEDULED', 'ACTIVE'] } },
      data: { status: 'CANCELLED', participantCount: 0 },
    });
    if (claimed.count === 0) {
      throw ApiError.badRequest('Competition cannot be cancelled');
    }

    // Read the prize from the row itself — never from client input.
    const fresh = await tx.groupCompetition.findUnique({
      where: { id: competitionId },
      select: { title: true, rewardGamePoints: true, rewardCoins: true, createdBy: true },
    });
    if (!fresh) throw ApiError.notFound('Competition not found');

    // Refund each entrant EXACTLY what THEY paid (entryPaid, recorded at their
    // own join), never the competition's current entryAmount. entryAmount is
    // mutable up until the first join (see updateCompetition's lock below);
    // refunding from it instead of from what was actually collected can mint
    // currency (entryAmount raised after collection) or destroy it (entryAmount
    // lowered or zeroed after collection).
    const participants = await tx.competitionParticipant.findMany({
      where: { competitionId, entryPaid: { gt: 0 } },
      select: { userId: true, entryPaid: true },
    });
    for (const p of participants) {
      await applyBalanceChanges(tx, p.userId, [
        {
          currency: 'GAME_POINTS',
          amount: p.entryPaid,
          ledgerType: 'CREDIT',
          transactionType: 'GAME_POINT_CREDIT',
          referenceType: 'GAME',
          description: 'Competition cancelled — entry refund',
        },
      ]);
    }

    // Release the full prize escrow back to the funder — nothing is stranded.
    const release = prizeEscrowChanges(
      fresh.rewardGamePoints,
      fresh.rewardCoins,
      'CREDIT',
      competitionId,
      `Competition cancelled — prize refund: ${fresh.title}`
    );
    if (release.length > 0) {
      await applyBalanceChanges(tx, fresh.createdBy, release);
    }
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
    // ── ATOMIC LIFECYCLE CLAIM + SEAT RESERVATION ────────────────
    // Reserving the seat and asserting the competition is still open happen in
    // ONE conditional statement, which takes the competition row lock BEFORE
    // the entry fee is debited.
    //
    // A plain read here was not sufficient: under READ COMMITTED a SELECT does
    // not block on a row locked by a concurrent cancel, so a join could pass a
    // stale status check, debit the entry, and commit after the cancellation
    // had already refunded everyone — stranding that entry fee. Claiming the
    // row makes join and cancel serialize, so either the seat is reserved
    // before cancellation (and is therefore refunded) or the claim fails.
    const txNow = new Date();
    const seat = await tx.groupCompetition.updateMany({
      where: {
        id: competitionId,
        status: { in: ['SCHEDULED', 'ACTIVE'] },
        finalizedAt: null,
        startsAt: { lte: txNow },
        endsAt: { gte: txNow },
      },
      data: { participantCount: { increment: 1 } },
    });
    if (seat.count === 0) {
      throw ApiError.badRequest('Competition is not open for participation');
    }

    const freshComp = await tx.groupCompetition.findUnique({ where: { id: competitionId } });
    if (!freshComp) throw ApiError.notFound('Competition not found');

    const existing = await tx.competitionParticipant.findUnique({
      where: { competitionId_userId: { competitionId, userId } },
    });
    if (existing) throw ApiError.badRequest('Already joined this competition');

    // Capacity is enforced against the just-incremented counter; because the
    // increment happened under the row lock, concurrent joins cannot both see
    // room for the same final seat. Throwing rolls back the increment.
    if (
      freshComp.maxParticipants !== null &&
      freshComp.maxParticipants !== undefined &&
      freshComp.participantCount > freshComp.maxParticipants
    ) {
      throw ApiError.badRequest('Competition is full');
    }

    if (freshComp.entryAmount > 0) {
      await applyBalanceChanges(tx, userId, [
        {
          currency: 'GAME_POINTS',
          amount: freshComp.entryAmount,
          ledgerType: 'DEBIT',
          transactionType: 'GAME_POINT_DEBIT',
          referenceType: 'GAME',
          description: `Competition entry: ${freshComp.title}`,
        },
      ]);
    }

    // Persist exactly what was just debited. This — not the competition's
    // live entryAmount — is the sole source of truth for what cancel refunds:
    // entryAmount can be edited later (see the immutability lock below), and
    // a refund derived from a since-changed value can mint or destroy funds.
    return tx.competitionParticipant.create({
      data: { competitionId, userId, entryPaid: freshComp.entryAmount },
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
      // A guess is optional (defaults to 50, matching prior behavior), but if
      // one IS supplied it must be a genuine integer — mirroring the sibling
      // validation in game-play.ts's generateNumberChallengeResult. Without
      // this, a fractional/NaN/Infinity guess reaches evaluateGuess() and
      // produces a fractional/NaN `away`, which then flows into an Int
      // increment on CompetitionParticipant.score and either corrupts the
      // column or throws mid-transaction after other work has run.
      const rawGuess = clientData?.guess;
      let guess = 50;
      if (rawGuess !== undefined && rawGuess !== null) {
        if (typeof rawGuess !== 'number' || !Number.isInteger(rawGuess)) {
          throw ApiError.badRequest('Guess must be an integer');
        }
        guess = rawGuess;
      }
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
      // CompetitionParticipant.score is a Prisma Int. game-catalog.ts's spin
      // multipliers include fractional values (e.g. SMALL_WIN = 1.5), which is
      // fine for the normal wallet-reward path (calculateGameReward() already
      // floors betAmount * multiplier there) but was never floored on THIS
      // path — an outcome like 1.5 would attempt a fractional Int increment,
      // throwing mid-transaction and effectively granting a free reroll
      // (the play is never consumed) that skews the score distribution.
      // game-catalog.ts's multipliers are intentionally left untouched — this
      // is the smallest correct point to normalize the value for scoring.
      const score = Math.floor(outcome.multiplier);
      return {
        score,
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
    if (comp.scoring !== 'TRIVIA_CORRECT') throw ApiError.badRequest('Invalid scoring');
    return playTriviaCompetitionRound(userId, comp, participant, clientData);
  }

  // Server-computed BEFORE the transaction, from CSPRNG game logic — clientData
  // can influence a guess/choice but never the score or correctness. Nothing
  // here reads client-supplied score/reward/result fields.
  const { score, result } = computeScore(comp.scoring as string, comp.game.type, config, clientData);

  const outcome = await prisma.$transaction(async (tx) => {
    // ── LOCK the competition row FIRST ────────────────────────────
    // A plain re-read of comp.status here would be a non-locking SELECT: under
    // READ COMMITTED it does not block on a concurrent finalize/cancel/update
    // claim that is mid-flight (locked but not yet committed), so it could
    // observe stale "still playable" state and let a score land after the
    // competition has already been paid out or refunded. SELECT ... FOR UPDATE
    // takes a genuine row lock: if finalize/cancel/update currently holds this
    // row (their own claim `updateMany` calls lock it first, before touching
    // participants — the same ordering used here), this blocks until they
    // commit or roll back, and then reads their COMMITTED result. Every
    // lifecycle claim in this file locks group_competitions before ever
    // touching competition_participants, so this ordering cannot deadlock
    // against them.
    const rows = await tx.$queryRaw<
      { status: string; finalizedAt: Date | null; startsAt: Date; endsAt: Date }[]
    >`SELECT status, "finalizedAt", "startsAt", "endsAt" FROM "group_competitions" WHERE id = ${competitionId} FOR UPDATE`;
    const locked = rows[0];
    if (!locked) throw ApiError.notFound('Competition not found');
    if (locked.finalizedAt || (locked.status !== 'ACTIVE' && locked.status !== 'SCHEDULED')) {
      throw ApiError.badRequest('Competition is not playable');
    }
    const lockedNow = new Date();
    if (lockedNow < locked.startsAt) throw ApiError.badRequest('Competition has not started yet');
    if (lockedNow > locked.endsAt) throw ApiError.badRequest('Competition has ended');

    // ── ATOMIC PLAY-COUNT GATE + SCORE MUTATION ───────────────────
    // The cap check and the increment are the SAME statement: a client cannot
    // forge gamesPlayed/score to bypass the cap (both are always server-side
    // increments off the DB's current value, never client input), and two
    // concurrent requests at gamesPlayed = MAX-1 cannot both pass — the
    // competition row lock above already serializes them against each other
    // (both transactions contend for the same lock before reaching this
    // statement), so at most one is ever executing this UPDATE at a time.
    const claim = await tx.competitionParticipant.updateMany({
      where: {
        competitionId,
        userId,
        gamesPlayed: { lt: MAX_NON_TRIVIA_PLAYS_PER_COMPETITION },
      },
      data: { score: { increment: score }, gamesPlayed: { increment: 1 } },
    });
    if (claim.count === 0) {
      throw ApiError.badRequest(
        `You have reached the maximum of ${MAX_NON_TRIVIA_PLAYS_PER_COMPETITION} plays for this competition`
      );
    }

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

    const updatedParticipant = await tx.competitionParticipant.findUnique({
      where: { competitionId_userId: { competitionId, userId } },
      select: { score: true, gamesPlayed: true },
    });
    if (!updatedParticipant) throw ApiError.notFound('Participant not found');
    return updatedParticipant;
  });

  return {
    score,
    result,
    accumulatedScore: outcome.score,
    gamesPlayed: outcome.gamesPlayed,
  };
}

/**
 * Two-phase, server-authoritative trivia competition round.
 *
 * Phase 1 — no `answerIndex` in clientData: serve a random active trivia
 * question the user has NOT yet answered in this competition. The served
 * question NEVER includes `correctIndex`. No database writes, no score
 * change — this only reveals the question.
 *
 * Phase 2 — `questionId` + `answerIndex` in clientData: the server verifies
 * the question against the database, records the attempt, and increments the
 * score atomically. The unique constraint on
 * CompetitionTriviaAttempt (userId, competitionId, questionId) is the
 * authoritative anti-replay guard: each question can be scored at most once
 * per user per competition, so repeated submissions cannot farm score.
 */
async function playTriviaCompetitionRound(
  userId: string,
  comp: { id: string; gameId: string; entryAmount: number },
  participant: { score: number; gamesPlayed: number },
  clientData?: Record<string, unknown>
) {
  const answerIndex = clientData?.answerIndex as number | undefined;
  const questionId = clientData?.questionId as string | undefined;

  // ── Phase 1: serve a question (no answer submitted yet) ────────
  if (answerIndex === undefined || answerIndex === null) {
    // Exclude questions already answered by this user in this competition.
    const attempted = await prisma.competitionTriviaAttempt.findMany({
      where: { userId, competitionId: comp.id },
      select: { questionId: true },
    });
    const attemptedIds = attempted.map((a) => a.questionId);

    const candidateCount = await prisma.triviaQuestion.count({
      where: { isActive: true, id: { notIn: attemptedIds } },
    });
    if (candidateCount === 0) {
      throw ApiError.badRequest('You have answered all available trivia questions in this competition');
    }

    // Cryptographically-secure random selection (never deterministic first row).
    const randomSkip = secureRandomInt(0, candidateCount - 1);
    const questions = await prisma.triviaQuestion.findMany({
      where: { isActive: true, id: { notIn: attemptedIds } },
      take: 1,
      skip: randomSkip,
      select: {
        id: true,
        question: true,
        choices: true,
        category: true,
        difficulty: true,
      },
    });
    if (questions.length === 0) {
      throw ApiError.badRequest('No trivia questions available');
    }

    return {
      phase: 'question' as const,
      question: questions[0],
    };
  }

  // ── Phase 2: score an answer submission ────────────────────────
  if (typeof questionId !== 'string' || questionId.length === 0) {
    throw ApiError.badRequest('Question ID is required');
  }
  if (!Number.isInteger(answerIndex)) {
    throw ApiError.badRequest('Answer index must be an integer');
  }

  const q = await prisma.triviaQuestion.findUnique({ where: { id: questionId } });
  if (!q || !q.isActive) throw ApiError.badRequest('Invalid question');

  // Correctness is ALWAYS evaluated server-side against the database —
  // the client can never assert correctness or score.
  const correct = answerIndex === q.correctIndex;
  const score = correct ? 1000 : 0;
  const result = { questionId: q.id, answerIndex, correct };

  await prisma.$transaction(async (tx) => {
    // ── LOCK the competition row FIRST ────────────────────────────
    // Identical discipline to playCompetition's non-trivia path above, and
    // for the identical reason. Every check performed before this
    // transaction (status, finalizedAt, startsAt/endsAt) came from a plain,
    // unlocked read taken by the caller; a concurrent finalizeCompetition
    // could claim and pay out the competition in between. Without this lock
    // the scoring below would still run, mutating CompetitionParticipant
    // score/gamesPlayed and consuming a trivia question AFTER the
    // competition reached its terminal state — leaving the stored
    // leaderboard permanently inconsistent with the leaderboard that was
    // actually paid out.
    //
    // SELECT ... FOR UPDATE blocks until any in-flight finalize/cancel
    // commits, then reads their COMMITTED result and rejects the play.
    // finalizeCompetition/cancelCompetition/updateCompetition all claim
    // group_competitions before touching competition_participants, so this
    // ordering matches theirs and cannot deadlock.
    const lockedRows = await tx.$queryRaw<
      { status: string; finalizedAt: Date | null; startsAt: Date; endsAt: Date }[]
    >`SELECT status, "finalizedAt", "startsAt", "endsAt" FROM "group_competitions" WHERE id = ${comp.id} FOR UPDATE`;
    const locked = lockedRows[0];
    if (!locked) throw ApiError.notFound('Competition not found');
    if (locked.finalizedAt || (locked.status !== 'ACTIVE' && locked.status !== 'SCHEDULED')) {
      throw ApiError.badRequest('Competition is not playable');
    }
    const lockedNow = new Date();
    if (lockedNow < locked.startsAt) throw ApiError.badRequest('Competition has not started yet');
    if (lockedNow > locked.endsAt) throw ApiError.badRequest('Competition has ended');

    // Record the attempt atomically with the score increment. The unique
    // constraint (userId, competitionId, questionId) is the authoritative
    // guard — a concurrent or replayed submission gets P2002 here and the
    // whole transaction (attempt + score + session) rolls back together.
    try {
      await tx.competitionTriviaAttempt.create({
        data: { userId, competitionId: comp.id, questionId: q.id },
      });
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') {
        throw ApiError.badRequest('You have already answered this question in this competition');
      }
      throw err;
    }

    await tx.competitionParticipant.update({
      where: { competitionId_userId: { competitionId: comp.id, userId } },
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

  return {
    phase: 'answer' as const,
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

  // The funder's wallet must exist: any prize left unawarded is returned to it
  // inside the finalization transaction.
  await getOrCreateWallet(comp.createdBy);

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
      // ── ATOMIC TERMINAL-STATE CLAIM ──────────────────────────────
      // This MUST be the first statement and MUST precede every wallet
      // movement. It takes the competition row lock and transitions the
      // competition to its terminal state in a single statement, so that
      // cancel, another finalize, update, and join all serialize against it.
      //
      // Reading the status and writing it later (the previous shape) allowed a
      // concurrent cancel to refund the escrow while this transaction also paid
      // it out — minting currency. A conditional write is the only thing that
      // makes the transition mutually exclusive; wallet version locking cannot
      // do it, because the racing operations touch different wallets.
      //
      // The WHERE clause reproduces the pre-transaction eligibility rules
      // exactly: an ACTIVE competition may be finalized early, a SCHEDULED one
      // only once it has ended, and neither COMPLETED nor CANCELLED qualifies.
      const claimedAt = new Date();
      const claim = await tx.groupCompetition.updateMany({
        where: {
          id: competitionId,
          finalizedAt: null,
          OR: [
            { status: 'ACTIVE' },
            { status: 'SCHEDULED', endsAt: { lte: claimedAt } },
          ],
        },
        data: {
          status: 'COMPLETED',
          finalizedAt: claimedAt,
          finalizerId: actorId,
        },
      });

      if (claim.count === 0) {
        // Another transaction reached a terminal state first (or the
        // competition is not yet finalizable). Perform NO economic operation.
        const existing = await tx.groupCompetition.findUnique({ where: { id: competitionId } });
        if (!existing) throw ApiError.notFound('Competition not found');
        if (existing.status === 'COMPLETED' && existing.finalizedAt) {
          return {
            id: existing.id,
            status: existing.status,
            result: existing.result,
            alreadyFinalized: true,
            winnerIds: [],
          };
        }
        if (existing.status === 'CANCELLED') throw ApiError.badRequest('Competition is cancelled');
        throw ApiError.badRequest('Competition has not ended');
      }

      // The terminal transition now belongs exclusively to this transaction:
      // the row is locked, so the prize amounts read below cannot be changed by
      // a concurrent update, and no other operation can pay or refund them.
      const fresh = await tx.groupCompetition.findUnique({ where: { id: competitionId } });
      if (!fresh) throw ApiError.notFound('Competition not found');

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

      // Only participants who ACTUALLY PLAYED are eligible for a prize.
      // Joining alone leaves score = 0 and gamesPlayed = 0, which must never
      // be rewarded — otherwise a competition could be drained by a participant
      // who never played a single round.
      //
      // Business rule: gamesPlayed > 0 is the participation requirement, NOT
      // score > 0. A player who genuinely played and scored zero (e.g. answered
      // trivia incorrectly) did participate, and among such players the
      // top-scorer — even at zero — is a legitimate winner.
      const eligible = participants.filter((p) => p.gamesPlayed > 0);

      const topScore = eligible[0]?.score;
      const winners =
        topScore === undefined ? [] : eligible.filter((p) => p.score === topScore);
      const winnerIds = winners.map((w) => w.userId);

      // Track what the winners are ENTITLED to, so any unallocated remainder
      // (no eligible winner at all, or the floor-division remainder of a tie
      // split) can be returned to the funder instead of being stranded.
      let allocatedGP = 0;
      let allocatedCoins = 0;

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
          // Already paid in a previous attempt: still counts against the
          // escrow, so it must not be refunded to the funder a second time.
          if (alreadyClaimed) {
            allocatedGP += perGP;
            allocatedCoins += perCoins;
            continue;
          }

          if (perGP > 0) {
            await applyBalanceChanges(tx, w.userId, [
              {
                currency: 'GAME_POINTS',
                amount: perGP,
                ledgerType: 'CREDIT',
                transactionType: 'GAME_POINT_CREDIT',
                referenceType: 'REWARD',
                referenceId: competitionId,
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
                referenceId: competitionId,
                description: `Competition reward: ${fresh.title}`,
              },
            ]);
          }

          allocatedGP += perGP;
          allocatedCoins += perCoins;

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

      // Return whatever the winners were not entitled to. This is what makes
      // the zero-play case economically inert: with no eligible winner the
      // entire escrowed prize goes back to the funder, so the original
      // "mint currency by finalizing my own empty competition" attack now
      // nets exactly zero instead of creating value from nothing.
      const unpaidGP = fresh.rewardGamePoints - allocatedGP;
      const unpaidCoins = fresh.rewardCoins - allocatedCoins;
      const refund = prizeEscrowChanges(
        unpaidGP,
        unpaidCoins,
        'CREDIT',
        competitionId,
        `Competition prize unawarded — escrow refund: ${fresh.title}`
      );
      if (refund.length > 0) {
        await applyBalanceChanges(tx, fresh.createdBy, refund);
      }

      // Status/finalizedAt/finalizerId were already written by the claim above;
      // only the computed leaderboard remains to be persisted.
      await tx.groupCompetition.update({
        where: { id: competitionId },
        data: { result },
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

      return { id: competitionId, status: 'COMPLETED', result, alreadyFinalized: false, winnerIds };
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
