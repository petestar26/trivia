# Staff database identity (dormant)

Status: **dormant**. Nothing changes in any environment until an operator sets
`STAFF_DATABASE_ISOLATION=enforce`. No migration, role, grant or deployment
setting is part of this change.

## What changed in code

- Authentication, sessions, referral generation, password change/reset, agent
  provisioning and member status changes no longer import a database client.
  Each receives one explicitly; the only place clients are chosen is
  `apps/api/src/routes/index.ts` (plus the two owner CLIs, which pass their own).
- Registration's own-referral-code uniqueness pre-check now runs on the
  registration transaction (`tx`) instead of the global client.
- Route plugins (`authRoutes`, `workspaceRoutes`, `adminAgentAccountRoutes`)
  refuse to register without their clients, and staff operations throw
  `STAFF_DATABASE_REQUIRED` without one. There is no default to fall back to.
- `apps/api/src/database/identity.ts` adds a guarded client. Inside **every**
  transaction, before any work runs, it reads `current_user`/`session_user` and
  refuses the transaction (`DatabaseIdentityError`, HTTP 503, reason code only)
  when the connection is:
  - shared with another configured identity (`DATABASE_URL`, both worker URLs,
    ledger/house owner URLs) — `SHARED_IDENTITY`;
  - switched with `SET ROLE` on a pooled connection — `ROLE_SWITCHED`;
  - not exactly `STAFF_DATABASE_ROLE` — `ROLE_MISMATCH`;
  - able to act as a superuser, `BYPASSRLS`, `CREATEROLE`, replication or a
    data-wide predefined role (`pg_read_all_data`, `pg_write_all_data`, server
    file/program roles), directly or through membership — `ELEVATED`;
  - able to act as the database owner or the owner of `public.users` (which
    would bypass `users_privilege_guard`) — `OWNER`.
  Verification is never cached: a role elevated later is refused on its next
  transaction, and a repaired role is accepted again without a restart.

## Modes (`STAFF_DATABASE_ISOLATION`)

| Value | Staff operations use | Notes |
| --- | --- | --- |
| unset or empty | existing logger-free credential client (`DATABASE_URL` identity) | Today's behaviour. `STAFF_DATABASE_URL`/`ROLE` are ignored. |
| `enforce` | `STAFF_DATABASE_URL` as `STAFF_DATABASE_ROLE`, verified per transaction | Same host, port and database as `DATABASE_URL`; different role. |
| anything else | nothing — every staff operation returns 503 | Typos fail closed rather than silently staying on the shared identity. |

`enforce` with a missing or invalid target (bad URL, a malformed
percent-escape in the login of `STAFF_DATABASE_URL`, `DATABASE_URL` or another
identity URL, role/URL mismatch, different server or database, identity shared
with another configured URL) also returns 503 for staff operations only. The
resolver never throws: the API starts, and member sign-in, registration,
refresh, logout and `/health` keep working in every mode.

Staff operations covered: create agent account, approve existing member as
agent, list pending agent accounts, reissue agent temporary password, member
suspend/reactivate. Agent self-activation stays on the credential client (it is
member-facing and uses the existing `activate_provisioned_agent` grant).

## Grants verified on disposable PostgreSQL 16

The native suite (`src/database/staff-identity.native.ts`) provisions agents
through a synthetic staff role holding only:

```sql
GRANT USAGE ON SCHEMA public TO <staff_role>;
GRANT SELECT, INSERT ON public.users, public.user_auth_identities, public.agents,
  public.agent_applications, public.agent_account_setups, public.audit_logs TO <staff_role>;
GRANT SELECT ON public.countries, public.sessions TO <staff_role>;
GRANT UPDATE ("updatedAt") ON public.countries TO <staff_role>;  -- FOR SHARE lock
GRANT UPDATE ("updatedAt") ON public.users TO <staff_role>;      -- row locks only
GRANT UPDATE ON public.agent_account_setups TO <staff_role>;      -- credential reissue
-- Member suspend/reactivate (only after the boundary below is installed):
GRANT EXECUTE ON FUNCTION public.staff_set_member_status(text, text, text, text, text) TO <staff_role>;
```

The staff role needs no `UPDATE` on `users.status`/`role`, no `DELETE` on
`sessions` and no `INSERT` on `audit_logs` for status changes; the boundary does
those as the owner. (The identity suite adds `UPDATE ("status")` only briefly,
to prove that the guard, not a missing grant, refuses a direct change.)

