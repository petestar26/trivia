import { TOGETHER_FOOTBALL_FIXTURES, type TogetherGame } from './play-together.js';
import { scoreWeights } from './virtual-football/model.js';

export interface TogetherGameGuide {
  selectionLabel: string;
  mechanics: readonly string[];
  tieRule: string;
  choiceNote: string;
  choices?: readonly { value: number; label: string }[];
  predictionLabels?: readonly string[];
  fixtureNotes?: readonly string[];
}

/** Display probabilities come from the same finite score model used by the draw.
 * They describe a match outcome, never a player's chance of winning the pool. */
export const TOGETHER_FOOTBALL_CHANCES = TOGETHER_FOOTBALL_FIXTURES.map((params, index) => {
  const cells = scoreWeights(params);
  const total = cells.reduce((sum, cell) => sum + cell.weight, 0n);
  const weights = [0n, 0n, 0n];
  for (const cell of cells) weights[cell.h > cell.a ? 0 : cell.h === cell.a ? 1 : 2] += cell.weight;
  const percentages = weights.map((weight) => Number((weight * 1000n + total / 2n) / total) / 10);
  return {
    match: index + 1,
    home: percentages[0],
    draw: percentages[1],
    away: percentages[2],
  };
});

/** Exact survival percentage for the published capped integer crash distribution.
 * This is not the probability of beating the other confirmed targets. */
export function togetherCrashSurvivalPercent(target: number): number {
  if (!Number.isInteger(target) || target < 101 || target > 2000)
    throw new RangeError('Choose an exit target from 1.01× to 20×');
  return Math.floor(100_000_000 / (target + 1)) / 10_000;
}

const sharedTies =
  'Tied leaders share the pool after the published fee. If everyone ties or nobody scores, every entry is returned without a fee.';
const raceMechanics = [
  'Choose one of eight runners before confirming. Each runner has the same chance of every finishing position.',
  'The best finish among the runners your group selected wins. The overall race winner does not have to be selected.',
] as const;
const raceTieRule =
  'Players who picked the best selected runner share the prize. If everyone picked the same runner, every entry is returned without a fee.';
const crashMechanics = [
  'Choose a target before confirming. It must be strictly below the shared crash point to qualify; an exact match loses.',
  'The highest qualifying target wins. Targets are scores, not payout multipliers. There is no live cash-out button.',
] as const;
const crashChoiceNote =
  'Higher targets are less likely to survive, but beat lower surviving targets. Your chance of winning also depends on the other players’ targets.';

