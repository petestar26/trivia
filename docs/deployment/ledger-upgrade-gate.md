# Ledger upgrade: maintenance procedure, gates and escalation

The G0 ledger release converts every wallet into the managed Coin ledger. It
**detects** inconsistent ledger data and **fails closed**; it never repairs,
re-mints or reclassifies anything by itself. This page is the operating
procedure for the upgrade and for every way it can stop.

The upgrade is supported **only with every writer stopped** (the maintenance
procedure below). The previous release writes wallets without the ledger, so
it must not run while the migrations do. The release detects a legacy
financial write made during the upgrade and stops (the window check), and a
migration that meets a writer's lock gives up after a bounded wait instead
of hanging (see "Lock waits and deadlocks"), but both are safety nets, not
support for live writers. **Upgrading with a writer running is not
supported.** Maintenance mode is mandatory.

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

4. **Two database credentials and an approval key.** See "Database roles
   and the approval key" below. Create the runtime role and generate the key
   before the upgrade; the setup runs in step 6.

## Database roles and the approval key

The database's guards bind every writer that is neither the owner of the
tables nor a superuser, and the approval trust boundary (signed approval
assertions, below) holds only against such a writer. So the release expects
two separate credentials:

| Credential | Used by | Can |
|---|---|---|
| **Owner** (the role that owns the tables) | `prisma migrate deploy`, `ledger:runtime-access`, reviewed escalation scripts | Everything, including reading the approval key and disabling guards. |
| **Runtime role** | The API and the worker (their `DATABASE_URL`) | Data access only (`ledger_apply_runtime_grants`): no writing approvals, assertions, the signing key or migration history, no changing any user's role or status, no rewriting or deleting financial history, and no switching off, replacing or shadowing a guard. |

Keep the owner credential out of the API and worker services' variables, so
neither process can read it: keep it in the secret store (or on a separate
service that never deploys) and supply it only to the owner-run commands.

**This repository does not configure Railway this way.** Today the Railway
API and worker share one `DATABASE_URL`, the owner's. Until an operator
creates the runtime role, installs the key and switches the services'
`DATABASE_URL` to it, the boundary described here is **not** in effect in that
environment: the guards and the approval binding still constrain the
application's ordinary code paths, but not arbitrary SQL issued with the
owner credential it holds.

### Create the runtime role (once, as the owner)

```sql
CREATE ROLE playqube_app LOGIN PASSWORD '<from the secret store>'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT CONNECT, TEMPORARY ON DATABASE <database> TO playqube_app;
```

Give it no other grants by hand; `ledger:runtime-access` applies them. Do not
use `ALTER DEFAULT PRIVILEGES` for it: that would give new tables full access
until the next setup run.

### Generate the approval key (once per key)

Every approval decision (a Coin adjustment request, each approval, a close;
a legacy review approval, reopen and resolution) is recorded with an
HMAC-SHA256 assertion that the API signs after authenticating the acting
SUPER_ADMIN. The assertion binds the approval or review ID, the action, the
actor, the user, the signed amount, the case ID, a digest of the exact
evidence and a single-use nonce. The database verifies it with its own copy of
the key, in the owner-only `ledger_approval_keys` table, and refuses any
approval without a valid one.

```bash
openssl rand -hex 32
```

Store the output as `LEDGER_APPROVAL_SIGNING_KEY` (32 to 64 bytes as hex, 64 to 128 characters)
and choose a `LEDGER_APPROVAL_KEY_ID` (1 to 64 characters of
`[A-Za-z0-9._-]`, default `primary`). Set both on the API service and supply
both to the setup command. The worker does not need them. Without the key
the API refuses every approval step (503) and nothing else changes.

### Apply the setup after every deploy that applied migrations (as the owner)

```bash
LEDGER_OWNER_DATABASE_URL=... LEDGER_RUNTIME_ROLE=playqube_app \
LEDGER_APPROVAL_SIGNING_KEY=... LEDGER_APPROVAL_KEY_ID=primary \
  pnpm --filter api ledger:runtime-access
```

