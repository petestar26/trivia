# Durable Spin Win practice rounds

This is an opt-in shared practice table, not live Coin wagering. It builds on the shared economics kernel in PR #10.
No player is charged, no fee is collected, and no treasury reserve is created.
The route `/games/spin-win/live` displays server rounds and practice selections.

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
  does not manufacture historical rounds after an outage. The ticket guard rejects absent, paused or closed rounds.
- Authenticated `GET /games/scheduled/spin-win` is read-only, returns server time,
  the last 12 rounds and only the current player's tickets, with no-store caching.
- `POST /games/scheduled/spin-win/tickets` accepts one immutable practice ticket per
  active player per round. Identical retries return the stored acceptance, even
  after closing; conflicting reuse returns 409. The API and SQL trigger both check
  the database deadline under the draw worker's stream lock. Amounts are multiples
  of 40, at most 480 total. These selections are not a redeemable balance.
- The UI polls every two seconds. It disables new entry on lost/stale connectivity
  or cutoff, displays committed outcomes only, and retries an uncertain submission
  with the same round and selections. Refresh recovers accepted tickets from the
  server. The last-12-round display is a recent-results view, not a full history
  export. Missed or delayed rounds are never simulated locally.

## Database and permissions

Forward migration `20260930110000_scheduled_practice_rounds` adds two tables,
guards and a **disabled** `spin-win-practice-v1` stream. It changes no wallet,
catalog availability, Coin rule pointer or existing ledger function.

The SQL functions are invoker functions with catalog-only search paths and
qualified references. Row/statement guards prevent result edits and truncation.
Migration `20260930120000_scheduled_practice_tickets` adds practice selections
linked to the player and round, including immutable-history and deadline guards.
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
the tick; loop mode retries later. Native two-connection tests exercise this behavior in CI. Advisory locking is not an RNG authenticity
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

Loop-mode health and supervision are described in
[the worker deployment runbook](../deployment/scheduled-practice-worker.md).
The optional health listener reports process readiness; a healthy worker may
still supervise a paused stream. Stalled progress exits nonzero for supervisor
restart. Target activation and account provisioning remain separate steps.

## Validation and limits

`pnpm --filter api test:scheduled-practice` executes the actual migration,
constraints and triggers in PGlite's embedded PostgreSQL, using a disposable
filesystem database. It covers persistence across database close/reopen,
duplicate ticks, pause/recovery, rollback, immutable results, timing, forbidden
Coin mode and no fabricated historical rounds. PGlite serializes transactions;
queued calls are **not** evidence for native multi-connection lock correctness.
The lock-busy test is a unit check with a simulated refused lock.

The storage/HTTP contracts include 26 tests on embedded PostgreSQL 17.5 and
real Fastify JWT authentication, in addition to the 127 economics tests. Targeted TypeScript, changed-file ESLint, Prisma schema
validation, Prisma client generation and the API build passed. The compiled
worker's help succeeds; starting without its opt-in configuration exits 2.

The preceding commit passed native PostgreSQL 16 locking, rollback/retry and
restricted-role tests plus fresh and populated migration checks in GitHub Actions
run 36677848882. The updated workflow runs PostgreSQL 13 and 16, including concurrent
ticket retries and an admission waiting across the cutoff. It also builds the API
and web and runs the focused UI tests. Check the exact candidate's CI results;
previous green runs do not validate later commits. No target environment was
accessed or configured. Keep activation separate from this draft feature.

## Financial integration that remains

Add dedicated scheduled-stake holds preserving lot lineage, restrictions and
obligations; immutable accepted tickets; transactionally backed treasury
reservations; result-driven exactly-once settlement/refund; and jurisdiction,
limits and disclosures. Withdrawal holds cannot be reused: they exclude
restricted lots and carry withdrawal-specific ledger proofs. The 15% contest
pool planner still needs its own funded escrow and fee journal integration.

## Runtime permissions for the practice UI

The API role needs SELECT on the three scheduled tables and INSERT on
`scheduled_practice_tickets`. Its existing user SELECT and limited UPDATE grants
permit the active-user FOR SHARE lock. Do not give it signing-key access or owner
credentials. Apply migrations and configure grants through the owner deployment
job, never through API startup. The standalone draw worker does not need ticket
SELECT/INSERT: it cannot choose results based on entries through these grants.
Do not publish a 24/7 availability claim until the worker is supervised and its
restart/health monitoring has been rehearsed on the deployment target.

### Admission clock and isolation

The ticket guard locks the round, stream and active player before sampling its
acceptance timestamp and enforcing cutoff. The stored timestamp is that same
sample. Repeatable-read and serializable callers fail closed if a pause or draw
committed after their snapshot; they must retry the whole transaction. The
normal adapter uses READ COMMITTED.
