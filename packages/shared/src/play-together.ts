import { bjResult, bjTotal } from './blackjack.js';
import { canonicalJson, sha256Hex } from './virtual-football/hash.js';
import { generateTimeline } from './virtual-football/outcome.js';
import { quicknetTargetForCutoff, QUICKNET_CHAIN_HASH } from './spin-win-proof.js';

export const TOGETHER_RULES_ID = 'salem-together-v1';
export const TOGETHER_FEE_POLICY = 'winning-profit-v1';
export const TOGETHER_GAMES = [
  {
    key: 'spin_win',
    name: 'Group Spin',
    picks: 0,
    min: 0,
    max: 0,
    rules: 'One equal wheel segment per confirmed player. One spin selects the winner.',
  },
  {
    key: 'turbo_keno',
    name: 'Turbo Keno',
    picks: 5,
    min: 1,
    max: 80,
    rules: 'Choose five numbers from 1–80. Twenty balls are drawn. Most matches wins.',
  },
  {
    key: 'dice',
    name: 'Dice Duel',
    picks: 0,
    min: 0,
    max: 0,
    rules: 'Two fair dice are rolled for every player. The highest total wins.',
  },
  {
    key: 'number_challenge',
    name: 'Number Challenge',
    picks: 1,
    min: 1,
    max: 100,
    rules: 'Choose 1–100. The closest guess to the shared target wins.',
  },
  {
    key: 'roulette_keno',
    name: 'Roulette Keno',
    picks: 5,
    min: 1,
    max: 72,
    rules: 'Choose five numbers from 1–72. Eighteen balls are drawn. Most matches wins.',
  },
  {
    key: 'lucky_six',
    name: 'Lucky Six',
    picks: 6,
    min: 1,
    max: 48,
    rules:
      'Choose six numbers from 1–48. First to complete six wins. If no ticket completes in 35 draws, most matches wins.',
  },
  {
    key: 'thunder_derby_3d',
    name: 'Derby — Beat the Picks',
    picks: 1,
    min: 1,
    max: 8,
    rules:
      'Choose one of eight equally likely runners. The best finish among the group’s selected runners wins.',
  },
  {
    key: 'neon_hounds_3d',
    name: 'Dog Racing — Beat the Picks',
    picks: 1,
    min: 1,
    max: 8,
    rules:
      'Choose one of eight equally likely dogs. The best finish among the group’s selected dogs wins.',
  },
  {
    key: 'virtual_football_3d',
    name: 'Football Predictions',
    picks: 3,
    min: 0,
    max: 2,
    rules:
      'Predict home win, draw or away win for three simulated matches. One point per correct result; highest score wins.',
  },
  {
    key: 'blackjack',
    name: 'Blackjack Predictions',
    picks: 6,
    min: 0,
    max: 2,
    rules:
      'Predict win, draw or loss for each of six automated hands against the dealer. Highest number correct wins.',
  },
  {
    key: 'sky_crash',
    name: 'Sky Crash Challenge',
    picks: 1,
    min: 101,
    max: 2000,
    rules:
      'Choose an automatic exit target from 1.01× to 20×. Highest target strictly below the crash wins. Targets are scores, not payout multipliers.',
  },
  {
    key: 'crash_point',
    name: 'Crash Point Challenge',
    picks: 1,
    min: 101,
    max: 2000,
    rules:
      'Choose an automatic exit target from 1.01× to 20×. Highest target strictly below the crash wins. Targets are scores, not payout multipliers.',
  },
] as const;
export type TogetherGame = (typeof TOGETHER_GAMES)[number]['key'];
export type TogetherCurrency = 'GAME_POINTS' | 'ETB';
export type TogetherState = 'OPEN' | 'LOCKED' | 'DRAWN' | 'PAID' | 'REFUNDED';
export const TOGETHER_LIMITS = Object.freeze({
  minPlayers: 2,
  maxPlayers: 20,
  minEntry: 100,
  maxEntry: 100_000,
  maxFeeBps: 2000,
  defaultFeeBps: 700,
  recoveryMs: 600_000,
  lobbySeconds: [120, 300, 600] as readonly number[],
});
export const TOGETHER_FOOTBALL_FIXTURES = [
  { homeAttack: 110, homeDefence: 100, awayAttack: 100, awayDefence: 100 },
  { homeAttack: 90, homeDefence: 100, awayAttack: 120, awayDefence: 100 },
  { homeAttack: 100, homeDefence: 100, awayAttack: 100, awayDefence: 100 },
] as const;

