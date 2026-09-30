# Durable Spin Win practice rounds

This is an opt-in backend component, not live Coin wagering or a published
multiplayer interface. It builds on the shared economics kernel in PR #10.
No player is charged, no fee is collected, and no treasury reserve is created.

## Behavior

- A fixed UTC anchor divides time into 45 seconds entry, 10 seconds reveal and
  5 seconds result. The worker uses fresh database time after acquiring its lock.
- Each stream/sequence has one unique database row. Its schedule and rules are
  immutable. The current implementation accepts only practice Spin Win v2.
- Once entries close, the worker generates one uniform cryptographic result
  independently of players, bets and bankroll, then commits it before reporting
  success. A completed result cannot be edited, deleted or reopened.
- A failed transaction publishes nothing. A restart resumes already-created
  rounds and reads committed results. A result generated in an aborted transaction
  was never published; the retry may generate a new candidate.
- Disabling a stream stops new rounds. Previously opened rounds still receive
  their results. No result is cancelled because of its outcome.
- Missed intervals for which no round was ever opened remain absent; the worker
  does not manufacture historical rounds after an outage. With no ticket API,
  nobody can have an accepted ticket for an absent interval.
- `readPracticeRound` is read-only and always returns `coinsAccepted: false`.
  The HTTP interface, frontend subscription and practice UI wiring are not added.

## Database and permissions

Forward migration `20260930110000_scheduled_practice_rounds` adds two tables,
guards and a **disabled** `spin-win-practice-v1` stream. It changes no wallet,
catalog availability, Coin rule pointer or existing ledger function.

The SQL functions are invoker functions with catalog-only search paths and
qualified references. Row/statement guards prevent result edits and truncation.
Prisma models map the tables; the pending-round partial index remains SQL-only.

The worker requires SELECT on both tables, INSERT on rounds, and UPDATE on round
`state`, `outcome`, `drawn_at`. It does not require signing keys or migration
ownership. The migration grants nothing to PUBLIC. Existing ledger setup grants
broad DML on all tables; rerunning it may grant broader access than this worker
needs. These practice guards still apply, but this migration does not change
that setup function or claim a newly configured runtime role.

All worker instances use the same transaction-scoped stream advisory lock.
Schedule changes and direct round writes acquire the same lock in their guards.
A busy worker skips that stream. Database serialization/deadlock failures abort
the tick; loop mode retries later. A full multi-connection PostgreSQL test is
still required before deployment. Advisory locking is not an RNG authenticity
proof against a compromised SQL writer; there is no such claim here.

## Local rehearsal after migrating a disposable database

Enable a stream explicitly using its owner/admin connection:

```sql
UPDATE public.scheduled_game_streams
SET enabled = true WHERE id = 'spin-win-practice-v1';
```

Run with the restricted worker connection in DATABASE_URL, not owner credentials:

```sh
SCHEDULED_PRACTICE_WORKER_ENABLED=true pnpm --filter api worker:scheduled-practice --once
# Long-running standalone process, not wired into the deployed API or worker:
SCHEDULED_PRACTICE_WORKER_ENABLED=true pnpm --filter api worker:scheduled-practice --loop
# Production build equivalent:
SCHEDULED_PRACTICE_WORKER_ENABLED=true node apps/api/dist/scripts/scheduled-practice-worker.js --once
```

The environment switch defaults off. The database stream defaults disabled.
Neither switch enables Coin wagering: a database CHECK rejects Coin-mode streams.
Both must be deliberately configured even for practice. The API's existing
startup and worker processes do not start this worker automatically.

## Validation and limits

`pnpm --filter api test:scheduled-practice` executes the actual migration,
constraints and triggers in PGlite's embedded PostgreSQL, using a disposable
filesystem database. It covers persistence across database close/reopen,
duplicate ticks, pause/recovery, rollback, immutable results, timing, forbidden
Coin mode and no fabricated historical rounds. PGlite serializes transactions;
queued calls are **not** evidence for native multi-connection lock correctness.
The lock-busy test is a unit check with a simulated refused lock.

This change passed 10 scheduled-round tests on embedded PostgreSQL 17.5 and
all 127 economics tests. Targeted TypeScript, changed-file ESLint, Prisma schema
validation, Prisma client generation and the API build passed. The compiled
worker's help succeeds; starting without its opt-in configuration exits 2.

No native PostgreSQL 13/16 run or full populated-master migration run was possible
in this environment. The Prisma adapter is typechecked but has not been exercised
against a native server here. Keep this change in draft until those checks and
the existing production migration/role configuration issue are resolved.

## Financial integration that remains

Add dedicated scheduled-stake holds preserving lot lineage, restrictions and
obligations; immutable accepted tickets; transactionally backed treasury
reservations; result-driven exactly-once settlement/refund; and jurisdiction,
limits and disclosures. Withdrawal holds cannot be reused: they exclude
restricted lots and carry withdrawal-specific ledger proofs. The 15% contest
pool planner still needs its own funded escrow and fee journal integration.
