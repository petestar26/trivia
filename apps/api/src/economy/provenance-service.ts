import { ApiError } from '../middleware';

/**
 * Coin provenance and allocation: the layer that makes a COINS wager
 * settlement tell the truth about WHICH coins funded it, instead of the
 * wallet's single aggregate `coinsBalance` (which only ever tells you the
 * total).
 *
 * The problem this closes: a wager funded even PARTLY by restricted
 * (non-withdrawable) coins — a trivia reward, a bonus, a promo — must never
 * turn into unrestricted, withdrawable coins just because the wager won. A
 * route that debits the wallet without looking at provenance, then credits a
 * win as unconditionally UNRESTRICTED, launders restricted coins through one
 * game round.
 *
 * Every wager debit and every coin-to-coin gift goes through the SAME
 * internal allocator (`allocateFromLots`), which:
 *   1. Locks the user's eligible CoinProvenance lots FOR UPDATE, in ONE
 *      statement, in a DETERMINISTIC order (createdAt ASC, id ASC — plain
 *      chronological FIFO, irrespective of restriction status: the oldest
 *      coins are spent first, regardless of what they are). Determinism is
 *      what makes two runs of the same history allocate identically, and
 *      lets a test assert exactly which lots a stake drew from.
 *   2. Computes each lot's REMAINING balance as amount minus the sum of its
 *      own existing CoinAllocation rows — read only after the lock is held,
 *      so no concurrent allocation against the SAME lot can be missed (see
 *      "Concurrency" below).
 *   3. Draws from lots in that order until the amount is fully covered,
 *      writing one CoinAllocation per lot touched.
 *   4. Any amount left uncovered by tracked lots is treated as untracked
 *      legacy balance (see "Legacy / untracked balance" below) and covered
 *      by minting a conservative gap lot.
 *
 * `allocateWagerDebit` layers wager-specific behavior on top of that core:
 * qualifying-wager playthrough credit per lot, and a `fundedByRestricted`
 * flag the caller (game-play.ts) uses — not the game's win/loss outcome —
 * to decide whether a payout must inherit restriction. "The wager won" says
 * nothing about what funded it; only the allocation does.
 *
 * `transferProvenanceOnGift` layers gift-specific behavior on top of the
 * same core: it debits the sender's lots exactly like a wager debit, but
 * instead of recording game-session consumption it MINTS one recipient-side
 * lot per source lot touched, carrying that lot's restriction status,
 * source lineage (`originalSource`, `giftChainOriginId`/`giftChainParentId`),
 * remaining playthrough (scaled to the gifted portion) and country-policy
 * version forward. No route in this codebase currently moves COINS
 * peer-to-peer (the existing gift flow in gift-service.ts exchanges COINS
 * for GAME_POINTS, a currency conversion, not a coin transfer), so this is a
 * tested primitive ready for that route rather than a new user-facing
 * feature — see provenance-service.test.ts for the direct proof that a
 * restricted lot's restriction, lineage and remaining playthrough survive a
 * transfer.
 *
 * ── Concurrency ───────────────────────────────────────────────────────────
 * `FOR UPDATE` on the provenance rows, taken by THIS function before it
 * reads their existing allocations, serializes every concurrent allocation
 * attempt against the SAME lot: a second transaction wanting the same row
 * waits behind the first until it commits or rolls back, so the "remaining
 * balance" this function computes can never be stale by the time it writes.
 * That is the primary defense. `coin_allocations_guard` (a database trigger,
 * see the 2026*_provenance_allocation_safeguards migration) is the backstop:
 * it takes the SAME row lock and re-sums independently of any caller, so an
 * aggregate over-allocation is refused by the database even if some future
 * code path forgot to serialize correctly here.
 *
 * ── Legacy / untracked balance ──────────────────────────────────────────
 * A wallet's `coinsBalance` can exceed the sum of a user's tracked
 * provenance — coins credited before this system existed, or by some other
 * path that has not been taught to create a CoinProvenance row. Silently
 * treating that gap as spendable-and-then-unrestricted would be exactly the
 * laundering hole this file exists to close. Instead, once every tracked lot
 * is exhausted, the allocator covers the remainder by MINTING a conservative
 * CoinProvenance for the gap — `LEGACY_UNTRACKED`, RESTRICTED, with a
 * requiredPlaythrough set far beyond anything organic play can reach (see
 * LEGACY_REQUIRED_PLAYTHROUGH) — and then allocates from it exactly like any
 * other lot. This both explains the wallet balance retroactively (from this
 * point on, every coin this user holds has a provenance row) and guarantees
 * the gap can never read as unrestricted by omission: it takes an explicit
 * admin action to ever unlock it, never ordinary qualifying play. The same
 * backfill runs once, proactively, over EXISTING balances in the
 * 2026*_provenance_legacy_migration migration — this is the runtime
 * fallback for balance that reaches this path without having been backfilled
 * (or credited after the backfill ran) by some other route.
 *
 * Callers are expected to have ALREADY verified (via applyBalanceChanges,
 * the sole wallet-mutation path) that the debit the amount here corresponds
 * to is one the wallet can actually afford, before calling into this file —
 * this allocator only ever explains provenance for a debit that has already
 * happened; it does not itself decide affordability, and its legacy-lot
 * fallback exists to explain a real, already-debited balance gap, never to
 * manufacture spending power that was not there.
 */

