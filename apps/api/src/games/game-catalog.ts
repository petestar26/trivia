import { prisma } from '@socialplay/database';

export interface GameCatalogItem {
  id: string;
  key: string;
  name: string;
  description: string | null;
  type: string;
  minBet: number;
  maxBet: number;
  isActive: boolean;
}

// ─── Server-Defined Game Definitions ────────────────────────────
// These seed the GameDefinition rows. Clients cannot modify them.

const GAME_DEFINITIONS = [
  {
    key: 'lucky_spin',
    name: 'Lucky Spin',
    description: 'Spin the wheel and try your luck! Different segments offer different multipliers.',
    type: 'LUCKY_SPIN',
    minBet: 10,
    maxBet: 500,
    configuration: {
      outcomes: [
        { name: 'LOSE', multiplier: 0, probability: 0.45 },
        { name: 'SMALL_WIN', multiplier: 1.5, probability: 0.25 },
        { name: 'MEDIUM_WIN', multiplier: 3, probability: 0.15 },
        { name: 'LARGE_WIN', multiplier: 5, probability: 0.10 },
        { name: 'JACKPOT', multiplier: 10, probability: 0.05 },
      ],
    },
  },
  {
    key: 'dice',
    name: 'Dice',
    description: 'Roll the dice! A sum of 7 or higher doubles your bet.',
    type: 'DICE',
    minBet: 5,
    maxBet: 1000,
    configuration: {
      winThreshold: 7,
      multiplier: 2,
    },
  },
  {
    key: 'number_challenge',
    name: 'Number Challenge',
    description: 'Guess a number between 1 and 100. The closer you are, the more you win!',
    type: 'NUMBER_CHALLENGE',
    minBet: 10,
    maxBet: 200,
    configuration: {
      range: { min: 1, max: 100 },
      rewards: { exact: 5, within1: 3, within5: 2, within10: 1.5 },
    },
  },
  {
    key: 'trivia',
    name: 'Trivia',
    description: 'Answer trivia questions correctly to earn rewards!',
    type: 'TRIVIA',
    minBet: 5,
    maxBet: 100,
    configuration: {
      correctMultiplier: 3,
    },
  },
];

export async function ensureGameDefinitions(): Promise<void> {
  for (const def of GAME_DEFINITIONS) {
    await prisma.gameDefinition.upsert({
      where: { key: def.key },
      update: {
        name: def.name,
        description: def.description,
        type: def.type as 'LUCKY_SPIN' | 'DICE' | 'TRIVIA' | 'NUMBER_CHALLENGE',
        minBet: def.minBet,
        maxBet: def.maxBet,
        configuration: def.configuration,
        isActive: true,
      },
      create: {
        key: def.key,
        name: def.name,
        description: def.description,
        type: def.type as 'LUCKY_SPIN' | 'DICE' | 'TRIVIA' | 'NUMBER_CHALLENGE',
        minBet: def.minBet,
        maxBet: def.maxBet,
        configuration: def.configuration,
        isActive: true,
      },
    });
  }
}

export async function listActiveGames(): Promise<GameCatalogItem[]> {
  await ensureGameDefinitions();
  const rows = await prisma.gameDefinition.findMany({
    where: { isActive: true },
    orderBy: { key: 'asc' },
    select: {
      id: true,
      key: true,
      name: true,
      description: true,
      type: true,
      minBet: true,
      maxBet: true,
      isActive: true,
    },
  });
  return rows;
}

export async function getGameByKey(key: string) {
  return prisma.gameDefinition.findUnique({ where: { key } });
}

export async function getGameConfig(key: string): Promise<Record<string, unknown>> {
  const game = await getGameByKey(key);
  if (!game) return {};
  return (game.configuration as Record<string, unknown>) ?? {};
}
