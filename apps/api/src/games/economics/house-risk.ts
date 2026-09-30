import { BPS, HOUSE_RTP_BPS } from './policy.js';
import { identifier, total, units } from './money.js';

/** Canonical elementary outcomes with exact integer probability weights. */
export interface OutcomeModel {
  gameKey: string;
  rulesId: string;
  outcomes: readonly string[];
  weights: readonly bigint[];
  /** Uniform without-replacement draw; payouts are additive for each hit. */
  drawCount?: number;
}
export interface HouseBook {
  model: OutcomeModel;
  stake: bigint;
  payouts: readonly bigint[];
}
export interface HouseTicket {
  gameKey: string;
  rulesId: string;
  stake: bigint;
  payouts: readonly bigint[];
}
export interface HouseLimits {
  /** Operator capital AFTER player balances, withdrawals and operating buffers. */
  backedCapital: bigint;
  otherRoundLossReserves: bigint;
  maxRoundLoss: bigint;
  maxRoundPayout: bigint;
  maxTicketStake: bigint;
  maxUserRoundStake: bigint;
}

function validateModel(model: OutcomeModel): void {
  identifier(model.gameKey, 'Game key');
  identifier(model.rulesId, 'Rules ID');
  if (!Array.isArray(model.outcomes) || model.outcomes.length < 2 || model.outcomes.length > 10_000 ||
      new Set(model.outcomes).size !== model.outcomes.length ||
      !Array.isArray(model.weights) || model.weights.length !== model.outcomes.length) {
    throw new RangeError('Invalid outcome model');
  }
  model.outcomes.forEach((value) => identifier(value, 'Outcome'));
  model.weights.forEach((weight) => units(weight, 'Outcome weight', true));
  total(model.weights, 'Total outcome weight');
  const drawCount = model.drawCount ?? 1;
  if (!Number.isSafeInteger(drawCount) || drawCount < 1 || drawCount >= model.outcomes.length ||
      (drawCount > 1 && model.weights.some((weight) => weight !== 1n))) {
    throw new RangeError('Multiple draws require uniform distinct outcomes');
  }
}

/** A proof for a ticket, not an estimate from random simulations. */
export function assertExactHouseReturn(model: OutcomeModel, ticket: HouseTicket): void {
  validateModel(model);
  units(ticket.stake, 'Stake', true);
  if (ticket.gameKey !== model.gameKey || ticket.rulesId !== model.rulesId) {
    throw new RangeError('Ticket does not match pinned model');
  }
  if (!Array.isArray(ticket.payouts) || ticket.payouts.length !== model.outcomes.length) {
    throw new RangeError('Incomplete payout vector');
  }
  ticket.payouts.forEach((payout) => units(payout, 'Payout'));
  const weightedPayout = ticket.payouts.reduce((sum, payout, index) => sum + payout * model.weights[index], 0n);
  const target = ticket.stake * total(model.weights, 'Weights') * HOUSE_RTP_BPS;
  if (weightedPayout * BigInt(model.drawCount ?? 1) * BPS !== target) {
    throw new RangeError('Ticket does not have exact 90% theoretical return');
  }
}

export function emptyHouseBook(model: OutcomeModel): HouseBook {
  validateModel(model);
  return { model: { ...model, outcomes: [...model.outcomes], weights: [...model.weights] },
    stake: 0n, payouts: model.outcomes.map(() => 0n) };
}

/**
 * Pure admission calculation. A live adapter MUST hold one treasury lock and
 * its round lock while loading, checking and persisting ALL reservations and
 * the provenance-preserving stake hold. Never accept against a stale quote.
 * Outcome generation must not receive this book or its limits.
 */
export function quoteHouseAdmission(
  book: HouseBook, ticket: HouseTicket, limits: HouseLimits, userRoundStake: bigint,
) {
  assertExactHouseReturn(book.model, ticket);
  units(book.stake, 'Existing stake');
  if (!Array.isArray(book.payouts) || book.payouts.length !== book.model.outcomes.length) {
    throw new RangeError('Invalid existing payout vector');
  }
  book.payouts.forEach((payout) => units(payout, 'Existing payout'));
  // A corrupted or different-rules book must not manufacture reserve capacity.
  if (book.stake === 0n) {
    if (book.payouts.some((payout) => payout !== 0n)) throw new RangeError('Unfunded book');
  } else {
    assertExactHouseReturn(book.model, { ...book.model, stake: book.stake, payouts: book.payouts });
  }
  units(limits.backedCapital, 'Backed capital', true);
  units(limits.otherRoundLossReserves, 'Other reserves');
  units(limits.maxRoundLoss, 'Round loss limit');
  units(limits.maxRoundPayout, 'Round payout limit', true);
  units(limits.maxTicketStake, 'Ticket stake limit', true);
  units(limits.maxUserRoundStake, 'User stake limit', true);
  units(userRoundStake, 'Existing user stake');
  if (userRoundStake > book.stake) throw new RangeError('User stake exceeds round stake');
  if (ticket.stake > limits.maxTicketStake ||
      total([userRoundStake, ticket.stake], 'User stake') > limits.maxUserRoundStake) {
    throw new RangeError('Stake limit reached');
  }
  const stake = total([book.stake, ticket.stake], 'Round stake');
  const payouts = book.payouts.map((amount, index) => total([amount, ticket.payouts[index]], 'Outcome payout'));
  // For a uniform k-of-n draw, any k distinct outcomes are reachable. Sum
  // the k largest liabilities; taking only the single largest under-reserves.
  const rankedPayouts = [...payouts].sort((a, b) => a > b ? -1 : a < b ? 1 : 0);
  const maxGrossPayout = total(rankedPayouts.slice(0, book.model.drawCount ?? 1), 'Maximum payout');
  const requiredLossReserve = maxGrossPayout > stake ? maxGrossPayout - stake : 0n;
  if (maxGrossPayout > limits.maxRoundPayout || requiredLossReserve > limits.maxRoundLoss ||
      total([limits.otherRoundLossReserves, requiredLossReserve], 'Committed capital') > limits.backedCapital) {
    throw new RangeError('House exposure limit reached');
  }
  return {
    book: { model: book.model, stake, payouts }, requiredLossReserve, maxGrossPayout,
    /** Stakes must stay in escrow; no revenue withdrawal before settlement. */
    escrowPlusReserve: total([stake, requiredLossReserve], 'Escrow plus reserve'),
  };
}
