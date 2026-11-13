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

Also: the boundary SQL is not installed, and no staff login exists.
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

**B. Staff login (role administrator).** Never put the password on a command
line. Give it no role settings (the guard refuses `SET ROLE`) and no
memberships.

```sql
\prompt 'staff password: ' pw
CREATE ROLE <staff> LOGIN PASSWORD :'pw' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
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

```sql
\set k `cat <private>/status.key`
SELECT staff_status_approval.install_key('<key_id>', decode(:'k', 'hex'));
```

The key must differ from every other secret (`signing-authority.md`).

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
- Reset-link binding to an owner issuance record, and a dedicated reset key
  (`signing-authority.md`, finding 1).
- Separate JWT secrets for workers, or remove them from worker configuration.
- Whether the API may hold both the status signing key and the staff
  credential, or whether approvals move to a separate signer.
- Retention of `staff_status_approval.approvals`.
- The staff password's storage, rotation cadence and owner.
- The connection-pooler mode: the guarded client refuses `SET ROLE` and needs
  `session_user` to be the staff login.
- Porting invitations and guarded account creation, which stay inactive.
