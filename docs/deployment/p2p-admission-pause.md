# P2P admission pause (rollout cutover)

A database-enforced switch that stops **new** agent (P2P) deposits and
withdrawals while a mixed-version rollout is in progress. Migration
`20261119000000_p2p_admission_pause` installs it **unpaused**.

## What it does and does not stop

| Path | While paused |
|---|---|
| New deposit order (`agent_orders` INSERT) | Refused |
| New withdrawal quote (`withdrawal_quotes` INSERT) | Refused |
| New withdrawal hold (`withdrawals` INSERT, including from a quote issued before the pause) | Refused, whole transaction rolled back (no debit, no liquidity reserve) |
| Idempotent retry of an already-accepted deposit or withdrawal | Returns the existing order (replay is read before any insert) |
| Mark paid, release/settle, cancel, refund, expiry sweeps, payout claim/submit/confirm, appeals, held-deposit and late-payment recovery | Unaffected (no gated insert) |
| Crypto deposits/withdrawals, commission, country/agent/rate controls, platform gates | Unaffected |

It is enforced by `BEFORE INSERT` triggers, so it applies to **every writer**:
current and older API replicas, the worker, scripts and consoles. A refused
request tells new replicas to return `503 SERVICE_UNAVAILABLE`; replicas that
predate this change return a generic 5xx, and nothing is admitted either way.
A refused request can be retried with the same idempotency key after resume
and is admitted exactly once.

Only the exact effective owner of the control table can change the switch.
Role membership alone is not sufficient. Use the already-authorized migration
owner identity; do not broaden runtime grants or role memberships. The API's
restricted runtime role cannot update, delete or truncate it, and it needs no
grant to read it (the guard runs as the owner). `ledger_apply_runtime_grants()`
is unchanged.

## Procedure

Use the authorized effective **table owner** connection, never the API runtime.
Do not run these instructions as an unattended repair. Coordinate one operator,
retain each command result, and use `psql` with `ON_ERROR_STOP=1`. Any SQL error,
lock timeout, unexpected row count, failed commit, lost connection or uncertain
commit outcome means **STOP**. Do not continue rollout or resume. An open failed
transaction must be rolled back (or its connection closed); establish committed
state with a fresh read before deciding any separately approved retry.

The candidate migration uses transactional `SET LOCAL lock_timeout = '10s'`
and `statement_timeout = '60s'` before its DDL. A lock timeout aborts that
transaction; it is not a reason to bypass locking. These are per-statement/lock
bounds, not a promise of total rollout or queue duration. If this migration has
already been applied anywhere, do not rewrite its checksum: stop and prepare a
separately reviewed forward migration instead of editing applied history.

1. **Pre-check (read-only).** Reconcile using the query below. Any mismatch must
   be triaged. Confirm the control table has exactly one row with id 1, and record
   its current state and the effective table owner.
2. **Pause and drain new admissions.** Replace audit placeholders with properly
   quoted approved values. This transaction refuses a zero-row update:
   ```sql
   \set ON_ERROR_STOP on
   BEGIN;
   SET LOCAL lock_timeout = '10s';
   SET LOCAL statement_timeout = '60s';
   DO $pause$
   DECLARE affected bigint;
   BEGIN
     UPDATE public.p2p_admission_control
        SET paused = true, reason = '<change ticket>', "changedBy" = '<operator>'
      WHERE id = 1;
     GET DIAGNOSTICS affected = ROW_COUNT;
     IF affected <> 1 THEN
       RAISE EXCEPTION 'Expected exactly one P2P admission control row';
     END IF;
   END;
   $pause$;
   COMMIT;
   -- Separate post-COMMIT verification; never infer pause from UPDATE alone.
   DO $verify$
   BEGIN
     IF (SELECT count(*) FROM public.p2p_admission_control) <> 1 OR
        (SELECT count(*) FROM public.p2p_admission_control WHERE id = 1 AND paused IS TRUE) <> 1 THEN
       RAISE EXCEPTION 'Committed P2P pause was not verified';
     END IF;
   END;
   $verify$;
   SELECT id, paused, reason, "changedBy", "changedAt"
     FROM public.p2p_admission_control WHERE id = 1;
   ```
   Proceed only after COMMIT succeeded and the separate committed-state check
   confirms exactly one paused row. The pause waits on admissions already past
   the trigger; committed accepted payments remain obligations, not cancellations.
3. **Reconcile and roll out** only within separately authorized scope. Keep the
   pause, triggers and migration metadata intact throughout mixed-version work.
   Verify compatible processing for already-accepted records; pause alone does
   not make an old API's settlement logic compatible with newer accepted terms.
4. **Resume is a separate decision**, not an automatic consequence of rollout or
   app rollback finishing. Require verified writer inventory, compatible accepted
   payment processing, reconciliation and explicit operational approval first.
   Only then use the same transactional update pattern, with `paused = false`,
   an approved audit reason, a required affected-row count of one and COMMIT.
   Perform the separate post-COMMIT one-row verification with `paused IS FALSE`.
   Any error or uncertain state means stop, not automatic retry or resume.

