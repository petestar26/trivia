import { prisma } from '@socialplay/database';
import type { Prisma } from '@socialplay/database';

/**
 * Publishes the next rules version of `gameKey` with `patch` applied, points
 * the game at it, and rewrites the game's mutable configuration the same way,
 * exactly what a later rules release (or a careless catalog edit) would do
 * while contests are running. restore() moves the pointer and configuration
 * back; the new version row is immutable and stays, so repeated runs keep
 * publishing past it. `resultSchemaVersion` overrides the copied one.
 */
export async function publishNextRulesVersion(
  gameKey: string, patch: Record<string, unknown>, options: { resultSchemaVersion?: number } = {},
) {
  const game = await prisma.gameDefinition.findUniqueOrThrow({ where: { key: gameKey } });
  const current = await prisma.gameRules.findUniqueOrThrow({
    where: { gameId_version: { gameId: game.id, version: game.currentRulesVersion! } },
  });
  const max = await prisma.gameRules.aggregate({ where: { gameId: game.id }, _max: { version: true } });
  const version = (max._max.version ?? 1) + 1;
  const rules = { ...(current.rules as Record<string, unknown>), ...patch } as Prisma.InputJsonObject;
  const [{ hash }] = await prisma.$queryRaw<{ hash: string }[]>`SELECT rules_hash(${JSON.stringify(rules)}::jsonb) AS hash`;
  await prisma.gameRules.create({
    data: {
      gameId: game.id, version, mode: current.mode, family: current.family,
      wagerCurrency: current.wagerCurrency, rewardCurrency: current.rewardCurrency,
      rules, resultSchemaVersion: options.resultSchemaVersion ?? current.resultSchemaVersion, rulesHash: hash,
    },
  });
  await prisma.gameDefinition.update({
    where: { id: game.id }, data: { currentRulesVersion: version, configuration: rules },
  });
  return {
    version,
    restore: () => prisma.gameDefinition.update({
      where: { id: game.id },
      data: { currentRulesVersion: game.currentRulesVersion, configuration: game.configuration as object },
    }),
  };
}
