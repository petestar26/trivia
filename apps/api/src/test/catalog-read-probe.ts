// Test helper, run as its own process against the database in DATABASE_URL:
// exercises every read path of the game catalog and prints what it served.
// The upgrade tests use it to prove that serving the catalog writes nothing.
import { getGameByKey, getGameConfig, listActiveGames, resolveCurrentRules } from '../games/game-catalog.js';

const KEYS = ['lucky_spin', 'dice', 'number_challenge', 'trivia'];

async function main() {
  const listed = await listActiveGames();
  const games: Record<string, unknown> = {};
  for (const key of KEYS) {
    const game = await getGameByKey(key);
    const rules = game ? await resolveCurrentRules(game) : null;
    games[key] = { config: await getGameConfig(key), rulesHash: rules?.rulesHash ?? null, rules: rules?.rules ?? null };
  }
  process.stdout.write(`${JSON.stringify({ listed: listed.map((game) => game.key), games })}\n`);
}

main().then(() => process.exit(0), (error) => {
  process.stderr.write(`${String(error)}\n`);
  process.exit(1);
});