export const TOGETHER_GAME_GUIDES: Record<TogetherGame, TogetherGameGuide> = {
  spin_win: {
    selectionLabel: 'Your wheel entry',
    mechanics: [
      'Each confirmed player receives one equal wheel segment. One shared spin selects a segment.',
      'Your place in the list and the time you joined do not improve your chance.',
    ],
    tieRule: 'There is one winner when the minimum number of players is met.',
    choiceNote: 'Every confirmed entry has the same chance of winning.',
  },
  turbo_keno: {
    selectionLabel: 'Choose five different numbers',
    mechanics: [
      'Pick five numbers from 1–80. The shared draw contains 20 different balls.',
      'The player with the most matches wins. The order you picked your numbers does not matter.',
    ],
    tieRule: sharedTies,
    choiceNote:
      'Every five-number ticket has the same match distribution. Overlapping tickets can tie.',
  },
  dice: {
    selectionLabel: 'Your dice entry',
    mechanics: [
      'Two fair dice are rolled for each confirmed player. The highest sum wins.',
      'No player chooses or changes a roll.',
    ],
    tieRule: sharedTies,
    choiceNote: 'Each player has the same roll distribution; shared top scores are possible.',
  },
  number_challenge: {
    selectionLabel: 'Choose your number from 1–100',
    mechanics: [
      'Everyone predicts the same uniformly drawn target from 1–100.',
      'The smallest distance to that target wins. A target exactly between two guesses ties them.',
    ],
    tieRule: sharedTies,
    choiceNote: 'Your chance of winning depends on the positions of all confirmed guesses.',
  },
  roulette_keno: {
    selectionLabel: 'Choose five different numbers',
    mechanics: [
      'Pick five numbers from 1–72. The shared draw contains 18 different balls.',
      'The player with the most matches wins. This is a number-draw contest; there are no roulette table bets.',
    ],
    tieRule: sharedTies,
    choiceNote:
      'Every five-number ticket has the same match distribution. Overlapping tickets can tie.',
  },
  lucky_six: {
    selectionLabel: 'Choose six different numbers',
    mechanics: [
      'Pick six numbers from 1–48. Up to 35 different balls are drawn in a shared order.',
      'Completing all six first wins. If no ticket completes, the most matched numbers wins.',
    ],
    tieRule: sharedTies,
    choiceNote:
      'Every six-number ticket has the same draw distribution. Equal completion positions or match counts can tie.',
  },
  thunder_derby_3d: {
    selectionLabel: 'Choose your runner',
    mechanics: raceMechanics,
    tieRule: raceTieRule,
    choiceNote:
      'All eight runners are equally likely. Picking a popular runner can mean sharing the prize.',
  },
  neon_hounds_3d: {
    selectionLabel: 'Choose your dog',
    mechanics: [
      'Choose one of eight dogs before confirming. Each dog has the same chance of every finishing position.',
      'The best finish among the dogs your group selected wins. The overall race winner does not have to be selected.',
    ],
    tieRule: raceTieRule.replaceAll('runner', 'dog'),
    choiceNote:
      'All eight dogs are equally likely. Picking a popular dog can mean sharing the prize.',
  },
  virtual_football_3d: {
    selectionLabel: 'Predict all three matches',
    mechanics: [
      'Predict home win, draw or away win in each of three simulated matches. Each correct prediction scores one point.',
      'These are simulated fixtures, not real sporting events. The highest total score wins.',
    ],
    tieRule: sharedTies,
    choiceNote:
      'The fixtures have different outcome probabilities. The model probabilities below describe each match, not your chance of winning the group prize.',
    choices: [
      { value: 0, label: 'Home win' },
      { value: 1, label: 'Draw' },
      { value: 2, label: 'Away win' },
    ],
    predictionLabels: ['Simulated match 1', 'Simulated match 2', 'Simulated match 3'],
    fixtureNotes: TOGETHER_FOOTBALL_CHANCES.map(
      (p) =>
        `Match ${p.match}: home ${p.home.toFixed(1)}% · draw ${p.draw.toFixed(1)}% · away ${p.away.toFixed(1)}%. Rounded model probabilities.`
    ),
  },
  blackjack: {
    selectionLabel: 'Predict all six hands',
    mechanics: [
      'Predict Win, Draw or Lose for each of six shared player hands against one dealer. Each correct prediction scores one point.',
      'A six-deck shoe is dealt without replacement. Every hand draws automatically below 17 and stands at 17 or above, including soft 17.',
      'A player bust loses even if the dealer also busts. A two-card blackjack beats other 21s. You do not hit, stand, split or double.',
    ],
    tieRule: sharedTies,
    choiceNote:
      'Win, Draw and Lose are not equally likely. The six hands share a dealer and shoe, so their outcomes are related. The prize is based on your prediction score.',
    choices: [
      { value: 0, label: 'Win' },
      { value: 1, label: 'Draw' },
      { value: 2, label: 'Lose' },
    ],
    predictionLabels: Array.from({ length: 6 }, (_, i) => `Hand ${i + 1} vs dealer`),
  },
  sky_crash: {
    selectionLabel: 'Choose your automatic exit target',
    mechanics: crashMechanics,
    tieRule: sharedTies,
    choiceNote: crashChoiceNote,
  },
  crash_point: {
    selectionLabel: 'Choose your automatic exit target',
    mechanics: crashMechanics,
    tieRule: sharedTies,
    choiceNote: crashChoiceNote,
  },
};

export function togetherGameGuide(game: TogetherGame): TogetherGameGuide {
  const guide = TOGETHER_GAME_GUIDES[game];
  if (!guide) throw new RangeError('This group game is unavailable');
  return guide;
}
