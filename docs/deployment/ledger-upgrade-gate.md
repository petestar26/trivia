# Ledger upgrade: maintenance procedure, gates and escalation

The G0 ledger release converts every wallet into the managed Coin ledger. It
**detects** inconsistent ledger data and **fails closed**; it never repairs,
re-mints or reclassifies anything by itself. This page is the operating
procedure for the upgrade and for every way it can stop.

The upgrade is supported **only with every writer stopped** (the maintenance
procedure below). The previous release writes wallets without the ledger, so
it must not run while the migrations do. The release detects a legacy
financial write made during the upgrade and stops (the window check), but
that is a safety net, not support for live writers.

## Prerequisites

Check each before scheduling the upgrade.

1. **PostgreSQL 13 or later.** The release uses `gen_random_uuid()` (built in
   from 13) and installs `pgcrypto`, which is a *trusted* extension from 13.

   ```sql
   SHOW server_version;
   ```

2. **The migration role can install `pgcrypto`.**
   `20260918010000_casino_foundation_schema` runs
   `CREATE EXTENSION IF NOT EXISTS "pgcrypto"`. On PostgreSQL 13+ this needs
   the `CREATE` privilege on the database (the database owner has it); on
   anything older it needs a superuser. Either confirm the privilege or have
   an administrator install the extension beforehand:

   ```sql
   SELECT has_database_privilege(current_user, current_database(), 'CREATE') AS can_create,
          EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pgcrypto') AS installed;
   ```

   One of the two must be `true`. If neither is, the release stops at that
   migration, before any ledger change; see "If a migration fails".

3. **A restorable backup is possible**: `pg_dump`/`pg_restore` of the same or
   a newer major version than the server, or the platform's volume backup with
   a tested restore.

4. **Database roles.** The database's guards bind every writer that is
   neither the owner of the tables nor a superuser. Migrations must run as the
   owner. For the guards to bind the application as well, the API and the
   worker should connect with a separate role that only has DML grants:

   ```sql
   CREATE ROLE playqube_app LOGIN PASSWORD '<from the secret store>'
     NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
   GRANT CONNECT, TEMPORARY ON DATABASE <database> TO playqube_app;
   GRANT USAGE ON SCHEMA public TO playqube_app;
   GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO playqube_app;
   GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO playqube_app;
   ALTER DEFAULT PRIVILEGES FOR ROLE <owner> IN SCHEMA public
     GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO playqube_app;
   ALTER DEFAULT PRIVILEGES FOR ROLE <owner> IN SCHEMA public
     GRANT USAGE, SELECT ON SEQUENCES TO playqube_app;
   ```

   Such a role cannot set `session_replication_role`, disable, drop or
   replace a trigger, a constraint or a guard function, or make a guard read
   its own TEMP tables (every function pins its `search_path`, migration
   `20260924040000`); the tests prove each of these. A process that connects
   as the owner or a superuser can do all of that. Today the Railway services
   share one `DATABASE_URL`: until the runtime role is split, the database
   guards constrain every ordinary SQL path of the application but not
   someone holding the owner credential.

## What checks the upgrade

| Where | What it evaluates |
|---|---|
| `20260917900000_ledger_preupgrade_gate` (first migration of the release) | What the upgrade *will* create from the current data, and that the legacy game catalog holds exactly the rules `master` ships. Locks the legacy financial tables and the game catalog while it reads; changes no existing data. It also records a fingerprint of every legacy financial record in `ledger_upgrade_window`. |
| `20260918020000`, `20260922020000`, `20260922060000` (catalog seed and rules-hash checks) | Stop if the frozen rules or their hashes differ from the expected ones. Each locks the catalog while it runs. |
| `20260924000000_ledger_integrity_gate` | The upgraded ledger itself, via `ledger_integrity_anomalies()`, with every ledger table locked. Only if it passes does it install the write guards that keep these rules true afterwards. |
| `20260924010000_ledger_resolution_authorization` | Installs the binding of `LEGACY_RESOLVE` and `ADMIN_ADJUST` to the records that authorize them, then stops if any operation already recorded breaks it. |
| `20260924040000_ledger_function_search_path` | Pins every schema function's `search_path` (schema first, `pg_temp` last). |
| `20260924090000_ledger_upgrade_window_check` (last migration) | Compares every legacy financial record with the fingerprint taken by the first migration and stops if anything changed while the release migrated. Drops `ledger_upgrade_window` when it passes. |
| Read-only preflight (`preflight:ledger-upgrade`) | Before: what the first gate will decide. After: what the final gate and invariant I15 decide, plus every operation the authorization rules reject. |
| Invariant scan (`scan:ledger-invariants`) | Every runtime invariant (I1 to I16) in a rolled-back transaction; records nothing. |
| Runtime invariant checker | The same invariants. A failing run keeps every platform gate (casino play, bonus grants, withdrawals, prizes) closed. |