// ─── Types ───────────────────────────────────────────────────────────────

export type Tx = any;

export interface AllocationLot {
  provenanceId: string;
  allocatedAmount: number;
  wasRestricted: boolean;
  provenanceType: string;
}

// A requiredPlaythrough value no ordinary qualifying wager stream can ever
// organically reach (Prisma Int is a 32-bit signed column; this stays well
// inside it). It exists to be an unmistakable, greppable sentinel — not a
// literal wagering target — for coins this migration could not explain, so
// they read as durably RESTRICTED until an explicit admin action says
// otherwise, never as a silently-completable bonus.
export const LEGACY_REQUIRED_PLAYTHROUGH = 2_000_000_000;

const RESTRICTED_STATUSES = new Set(['RESTRICTED', 'PLAYING_THROUGH']);

interface LockedLot {
  id: string;
  amount: number;
  restrictionStatus: string;
  provenanceType: string;
  originalSource: string | null;
  requiredPlaythrough: number;
  completedPlaythrough: number;
  countryPolicyId: string | null;
  countryPolicyVersion: number | null;
  giftChainOriginId: string | null;
}

/**
 * Lock every non-EXPIRED provenance lot for `userId`, oldest first
 * (createdAt ASC, id ASC — id as the tiebreak for rows created in the same
 * instant). ONE statement, so the lock acquisition order matches the
 * iteration order below exactly; see group-locks.ts elsewhere in this API
 * for why "lock everything you might touch, in one deterministic-order
 * statement" is what prevents two concurrent transactions from deadlocking
 * each other over the same set of rows.
 */
async function lockEligibleLots(tx: Tx, userId: string): Promise<LockedLot[]> {
  return tx.$queryRaw<LockedLot[]>`
    SELECT "id", "amount", "restrictionStatus"::text AS "restrictionStatus",
           "provenanceType"::text AS "provenanceType",
           "originalSource"::text AS "originalSource",
           "requiredPlaythrough", "completedPlaythrough",
           "countryPolicyId", "countryPolicyVersion", "giftChainOriginId"
    FROM "coin_provenance"
    WHERE "userId" = ${userId} AND "restrictionStatus" <> 'EXPIRED'
    ORDER BY "createdAt" ASC, "id" ASC
    FOR UPDATE
  `;
}

/** Sum of this lot's own existing allocations — read only AFTER the lot's row is locked. */
async function allocatedSoFar(tx: Tx, provenanceId: string): Promise<number> {
  const rows = await tx.$queryRaw<{ total: bigint | number | null }[]>`
    SELECT COALESCE(SUM("allocatedAmount"), 0) AS total
    FROM "coin_allocations"
    WHERE "provenanceId" = ${provenanceId}
  `;
  return Number(rows[0]?.total ?? 0);
}

