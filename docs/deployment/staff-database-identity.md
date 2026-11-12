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

`enforce` with a missing or invalid target (bad URL, role/URL mismatch,
different server or database, identity shared with another configured URL)
also returns 503 for staff operations only. Member sign-in, registration,
refresh and logout keep working in every mode.

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
GRANT UPDATE ("updatedAt") ON public.countries TO <staff_role>;      -- FOR SHARE lock
GRANT UPDATE ("updatedAt", "status") ON public.users TO <staff_role>; -- row locks; see below
GRANT UPDATE ON public.agent_account_setups TO <staff_role>;          -- credential reissue
GRANT DELETE ON public.sessions TO <staff_role>;                      -- suspension revokes sessions
```

The role must be `LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION`, not
`BYPASSRLS`, not a member of the owner or of any elevated role. This list is a
tested starting point, **not** an applied change.

## Known limitation: member status changes

`users_privilege_guard` lets only the table owner change a user's `role` or
`status`. That protection is unchanged and is proven by the native suite: under
a non-owner staff identity (even with `UPDATE ("status")` granted),
suspend/reactivate is refused with no status change, no audit row and sessions
intact. The same is true today for the restricted runtime role. Enabling staff
status changes under isolation therefore needs an operator decision (for
example a narrow `SECURITY DEFINER` function in the style of
`activate_provisioned_agent`, executable only by the staff role). That
migration is deliberately **not** included.

## Activation (operator, not done here)

1. In a disposable or staging database: create the staff role and grants above;
   confirm with `SELECT current_user` as that login.
2. Set `STAFF_DATABASE_URL` (same host/port/database as `DATABASE_URL`) and
   `STAFF_DATABASE_ROLE`, then `STAFF_DATABASE_ISOLATION=enforce`.
3. Check: create a synthetic agent account (201), member sign-in (200).
   A 503 on staff routes with member routes healthy means the identity was
   refused; the API log line `DATABASE_IDENTITY_REFUSED` carries the reason code.

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