The gates, the preflight and invariant I15 use one definition of an anomaly
(`apps/api/src/economy/ledger-integrity-definitions.ts`); the authorization
migration's closing check, the preflight and invariant I16 use one query
(`UNAUTHORIZED_OPERATIONS_QUERY` in the same file). Tests fail if any copy
drifts. The anomaly categories:

| Category | Meaning |
|---|---|
| `LOT_STATE_NULL` | A managed lot has no state. |
| `LOT_CACHE_NULL` | A managed lot has a NULL available, reserved, requirement or progress cache. |
| `LOT_PARTIALLY_LEGACY` | A lot without a lot class has some ledger fields set (a pre-journal lot keeps all of them NULL). |
| `LEGACY_LOT_OF_CLASSIFIED_OWNER` | A pre-journal lot belongs to a user whose account is already classified. |
| `WALLET_MISSING` | A user owns a ledger account or coin lots but has no wallet row. |
| `WALLET_LOT_MISMATCH` | A classified wallet's balance differs from the sum of its lots. |
| `CACHE_JOURNAL_MISMATCH` | A managed lot's caches differ from the sum of its own journal entries. |
| `SOURCE_OPERATION_MISSING` / `_INVALID` / `_CROSS_USER` | A managed lot has no source operation, names one that does not exist, or names another user's. |
| `UNCLASSIFIED_VALUE_UNREVIEWED` | A classified user's UNCLASSIFIED value (available or reserved) is not covered by an OPEN or FIRST_APPROVED review of that user. |
| `GAME_RULES_CHANGED` | Pre-upgrade only. A `game_definitions` row's configuration differs in value from the rules `master` ships for that game. The upgrade freezes those rules under a fixed hash, so it stops rather than hash rules nobody reviewed. Number formatting (`0.1` vs `0.10`) and key order are not differences. |
| `UNAUTHORIZED_OPERATION` | After the upgrade only. A `LEGACY_RESOLVE` or `ADMIN_ADJUST` operation is not backed exactly by the records that authorize it. |

Supported starting points are an empty database and a database at the
pre-upgrade `master` schema. A database that applied migrations from the
unreleased `feat/casino-platform-foundation` branch (including its
`20260923140000`–`20260923160000` repair-workflow migrations) is not one:
the preflight reports it as unsupported. No persistent environment ever
received those migrations; recreate any local database that did.

## The maintenance procedure

Do these steps in order and stop at the first one that does not pass. Commands
use the platform's own environment (`railway run --service api ...`) so no
connection string is typed on a command line.

### 1. Stop every writer

Stop the API service, the worker service, and every scheduled or one-off job
and admin script that can write to the database. On Railway, stop the API and
worker deployments themselves (a redeploy is **not** enough: the API's
`preDeployCommand` runs `prisma migrate deploy` while the previous deployment
keeps serving). Put the web application in maintenance so users see why.

### 2. Verify that no writer is connected

```sql
SELECT pid, usename, application_name, client_addr, backend_start, state, left(query, 80) AS query
FROM pg_stat_activity
WHERE datname = current_database()
  AND backend_type = 'client backend'
  AND pid <> pg_backend_pid();

SELECT gid, prepared, owner FROM pg_prepared_xacts WHERE database = current_database();
```