export interface DrawnLot extends AllocationLot {
  lot: LockedLot;
  draw: number;
}

interface AllocateCoreArgs {
  tx: Tx;
  userId: string;
  amount: number;
  gameSessionId: string | null;
  policy: { id: string; version: number } | null;
  /** Called once per source lot drawn from, BEFORE the CoinAllocation row for it is written. Used for wager playthrough credit. */
  onDraw?: (lot: LockedLot, draw: number) => Promise<void>;
}

interface AllocateCoreResult {
  drawn: DrawnLot[];
  fundedByRestricted: boolean;
}

/**
 * Shared core: draw `amount` COINS from `userId`'s eligible provenance lots,
 * FIFO, writing one CoinAllocation per lot touched (and minting a
 * LEGACY_UNTRACKED gap lot for any shortfall). Used by both
 * `allocateWagerDebit` (gameSessionId set, no onDraw side effect beyond
 * playthrough credit) and `transferProvenanceOnGift` (gameSessionId null,
 * onDraw unused — the caller instead mints recipient-side lots from the
 * returned `drawn` list).
 */
async function allocateFromLots(args: AllocateCoreArgs): Promise<AllocateCoreResult> {
  const { tx, userId, amount, gameSessionId, policy, onDraw } = args;
  if (!Number.isInteger(amount) || amount <= 0) {
    throw ApiError.internal('allocateFromLots: amount must be a positive integer');
  }

  const lots = await lockEligibleLots(tx, userId);

  let remaining = amount;
  let fundedByRestricted = false;
  const drawn: DrawnLot[] = [];
  let allocationOrder = 0;

  for (const lot of lots) {
    if (remaining <= 0) break;
    const already = await allocatedSoFar(tx, lot.id);
    const free = lot.amount - already;
    if (free <= 0) continue;

    const draw = Math.min(free, remaining);
    const wasRestricted = RESTRICTED_STATUSES.has(lot.restrictionStatus);
    if (wasRestricted) fundedByRestricted = true;

    if (onDraw) await onDraw(lot, draw);

    await tx.coinAllocation.create({
      data: {
        userId,
        gameSessionId,
        provenanceId: lot.id,
        allocatedAmount: draw,
        provenanceType: lot.provenanceType,
        wasRestricted,
        allocationOrder: allocationOrder++,
      },
    });

    drawn.push({ provenanceId: lot.id, allocatedAmount: draw, wasRestricted, provenanceType: lot.provenanceType, lot, draw });
    remaining -= draw;
  }

  if (remaining > 0) {
    // Untracked (legacy, or credited by a path that never created
    // provenance) balance: mint a conservative gap lot and draw the rest
    // from it. See the "Legacy / untracked balance" note at the top of this
    // file for why this must never read as anything but RESTRICTED.
    const gapLot = await tx.coinProvenance.create({
      data: {
        userId,
        amount: remaining,
        provenanceType: 'LEGACY_UNTRACKED',
        restrictionStatus: 'RESTRICTED',
        originalSource: 'LEGACY_UNTRACKED',
        countryPolicyId: policy?.id ?? null,
        countryPolicyVersion: policy?.version ?? null,
        requiredPlaythrough: LEGACY_REQUIRED_PLAYTHROUGH,
      },
    });
    fundedByRestricted = true;

    const lockedGapLot: LockedLot = {
      id: gapLot.id,
      amount: gapLot.amount,
      restrictionStatus: 'RESTRICTED',
      provenanceType: 'LEGACY_UNTRACKED',
      originalSource: 'LEGACY_UNTRACKED',
      requiredPlaythrough: LEGACY_REQUIRED_PLAYTHROUGH,
      completedPlaythrough: 0,
      countryPolicyId: policy?.id ?? null,
      countryPolicyVersion: policy?.version ?? null,
      giftChainOriginId: null,
    };

    await tx.coinAllocation.create({
      data: {
        userId,
        gameSessionId,
        provenanceId: gapLot.id,
        allocatedAmount: remaining,
        provenanceType: 'LEGACY_UNTRACKED',
        wasRestricted: true,
        allocationOrder: allocationOrder++,
      },
    });

    drawn.push({
      provenanceId: gapLot.id,
      allocatedAmount: remaining,
      wasRestricted: true,
      provenanceType: 'LEGACY_UNTRACKED',
      lot: lockedGapLot,
      draw: remaining,
    });
    remaining = 0;
  }

  return { drawn, fundedByRestricted };
}

