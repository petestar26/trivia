export type SportsEnv = Record<string, string | undefined>;
// Verified against this operator's authenticated catalogue. Never pass a
// caller-supplied game ID into the cash sportsbook connection.
export const SPORTS_GAME_ID = 'x88c09ae664d9af4';
export const sportsGameId = (env: SportsEnv) =>
  env.SOFTAGGREGATOR_SPORTS_GAME_ID?.trim() || SPORTS_GAME_ID;
export const isSportsGame = (id: string, env: SportsEnv) =>
  id === SPORTS_GAME_ID || id === sportsGameId(env);
