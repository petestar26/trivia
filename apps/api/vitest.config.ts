import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // ── DETERMINISM: run test FILES sequentially ────────────────────
    // Every suite in this package talks to the SAME PostgreSQL database and
    // performs destructive fixture cleanup (`deleteMany`) in its own
    // beforeAll. Under Vitest's default file parallelism those cleanups
    // interleave with other files' running tests, and shared reference data
    // (GameDefinition / Achievement upserts via ensureGameDefinitions and
    // ensureAchievements) is written concurrently by several files at once.
    //
    // That produced order-dependent, non-reproducible failures — e.g.
    // challenge suites failing with "Insufficient Game Points for entry"
    // because another file had deleted their wallets mid-test.
    //
    // Sequential file execution makes the suite reproducible. It is set here
    // rather than passed as a CLI flag so that the repository's normal
    // `pnpm test` is safe by default and cannot silently run unsafely.
    fileParallelism: false,
    // Vitest's default 'threads' pool runs test files as worker_threads
    // sharing one process's memory space. Prisma's query engine is a
    // native binary loaded via N-API, and native modules inside
    // worker_threads is a known source of Windows access violations
    // (observed here as exit code 3221225477 / 0xC0000005 on the full
    // suite). 'forks' runs each file in a separate OS process instead —
    // slightly slower to spin up, but immune to this class of crash.
    pool: 'forks',
    // These are database-backed integration tests, not unit tests. Some first-
    // run paths do a genuine amount of work against PostgreSQL (e.g. VIP
    // activation cascades into achievement definition upserts, an achievement
    // unlock, a reward grant, an XP award and a possible level-up unlock),
    // which exceeds Vitest's 5s default on a cold database. Raised so a slow
    // but correct operation is not reported as a failure.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // pino's `pino-pretty` transport spawns its own worker thread to load
    // the pretty-printer module, and that resolution fails inside Vitest's
    // transformed module context (see server.test.ts: "unable to determine
    // transport target for pino-pretty"). Force it off for test runs only —
    // packages/config's LOG_PRETTY default of `true` is untouched, so local
    // dev and prod logging are unaffected.
    env: {
      LOG_PRETTY: 'false',
    },
    // Seeds reference data (trivia questions) exactly once before the run,
    // so the suite never depends on a manually pre-seeded database.
    globalSetup: ['./src/test/global-setup.ts'],
  },
});