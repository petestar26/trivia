# Staff identity runbook (dormant)

Setup, verification, session drain, rollback, recovery, key rotation and a
staging-rehearsal plan for:

- the staff database identity (`staff-database-identity.md`);
- the signed member-status boundary (`staff-member-status-boundary.sql`).

**Nothing here has been applied anywhere except disposable local databases.**
Angle brackets are placeholders an operator fills in privately; keep real
role names, URLs and inventories out of this public repository.

## 0. Keep everything inactive until these gates hold

In every environment that is not disposable, these stay **unset**:

- `STAFF_DATABASE_ISOLATION`. Unset means guarded account creation through the
  staff identity, and staff isolation, are inactive; agent provisioning stays
  on today's credential client.
- `STAFF_DATABASE_URL`, `STAFF_DATABASE_ROLE`.
- `STAFF_STATUS_APPROVAL_KEY_ID`, `STAFF_STATUS_APPROVAL_KEY`.
- `PASSWORD_RESET_ISSUANCE` (section 9) and `PASSWORD_RESET_SIGNING_KEY`
  (section 10).

Also: neither the boundary SQL nor the reset issuance SQL is installed, and no
staff login exists.
Invitations are not implemented on this branch (the candidate's invitation
flow was not ported), so there is nothing to switch on.

Before any staging step:

1. The identity inventory for the target is recorded and reviewed. That means
   the `staff-identity-inventory.sql` output, plus the facts outside the
   database listed in `database-ownership-assessment.md`.
2. The security review has signed off on:
   - the `signing-authority.md` findings (at least a decision on reset-link
     binding and key separation);
   - the status signer's trust limits;
   - the ownership layout.
3. `scripts/staff-identity-rehearsal.sh` passes on the commit being deployed.

Before production: staging evidence (section 7), explicit operator approval,
and a named owner for the window.

## 1. Disposable rehearsal (repeatable)

```bash
pnpm --filter api build
```

```bash
STAFF_REHEARSAL_ACK=disposable \
REHEARSAL_ADMIN_URL='postgresql://<admin>:<password>@127.0.0.1:<port>/postgres' \
  scripts/staff-identity-rehearsal.sh
```

It refuses any host other than localhost, any run without the
acknowledgement, and any run inside a deployment environment. It creates and
removes its own database (`staff_identity_rehearsal_throwaway`) and `sir_*`
roles. In 12 checked steps it:

1. Creates the non-superuser ownership layout.
2. Applies every migration through the SET-only migrator.
3. Applies runtime grants and the ledger key.
4. Runs the preDeploy checks: they pass for the runtime and refuse the owner.
5. Takes a baseline inventory.
6. Installs the boundary. The inventory may change only for the boundary; no
   grant; reinstall is idempotent.
7. Installs the status key and staff grants. The inventory may change only by
   those.
8. Verifies:
   - unsigned and replayed approvals are refused, signed changes work;
   - neither staff nor runtime can write status directly;
   - both key tables stay private, also after re-applying runtime grants;
   - preDeploy still passes.
9. Disables the boundary and keeps the evidence.
10. Recovers.
11. Rotates and retires a key.
12. Removes everything; the inventory must be identical to the baseline.

It was mutation-checked: a stray `PUBLIC` grant fails step 6, and a missing
HMAC check fails step 8.

## 2. Setup (staging first)

Save every inventory privately (it names roles). Run it each time:

```bash
psql -X -At -F '|' -v ON_ERROR_STOP=1 -f docs/deployment/staff-identity-inventory.sql > <private>/inventory-N.txt
```

**A. Baseline.** As the users owner: inventory-0. Run the preDeploy commands
as the runtime and keep their output.

**B. Staff login (role administrator).** Give it no role settings (the guard
refuses `SET ROLE`) and no memberships. Set the password with psql's
`\password`, which hashes it on the client so only a SCRAM verifier reaches the
server. Never put a password in SQL text, where `log_statement = 'ddl'` or a
failed statement would log it.

```sql
CREATE ROLE <staff> LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
\password <staff>
```

**C. Staff grants (users owner).** Use exactly the list in
`staff-database-identity.md` ("Grants verified"), without the boundary
`EXECUTE`.

**D. Verify (inventory-1).** The diff against inventory-0 may contain only:

- `role|<staff>|…`;
- `reach|<staff>|superuser=false,member_of_users_owner=false,can_set_users_owner=false,member_of_database_owner=false,predefined=none`;
- `grant|<staff>|…` lines matching step C.

Anything else: stop and roll back (section 5).

**E. Staff isolation (activation; not part of this change).** Set
`STAFF_DATABASE_URL`, `STAFF_DATABASE_ROLE`, then
`STAFF_DATABASE_ISOLATION=enforce`, and follow "Activation" in
`staff-database-identity.md`.

