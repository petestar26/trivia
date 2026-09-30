import { parseSpin90Bets, settleSpin90Bets, SPIN90_RULES_ID } from '@socialplay/shared';
import { assertExactHouseReturn } from './house-risk.js';
import type { HouseTicket, OutcomeModel } from './house-risk.js';
import { units } from './money.js';

export const DICE_90_DRAFT = 'dice-sum7-rtp90-draft-v1';
export const NUMBER_90_DRAFT = 'number-exact100-rtp90-draft-v1';

/** Explicit product proposals, not inferred rules for the empty catalog configs. */
export const DRAW_PROPOSALS = [
  { key: 'thunder_derby_3d', choices: 6, drawCount: 1, step: 5n, payoutPerStep: 27n },
  { key: 'neon_hounds_3d', choices: 6, drawCount: 1, step: 5n, payoutPerStep: 27n },
  { key: 'turbo_circuit_3d', choices: 6, drawCount: 1, step: 5n, payoutPerStep: 27n },
  { key: 'jungle_dash_3d', choices: 6, drawCount: 1, step: 5n, payoutPerStep: 27n },
  { key: 'strait_rush', choices: 6, drawCount: 1, step: 5n, payoutPerStep: 27n },
  { key: 'starfall_nebula', choices: 12, drawCount: 1, step: 5n, payoutPerStep: 54n },
  { key: 'crystal_trail', choices: 8, drawCount: 1, step: 5n, payoutPerStep: 36n },
  { key: 'heat_vault', choices: 20, drawCount: 1, step: 1n, payoutPerStep: 18n },
  { key: 'turbo_keno', choices: 80, drawCount: 20, step: 5n, payoutPerStep: 18n },
] as const;

export function draftDrawRulesId(gameKey: string) {
  if (!DRAW_PROPOSALS.some((game) => game.key === gameKey)) throw new RangeError('Unknown draw proposal');
  return `${gameKey}-uniform-rtp90-draft-v1`;
}

/** Proposals are deliberately NOT the IDs of any active legacy rules. */
export function buildHouseModel(gameKey: string, rulesId: string): OutcomeModel {
  let outcomes: string[];
  let drawCount = 1;
  if (gameKey === 'spin_win' && rulesId === SPIN90_RULES_ID) {
    outcomes = Array.from({ length: 37 }, (_, index) => String(index));
  } else if (gameKey === 'dice' && rulesId === DICE_90_DRAFT) {
    outcomes = Array.from({ length: 36 }, (_, index) => `${Math.floor(index / 6) + 1}:${index % 6 + 1}`);
  } else if (gameKey === 'number_challenge' && rulesId === NUMBER_90_DRAFT) {
    outcomes = Array.from({ length: 100 }, (_, index) => String(index + 1));
  } else {
    const proposal = DRAW_PROPOSALS.find((game) => game.key === gameKey);
    if (!proposal || rulesId !== draftDrawRulesId(gameKey)) {
      throw new RangeError('No supported payout model for this game/rules pair');
    }
    outcomes = Array.from({ length: proposal.choices }, (_, index) => String(index + 1));
    drawCount = proposal.drawCount;
  }
  return { gameKey, rulesId, outcomes, weights: outcomes.map(() => 1n), drawCount };
}

/**
 * Winner-only race/draw proposals. Keno is single-number lines, each winning
 * once if included in a uniform 20-of-80 draw; no unpriced match-count tiers.
 */
export function quoteDraftDrawTicket(gameKey: string, lines: readonly { choice: number; stake: bigint }[]) {
  const proposal = DRAW_PROPOSALS.find((game) => game.key === gameKey);
  if (!proposal) throw new RangeError('Unknown draw proposal');
  if (!Array.isArray(lines) || lines.length === 0 || lines.length > proposal.choices) throw new RangeError('Invalid lines');
  const choices = new Set<number>();
  const model = buildHouseModel(gameKey, draftDrawRulesId(gameKey));
  const payouts = model.outcomes.map(() => 0n);
  let stake = 0n;
  for (const line of lines) {
    units(line.stake, 'Line stake', true);
    if (!Number.isInteger(line.choice) || line.choice < 1 || line.choice > proposal.choices ||
        choices.has(line.choice) || line.stake % proposal.step !== 0n) {
      throw new RangeError('Invalid choice, duplicate choice or stake step');
    }
    choices.add(line.choice);
    stake = units(stake + line.stake, 'Ticket stake');
    payouts[line.choice - 1] = units(line.stake / proposal.step * proposal.payoutPerStep, 'Line payout');
  }
  const ticket = { gameKey, rulesId: model.rulesId, stake, payouts };
  assertExactHouseReturn(model, ticket);
  return { model, ticket };
}

export function quoteSpin90Ticket(selections: unknown): { model: OutcomeModel; ticket: HouseTicket } {
  const bets = parseSpin90Bets(selections);
  const model = buildHouseModel('spin_win', SPIN90_RULES_ID);
  const stake = BigInt(bets.reduce((sum, bet) => sum + bet.amount, 0));
  const payouts = model.outcomes.map((number) => BigInt(settleSpin90Bets(bets, Number(number)).payout));
  const ticket = { gameKey: model.gameKey, rulesId: model.rulesId, stake, payouts };
  assertExactHouseReturn(model, ticket);
  return { model, ticket };
}

/** 21 winning elementary outcomes / 36; a 35-unit stake returns 54 on a win. */
export function quoteDice90Ticket(stake: bigint): { model: OutcomeModel; ticket: HouseTicket } {
  units(stake, 'Stake', true);
  if (stake % 35n !== 0n) throw new RangeError('Draft Dice stake must be a multiple of 35');
  const model = buildHouseModel('dice', DICE_90_DRAFT);
  const payouts = model.outcomes.map((pair) => {
    const [first, second] = pair.split(':').map(Number);
    return first + second >= 7 ? stake / 35n * 54n : 0n;
  });
  const ticket = { gameKey: model.gameKey, rulesId: model.rulesId, stake, payouts };
  assertExactHouseReturn(model, ticket);
  return { model, ticket };
}

/** New exact-match proposal; NEVER applied to the historical proximity rules. */
export function quoteNumber90Ticket(stake: bigint, guess: number): { model: OutcomeModel; ticket: HouseTicket } {
  units(stake, 'Stake', true);
  if (!Number.isInteger(guess) || guess < 1 || guess > 100) throw new RangeError('Guess must be 1–100');
  const model = buildHouseModel('number_challenge', NUMBER_90_DRAFT);
  const payouts = model.outcomes.map((number) => Number(number) === guess ? stake * 90n : 0n);
  const ticket = { gameKey: model.gameKey, rulesId: model.rulesId, stake, payouts };
  assertExactHouseReturn(model, ticket);
  return { model, ticket };
}
