import { randomInt } from 'node:crypto';
import { buildHouseModel } from './models.js';
import { assertExactHouseReturn } from './house-risk.js';
import type { HouseTicket, OutcomeModel } from './house-risk.js';
import { total } from './money.js';

export interface RoundOutcome {
  gameKey: string;
  rulesId: string;
  outcomes: readonly string[];
}

/**
 * Call only after the durable round is locked and before its result is stored.
 * Takes no tickets, stakes, bankroll, user or previous-result inputs.
 * A worker retry MUST load the stored result rather than call this again.
 * Draft models are for sandbox evaluation; this is not a catalog activation.
 */
export function generateRoundOutcome(gameKey: string, rulesId: string): RoundOutcome {
  const model = buildHouseModel(gameKey, rulesId);
  // All currently registered models use equiprobable elementary outcomes.
  if (model.weights.some((weight) => weight !== 1n)) throw new RangeError('Uniform sampler cannot serve weighted rules');
  const available = [...model.outcomes];
  const selected: string[] = [];
  for (let i = 0; i < (model.drawCount ?? 1); i++) {
    const index = randomInt(available.length);
    selected.push(available[index]);
    available[index] = available[available.length - 1];
    available.pop();
  }
  return { gameKey, rulesId, outcomes: selected };
}

export function settleHouseTicket(model: OutcomeModel, ticket: HouseTicket, result: RoundOutcome) {
  assertExactHouseReturn(model, ticket);
  if (result.gameKey !== model.gameKey || result.rulesId !== model.rulesId ||
      !Array.isArray(result.outcomes) || result.outcomes.length !== (model.drawCount ?? 1) ||
      new Set(result.outcomes).size !== result.outcomes.length ||
      result.outcomes.some((outcome) => !model.outcomes.includes(outcome))) {
    throw new RangeError('Result does not match pinned round rules');
  }
  const payout = total(result.outcomes.map((outcome) => ticket.payouts[model.outcomes.indexOf(outcome)]), 'Ticket payout');
  return { stake: ticket.stake, payout, houseGrossResult: ticket.stake - payout };
}