The role must be `LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION`, not
`BYPASSRLS`, not a member of the owner or of any elevated role. This list is a
tested starting point, **not** an applied change.

## Member status changes: the narrow boundary (dormant)

`users_privilege_guard` lets only the table owner change a user's `role` or
`status`; it is unchanged. Two facts shaped the design:

- The production runtime grants (`ledger_apply_runtime_grants`) allow `UPDATE`
  on 13 `users` columns but **not** `status` or `role`. So with the restricted
  runtime login the deploy docs require, today's direct suspend/reactivate path
  (the dormant mode, which uses that identity) is refused with `permission
  denied` (HTTP 500). This is pre-existing and left unchanged here; the native
  suite records it.
- A non-owner staff login, even with `UPDATE ("status")`, is refused by the guard.

`docs/deployment/staff-member-status-boundary.sql` installs
`public.staff_set_member_status(actor, member, status, expected_updated_at, reason)`:

- `SECURITY DEFINER`, owned by the `users` owner, `search_path` pinned to
  `pg_catalog, pg_temp`, created and revoked from `PUBLIC` in one atomic `DO`
  block. It grants `EXECUTE` to nobody. The installer refuses to run as anyone
  but the `users` owner, and refuses if the guard trigger is missing or disabled.
- Only moves a plain `USER` between `ACTIVE` and `SUSPENDED`; re-checks an active
  `ADMIN`/`SUPER_ADMIN` actor under `FOR SHARE`, refuses self-changes, staff,
  pending, banned and inactive accounts, and matches the optimistic `updatedAt`
  under `FOR UPDATE`. It never changes `role`.
- Same effects as the direct path: refresh sessions deleted on suspension,
  `tokenVersion` unchanged (bounded own-funds-return access keeps working), one
  audit row (with the database login recorded). Returns an outcome code; the API
  maps it to the same HTTP responses as the direct path.
- It is an operator-applied file like `repair-practice-runtime-reads.sql`, not a
  Prisma migration, so merging cannot change any schema. Uninstall with
  `DROP FUNCTION IF EXISTS public.staff_set_member_status(text, text, text, text, text);`

The API uses it only in `enforce` mode. Missing function or missing grant fails
closed with 503 and changes nothing. Dormant mode never calls it.

Verified on disposable PostgreSQL (`src/database/member-status-boundary.native.ts`):
non-owner install refused with nothing left behind; installation leaves every
non-owner privilege in `public` and the guard's definition and trigger state
byte-identical, also after re-running the runtime grants; runtime and `PUBLIC`
cannot execute it; suspend and reactivate work under a staff login with only
`SELECT` on `users` plus `EXECUTE`; 23 out-of-scope requests change nothing;
exactly one of two concurrent suspensions wins; HTTP end to end (refresh 401,
`/me` 403, sign-in 403 while suspended, sign-in 200 after reactivation);
revoke/uninstall fail closed and recover; reinstall is idempotent. The API's
`preDeployCommand` checks (runtime identity, `migrate status`, upgrade
preflight) and the owner setup pass before install, after install, after the
owner setup is re-run and after uninstall.

## Activation (operator, not done here)

1. In a disposable or staging database: create the staff role and grants above;
   confirm with `SELECT current_user` as that login.
2. Set `STAFF_DATABASE_URL` (same host/port/database as `DATABASE_URL`) and
   `STAFF_DATABASE_ROLE`, then `STAFF_DATABASE_ISOLATION=enforce`.
3. Check: create a synthetic agent account (201), member sign-in (200).
   A 503 on staff routes with member routes healthy means the identity was
   refused; the API log line `DATABASE_IDENTITY_REFUSED` carries the reason code.
4. Member status changes (separate decision): as the `users` owner, run
   `psql -X -v ON_ERROR_STOP=1 -f docs/deployment/staff-member-status-boundary.sql`,
   then `GRANT EXECUTE` on it to the staff role only. Re-grant after any
   uninstall/reinstall (dropping the function drops its grants).

## Recovery and rollback

Rehearsed in the native suite on disposable PostgreSQL:

- Identity drift (e.g. role gains `CREATEROLE`): staff routes 503 immediately,
  members unaffected; reverting the role restores staff routes with no restart.
- Staff login disabled and its sessions terminated: staff routes 503, members
  unaffected, nothing partially written; restoring `LOGIN` recovers on a
  following request.
- Rollback: unset `STAFF_DATABASE_ISOLATION` and restart; staff operations
  return to the credential client even if the staff role is unusable. No data
  or schema change needs reverting.
