/** Proposed economics, not an activation flag or a statement of deployed RTP. */
export const ECONOMICS_POLICY = 'scheduled-economics-v1';
export const HOUSE_RTP_BPS = 9_000n;
export const CONTEST_FEE_BPS = 1_500n;
export const BPS = 10_000n;

export const GAME_ECONOMICS = Object.freeze([
  { key: 'spin_win', model: 'HOUSE', schedule: 'DRAW', math: 'EXACT_90_ADAPTER' },
  { key: 'dice', model: 'HOUSE', schedule: 'DRAW', math: 'PROPOSED_90_ADAPTER' },
  { key: 'number_challenge', model: 'HOUSE', schedule: 'DRAW', math: 'PROPOSED_90_ADAPTER' },
  { key: 'trivia', model: 'BONUS', schedule: 'QUESTION', math: 'FUNDED_REWARD_BUDGET' },
  { key: 'thunder_derby_3d', model: 'HOUSE', schedule: 'RACE', math: 'PROPOSED_90_ADAPTER' },
  { key: 'neon_hounds_3d', model: 'HOUSE', schedule: 'RACE', math: 'PROPOSED_90_ADAPTER' },
  { key: 'turbo_circuit_3d', model: 'HOUSE', schedule: 'RACE', math: 'PROPOSED_90_ADAPTER' },
  { key: 'starfall_nebula', model: 'HOUSE', schedule: 'DRAW', math: 'PROPOSED_90_ADAPTER' },
  { key: 'jungle_dash_3d', model: 'HOUSE', schedule: 'RACE', math: 'PROPOSED_90_ADAPTER' },
  { key: 'turbo_keno', model: 'HOUSE', schedule: 'DRAW', math: 'PROPOSED_90_ADAPTER' },
  { key: 'crystal_trail', model: 'HOUSE', schedule: 'DRAW', math: 'PROPOSED_90_ADAPTER' },
  { key: 'heat_vault', model: 'HOUSE', schedule: 'DRAW', math: 'PROPOSED_90_ADAPTER' },
  { key: 'strait_rush', model: 'HOUSE', schedule: 'RACE', math: 'PROPOSED_90_ADAPTER' },
] as const);

export type EconomicGameKey = (typeof GAME_ECONOMICS)[number]['key'];

export function gameEconomics(key: string) {
  const policy = GAME_ECONOMICS.find((game) => game.key === key);
  if (!policy) throw new RangeError('Unknown game economics');
  return policy;
}
