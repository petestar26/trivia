/**
 * Deterministic development/test seed.
 *
 * Referenced by `pnpm --filter database db:seed` (package.json), which
 * previously pointed at this file before it existed.
 *
 * SCOPE — deliberately minimal. This seeds ONLY reference data that the
 * schema requires but that no runtime code creates on demand:
 *
 *   - TriviaQuestion rows.
 *
 * It deliberately does NOT seed:
 *   - GameDefinition — created on demand by `ensureGameDefinitions()`
 *     (apps/api/src/games/game-catalog.ts) on every game/challenge/
 *     competition entry point.
 *   - Achievement — created on demand by `ensureAchievements()`
 *     (apps/api/src/rewards/achievement-service.ts).
 *   - Users, wallets, groups, agents, countries, payment methods, exchange
 *     rates, orders — every test builds its own fixtures, and seeding
 *     speculative "production-like" data here would be inventing product
 *     data that no requirement asks for.
 *
 * Determinism: every row uses a FIXED uuid, and the insert is an idempotent
 * upsert. Running this repeatedly, or against a database that already has
 * some of these rows, converges on exactly the same state — which is what
 * makes test results reproducible across clean and reused databases.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/** Stable, valid v4-shaped uuid derived from an index, so ids never drift. */
function seedId(n: number): string {
  const hex = n.toString(16).padStart(12, '0');
  return `00000000-0000-4000-8000-${hex}`;
}

interface SeedQuestion {
  question: string;
  choices: string[];
  correctIndex: number;
  category: string;
  difficulty: number;
}

// A small, factual, non-controversial pool. The competition and game trivia
// flows consume one question per scored round and never re-serve a question
// a user has already attempted, so the pool must be comfortably larger than
// the number of rounds any single suite plays.
const QUESTIONS: SeedQuestion[] = [
  { question: 'What is the capital of France?', choices: ['Berlin', 'Madrid', 'Paris', 'Rome'], correctIndex: 2, category: 'geography', difficulty: 1 },
  { question: 'How many continents are there?', choices: ['5', '6', '7', '8'], correctIndex: 2, category: 'geography', difficulty: 1 },
  { question: 'What is the largest ocean on Earth?', choices: ['Atlantic', 'Indian', 'Arctic', 'Pacific'], correctIndex: 3, category: 'geography', difficulty: 1 },
  { question: 'Which planet is closest to the Sun?', choices: ['Venus', 'Mercury', 'Earth', 'Mars'], correctIndex: 1, category: 'science', difficulty: 1 },
  { question: 'What is the chemical symbol for water?', choices: ['H2O', 'CO2', 'O2', 'NaCl'], correctIndex: 0, category: 'science', difficulty: 1 },
  { question: 'How many sides does a hexagon have?', choices: ['5', '6', '7', '8'], correctIndex: 1, category: 'math', difficulty: 1 },
  { question: 'What is 12 x 12?', choices: ['124', '144', '134', '154'], correctIndex: 1, category: 'math', difficulty: 1 },
  { question: 'Which gas do plants absorb from the air?', choices: ['Oxygen', 'Nitrogen', 'Carbon dioxide', 'Hydrogen'], correctIndex: 2, category: 'science', difficulty: 1 },
  { question: 'How many minutes are in one hour?', choices: ['30', '45', '60', '90'], correctIndex: 2, category: 'general', difficulty: 1 },
  { question: 'What is the largest mammal?', choices: ['Elephant', 'Blue whale', 'Giraffe', 'Hippopotamus'], correctIndex: 1, category: 'nature', difficulty: 1 },
  { question: 'Which metal is liquid at room temperature?', choices: ['Iron', 'Mercury', 'Copper', 'Lead'], correctIndex: 1, category: 'science', difficulty: 2 },
  { question: 'How many days are in a leap year?', choices: ['364', '365', '366', '367'], correctIndex: 2, category: 'general', difficulty: 1 },
  { question: 'What is the square root of 81?', choices: ['7', '8', '9', '11'], correctIndex: 2, category: 'math', difficulty: 1 },
  { question: 'Which ocean lies east of Africa?', choices: ['Pacific', 'Atlantic', 'Indian', 'Arctic'], correctIndex: 2, category: 'geography', difficulty: 2 },
  { question: 'What is the freezing point of water in Celsius?', choices: ['-10', '0', '10', '32'], correctIndex: 1, category: 'science', difficulty: 1 },
  { question: 'How many strings does a standard guitar have?', choices: ['4', '5', '6', '7'], correctIndex: 2, category: 'music', difficulty: 1 },
  { question: 'Which is the longest river in the world?', choices: ['Amazon', 'Nile', 'Yangtze', 'Mississippi'], correctIndex: 1, category: 'geography', difficulty: 2 },
  { question: 'What is 15% of 200?', choices: ['20', '25', '30', '35'], correctIndex: 2, category: 'math', difficulty: 2 },
  { question: 'How many players are on a soccer team on the field?', choices: ['9', '10', '11', '12'], correctIndex: 2, category: 'sports', difficulty: 1 },
  { question: 'Which planet is known as the Red Planet?', choices: ['Venus', 'Mars', 'Jupiter', 'Saturn'], correctIndex: 1, category: 'science', difficulty: 1 },
];

/**
 * Expands the base pool to `TARGET_COUNT` deterministic rows. The suite
 * plays many scored rounds across several competitions, and a user is never
 * re-served a question they already attempted, so a small pool would make
 * later rounds fail with "answered all available questions" — an
 * environment artefact rather than a real assertion failure.
 */
const TARGET_COUNT = 120;

async function main(): Promise<void> {
  let created = 0;
  let updated = 0;

  for (let i = 0; i < TARGET_COUNT; i++) {
    const base = QUESTIONS[i % QUESTIONS.length];
    const round = Math.floor(i / QUESTIONS.length);
    // Questions past the first pass are suffixed so each row stays distinct
    // and individually attemptable, while remaining fully deterministic.
    const question = round === 0 ? base.question : `${base.question} (set ${round + 1})`;

    const data = {
      question,
      choices: base.choices,
      correctIndex: base.correctIndex,
      category: base.category,
      difficulty: base.difficulty,
      isActive: true,
    };

    const existing = await prisma.triviaQuestion.findUnique({ where: { id: seedId(i) } });
    await prisma.triviaQuestion.upsert({
      where: { id: seedId(i) },
      update: data,
      create: { id: seedId(i), ...data },
    });
    if (existing) updated++;
    else created++;
  }

  const total = await prisma.triviaQuestion.count();
  console.log(`Seed complete — trivia questions: ${created} created, ${updated} updated, ${total} total.`);
}

main()
  .catch((err) => {
    console.error('Seed failed:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