## Application rollback keeps the database pause

Normal application rollback restores a separately verified compatible app
artifact while **leaving this migration, triggers, control row and pause in
place**. Do not drop the control or erase migration metadata. Do not resume
merely because older replicas are running. Old ordinary writers remain fenced
by the retained database triggers, but accepted-record processing compatibility
must still be independently established. If it is not, stay paused and use a
compatible roll-forward or another reviewed recovery plan.

Treat reopening admission on the new API as a separate go/no-go decision.
Once an order has been admitted under the new pricing rules, the historical
API is not a supported settlement writer: it can recompute its older USD
minimum and reject a valid new ETB order. Keeping the switch paused only
stops new admissions; it does not repair settlement. After reopening, pause
new admissions if needed but retain a compatible settlement writer or roll
forward. Do not restore the historical API as the sole writer. Before reopening,
a rollback still requires a confirmed pause and evidence that all outstanding
records are compatible. If the new web is live, account for its new API routes
and clients with cached bundles.

There is no production migration-removal recipe here. The prior destructive
removal/reapply helper and its native test were removed. The replacement native
test checks the normal rollback contract: retained paused control, refusal of
new ordinary admissions, accepted replay and preserved completed migration
history. It is source-only until run on a separately authorized disposable
synthetic database and does not claim to execute a historical deployed API.

## Bound legacy migration lock waits before rollout

This narrowed payment API candidate is based on the last verified Railway API
(`3d8c979`). It adds deposit destination revisions, held-deposit recovery, and
the P2P admission pause. It does not add the independent password-reset or
ledger-runtime repair migrations from the broader rehearsal archive. The
PG18 results from that archive are useful background, not evidence that this
exact three-migration sequence has been rehearsed.

Before any real migration, verify the exact candidate against a disposable
PG18 upgrade from the deployed migration history. The owner deploy URL must
have the approved lock and statement bounds. Prove `10s` and `2min` using
a read-only Prisma probe through the same proposed connection, without
independently injecting session settings. Preserve required existing
connection options and never log the URL. No statement-time budget at live
data volume has been established.

Before allowing the replacement API to take traffic, run the built
`ledger-runtime-identity-check.js` against the exact restricted runtime role,
not the owner connection. The check must confirm the held-deposit policy,
case-table privileges, and SELECT/INSERT on receiving-account revisions.
Migrations alone do not establish those grants. If the receipt fails, stop;
any canonical owner-run grants operation must be explicitly authorized and
followed by the same restricted-runtime check. Do not make the API an owner.

Before the DDL, enforce the approved writer-quiescence plan separately:
the admission control table does not exist before the migration. After the
DDL, commit the pause and verify it in a fresh read before treating admissions
as fenced. Confirm platform SIGTERM grace exceeds the app's 20-second outer
deadline and plan for the uploads-volume handover interruption.

Before migration, validate target identity and migration checksums, verify
backup and restore evidence for any future live run, and arrange the approved
writer quiescence. A timed-out migration can still stall ordinary writes on
tables it has already locked; the bound is not a zero-downtime guarantee.

On failure, stop before retry or application rollout. Check the state of the
exact migration session, migration metadata, checksums and the complete
expected catalog/data effects. Never kill the local deploy process as a
substitute for verifying the server-side state. Do not automate migration
resolution: completed-and-verified, fully rolled-back, and partial/unknown
outcomes need distinct recovery decisions; partial/unknown remains blocked.
App rollback must retain the pause and migration history as above.

## Reconciliation (read-only)

`P2P_RECONCILIATION_SQL` in `apps/api/src/agents/p2p-reconciliation.ts`, run
inside `BEGIN READ ONLY; ... ROLLBACK;`. This is a focused P2P consistency check, not a complete wallet reconciliation.
It returns one row (`rule`, `id`) per
mismatch and zero rows when all of the following hold: completed deposits have
exactly one settlement and one matching wallet credit; reservation state follows
order state; agent inventory and fiat-liquidity reserved balances equal their
active reservations; withdrawal holds, debits, refunds and settlements match
their withdrawal; and P2P wallets' balances equal their latest ledger
`balanceAfter`. Compare its output before the pause, after the drain and after
resume. Any new row means something changed that should not have.

## Not covered by synthetic tests

Earlier upstream proof reported fresh loopback PostgreSQL 16 synthetic data;
this follow-up has not executed SQL or native tests. Its owner identity, DDL lock
bounds and replacement rollback test still require disposable validation. A
staging rehearsal must still confirm: the owner connection and lock timeout on
the hosted database; the Railway rolling deploy with real old/new replicas;
the member and agent UI for the 503 (new) and 5xx (old) refusals; PostgreSQL
13/18 (CI matrix); and that pausing under real traffic causes no lock queue
longer than the chosen `lock_timeout`.

A `wallet_ledger_tail_ambiguous` row is indeterminate, not a confirmed
balance mismatch or an all-clear. Multiple COINS ledger writes can share
one timestamp and random IDs are not chronological. Resolve such rows with
an independently verified balance reconciliation before resuming.