// ─── Qualifying wager ────────────────────────────────────────────────────

/**
 * Whether a WAGER on `gameKey` for `stake` counts toward clearing a
 * restricted lot's playthrough requirement, per the CURRENT (locked) policy.
 * A policy with no qualifying games configured, or a zero stake cap,
 * qualifies nothing — the conservative reading, since an unconfigured cap is
 * indistinguishable from "compliance has not reviewed this game yet".
 */
export function isQualifyingWager(
  policy: { qualifyingGames: unknown; maxQualifyingStake: number },
  gameKey: string,
  stake: number
): boolean {
  const games = Array.isArray(policy.qualifyingGames) ? (policy.qualifyingGames as unknown[]) : [];
  if (!games.includes(gameKey)) return false;
  if (policy.maxQualifyingStake <= 0) return false;
  return stake <= policy.maxQualifyingStake;
}

/**
 * Credit `draw` toward `lot`'s own playthrough requirement (never more than
 * the amount THIS wager actually drew from THIS lot), clamp to
 * requiredPlaythrough, and unlock the lot the moment it is fully met.
 * RESTRICTED -> PLAYING_THROUGH on the first qualifying wager that does not
 * yet clear it, PLAYING_THROUGH -> UNRESTRICTED (or RESTRICTED ->
 * UNRESTRICTED directly, for a lot small enough to clear in one wager) once
 * completedPlaythrough reaches requiredPlaythrough. The coin_provenance
 * guard trigger enforces both the upper bound and that these are the only
 * legal transitions, so a bug here fails loudly instead of corrupting a lot.
 */
async function applyPlaythroughCredit(tx: Tx, lot: LockedLot, draw: number): Promise<void> {
  const completed = Math.min(lot.completedPlaythrough + draw, lot.requiredPlaythrough);
  const cleared = completed >= lot.requiredPlaythrough;
  await tx.coinProvenance.update({
    where: { id: lot.id },
    data: {
      completedPlaythrough: completed,
      restrictionStatus: cleared ? 'UNRESTRICTED' : 'PLAYING_THROUGH',
      unlockedAt: cleared ? new Date() : undefined,
    },
  });
}

export interface AllocateWagerDebitArgs {
  tx: Tx;
  userId: string;
  amount: number;
  gameSessionId: string;
  /** True only when this wager's game and stake both fall within the active policy's qualifying rules (see `isQualifyingWager`). */
  isQualifyingWager: boolean;
  /** Only used if a LEGACY_UNTRACKED gap lot has to be minted to cover this debit. */
  policy: { id: string; version: number } | null;
}

export interface AllocateWagerDebitResult {
  lots: AllocationLot[];
  /** True the moment ANY lot drawn from was RESTRICTED or PLAYING_THROUGH at allocation time. */
  fundedByRestricted: boolean;
}

/**
 * Allocate a wager debit of `amount` COINS across the user's provenance
 * lots, crediting qualifying playthrough per restricted lot touched. Must be
 * called AFTER `applyBalanceChanges` has already debited the wallet for this
 * same amount in the same transaction — see the file-level doc on why this
 * allocator does not itself decide affordability.
 */
