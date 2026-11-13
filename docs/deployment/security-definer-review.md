# SECURITY DEFINER functions any login can execute: review worksheet

Status: read-only review for the staff-identity security review. Nothing here
changes a function, grant or role.

**Scope.** Every `SECURITY DEFINER` function in `public` that `PUBLIC` can
execute after all migrations: 17 at release `a54696e`. Staff isolation adds
database logins, and each of them inherits `PUBLIC`'s `EXECUTE`, so each
function's own gate matters. The staff boundary and reset-issuance functions
added on this branch grant `EXECUTE` to nobody and are not in scope.

**Method.**
- Read each definition and its callers.
- Probe on disposable PostgreSQL 16 with a synthetic login that holds no
  table privilege at all.

`docs/deployment/staff-identity-inventory.sql` (`definer|…` rows) lists the
same set for any environment.

## Results

All 17 pin `search_path = pg_catalog, pg_temp` and schema-qualify what they
call.

| Function | Kind | Callable directly | Gate | Verdict |
| --- | --- | --- | --- | --- |
| `coin_allocations_guard()`, `coin_provenance_guard()`, `game_rules_immutable()`, `game_rules_validate_parent()`, `game_sessions_validate_rules_snapshot()`, `game_definitions_prevent_metadata_drift()` | Trigger | **No.** PostgreSQL refuses: "trigger functions can only be called as triggers" (probed) | Run only on their tables' writes. They only check and raise; no `INSERT`, `UPDATE` or `DELETE` | Fine. `EXECUTE` is irrelevant for trigger functions |
| `house_public_spin_proof(text)` | Read, stable | Yes | Input pattern. Only `spin_win` financial rounds; reveals the seed only after the draw | Public by design (`games/economics/house-public-proof.ts`) |
| `house_round_randomness_failures()` | Read, stable | Yes | None needed: returns only round IDs that fail integrity checks | Low sensitivity; used by recovery and the invariant checker |
| `ledger_approval_signature_valid(text,text,text,boolean)` | Read, stable | Yes | None: answers whether a signature verifies under an owner-only key | **Finding 2** (low) |
| `ledger_adjustment_request`, `_first_approval`, `_execute`, `_close` | Write | Yes | State machine, actor must be an active SUPER_ADMIN, and an assertion that `ledger_record_assertion` (not `PUBLIC`) verifies with the owner-only key | Actor is caller-supplied but bound by the signature. **Finding 3** (observation) |
| `ledger_review_first_approval`, `_reopen`, `_resolve` | Write | Yes | Same pattern as the adjustments | As above |
| `ledger_lock_economy_for_invariant_check()` | Lock | Yes | **None** | **Finding 1** (medium, availability) |

`practice-activation/provision.ts` already lists the 11 directly callable
functions as known `PUBLIC` functions, so this is existing, deliberate design.
The findings below are for the review to accept or change.

## Finding 1: any login can freeze writes to the economy (medium, availability)

`ledger_lock_economy_for_invariant_check()` runs
`LOCK TABLE … IN SHARE MODE` as its owner on `wallets`, `wallet_transactions`,
`coin_provenance`, `coin_lot_entries`, `economic_operations`,
`coin_ledger_accounts`, `legacy_balance_reviews`, `withdrawal_holds`,
`country_jurisdictions`, `country_casino_policies` and `game_sessions`.
`SHARE` blocks every `INSERT`, `UPDATE` and `DELETE` on them until the
caller's transaction ends.

Demonstrated on disposable PostgreSQL:
1. A synthetic login holding no privilege on any of those tables ran
   `BEGIN; SELECT public.ledger_lock_economy_for_invariant_check();`.
2. It held 11 `SHARE` locks.
3. The owner's own `ROW EXCLUSIVE` lock on `wallets` then timed out.

With `idle_in_transaction_session_timeout` at its default (off), such a lock
can be held indefinitely. Any login qualifies: the API runtime, every worker
login, and a staff login once isolation is active.

The only caller is the API's super-admin gate change
(`economy/ledger-admin-service.ts`), on the runtime login.

Where practice activation has run, `restrictKnownPublicCapabilities`
(`practice-activation/provision.ts`) has already moved this function from
`PUBLIC` to every role that existed at that moment. That keeps today's callers,
but every existing service login keeps the lock, while a login created later
does not get it.

Options (decisions; nothing applied):
- **Prepared, dormant:** `docs/deployment/economy-lock-restriction.sql`.
  - Run as the owner with `-v runtime_role=<API runtime login>`. It leaves
    `EXECUTE` with the owner and the runtime login only, revoking `PUBLIC` and
    every per-role grant (practice activation's included), and verifies the
    result.
  - It refuses a non-owner (whose `GRANT`/`REVOKE` would only warn), and a
    runtime role that is missing, cannot log in, is a superuser or is the
    owner.
  - Re-running it is harmless. Rollback is
    `GRANT EXECUTE ON FUNCTION public.ledger_lock_economy_for_invariant_check() TO PUBLIC;`.
  - Practice activation skips the function afterwards, since it is no longer
    `PUBLIC`.
  - Verified in `src/database/economy-lock-restriction.native.ts`:
    - the release behaviour (a login with no table privilege holds 11 locks);
    - refusals that change nothing;
    - after it runs, that login is refused and the runtime still locks;
    - it holds after runtime grants are re-applied, and the preDeploy runtime
      access check still passes;
    - re-running and rollback.

    Removing each of the public revoke, the per-role revokes, the runtime
    grant, the owner check and the runtime-role validation makes it fail.
- As defence in depth, set `idle_in_transaction_session_timeout` and
  `lock_timeout` on every login other than the owner (for example
  `ALTER ROLE <login> SET idle_in_transaction_session_timeout = '30s'`).
- Monitor `pg_locks` for `ShareLock` on these tables held by any session but
  the API's invariant check.

## Finding 2: a public signature oracle (low)

`ledger_approval_signature_valid` reads the owner-only `ledger_approval_keys`
and tells any caller whether a key ID, payload and signature match. It never
returns the key, and with a 256-bit HMAC key an oracle does not help forge a
new signature. Only `ledger_record_assertion` (owner-only) needs it.
Restricting it to the owner would remove the oracle at no cost, but it is not
urgent.

## Finding 3: ledger assertions do not expire (observation)

Ledger approvals are well bound:
- The signature covers subject, action, actor, user, amount, case, evidence
  digest and nonce.
- The nonce is unique, so each assertion is single use.
- `operation_authorization_guard` / `admin_adjustment_violation` re-check that
  an executing operation matches an `EXECUTED` approval: same user, two
  distinct active SUPER_ADMIN approvers, and signed assertions for exactly
  those terms.
- The operation and wallet-transaction IDs passed to `_execute`/`_resolve`
  are not signed, but they are foreign keys checked by that guard.

What they lack, compared with the new status boundary
(`staff-member-status-boundary.sql`), is an expiry and a binding to the
signer's session generation (`tokenVersion`). An assertion signed but never
submitted stays usable while its key is active and the subject's state still
allows the action. The API signs and submits within one request, so the window
is small. Aligning the ledger format would mean a new payload version, and is
for the ledger owners to decide.

## Re-running this review

1. Run the inventory and filter its `definer|` rows.
2. Any new function, or any change in a definition's digest (`guard|` rows
   cover the boundaries), needs a fresh look.
3. A function that grants `EXECUTE` to `PUBLIC` and writes, locks or reads
   secrets should name its gate in this table.