export function togetherGame(key: string) {
  const game = TOGETHER_GAMES.find((g) => g.key === key);
  if (!game) throw new RangeError('This group game is unavailable');
  return game;
}
export function togetherSelection(key: TogetherGame, input: unknown): number[] {
  const game = togetherGame(key);
  if (
    !Array.isArray(input) ||
    input.length !== game.picks ||
    input.some((n) => !Number.isInteger(n) || n < game.min || n > game.max)
  )
    throw new RangeError('Complete your selection using the published game rules');
  const ordered = key === 'blackjack' || key === 'virtual_football_3d';
  if (!ordered && new Set(input).size !== input.length)
    throw new RangeError('Choose different numbers');
  return ordered ? [...input] : [...input].sort((a, b) => a - b);
}
export interface TogetherTerms {
  /** Absent on historical v1 receipts; never add defaults to their hash. */
  termsVersion?: 2;
  presentationVersion?: 2;
  presentationDurationMs?: number;
  id: string;
  groupId: string | null;
  game: TogetherGame;
  currency: TogetherCurrency;
  entryAmount: number;
  feeBps: number;
  settingsVersion: number;
  minPlayers: number;
  maxPlayers: number;
  closesAt: number;
  rulesId: typeof TOGETHER_RULES_ID;
  feePolicy: typeof TOGETHER_FEE_POLICY;
  seedCommitment: string;
  beaconRound: number;
}
export interface TogetherTicket {
  id: string;
  userId: string;
  selection: number[];
}
export interface TogetherOutcome {
  numbers: number[];
  hands?: number[][];
  football?: { home: number; away: number }[];
}
export interface TogetherRanking {
  entryId: string;
  score: number;
  detail: string;
}
export interface TogetherSettlement {
  funded: number;
  platformFee: number;
  feeBps: number;
  winnerCount: number;
  refunds: boolean;
  reason: string | null;
  payouts: { entryId: string; amount: number; profit: number }[];
}
export interface TogetherProof {
  seed: string;
  beacon: { round: number; signature: string; randomness: string };
}
export interface TogetherEntryView {
  id: string;
  userId: string;
  username: string;
  selection: number[] | null;
  state: 'ACCEPTED' | 'REFUNDED' | 'SETTLED';
  amount: number;
  payout: number | null;
  createdAt: number;
  walletTransactionId: string;
  payoutTransactionId: string | null;
  requestId: string | null;
}
export interface TogetherRoundView extends TogetherTerms {
  presentation?: import('./together-presentation.js').TogetherPresentationView;
  revision?: number;
  eventSequence?: number;
  creatorId: string | null;
  groupName: string | null;
  state: TogetherState;
  termsHash: string;
  rosterHash: string | null;
  entries: TogetherEntryView[];
  outcome: TogetherOutcome | null;
  ranking: TogetherRanking[];
  settlement: TogetherSettlement | null;
  voidReason: string | null;
  proof: TogetherProof | null;
  recoveryDeadline: number;
  paidAt: number | null;
}
export interface TogetherSettings {
  version: number;
  feeBps: number;
  minEntry: number;
  maxEntry: number;
  enabledGames: TogetherGame[];
  practiceEnabled: boolean;
  cashEnabled: boolean;
  publicRoomsEnabled: boolean;
}
export interface TogetherSnapshot {
  serverTime: number;
  workerReady: boolean;
  admissionsEnabled: boolean;
  settings: TogetherSettings;
  balances: {
    cashAvailable: number;
    cashReserved: number;
    pointsAvailable: number;
    pointsReserved: number;
  };
  cashAvailable: boolean;
  round: TogetherRoundView;
}
export function togetherTermsHash(terms: TogetherTerms): string {
  const {
    id,
    groupId,
    game,
    currency,
    entryAmount,
    feeBps,
    settingsVersion,
    minPlayers,
    maxPlayers,
    closesAt,
    rulesId,
    feePolicy,
    seedCommitment,
    beaconRound,
  } = terms;
  return sha256Hex(
    canonicalJson({
      id,
      groupId,
      game,
      currency,
      entryAmount,
      feeBps,
      settingsVersion,
      minPlayers,
      maxPlayers,
      closesAt,
      rulesId,
      feePolicy,
      seedCommitment,
      beaconRound,
      ...(terms.termsVersion === 2
        ? {
            termsVersion: 2,
            presentationVersion: terms.presentationVersion,
            presentationDurationMs: terms.presentationDurationMs,
          }
        : {}),
    })
  );
}
export function togetherRosterHash(tickets: TogetherTicket[]): string {
  return sha256Hex(
    canonicalJson([...tickets].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)))
  );
}
export function togetherSeedCommitment(roundId: string, seed: string): string {
  if (!/^[a-f0-9]{64}$/.test(seed)) throw new RangeError('Invalid round seed');
  return sha256Hex('salem:together:seed:v1|' + roundId + '|' + seed);
}