**F. Boundary (separate decision; users owner).**

```bash
psql -X -v ON_ERROR_STOP=1 -f docs/deployment/staff-member-status-boundary.sql
```

The inventory-2 diff may change only lines naming `staff_status_approval` or
`staff_set_member_status`, and the function count in `owner|objects in
public|…`. No `grant|` line may change.

**G. Status key.** Generate it outside the database, into a file only the
operator can read. Install it from that file, put the same value and key ID in
the API's secret store, then delete the file.

```bash
umask 077; openssl rand -hex 32 > <private>/status.key
```

Pass the key as a bind parameter (psql 16 or later). PostgreSQL logs the text
of any statement that fails, so a key written into the SQL would land in the
server log. This was rehearsed: a failing install with the key in the text
logged the key; the same failure through `\bind` logged only `$1, $2`. Bind
parameters are still logged on success when `log_statement = 'all'` or
`log_min_duration_statement` is 0 or more, so check those first. If they are
set, have the database administrator turn them off for the window; a
non-superuser cannot change them per session.

```sql
SHOW log_statement;                      -- none, ddl or mod
SHOW log_min_duration_statement;         -- -1
SHOW log_parameter_max_length_on_error;  -- 0
\set k `cat <private>/status.key`
SELECT staff_status_approval.install_key($1, decode($2, 'hex')) \bind '<key_id>' :k \g
```

