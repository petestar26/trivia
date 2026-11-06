// Reproducible product review. This does not use real users, wallets or a live beacon.
// Run after pnpm --filter @socialplay/shared build.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import {
  TOGETHER_GAMES,
  TOGETHER_RULES_ID,
  TOGETHER_FEE_POLICY,
  togetherSeedCommitment,
  deriveTogetherOutcome,
  rankTogether,
  settleTogether,
} from '../packages/shared/dist/play-together.js';
import { quicknetTargetForCutoff } from '../packages/shared/dist/spin-win-proof.js';
import {
  TOGETHER_FOOTBALL_CHANCES,
  togetherCrashSurvivalPercent,
} from '../packages/shared/dist/together-game-guide.js';

const countArg = process.argv.find((arg) => arg.startsWith('--samples='));
const samples = Number(countArg?.split('=')[1] ?? 10_000);
if (!Number.isInteger(samples) || samples < 100 || samples > 100_000)
  throw new Error('Use --samples=100 through --samples=100000');
const players = Number(
  process.argv.find((arg) => arg.startsWith('--players='))?.split('=')[1] ?? 4
);
if (!Number.isInteger(players) || players < 2 || players > 20)
  throw new Error('Use --players=2 through --players=20');
const hash = (value) => createHash('sha256').update(value).digest('hex');
const closesAt = 1_800_000_000_000;
const beaconRound = quicknetTargetForCutoff(closesAt).beaconRound;
const games = TOGETHER_GAMES.slice(4);
const summaries = [];
const pct = (n, d = samples) => Math.round((n / d) * 100_000) / 1000;

function selection(game, sample, player) {
  let counter = 0;
  const next = (size) => {
    const bound = Math.floor(4294967296 / size) * size;
    for (;;) {
      const value = parseInt(
        hash(`selection:v1:${game.key}:${sample}:${player}:${counter++}`).slice(0, 8),
        16
      );
      if (value < bound) return value % size;
    }
  };
  if (game.key === 'blackjack' || game.key === 'virtual_football_3d')
    return Array.from({ length: game.picks }, () => next(3));
  const picks = new Set();
  while (picks.size < game.picks) picks.add(game.min + next(game.max - game.min + 1));
  return [...picks].sort((a, b) => a - b);
}

for (const game of games) {
  let paid = 0,
    allTied = 0,
    noWinners = 0,
    sharedPrize = 0,
    identicalRefunds = 0;
  const playerReturns = Array(players).fill(0),
    playerWins = Array(players).fill(0);
  const outcomes =
    game.key === 'virtual_football_3d'
      ? Array.from({ length: 3 }, () => [0, 0, 0])
      : game.key === 'blackjack'
        ? Array.from({ length: 6 }, () => [0, 0, 0])
        : null;
  let fees = 0;
  for (let sample = 0; sample < samples; sample++) {
    const id = `balance-v1-${game.key}-${sample}`;
    const seed = hash(`seed:${id}`);
    const terms = {
      id,
      groupId: 'synthetic-balance-only',
      game: game.key,
      currency: 'GAME_POINTS',
      entryAmount: 1000,
      feeBps: 700,
      settingsVersion: 1,
      minPlayers: 2,
      maxPlayers: 20,
      closesAt,
      rulesId: TOGETHER_RULES_ID,
      feePolicy: TOGETHER_FEE_POLICY,
      seedCommitment: togetherSeedCommitment(id, seed),
      beaconRound,
    };
    const tickets = playerReturns.map((_, player) => ({
      id: `entry-${player}`,
      userId: `synthetic-${player}`,
      selection: selection(game, sample, player),
    }));
    const proof = {
      seed,
      beacon: {
        round: beaconRound,
        signature: 'synthetic-not-a-signed-proof',
        randomness: hash(`beacon:${id}`),
      },
    };
    const outcome = deriveTogetherOutcome(terms, tickets, proof);
    const ranks = rankTogether(game.key, tickets, outcome);
    const result = settleTogether(1000, 700, ranks, id);
    if (
      result.payouts.reduce((sum, payout) => sum + payout.amount, 0) + result.platformFee !==
      players * 1000
    )
      throw new Error('Pool conservation failed');
    fees += result.platformFee;
    if (!result.refunds) paid++;
    if (result.reason === 'ALL_TIED') allTied++;
    if (result.reason === 'NO_WINNERS') noWinners++;
    if (result.winnerCount > 1) sharedPrize++;
    for (const [player, payout] of result.payouts.entries()) {
      playerReturns[player] += payout.amount;
      if (!result.refunds && payout.amount > 0) playerWins[player]++;
    }
    if (outcomes) outcome.numbers.forEach((value, i) => outcomes[i][value]++);
    const identical = tickets.map((ticket) => ({ ...ticket, selection: tickets[0].selection }));
    const same = settleTogether(1000, 700, rankTogether(game.key, identical, outcome), id);
    if (same.refunds && same.platformFee === 0 && same.payouts.every((p) => p.amount === 1000))
      identicalRefunds++;
  }
  if (identicalRefunds !== samples) throw new Error(`Identical-pick refund failed: ${game.key}`);
  summaries.push({
    game: game.key,
    samples,
    players,
    selectionPolicy: 'independent uniform legal choices',
    paidPercent: pct(paid),
    allTiedPercent: pct(allTied),
    noWinnersPercent: pct(noWinners),
    sharedPrizePercent: pct(sharedPrize),
    identicalPicksRefundPercent: pct(identicalRefunds),
    playerWinPercent: playerWins.map((n) => pct(n)),
    playerReturnPercent: playerReturns.map((n) => pct(n, samples * 1000)),
    totalFeePercentOfEntries: pct(fees, samples * players * 1000),
    predictionOutcomePercent: outcomes?.map((row) => row.map((n) => pct(n))) ?? null,
  });
}
const crashDuel = (a, b) => {
  const low = Math.min(a, b),
    high = Math.max(a, b);
  const lowSurvives = togetherCrashSurvivalPercent(low),
    highSurvives = togetherCrashSurvivalPercent(high);
  return a === b
    ? { targets: [a / 100, b / 100], aWins: 0, bWins: 0, refunds: 100 }
    : {
        targets: [a / 100, b / 100],
        aWins: a < b ? lowSurvives - highSurvives : highSurvives,
        bWins: b < a ? lowSurvives - highSurvives : highSurvives,
        refunds: 100 - lowSurvives,
      };
};
const report = {
  method:
    'Deterministic synthetic outcomes from the deployed v1 shared engine; no live beacon verification or live wallet operations.',
  rules: TOGETHER_RULES_ID,
  engineSourceSha256: hash(
    readFileSync(new URL('../packages/shared/src/play-together.ts', import.meta.url))
  ),
  samplesPerGame: samples,
  empiricalSummaries: summaries,
  footballModelProbabilities: TOGETHER_FOOTBALL_CHANCES,
  exactCrashSurvivalPercent: [101, 150, 200, 300, 500, 1000, 2000].map((target) => ({
    target: target / 100,
    survival: togetherCrashSurvivalPercent(target),
  })),
  exactTwoPlayerCrashExamples: [
    [101, 200],
    [200, 201],
    [101, 201],
    [101, 300],
    [101, 2000],
    [200, 200],
  ].map(([a, b]) => crashDuel(a, b)),
};
const output = JSON.stringify(report, null, 2) + '\n';
const outArg = process.argv.find((arg) => arg.startsWith('--out='));
if (outArg) writeFileSync(outArg.slice(6), output);
else process.stdout.write(output);