Supply the values from the secret store rather than typing them (for example
`railway run --service <ops service> pnpm --filter api ledger:runtime-access`).
In a built image use `node apps/api/dist/scripts/ledger-runtime-access.js`.
It reads only these variables (no `.env` file), and in one transaction:

- refuses if `LEDGER_OWNER_DATABASE_URL` does not connect as the tables'
  owner, if the runtime role is that same role, or if its own
  `DATABASE_URL` is the owner credential (the services would still hold it);
- installs the key (`ledger_install_approval_key`; idempotent, and a
  different secret under an installed key ID is refused);
- applies `ledger_apply_runtime_grants('<runtime role>')`, which first
  revokes everything and then grants only data access, so it is idempotent and
  also covers tables added by the migrations just applied;
- takes from the runtime role `UPDATE` on every key another table follows by
  a cascading foreign key (an `id`, `countries.code`), keeping it on every
  other column. A cascade runs as the owner of the referencing table, and so
  do that table's triggers; the application never changes these keys. The
  setup verifies that none of them is left updatable, and refuses (exit 1,
  nothing changed) while any role the runtime role can become can change one:
  a membership usable by `SET ROLE` alone (the runtime role `NOINHERIT`),
  direct or through other roles, would let it start the cascade as that role.
  The refusal names each key and role; revoke that membership, or that role's
  `UPDATE` on the key, as its grantor, then run the setup again;
