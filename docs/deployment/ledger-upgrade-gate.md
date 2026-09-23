# Ledger upgrade gate: preflight, stop and escalation

The G0 ledger release converts every wallet into the managed Coin ledger. It
**detects** inconsistent ledger data and **fails closed**; it never repairs,
re-mints or reclassifies anything by itself. This page is the operating
procedure for that check.

## What checks the upgrade

| Where | What it evaluates |
|---|---|
| `20260917900000_ledger_preupgrade_gate` (first migration of the release) | What the upgrade *will* create from the current (pre-upgrade) data. Runs before any ledger table exists and changes nothing. |
| `20260924000000_ledger_integrity_gate` (last migration of the release) | The upgraded ledger itself, via `ledger_integrity_anomalies()`. Only if it passes does the migration install the write guards that keep these rules true afterwards. |
| Runtime invariant checker, invariant **I15** | The same `ledger_integrity_anomalies()` function. A failing run keeps every platform gate (casino play, bonus grants, withdrawals, prizes) closed. |
| Read-only preflight (`preflight:ledger-upgrade`) | Either of the two definitions above, whichever matches the schema it finds. |

All four use one definition of an anomaly
(`apps/api/src/economy/ledger-integrity-definitions.ts`); tests fail if any
copy drifts. The anomaly categories:

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

Two kinds of operation can create Coins outside a purchase, and the database
refuses a forged one when its entries are written:

- a `LEGACY_RESOLVE` must be the exact resolution of a RESOLVED legacy review
  of the same user and amount, matching the review's frozen evidence and
  approved proposal, approved by two distinct SUPER_ADMINs (neither of them the
  owner), both active at that moment;
- an `ADMIN_ADJUST` credit must mint only into UNCLASSIFIED lots, carry
  evidence, be recorded by a SUPER_ADMIN active at that moment who is not the
  owner, and be backed by exactly one matching successful wallet credit.

The runtime checker re-verifies both as invariant **I16**. It does not
re-check that the administrators are still active, since an administrator may
legitimately be deactivated after acting.

Supported starting points are an empty database and a database at the
pre-upgrade `master` schema. A database that applied migrations from the
unreleased `feat/casino-platform-foundation` branch (including its
`20260923140000`–`20260923160000` repair-workflow migrations) is not one:
the preflight reports it as unsupported. No persistent environment ever
received those migrations; recreate any local database that did.

## Before deploying the release

1. Take a backup or snapshot of the target database and confirm it restores.
2. Run the read-only preflight against the target, using the platform's normal
   environment. It reads only `DATABASE_URL`; it needs no `.env` file and no
   application secrets, opens a READ ONLY transaction, and never prints the
   connection string or its credentials.

   ```bash
   railway run --service api pnpm --filter api preflight:ledger-upgrade
   ```

   In a built image without `tsx`, use
   `node apps/api/dist/scripts/ledger-upgrade-preflight.js`. Add `--json` for
   a machine-readable report and `--limit N` to list more records per category.
   Never type a connection string with a password onto a shared command line.
3. Act on the exit code:
   - **0**: no anomaly; deploy.
   - **1**: anomalies found; the upgrade would stop. Do not deploy. Escalate
     (below).
   - **2**: could not evaluate: no connection, an intermediate (unsupported)
     schema, or installed definitions that differ from this release. Do not
     deploy. Escalate.

## If a deployment stops at a gate

The API service's pre-deploy `prisma migrate deploy` fails with `P3018` and
names one of the two gate migrations. The error message starts with
`LEDGER PRE-UPGRADE GATE STOPPED THE UPGRADE` or
`LEDGER INTEGRITY GATE STOPPED THE UPGRADE`, followed by each category with its
count and first record ids. Each gate runs in one transaction, so the failed
gate itself has changed nothing. Later deploy attempts fail with `P3009` until
the failure is resolved as below. Do not keep retrying.

### Stopped at the pre-upgrade gate

No ledger migration has run and the schema is unchanged. The previous release
keeps serving normally; Railway does not promote the new one.

1. Save the preflight's `--json` report in the incident.
2. Escalate each record (below) and wait for its reviewed correction.
3. Re-run the preflight until it exits 0.
4. Record the failed gate as rolled back. This is accurate: it made no change.

   ```bash
   railway run --service api pnpm --filter database exec prisma migrate resolve --rolled-back 20260917900000_ledger_preupgrade_gate
   ```

5. Redeploy normally.

### Stopped at the final integrity gate

This gate should not fire once the pre-upgrade gate has passed. If it does, data
changed while the migrations ran, or the projection missed a case. Treat it as
an incident:

1. The gate migration changed nothing, but every earlier migration of this
   release **is** applied, and the previous release was not built for that
   schema. Keep the platform in maintenance if the previous release
   misbehaves. The platform gates stay closed on their own, because invariant
   I15 fails.
2. Escalate immediately with the preflight's `--json` report.
3. Preferred recovery: restore the pre-deploy backup, redeploy the previous
   release, and investigate on a copy. Then run the preflight on the restored
   database, correct the data (reviewed, below), and deploy again.
4. Alternative, only if the incident owner decides so: apply the reviewed
   correction to this database, re-run the preflight until it exits 0, then
   `prisma migrate resolve --rolled-back 20260924000000_ledger_integrity_gate`
   and redeploy.

## Escalation: a separately reviewed, case-specific correction

Every reported record is corrected on its own merits, or not at all.

- Record the preflight output, the affected users and records, and how they
  arose.
- Establish the true value from source evidence (agent settlements, wallet
  transactions, withdrawal records), not from the ledger row under question.
- Write the exact change for that case. Review it with a second person (the
  ledger owner plus one reviewer) before anyone runs it.
- Run it as a reviewed, version-controlled script or migration. Attach the
  before and after preflight output to the incident.
- Unexplained **imported** balances are not corrections: they stay
  UNCLASSIFIED and go through the existing two-administrator legacy balance
  review.

Never:

- mark either gate migration as applied (`prisma migrate resolve --applied`).
  That skips the check, leaves every anomaly in place, fails every later
  invariant run, and records a bypassed control;
- edit ledger rows ad hoc, disable triggers, or run `session_replication_role`
  changes against a real database;
- build or use a generic admin credit, debit or lot-replacement tool. None
  exists, by design;
- edit a migration an environment has already applied, or run
  `prisma migrate reset` on a database whose data matters.
