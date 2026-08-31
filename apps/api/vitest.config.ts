import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],

    // ── DETERMINISM: run test FILES sequentially ──────────────────
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

    // These are database-backed integration tests, not unit tests. Some first-
    // run paths do a genuine amount of work against PostgreSQL (e.g. VIP
    // activation cascades into achievement definition upserts, an achievement
    // unlock, a reward grant, an XP award and a possible level-up unlock),
    // which exceeds Vitest's 5s default on a cold database. Raised so a slow
    // but correct operation is not reported as a failure.
    testTimeout: 30_000,
    hookTimeout: 30_000,

    // Seeds reference data (trivia questions) exactly once before the run,
    // so the suite never depends on a manually pre-seeded database.
    globalSetup: ['./src/test/global-setup.ts'],
  },
});