- makes sure the runtime role cannot create objects in the schemas where
  functions that run as the owner resolve names (`pg_catalog`, `public`,
  pgcrypto's): a function or operator the runtime role could create there
  would run with the owner's privileges. The setup revokes `CREATE` there
  from `PUBLIC` and from the role. It refuses (exit 1, nothing changed) if
  the role could still create there through a grant the owner cannot revoke
  or through a role it belongs to (inherited or by `SET ROLE`, the schema's
  owner included), or if it already owns anything there that it could have
  planted while it had that privilege. Revoke that grant or membership as
  its grantor, or check and drop what it owns, then run the setup again. On
  PostgreSQL 13 and 14, `PUBLIC` holds `CREATE` on `public` by default,
  granted by the superuser that owns the schema, so revoke it as that
  superuser first;
- refuses (exit 1, nothing changed) while any role outside the owner's
  trust can still create in those schemas. A role is inside it when it can
  act as a superuser or as the tables' owner; any other role (another
  application's, an operator's, a retired account) counts, however it gets
  `CREATE`: a grant, `PUBLIC`, a role it can become (inherited or by
  `SET ROLE`), or the schema's ownership. Whatever such a role created after
  the setup would be picked by code that runs as the owner: migrations, the
  preflight and the invariant scan, every function pinned to `public`, and
  the triggers a cascade from a key the runtime role changes runs as the
  owner. The setup revokes only its own grants (`PUBLIC`'s and the runtime
  role's); the refusal names every other role and the grant or role it
  creates through. Revoke that grant or membership as its grantor, or make
  the role one that can act as the tables' owner, then run the setup again;
- refuses (exit 1, nothing changed) while those schemas hold any object owned
  by such a role, such as a retired account that could create in `public` in
  the past (the PostgreSQL 13 and 14 default). An exact-type overload it left
  behind, such as `public.to_jsonb(integer)`, would be picked over the
  built-in by anything that runs as the owner and resolves names in
  `public`. The refusal names each object and its owner: check what they
  are, then drop them or reassign them to the owner (`ALTER ... OWNER TO`, or
  `REASSIGN OWNED BY`), and run the setup again;
- verifies every denied and every required privilege.

The approval functions themselves, the older guards and validators a
signed decision fires (`operation_authorization_guard`,
`admin_adjustment_violation`, `legacy_resolution_violation`,
`review_coverage_guard`, `unclassified_lot_review_violation`), and every
SECURITY DEFINER function (`coin_provenance_guard`, `coin_allocations_guard`,
`game_sessions_validate_rules_snapshot`,
`game_definitions_prevent_metadata_drift`, `game_rules_validate_parent`,
`game_rules_immutable`), and every trigger function a cascade can fire
(migration `20260924050000`: the Agent order and reservation proof guards,
the append-only guards, the coin lot, account and wallet guards, the policy
pointer, contest pin, game session and platform gate guards, and
`users_privilege_guard`) run with the fixed search path `pg_catalog, pg_temp`
and name every table and non-catalog function by schema, with exact argument
types, so no object another role creates is picked in their place, even one
created after the setup ran (the setup's checks hold only when it runs).
Invariant I3 reports any of them without that pin - it derives the cascade
triggers from the catalog, so a trigger added later to a table a cascade
writes is reported too - and reports `CREATE` in `public` or `pg_catalog`
held by any role outside the owner's trust if it is granted after the setup
ran.

It never prints a connection string, a password or the key. Exit codes:
**0** applied and verified; **1** refused or not verified (nothing changed);
**2** could not run (nothing changed). Do not start the API or the worker
until it exits 0.

With the runtime role in place, the API's `preDeployCommand`
(`prisma migrate deploy`) runs as that role: with nothing pending it reports
"No pending migrations to apply"; with a pending migration it fails with
`permission denied for table _prisma_migrations` before applying anything.
Migrations are then applied by hand as the owner, followed by this setup.

### Rotating the key

Install the new key under a **new** key ID with the setup command, switch
the API's `LEDGER_APPROVAL_SIGNING_KEY` and `LEDGER_APPROVAL_KEY_ID`, redeploy
the API, then retire the old key as the owner:
`SELECT "ledger_retire_approval_key"('<old key id>');`. A retired key signs
nothing new; assertions it signed stay verifiable. Never delete a key.

### What the boundary does and does not cover

It covers SQL issued as the runtime role, however that SQL is reached: such a
caller cannot write an approval or review decision except through the signed
procedures, cannot produce a valid signature, and cannot replay one for
another approval, action, actor or amount. A fabricated `ADMIN_ADJUST` or
`LEGACY_RESOLVE` rolls back at commit and changes nothing.

It does not cover the owner or a superuser (they can read the key and
disable guards), or anyone who holds both the API's signing key and SQL
access, for example a fully compromised API host. The key must therefore stay
in the secret store and the API process only. The runtime role can still
perform every other write the application performs (game play, agent,
withdrawal and gift flows, platform gates and policies); those are
constrained by the ledger's guards and invariants, not by signed approvals.

## What checks the upgrade

| Where | What it evaluates |
|---|---|
| `20260917900000_ledger_preupgrade_gate` (first migration of the release) | What the upgrade *will* create from the current data, and that the legacy game catalog holds exactly the rules `master` ships. Locks the legacy financial tables and the game catalog while it reads; changes no existing data. It also records a fingerprint of every legacy financial and provenance record in `ledger_upgrade_window`: every column `master` defines of each wallet, and of the wallet transactions (including the chronological `balanceBefore`/`balanceAfter` and the purchase evidence `referenceType`/`referenceId`/`description`), withdrawal holds, withdrawals, agent orders, settlements and reservations, gift transactions and game sessions, plus the game catalog. No migration of the release changes those columns. |
| `20260918020000`, `20260922020000`, `20260922060000` (catalog seed and rules-hash checks) | Stop if the frozen rules or their hashes differ from the expected ones. Each locks the catalog while it runs. |
| `20260924000000_ledger_integrity_gate` | The upgraded ledger itself, via `ledger_integrity_anomalies()`, with every ledger table locked. Only if it passes does it install the write guards that keep these rules true afterwards. |
| `20260924010000_ledger_resolution_authorization` | Installs the binding of `LEGACY_RESOLVE` and `ADMIN_ADJUST` to the records that authorize them, then stops if any operation already recorded breaks it. |
| `20260924040000_ledger_function_search_path` | Pins every schema function's `search_path` (schema first, `pg_temp` last); the functions that run as the owner get the stricter `pg_catalog, pg_temp`. |
| `20260924050000_ledger_cascade_trigger_search_path` | Gives every trigger function a cascade can fire the same strict `pg_catalog, pg_temp`, rules unchanged. |
| `20260924060000_ledger_runtime_grants_cascade_keys` | Installs the current `ledger_apply_runtime_grants` (cascade keys taken from the runtime role, and from every role it can become), also on a database that applied the earlier version with `20260924010000`. |
| `20260924090000_ledger_upgrade_window_check` (last migration) | Locks the same tables and compares every one of those records, field by field, with the fingerprint taken by the first migration; stops if anything changed while the release migrated, even when row counts and credited totals are unchanged. Drops `ledger_upgrade_window` when it passes. |
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
If the application already uses the runtime role, you may also
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

### 5. Apply the migrations (as the owner)

```bash
railway run --service api pnpm --filter database exec prisma migrate deploy
```

This uses the service's `DATABASE_URL`, which is the owner credential until
the runtime role is introduced. Once the services use the runtime role, run it
with the owner credential instead (from the secret store or the ops service;
see "Database roles and the approval key"). It must end with "All migrations
have been successfully applied". Anything else: see "If a migration fails".

Then, before any check or writer, set up the runtime role and the approval
key as the owner (`ledger:runtime-access`, same section). It must exit 0. If
the services still use the owner credential and no runtime role exists yet,
this step cannot run; the release still works, without the runtime trust
boundary (see that section).

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

Only after every check above passed: deploy the new release of the API
(with `LEDGER_APPROVAL_SIGNING_KEY` and `LEDGER_APPROVAL_KEY_ID` set) and the
worker (their `preDeployCommand` now reports no pending migrations),
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

### Lock waits and deadlocks

Every migration of the release that locks tables (`20260917900000`,
`20260918020000`, `20260922020000`, `20260922060000`, `20260924000000`,
`20260924010000`, `20260924090000`) first sets `lock_timeout = '20s'` for its
own transaction. With every writer stopped the locks are free and this
changes nothing. If a writer was missed and holds a conflicting lock:

- the migration waits at most 20 seconds and fails with
  `canceling statement due to lock timeout` (SQLSTATE `55P03`); or
- if the writer and the migration wait for each other, PostgreSQL's deadlock
  detector (after `deadlock_timeout`, 1 second by default) aborts one of them
  with `deadlock detected` (`40P01`). If it aborts the migration, the writer's
  transaction completes; if it aborts the writer, the migration continues and
  the window check at the end detects any legacy financial write the writer
  made earlier.

Either way the failed migration's transaction rolls back completely: none of
its changes is applied, and the tests prove that no partial change and no
ledger corruption remains. It always means steps 1 and 2 missed a writer.
Respond as the table above says for that migration (for the pre-upgrade
gate: find and stop the writer, repeat steps 2 to 4, record the gate as
rolled back and continue; for any later migration: restore the backup). A
lock timeout is not a retry signal, and it does not make a live-writer
upgrade supported.

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

The amount reaches the database as an exact number and is checked before
any conversion: a fractional value (`0.5`, `1.5`, `1e-3`) is refused, never
rounded. Two identical second approvals racing each other settle once; the
losing request is retried and returns the same settled operation.

Neither approver may be the adjusted user. `/reject` (any other SUPER_ADMIN)
and `/cancel` (the requester) close an open request with a reason. Executed,
rejected and cancelled requests never change and are never deleted, and each
executed request is consumed by exactly one `ADMIN_ADJUST` operation. The
database enforces all of this for every writer bound by it (the runtime role),
at commit, and invariant I16 re-checks it for all history.

Every one of these steps is also a signed approval assertion (see "Database
roles and the approval key"), and the executing `ADMIN_ADJUST` operation must
be backed by exactly one wallet transaction of its own: a succeeded Coin
credit or debit of that user for exactly the approval's amount, referenced to
the approval's case (`ADMIN` / case ID), and named by no other operation,
purchase settlement or lot. A purchase credit, a transaction of another case
or scope, or one another operation already used is refused, and invariant
I16 reports any historical mismatch. A writer limited to the runtime role therefore cannot fabricate a
request or an approval, even one naming two real, active SUPER_ADMINs: the
fabrication rolls back at commit and changes no operation, journal entry,
lot, review or wallet. The owner, a superuser, or anyone holding both the
API's signing key and SQL access remain outside this boundary; the binding
still makes what they record visible (who, when, which evidence) and exact.

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