Both must return no rows other than sessions you can name as read-only (for
example your own `psql`). Run them again a minute later with the same result.
If the application uses its own role (prerequisite 4), you may also
`REVOKE CONNECT ON DATABASE <database> FROM playqube_app` for the duration and
grant it back in step 7.

### 3. Take a backup and prove it restores

```bash
railway run --service api sh -c 'pg_dump --format=custom --file=pre-ledger-upgrade.dump "$DATABASE_URL"'
pg_restore --list pre-ledger-upgrade.dump > /dev/null
```

Restore it into an empty scratch database, run the preflight there (step 4)
and confirm the same result as on the target, then drop the scratch database.
A platform volume backup is equally good if you perform the same test
restore. Keep the backup until the release has run cleanly for at least a
day.

### 4. Run the preflight

```bash
railway run --service api pnpm --filter api preflight:ledger-upgrade
```

It reads only `DATABASE_URL`, needs no `.env` file and no application
secrets, opens a READ ONLY transaction and never prints the connection string
or its credentials. In a built image without `tsx`, use
`node apps/api/dist/scripts/ledger-upgrade-preflight.js`. Add `--json` for a
machine-readable report and `--limit N` to list more records per category.

- **0**: no anomaly (schema `PRE_UPGRADE`). Continue.
- **1**: anomalies found; the upgrade would stop. Do not continue. Escalate
  (below).
- **2**: could not evaluate: no connection, an intermediate (unsupported)
  schema, or installed definitions that differ from this release. Do not
  continue. Escalate.

### 5. Apply the migrations

```bash
railway run --service api pnpm --filter database exec prisma migrate deploy
```

It must end with "All migrations have been successfully applied". Anything
else: see "If a migration fails".

### 6. Check the upgraded database

```bash
railway run --service api pnpm --filter api preflight:ledger-upgrade
railway run --service api pnpm --filter api scan:ledger-invariants
```

The preflight must exit 0 and report `Schema: UPGRADED`, gate definitions
identical to this release and the operation authorization rules installed.
The scan must exit 0 ("every invariant holds"); in a built image use
`node apps/api/dist/scripts/ledger-invariant-scan.js`. Also confirm that
`SELECT to_regclass('ledger_upgrade_window')` is NULL: the last migration
drops it only when the whole upgrade passed.

### 7. Restart the writers

Only after every check above passed: deploy the new release of the API and
the worker (their `preDeployCommand` now reports no pending migrations),
restore any revoked `CONNECT`, and leave maintenance.

## If a migration fails

`prisma migrate deploy` fails with `P3018` and names the migration. Each
migration runs in one transaction, so the failed one changed nothing; the
migrations before it **are** applied. Later deploy attempts fail with `P3009`
until the failure is resolved. Do not keep retrying, and keep every writer
stopped.

| The failed migration | What it means | Response |
|---|---|---|
| `20260917900000_ledger_preupgrade_gate` (`LEDGER PRE-UPGRADE GATE STOPPED THE UPGRADE`) | Anomalies in the current data, or a game's rules differ from `master` (`GAME_RULES_CHANGED`). Nothing of the release is applied. | 1. Save the preflight's `--json` report in the incident. 2. Escalate each record (below) and wait for its reviewed correction. 3. Re-run the preflight until it exits 0. 4. Record the gate as rolled back, which is accurate since it changed nothing: `railway run --service api pnpm --filter database exec prisma migrate resolve --rolled-back 20260917900000_ledger_preupgrade_gate`. 5. Continue from step 4 of the procedure. |
| `20260918010000_casino_foundation_schema` failing on `CREATE EXTENSION` | Prerequisite 2 is not met. Only the pre-upgrade gate is applied; it changed no data. | Restore the backup (below), fix the privilege or install `pgcrypto`, then start again from step 2. |
| Any later migration, including `LEDGER INTEGRITY GATE STOPPED THE UPGRADE`, `LEDGER AUTHORIZATION CHECK STOPPED THE UPGRADE`, `LEDGER UPGRADE WINDOW CHECK STOPPED THE UPGRADE`, a rules hash mismatch, or any other error | The database is at an intermediate schema no release was built for. The window check means something wrote while the release migrated: steps 1 and 2 missed a writer. | Restore the backup (below). Do **not** correct this database in place or mark anything resolved. Investigate on a copy, escalate with the error and the preflight report, and start again from step 1 only once the cause is understood and fixed. If the same stop repeats, the release itself is at fault: escalate to the ledger owner before any further attempt. |