export async function allocateWagerDebit(args: AllocateWagerDebitArgs): Promise<AllocateWagerDebitResult> {
  const { tx, userId, amount, gameSessionId, isQualifyingWager: qualifies, policy } = args;
  const { drawn, fundedByRestricted } = await allocateFromLots({
    tx,
    userId,
    amount,
    gameSessionId,
    policy,
    onDraw: async (lot, draw) => {
      if (qualifies && RESTRICTED_STATUSES.has(lot.restrictionStatus)) {
        await applyPlaythroughCredit(tx, lot, draw);
      }
    },
  });
  return {
    lots: drawn.map(({ provenanceId, allocatedAmount, wasRestricted, provenanceType }) => ({
      provenanceId,
      allocatedAmount,
      wasRestricted,
      provenanceType,
    })),
    fundedByRestricted,
  };
}

// ─── Payout restriction ────────────────────────────────────────────────

export interface PayoutRestrictionArgs {
  tx: Tx;
  userId: string;
  walletTransactionId: string;
  amount: number;
  fundedByRestricted: boolean;
  policy: { id: string; version: number; playthroughMultiplier: number };
}

/**
 * Create the CoinProvenance for a wager's payout. Conservative by
 * construction: `fundedByRestricted` — whether ANY lot this wager drew from
 * was itself restricted — is the ONLY thing that decides the payout's
 * restriction, never the game's win/loss result. A payout funded even
 * partly by restricted coins is itself RESTRICTED, with its OWN
 * requiredPlaythrough under the CURRENT policy (never inherited from the
 * funding lots — a fresh obligation on the new amount, so a payout can never
 * end up needing LESS playthrough than an equivalent fresh bonus would).
 */
export async function createPayoutProvenance(args: PayoutRestrictionArgs): Promise<void> {
  const { tx, userId, walletTransactionId, amount, fundedByRestricted, policy } = args;
  if (fundedByRestricted) {
    await tx.coinProvenance.create({
      data: {
        userId,
        walletTransactionId,
        amount,
        provenanceType: 'GAME_WIN',
        restrictionStatus: 'RESTRICTED',
        originalSource: 'GAME_WIN',
        countryPolicyId: policy.id,
        countryPolicyVersion: policy.version,
        requiredPlaythrough: Math.round(amount * policy.playthroughMultiplier),
      },
    });
  } else {
    await tx.coinProvenance.create({
      data: {
        userId,
        walletTransactionId,
        amount,
        provenanceType: 'GAME_WIN',
        restrictionStatus: 'UNRESTRICTED',
        originalSource: 'GAME_WIN',
      },
    });
  }
}

// ─── Gift-chain transfer primitive ─────────────────────────────────────

export interface GiftTransferArgs {
  tx: Tx;
  fromUserId: string;
  toUserId: string;
  amount: number;
  /** The recipient's CREDIT WalletTransaction id this provenance attaches to. */
  walletTransactionId: string;
}

/**
 * Move `amount` COINS of provenance from `fromUserId` to `toUserId`,
 * preserving restriction status, source lineage, remaining playthrough and
 * country-policy version across the transfer. Debits the sender's lots
 * through the SAME deterministic FIFO allocator a wager uses (gameSessionId
 * null — this is not game consumption), then mints one recipient-side lot
 * per source lot touched:
 *
 *   - restrictionStatus mirrors the source lot exactly (never upgraded —
 *     a PLAYING_THROUGH lot arrives PLAYING_THROUGH, not reset to
 *     RESTRICTED and not promoted to UNRESTRICTED).
 *   - requiredPlaythrough/completedPlaythrough are rewritten as a fresh
 *     0..remaining pair, where remaining is the source lot's own
 *     OUTSTANDING requirement scaled to the gifted portion
 *     (`(requiredPlaythrough - completedPlaythrough) * draw / lot.amount`,
 *     rounded up so a fractional remainder is never silently dropped) —
 *     the recipient owes exactly what was left to clear, no more, no less.
 *   - originalSource carries the source lot's own originalSource, or its
 *     provenanceType if this is the first hop — so the lineage always
 *     traces back to the ORIGINAL grant type, not "GIFT_RECEIVED" at every
 *     hop.
 *   - giftChainOriginId is the first lot's id in the chain (propagated
 *     unchanged after the first hop); giftChainParentId is always the
 *     immediate source lot's id.
 *   - countryPolicyId/countryPolicyVersion propagate unchanged — a gift
 *     never re-prices its playthrough obligation under whatever policy
 *     happens to be active at transfer time.
 *
 * Like `allocateWagerDebit`, this must be called AFTER the wallet debit/
 * credit for this transfer (via applyBalanceChanges) has already happened
 * in the same transaction.
 */
