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
- **Prepared, dormant:** three operator files, all run as the function's
  owner. Nothing in the repository applies them.

  | File | Purpose |
  | --- | --- |
  | `docs/deployment/economy-lock-restriction.sql` | Apply, with `-v runtime_role=<API runtime login>` and, when named consumers exist, `-v revoke_roles=<role>,<role>` |
  | `docs/deployment/economy-lock-verify.sql` | Read-only check, with `-v runtime_role=…` |
  | `docs/deployment/economy-lock-rollback.sql` | Exact rollback |

  **Unsupported layouts fail closed.** The restriction refuses, changing
  nothing:
  - a non-owner, whose `GRANT` and `REVOKE` would only warn;
  - a runtime role that is missing, cannot log in, is a superuser, is the
    owner, or can act as the owner through any membership;
  - any other role (superusers and owner-equivalents aside) that can inherit
    from, or `SET ROLE` to, the runtime, directly or through a chain of roles.
    Restricting `EXECUTE` to the runtime would quietly extend it to them;
  - an `EXECUTE` grant made by someone other than the owner, which the owner
    cannot revoke;
  - named consumers (roles with their own grant, such as those practice
    activation leaves) that are not listed exactly in `revoke_roles`. A role
    is never revoked silently.

  **What it changes.** Before its first change it captures the exact
  pre-change grants, grant options included, in an owner-only schema
  (`economy_lock_restriction`). A re-run keeps the original capture. It then:
  - grants the runtime `EXECUTE` without grant option;
  - revokes `PUBLIC` and the listed roles;
  - verifies the direct ACL (owner and runtime only) and the effective access.

  **Effective access** means any way a login could run the function: directly,
  through an inherited role, or after `SET ROLE` to any role, the runtime
  included. Only superusers and owner-equivalent logins may do so besides the
  runtime. The verify file lists those logins, so a reviewer can confirm they
  are the expected operators.

  **Rollback** restores exactly the captured grants:
  - `PUBLIC` for the release default;
  - the named roles, with their grant options, for a start that was already
    restricted.

  It refuses when there is nothing to restore, when run by a non-owner, or when
  a captured role no longer exists; it then marks the capture restored.
  There is no generic `GRANT … TO PUBLIC` rollback any more.

  **Provisioning and migrations.**
  - Practice activation (`restrictKnownPublicCapabilities`) and
    `staging-practice-owner.ts` act only on functions `PUBLIC` can still
    execute, so they skip it once restricted. The real activation code was
    checked in a dry run: it plans a change for this function before the
    restriction and none after. `ledger_apply_runtime_grants` leaves it
    unchanged, and the preDeploy runtime check still passes.
  - **What breaks it, and what repairs each case.** Run the verify file
    after every migration and provisioning step; it catches all three:

    | Drift | Effect | Repair |
    | --- | --- | --- |
    | A migration drops and recreates the function | Its grants reset to `PUBLIC` | **Re-applying the restriction repairs it** and keeps the original capture (tested) |
    | A later direct grant to another role | That role can call it | Re-applying refuses until the role is listed in `revoke_roles`; listing it is a decision about a named consumer |
    | A later membership through which a login can inherit from or `SET ROLE` to the runtime | That login can call it | **Re-applying does not repair it.** It refuses, fail closed, names the role, and changes neither the grants nor the capture (tested). The repair is a separately approved role-layout correction, usually revoking that membership. Verify then passes with no re-apply needed |

    A migration using `CREATE OR REPLACE` keeps the restriction.

  **Verified** in `src/database/economy-lock-restriction.native.ts` (10 tests,
  PostgreSQL 13 to 18, effective access asserted by calling the function as
  real logins). The tests cover:
  - every unsupported layout above, including `SET ROLE` through a NOINHERIT
    login, the explicit `INHERIT FALSE, SET TRUE` form on PostgreSQL 16+, and
    a NOLOGIN chain;
  - an already restricted start, with a group consumer and a grant option,
    through apply and exact rollback;
  - re-runs, rollback refusals, and the runtime's own prior grant option;
  - the provisioning dry run and the migration recreate;
  - drift by inheritance and by `SET ROLE` only. Re-applying is refused with
    the grants and the capture unchanged, and the drifted login can still take
    the lock until the role-layout correction.

  13 mutation checks across the three files are each caught. The disposable
  rehearsal applies, verifies (listing the `SET`-only migrator as
  owner-equivalent: refused as itself, able after `SET ROLE` to the owner) and
  rolls back to an identical baseline inventory.

  **Comparison with the separately reviewed candidate `6818dbe3`: incomplete.**
  It stays incomplete until the authorized artifact for that commit is made
  available. I could not reach it from this repository:
  - no remote ref points at it, and no fetched branch contains it;
  - no pull request, issue or commit search finds it;
  - it is not in the archive supplied earlier.

  It was not reconstructed. That archive's review notes (an earlier
  candidate) report two things, and this design follows both:
  - catalog evidence in which the economy lock already had owner-only or
    named-consumer grants. This has not been verified here;
  - a design that preserves named (non-`PUBLIC`) grants and restores a
    complete ACL snapshot on failure.

  Its deployed state must be established with the read-only inventory and the
  verify file, not assumed from either.
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