The key must differ from every other secret (`signing-authority.md`). (The
API's own ledger key install already binds its parameters.)

**H. Allow the staff login to call the boundary (users owner).**

```sql
GRANT EXECUTE ON FUNCTION public.staff_set_member_status(
  text, text, text, text, text, integer, text, text, text, text) TO <staff>;
```

The inventory-3 diff may contain only the new `grant|<staff>|function
public.staff_set_member_status…` line, that function's `definer` line
(`execute=<staff>`), and the `key|` lines.

## 3. Verification checklist

- Inventory, for every service login (runtime, staff, workers): `superuser=false`,
  `member_of_users_owner=false`, `can_set_users_owner=false`,
  `member_of_database_owner=false`, `predefined=none`.
- `key|readable …` names no service login.
- `guard|trigger public.users.users_privilege_guard|…enabled=origin`, and the
  guard function's `md5` is unchanged from inventory-0.
- The boundary's `definer` line: owner is the users owner,
  `search_path=pg_catalog, pg_temp`, `execute=<staff>` only.
- The preDeploy checks pass as the runtime.
- API, with synthetic accounts only:
  - staff routes work and member sign-in works;
  - suspending a member makes refresh 401, `/me` 403 and sign-in 403;
  - reactivating makes sign-in 200 again;
  - the audit row shows `boundary: staff_set_member_status/v2`, an
    `approvalNonce` and `databaseLogin: <staff>`.
- With the key unset, status changes return 503 and other staff operations are
  unaffected.

## 4. Session drain

- **Member suspension.** The boundary deletes the member's refresh sessions in
  the same transaction. Their access tokens fail at the next request, because
  `authenticate` checks status every time (403).
  - Sockets: the handling instance disconnects them; other instances refuse at
    the next packet or private delivery.
  - `tokenVersion` is deliberately not advanced, so bounded own-funds-return
    access keeps working.
- **Member logout.** All devices; it advances `tokenVersion`
  (`access-token-revocation.md`).
- **Staff credential change.**
  1. Update the API's staff URL.
  2. Terminate the old sessions:
     `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = '<staff>';`

  In-flight staff transactions roll back. Staff routes return 503 until the API
  holds a working credential; members are unaffected. This was rehearsed in
  the native suite.
- **Status key change.** Approvals live 60 seconds, and the database accepts
  expiries up to 5 minutes ahead. Install the new key first, switch the API,
  then wait at least 5 minutes before retiring the old key ID.

## 5. Rollback (fastest first)

| Level | Steps | Effect | Undo |
| --- | --- | --- | --- |
| 0. API only | Unset `STAFF_STATUS_APPROVAL_KEY*` (status changes then 503 in `enforce`), or unset `STAFF_DATABASE_ISOLATION` (back to dormant), and restart | No SQL. Nothing written needs reverting | Set again |
| 1. Disable the boundary, keep evidence | `REVOKE EXECUTE ON FUNCTION <signature> FROM <staff>;` then `DROP FUNCTION IF EXISTS <signature>;` | Keys and approvals stay in `staff_status_approval`; audit rows stay | Rerun the boundary file (idempotent; keeps keys and evidence), then `GRANT EXECUTE` again |
| 2. Remove the staff login | Level 1, then revoke step C's grants, terminate `<staff>` sessions, `DROP ROLE <staff>` | The staff identity no longer exists | Setup steps B–D |
| 3. Remove the evidence (irreversible) | Only after exporting `staff_status_approval.approvals` under the retention policy: `DROP SCHEMA staff_status_approval CASCADE;` | The inventory equals the baseline (rehearsal step 12) | Reinstall from scratch with a new key |

## 6. Key rotation and retirement

1. Generate and install `<new_key_id>` (step G).
2. Switch the API to the new key and key ID, then restart.
3. Wait at least 5 minutes.
4. `SELECT staff_status_approval.retire_key('<old_key_id>');`

A retired key never verifies again. Keep its row, because evidence references
its ID. Rehearsed in step 11.

## 7. Staging rehearsal plan

Use a staging database seeded with synthetic data only, with its own
credentials, never production data. One operator runs it and a second
reviews the evidence.

1. Run section 1 on the release commit and keep the output.
2. Take inventory-0 and record the preDeploy output.
3. Run steps B–D. With `STAFF_DATABASE_ISOLATION` still unset, confirm API
   behaviour is unchanged.
4. Enable step E on staging. Confirm that staff routes return 503 and member
   routes stay healthy when:
   - `<staff>` briefly gets `CREATEROLE`;
   - its login is disabled;
   - the URL names another role.

   Restoring the role (removing `CREATEROLE`, re-enabling login) recovers
   without a restart; correcting the URL needs an environment change and a
   restart.
5. Run steps F–H. Run section 3, including two administrators suspending the
   same synthetic member at once (exactly one succeeds, the other gets 409).
6. Run rollback levels 0 and 1 and recover from each. Rotate the key
   (section 6).
7. Use levels 2–3 only if staging is being reset. Then the diff against
   inventory-0 must be empty.
8. Evidence to keep privately, never in this repository:
   - every inventory and diff;
   - preDeploy outputs;
   - HTTP status codes;
   - audit row IDs;
   - timings;
   - who ran each step.

Exit criteria: every diff matches its allowed set, no unexpected `grant|`
line, every rollback restores its prior inventory, and member routes stay
healthy throughout.

## 8. Decisions still open

- Ownership layout, and how and when to convert an existing database
  (`database-ownership-assessment.md`).
- Whether to activate reset issuance records (section 9) and a dedicated reset
  key (section 10). Both are built and dormant (`signing-authority.md`,
  finding 1).
- Separate JWT secrets for workers, or remove them from worker configuration.
- Whether the API may hold both the status signing key and the staff
  credential, or whether approvals move to a separate signer.
- Retention of `staff_status_approval.approvals`.
- The staff password's storage, rotation cadence and owner.
- The connection-pooler mode: the guarded client refuses `SET ROLE` and needs
  `session_user` to be the staff login.
- Porting invitations and guarded account creation, which stay inactive.
- `security-definer-review.md`, finding 1: any database login, the staff login
  included once it exists, can call `ledger_lock_economy_for_invariant_check()`
  and block writes to the economy tables for as long as its transaction stays
  open. Decide whether to restrict `EXECUTE` and set idle-transaction
  timeouts on service logins before creating new logins. The restriction is
  prepared as dormant operator SQL (section 11).

## 9. Owner password-reset issuance records (separate decision)

Closes `signing-authority.md` finding 1. It is independent of the staff
identity and can be activated on its own.

**Setup.** Run each step in a separate window from the staff steps.

1. Take an inventory.
2. As the users owner, install the records:

   ```bash
   psql -X -v ON_ERROR_STOP=1 -f docs/deployment/owner-password-reset-issuance.sql
   ```

   The inventory diff may change only lines naming `owner_password_reset`, and
   the function count in `owner|objects in public|…`. No `grant|` line may
   change.
3. From then on the owner CLI records every link it issues. Confirm with one
   synthetic account: issue a link, and check that
   `key|owner_password_reset issuance records|present` appears.
4. Allow the login behind the API's credential client to consume records:

   ```sql
   GRANT EXECUTE ON FUNCTION public.owner_password_reset_consume(text, text, integer) TO <credential login>;
   ```

5. Set `PASSWORD_RESET_ISSUANCE=enforce` on the API and restart. Links issued
   before step 2 have no record and stop working; they last at most 15
   minutes.

**Verify, with synthetic accounts only.**

- A link from the owner CLI resets the password once (HTTP 200), and a second
  use returns 401.
- A link computed from the signing secret alone returns 401 and changes
  nothing.
- `key|readable owner_password_reset.issuances|…` names no service login.
- With `EXECUTE` revoked, resets return 503 and change nothing.

**Rollback.**

| Level | Steps | Effect |
| --- | --- | --- |
| 0 | Unset `PASSWORD_RESET_ISSUANCE` and restart | Back to signature-only completion. Records are kept |
| 1 | `REVOKE EXECUTE` on the consume function, then `DROP FUNCTION IF EXISTS public.owner_password_reset_consume(text, text, integer);` | While enforced, resets return 503. Reinstalling the file restores it and keeps the records; grant `EXECUTE` again |
| 2 (irreversible) | After exporting `owner_password_reset.issuances` under the retention policy, drop the function and `DROP SCHEMA owner_password_reset CASCADE;` | The owner CLI stops recording; the inventory returns to its baseline (rehearsal step 12) |

Verified in `src/auth/password-reset-issuance.native.ts`; installation and
full removal are also part of the disposable rehearsal (section 1).

## 10. Dedicated password-reset signing key (separate decision)

Independent of sections 2 to 9. It stops holders of `JWT_ACCESS_SECRET`, such
as a worker's environment, from signing reset links.

1. Generate the key outside the database, into a file only the operator can
   read:

   ```bash
   umask 077; openssl rand -hex 32 > <private>/reset.key
   ```

2. Put the same value in `PASSWORD_RESET_SIGNING_KEY` for the API service, and
   in the environment the owner CLI runs in. It must differ from every other
   secret. Never give it to workers.
3. Restart the API. Links issued before the restart stop working; they last at
   most 15 minutes.
4. Verify with a synthetic account:
   - a link from the owner CLI completes (HTTP 200);
   - a link signed from `JWT_ACCESS_SECRET` gets 401.
5. Delete the key file.

**Rotation:** set a new value on the API and the CLI together and restart.
Only links issued under the old key stop working.

**Rollback:** unset it on both and restart. Links are derived from
`JWT_ACCESS_SECRET` again, and only links issued under the dedicated key stop
working.

**If the value is malformed:** issuing and completing resets return 503, before
any session is revoked, and nothing falls back to the shared secret. Fix the
value and restart.

Verified in `src/auth/password-reset-key.native.ts`.

## 11. Economy-lock restriction (separate decision)

Closes `security-definer-review.md` finding 1. Each file runs as the owner of
`public.ledger_lock_economy_for_invariant_check()`, with psql 10 or later.

**Prerequisites before production (none met by this branch):**

1. **Establish the target's actual state, read only.** Do not assume the
   release default or any candidate's evidence.
   - Take an inventory (`definer|public.ledger_lock_economy…` and `grant|`
     rows).
   - Run `docs/deployment/economy-lock-verify.sql`, which is expected to fail
     before the restriction. Its message names `PUBLIC` or the logins that can
     execute the function.
2. **Name every current caller.** In code, the only caller is the API runtime
   (`economy/ledger-admin-service.ts`, enabling a ledger gate). For every
   other role holding its own grant (for example from practice activation),
   confirm it never calls the function before listing it in `revoke_roles`.
   External tools and consoles count as callers.
3. **Resolve any layout the restriction refuses.** That means a login that
   can inherit from or `SET ROLE` to the runtime, a runtime that can act as
   the owner, or grants made by someone other than the owner. Change the
   memberships deliberately; do not work around the refusal.
4. **Confirm the owner-equivalent logins** the verify file will list
   (superusers, and members of the owner role such as a migrator) are the
   intended operators.
5. **Rehearse on staging** with the same files and record the inventories
   before and after, including a rollback.
6. **Schedule the window.** Sessions that already hold the lock keep it until
   their transaction ends, and an open transaction is not interrupted by the
   change. Drain or terminate stale idle-in-transaction sessions first, and
   set `idle_in_transaction_session_timeout` on service logins.
7. **Make verify part of every migration and provisioning step,** because a
   migration that drops and recreates the function silently resets it to
   `PUBLIC`.

**Apply:**

```bash
psql -X -v ON_ERROR_STOP=1 -v runtime_role=<API runtime login> -v revoke_roles=<role>,<role> -f docs/deployment/economy-lock-restriction.sql
```

```bash
psql -X -v ON_ERROR_STOP=1 -v runtime_role=<API runtime login> -f docs/deployment/economy-lock-verify.sql
```

Omit `revoke_roles` when only `PUBLIC` holds the grant. The apply refuses,
changing nothing, if the list does not match exactly. Then confirm the API can
still enable a ledger gate on staging.

**Rollback** restores exactly the captured pre-change grants, and refuses if a
captured role no longer exists:

```bash
psql -X -v ON_ERROR_STOP=1 -f docs/deployment/economy-lock-rollback.sql
```

Keep the `economy_lock_restriction` schema: it holds the capture, and after a
rollback it is the record of what was restored.

Verified in `src/database/economy-lock-restriction.native.ts` and in the
disposable rehearsal (section 1).