export async function transferProvenanceOnGift(args: GiftTransferArgs): Promise<AllocationLot[]> {
  const { tx, fromUserId, toUserId, amount, walletTransactionId } = args;
  const { drawn } = await allocateFromLots({
    tx,
    userId: fromUserId,
    amount,
    gameSessionId: null,
    policy: null,
  });

  for (const { lot, draw } of drawn) {
    const isRestrictedLike = lot.restrictionStatus !== 'UNRESTRICTED';
    const outstanding = Math.max(0, lot.requiredPlaythrough - lot.completedPlaythrough);
    const scaledRemaining = isRestrictedLike ? Math.ceil((outstanding * draw) / lot.amount) : 0;

    await tx.coinProvenance.create({
      data: {
        userId: toUserId,
        walletTransactionId,
        amount: draw,
        provenanceType: 'GIFT_RECEIVED',
        restrictionStatus: lot.restrictionStatus,
        originalSource: (lot.originalSource as any) ?? lot.provenanceType,
        countryPolicyId: lot.countryPolicyId,
        countryPolicyVersion: lot.countryPolicyVersion,
        requiredPlaythrough: scaledRemaining,
        completedPlaythrough: 0,
        giftChainOriginId: lot.giftChainOriginId ?? lot.id,
        giftChainParentId: lot.id,
      },
    });
  }

  return drawn.map(({ provenanceId, allocatedAmount, wasRestricted, provenanceType }) => ({
    provenanceId,
    allocatedAmount,
    wasRestricted,
    provenanceType,
  }));
}

// ─── Withdrawable balance ───────────────────────────────────────────────

/**
 * The amount of `userId`'s coins that are actually eligible for withdrawal
 * RIGHT NOW: the sum of each UNRESTRICTED lot's own remaining (unallocated)
 * balance. This is deliberately NOT the same number as `wallet.coinsBalance`
 * — the wallet balance is the unified, visible figure a player sees and
 * spends from; this is the narrower figure a withdrawal may actually draw
 * on. A lot that is RESTRICTED, PLAYING_THROUGH or EXPIRED contributes
 * nothing here even though it is still part of the visible balance.
 */
export async function getWithdrawableBalance(tx: Tx, userId: string): Promise<number> {
  const rows = await tx.$queryRaw<{ available: bigint | number | null }[]>`
    SELECT COALESCE(SUM(
      p."amount" - COALESCE((
        SELECT SUM(a."allocatedAmount") FROM "coin_allocations" a WHERE a."provenanceId" = p."id"
      ), 0)
    ), 0) AS available
    FROM "coin_provenance" p
    WHERE p."userId" = ${userId} AND p."restrictionStatus" = 'UNRESTRICTED'
  `;
  const available = Number(rows[0]?.available ?? 0);
  return Math.max(0, available);
}