### Restoring the backup

With every writer still stopped, restore the step-3 backup into an empty
database (the platform's backup restore, or `createdb` plus
`pg_restore --no-owner --dbname ...`), point the services' `DATABASE_URL` at
it if it is a new database, and run the preflight: it must report
`PRE_UPGRADE` and the same result as step 4. The previous release can then
be restarted if the upgrade is postponed.

## Escalation: a separately reviewed, case-specific correction

Every reported record is corrected on its own merits, or not at all.

- Record the preflight output, the affected users and records, and how they
  arose.
- Establish the true value from source evidence (agent settlements, wallet
  transactions, withdrawal records), not from the ledger row under question.
- Write the exact change for that case. Review it with a second person (the
  ledger owner plus one reviewer) before anyone runs it.
- Run it against the **pre-upgrade** database as a reviewed,
  version-controlled script. Attach the before and after preflight output to
  the incident.
- Unexplained **imported** balances are not corrections: they stay
  UNCLASSIFIED and go through the existing two-administrator legacy balance
  review.

## Coin adjustments after the upgrade

There is no generic administrator credit or debit. A Coin adjustment is an
`admin_adjustment_approvals` record that moves through three steps of the
ledger administration API, each by an active SUPER_ADMIN:

1. `POST /adjustments` records the request: the user, a signed whole number
   of Coins (not zero, at most 1,000,000,000 either way), a case ID and the
   evidence (a rationale of at least 10 characters and at least one
   non-empty supporting reference). Nothing moves. A case ID names one set of
   terms; repeating it with other terms is refused.
2. `POST /adjustments/:id/first-approval`.
3. `POST /adjustments/:id/second-approval` by a different SUPER_ADMIN, which
   rechecks that both approvers are still active SUPER_ADMINs and settles the
   adjustment in the same transaction. A credit mints UNCLASSIFIED value under
   a new legacy review (it can only become withdrawable through that
   two-administrator review); a debit consumes the user's existing lots.

Neither approver may be the adjusted user. `/reject` (any other SUPER_ADMIN)
and `/cancel` (the requester) close an open request with a reason. Executed,
rejected and cancelled requests never change and are never deleted, and each
executed request is consumed by exactly one `ADMIN_ADJUST` operation. The
database enforces all of this for every writer bound by it (prerequisite 4),
at commit, and invariant I16 re-checks it for all history.

The database cannot authenticate people. A writer who holds the owner or a
superuser credential can bypass any of it, and a writer who can issue
arbitrary SQL as the application role can fabricate a complete request with
both approvals if it names two real, currently active SUPER_ADMINs other than
the user. The binding makes such a fabrication visible (who, when, which
evidence) and still exact: the amount, the conservation and the
UNCLASSIFIED-only credit hold.

## Never

- mark any migration of this release as applied
  (`prisma migrate resolve --applied`). For the gates and checks that skips
  the check, leaves every anomaly in place, fails every later invariant run
  and records a bypassed control; for the others it records a schema change
  that never happened;
- run the upgrade with any writer still running, or restart one before step
  6 passed;
- edit ledger rows ad hoc, disable triggers, or run `session_replication_role`
  changes against a real database;
- build or use a generic admin credit, debit or lot-replacement tool. None
  exists, by design;
- edit a migration an environment has already applied, or run
  `prisma migrate reset` on a database whose data matters.
