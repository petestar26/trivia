import { randomInt } from 'crypto';

// ─── Crypto-Secure Randomness ──────────────────────────────────
// All game outcomes use Node.js crypto.randomInt (CSPRNG).
// Math.random() is NEVER used for game outcomes.

function secureRandomInt(min: number, max: number): number {
  return randomInt(min, max + 1);
}

// ─── Lucky Spin ────────────────────────────────────────────────

export interface LuckySpinOutcome {
  name: string;
  multiplier: number;
  probability: number;
}

export interface LuckySpinConfig {
  outcomes: LuckySpinOutcome[];
}

export interface LuckySpinResult {
  name: string;
  multiplier: number;
  index: number;
}

const DEFAULT_LUCKY_SPIN_CONFIG: LuckySpinConfig = {
  outcomes: [
    { name: 'LOSE', multiplier: 0, probability: 0.45 },
    { name: 'SMALL_WIN', multiplier: 1.5, probability: 0.25 },
    { name: 'MEDIUM_WIN', multiplier: 3, probability: 0.15 },
    { name: 'LARGE_WIN', multiplier: 5, probability: 0.10 },
    { name: 'JACKPOT', multiplier: 10, probability: 0.05 },
  ],
};

function weightedRandomIndex(config: LuckySpinConfig): number {
  const totalWeight = config.outcomes.reduce((s, o) => s + o.probability, 0);
  const r = secureRandomInt(0, 10000) / 10000 * totalWeight;
  let cumulative = 0;
  for (let i = 0; i < config.outcomes.length; i++) {
    cumulative += config.outcomes[i].probability;
    if (r <= cumulative) return i;
  }
  return config.outcomes.length - 1;
}

function pickLuckySpinOutcome(overrides?: Partial<LuckySpinConfig>): {
  outcome: LuckySpinResult;
  rewardAmount: number;
} {
  const config = { ...DEFAULT_LUCKY_SPIN_CONFIG, ...overrides };
  const index = secureRandomInt(0, config.outcomes.length - 1);
  const outcome = config.outcomes[index];
  return {
    outcome: {
      name: outcome.name,
      multiplier: outcome.multiplier,
      index,
    },
    rewardAmount: 0, // set by caller based on bet * multiplier
  };
}

// ─── Dice ──────────────────────────────────────────────────────

function rollDice(): { die1: number; die2: number; sum: number } {
  const die1 = secureRandomInt(1, 6);
  const die2 = secureRandomInt(1, 6);
  return { die1, die2, sum: die1 + die2 };
}

// ─── Number Challenge ──────────────────────────────────────────

function generateTarget(min: number = 1, max: number = 100): number {
  return secureRandomInt(min, max);
}

function evaluateGuess(guess: number, target: number): {
  correct: boolean;
  away: number;
} {
  const away = Math.abs(guess - target);
  return { correct: away === 0, away };
}

// ─── Trivia ────────────────────────────────────────────────────

function checkTriviaAnswer(
  submittedIndex: number,
  correctIndex: number
): { correct: boolean } {
  return { correct: submittedIndex === correctIndex };
}

// ─── Reward Calculator ─────────────────────────────────────────

function calculateGameReward(
  betAmount: number,
  multiplier: number
): { rewardAmount: number; isWin: boolean } {
  const rewardAmount = Math.floor(betAmount * multiplier);
  return {
    rewardAmount,
    isWin: rewardAmount > 0,
  };
}

// ─── Exports ───────────────────────────────────────────────────

export {
  pickLuckySpinOutcome,
  rollDice,
  generateTarget,
  evaluateGuess,
  checkTriviaAnswer,
  calculateGameReward,
  DEFAULT_LUCKY_SPIN_CONFIG,
  secureRandomInt,
};