/** Shared deterministic sampler. Rejection avoids modulo bias. A verified,
 * pinned beacon is required by the server before this pure function is called. */
export function deriveTogetherOutcome(
  terms: TogetherTerms,
  tickets: TogetherTicket[],
  proof: TogetherProof
): TogetherOutcome {
  const target = quicknetTargetForCutoff(terms.closesAt);
  if (
    terms.rulesId !== TOGETHER_RULES_ID ||
    proof.beacon.round !== target.beaconRound ||
    terms.beaconRound !== target.beaconRound ||
    togetherSeedCommitment(terms.id, proof.seed) !== terms.seedCommitment ||
    !/^[a-f0-9]{64}$/.test(proof.beacon.randomness)
  )
    throw new RangeError('Result proof does not match the round');
  const ids = [...tickets].map((t) => t.id).sort();
  if (ids.length < 2 || ids.length > 20 || new Set(ids).size !== ids.length)
    throw new RangeError('Invalid confirmed roster');
  // Player selections and money never influence the random stream.
  const root = sha256Hex(
    [
      'salem:together:draw:v1',
      terms.id,
      terms.rulesId,
      terms.game,
      proof.seed,
      QUICKNET_CHAIN_HASH,
      target.beaconRound,
      proof.beacon.randomness,
    ].join('|')
  );
  let counter = 0;
  const below = (n: number) => {
    if (!Number.isSafeInteger(n) || n < 1 || n > 1_000_000)
      throw new RangeError('Invalid draw bound');
    const limit = Math.floor(4294967296 / n) * n;
    for (let tries = 0; tries < 1024; tries++) {
      const value = parseInt(sha256Hex(root + '|' + counter++).slice(0, 8), 16);
      if (value < limit) return value % n;
    }
    throw new Error('Random sampler exhausted');
  };
  const draw = (size: number, count: number) => {
    const pool = Array.from({ length: size }, (_, i) => i + 1);
    for (let i = 0; i < count; i++) {
      const j = i + below(size - i);
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    return pool.slice(0, count);
  };
  switch (terms.game) {
    case 'spin_win':
      return { numbers: [below(ids.length)] };
    case 'dice':
      return { numbers: ids.flatMap(() => [below(6) + 1, below(6) + 1]) };
    case 'number_challenge':
      return { numbers: [below(100) + 1] };
    case 'turbo_keno':
      return { numbers: draw(80, 20) };
    case 'roulette_keno':
      return { numbers: draw(72, 18) };
    case 'lucky_six':
      return { numbers: draw(48, 35) };
    case 'thunder_derby_3d':
    case 'neon_hounds_3d':
      return { numbers: draw(8, 8) };
    case 'sky_crash':
    case 'crash_point':
      // Published finite distribution: U uniform in 1..1,000,000.
      // crash = floor(100,000,000/U), capped at 20.01x so 20x can succeed.
      return { numbers: [Math.min(2001, Math.floor(100_000_000 / (below(1_000_000) + 1)))] };
    case 'virtual_football_3d': {
      const football = TOGETHER_FOOTBALL_FIXTURES.map((p, i) => {
        const result = generateTimeline(sha256Hex(root + '|fixture|' + i), p);
        return { home: result.ftHome, away: result.ftAway };
      });
      return {
        numbers: football.map((s) => (s.home > s.away ? 0 : s.home === s.away ? 1 : 2)),
        football,
      };
    }
    case 'blackjack': {
      const pool = Array.from({ length: 312 }, (_, i) => i);
      const take = () => pool.splice(below(pool.length), 1)[0];
      const hands: number[][] = Array.from({ length: 7 }, () => []);
      for (let stage = 0; stage <= 3; stage++)
        for (const hand of hands) {
          if (stage <= 1) hand.push(take());
          else if (stage === 2) {
            if (bjTotal(hand).total < 17) hand.push(take());
          } else while (bjTotal(hand).total < 17) hand.push(take());
        }
      return {
        numbers: hands.slice(1).map((h) => ['WIN', 'DRAW', 'LOSE'].indexOf(bjResult(h, hands[0]))),
        hands,
      };
    }
  }
}

export function rankTogether(
  game: TogetherGame,
  tickets: TogetherTicket[],
  outcome: TogetherOutcome
): TogetherRanking[] {
  const sorted = [...tickets].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const drawn = outcome.numbers;
  return sorted.map((ticket, index) => {
    const pick = togetherSelection(game, ticket.selection);
    let score = 0,
      detail = '';
    if (game === 'spin_win') {
      score = drawn[0] === index ? 1 : 0;
      detail = 'Segment ' + (index + 1);
    } else if (game === 'dice') {
      const dice = drawn.slice(index * 2, index * 2 + 2);
      score = dice[0] + dice[1];
      detail = dice.join(' + ') + ' = ' + score;
    } else if (game === 'number_challenge') {
      const distance = Math.abs(pick[0] - drawn[0]);
      score = 100 - distance;
      detail = 'Distance ' + distance;
    } else if (game === 'thunder_derby_3d' || game === 'neon_hounds_3d') {
      const place = drawn.indexOf(pick[0]) + 1;
      score = 9 - place;
      detail = 'Runner ' + pick[0] + ' finished #' + place;
    } else if (game === 'sky_crash' || game === 'crash_point') {
      score = pick[0] < drawn[0] ? pick[0] : 0;
      detail = score ? (score / 100).toFixed(2) + '× reached' : 'Crashed';
    } else if (game === 'blackjack' || game === 'virtual_football_3d') {
      score = pick.filter((p, i) => p === drawn[i]).length;
      detail = score + ' correct';
    } else {
      const hits = pick.filter((p) => drawn.includes(p)).length;
      score = hits;
      detail = hits + ' matches';
      if (game === 'lucky_six' && hits === 6) {
        const completion = Math.max(...pick.map((p) => drawn.indexOf(p))) + 1;
        score = 100 - completion;
        detail = 'Six complete on ball ' + completion;
      }
    }
    return { entryId: ticket.id, score, detail };
  });
}

/** One entry per player, integer smallest units, fee only on losing entries.
 * Winner principal is included in the payout; it is never credited twice. */
export function settleTogether(
  entryAmount: number,
  feeBps: number,
  ranking: TogetherRanking[],
  roundId: string,
  voidReason: string | null = null
): TogetherSettlement {
  if (
    !Number.isSafeInteger(entryAmount) ||
    entryAmount < 1 ||
    entryAmount > TOGETHER_LIMITS.maxEntry ||
    !Number.isSafeInteger(feeBps) ||
    feeBps < 0 ||
    feeBps > TOGETHER_LIMITS.maxFeeBps ||
    ranking.length > 20 ||
    new Set(ranking.map((r) => r.entryId)).size !== ranking.length ||
    ranking.some((r) => !Number.isFinite(r.score))
  )
    throw new RangeError('Invalid group settlement');
  const funded = entryAmount * ranking.length;
  const best = Math.max(0, ...ranking.map((r) => r.score));
  const winners = ranking.filter((r) => r.score === best);
  const reason =
    voidReason ??
    (ranking.length < 2
      ? 'NOT_ENOUGH_PLAYERS'
      : best === 0
        ? 'NO_WINNERS'
        : winners.length === ranking.length
          ? 'ALL_TIED'
          : null);
  if (reason)
    return {
      funded,
      platformFee: 0,
      feeBps,
      winnerCount: 0,
      refunds: true,
      reason,
      payouts: ranking.map((r) => ({ entryId: r.entryId, amount: entryAmount, profit: 0 })),
    };
  const losingPool = funded - entryAmount * winners.length;
  const platformFee = Number((BigInt(losingPool) * BigInt(feeBps)) / 10_000n);
  const prize = funded - platformFee;
  const share = Math.floor(prize / winners.length),
    remainder = prize % winners.length;
  // Round-dependent published ordering spreads rounding units without favoring
  // the owner, earliest request, or one permanent account ID.
  const ordered = winners
    .map((w) => ({ ...w, order: sha256Hex(roundId + '|remainder|' + w.entryId) }))
    .sort((a, b) =>
      a.order < b.order
        ? -1
        : a.order > b.order
          ? 1
          : a.entryId < b.entryId
            ? -1
            : a.entryId > b.entryId
              ? 1
              : 0
    );
  const byId = new Map(ordered.map((w, i) => [w.entryId, share + (i < remainder ? 1 : 0)]));
  const payouts = ranking.map((r) => {
    const amount = byId.get(r.entryId) ?? 0;
    return { entryId: r.entryId, amount, profit: amount - entryAmount };
  });
  if (payouts.reduce((sum, p) => sum + p.amount, 0) + platformFee !== funded)
    throw new Error('Group settlement does not conserve funds');
  return {
    funded,
    platformFee,
    feeBps,
    winnerCount: winners.length,
    refunds: false,
    reason: null,
    payouts,
  };
}

export function togetherPayoutEstimate(entry: number, players: number, feeBps: number) {
  if (!Number.isSafeInteger(players) || players < 0 || players > 20)
    throw new RangeError('Invalid player count');
  if (players < 2) return { pool: entry * players, soleWinnerPayout: 0, fee: 0 };
  const fee = Number((BigInt(entry * (players - 1)) * BigInt(feeBps)) / 10_000n);
  return { pool: entry * players, soleWinnerPayout: entry * players - fee, fee };
}
