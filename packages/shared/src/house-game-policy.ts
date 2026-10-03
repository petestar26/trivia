/** Common target contract for house games. This does not activate a game or mode.
 * Pooled contests and funded Trivia rewards are separate products.
 */
export const HOUSE_GAME_MODES = ['SOLO', 'SHARED', 'GROUP'] as const;
export type HouseGameMode = (typeof HOUSE_GAME_MODES)[number];
export const HOUSE_GAME_POLICY = Object.freeze({
  targetRtpBps: 9000,
  expectedHouseEdgeBps: 1000,
  additionalGroupFeeBps: 0,
  phases: ['BETTING_OPEN', 'LOCKED', 'RUNNING', 'RESULT', 'SETTLED'] as const,
});
export const KENO_90_RULES = Object.freeze({
  choices: 80,
  drawCount: 20,
  stakeStep: 5,
  returnPerStep: 18,
});