/**
 * Lock every UNRESTRICTED lot for `userId`, draw `amount` FIFO EXCLUSIVELY
 * from them (never RESTRICTED/PLAYING_THROUGH/EXPIRED lots, and never the
 * legacy-gap fallback — a withdrawal must never manufacture eligibility),
 * and record one CoinAllocation per lot touched. Throws the same
 * insufficient-withdrawable-balance error as `requireWithdrawableBalance`
 * if the combined remaining UNRESTRICTED balance cannot cover `amount`.
 *
 * This is deliberately a SEPARATE, narrower allocator from
 * `allocateFromLots` (which `allocateWagerDebit`/`transferProvenanceOnGift`
 * share): that core walks every non-EXPIRED lot in chronological order
 * regardless of restriction status, which is correct for a wager (any
 * coin can fund a wager) but would be WRONG here — a withdrawal that drew
 * from an older RESTRICTED lot before a newer UNRESTRICTED one, just
 * because the restricted lot happened to be created first, would let
 * restricted coins leave the system as if they were withdrawable. A
 * withdrawal may only ever touch UNRESTRICTED balance.
 *
 * Must be called INSIDE the same transaction that performs the
 * withdrawal's own wallet debit (via applyBalanceChanges), so nothing can
 * change between this allocation and the debit it explains — if either
 * fails, the transaction rolls back and undoes both together.
 */
export async function allocateWithdrawalDebit(tx: Tx, userId: string, amount: number): Promise<AllocationLot[]> {
  if (!Number.isInteger(amount) || amount <= 0) {
    throw ApiError.internal('allocateWithdrawalDebit: amount must be a positive integer');
  }

  const lots = (await tx.$queryRaw`
    SELECT "id", "amount", "provenanceType"::text AS "provenanceType"
    FROM "coin_provenance"
    WHERE "userId" = ${userId} AND "restrictionStatus" = 'UNRESTRICTED'
    ORDER BY "createdAt" ASC, "id" ASC
    FOR UPDATE
  `) as { id: string; amount: number; provenanceType: string }[];

  let remaining = amount;
  const drawn: AllocationLot[] = [];
  let allocationOrder = 0;

  for (const lot of lots) {
    if (remaining <= 0) break;
    const already = await allocatedSoFar(tx, lot.id);
    const free = lot.amount - already;
    if (free <= 0) continue;

    const draw = Math.min(free, remaining);
    await tx.coinAllocation.create({
      data: {
        userId,
        gameSessionId: null,
        provenanceId: lot.id,
        allocatedAmount: draw,
        provenanceType: lot.provenanceType,
        wasRestricted: false,
        allocationOrder: allocationOrder++,
      },
    });
    drawn.push({ provenanceId: lot.id, allocatedAmount: draw, wasRestricted: false, provenanceType: lot.provenanceType });
    remaining -= draw;
  }

  if (remaining > 0) {
    const available = amount - remaining;
    throw ApiError.badRequest(
      `Insufficient withdrawable Coins: ${available} eligible, ${amount} requested. Restricted Coins must complete their playthrough requirement before they can be withdrawn.`
    );
  }

  return drawn;
}

/**
 * Fail-closed guard for a withdrawal debit: locks every UNRESTRICTED lot for
 * `userId` (same statement shape as `lockEligibleLots`, scoped to
 * UNRESTRICTED so it never blocks on a lot a wager is concurrently touching
 * for playthrough) and refuses if their combined remaining balance is less
 * than `amount`. Callers must run this INSIDE the same transaction that
 * performs the withdrawal's own coin debit, so nothing can change between
 * this check and the debit it is guarding.
 */
export async function requireWithdrawableBalance(tx: Tx, userId: string, amount: number): Promise<void> {
  const rows = await tx.$queryRaw<{ id: string; amount: number }[]>`
    SELECT "id", "amount" FROM "coin_provenance"
    WHERE "userId" = ${userId} AND "restrictionStatus" = 'UNRESTRICTED'
    ORDER BY "createdAt" ASC, "id" ASC
    FOR UPDATE
  `;
  let available = 0;
  for (const lot of rows) {
    available += lot.amount - (await allocatedSoFar(tx, lot.id));
  }
  if (available < amount) {
    throw ApiError.badRequest(
      `Insufficient withdrawable Coins: ${available} eligible, ${amount} requested. Restricted Coins must complete their playthrough requirement before they can be withdrawn.`
    );
  }
}
