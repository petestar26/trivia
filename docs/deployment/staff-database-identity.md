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
- `/auth/refresh` refuses (401, session kept) a correctly signed refresh token
  whose subject is not the user who owns the matching session row, in addition
  to the `tokenVersion` check.
- Sign-in, refresh and Google sign-in read explicit columns only (refresh no
  longer reads `passwordHash` or whole rows), and their writes return only `id`.
  Tested through a column-restricted login that cannot read session IP/user
  agent or `users.updatedAt`, with `passwordHash` revoked after sign-in.
- Password change and owner-issued reset completion write without returning
  rows. Tested through a separate credential login holding only users
  `SELECT(id, status, role, passwordHash, tokenVersion)` and
  `UPDATE(passwordHash, tokenVersion, updatedAt)`, sessions
  `SELECT(userId)`/`DELETE` and audit `SELECT(id)`/`INSERT`; it cannot read
  emails, refresh tokens or audit contents.
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
GRANT EXECUTE ON FUNCTION public.staff_set_member_status(
  text, text, text, text, text, integer, text, text, text, text) TO <staff_role>;
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

### A caller-supplied administrator ID is not proof of approval

The first version of the boundary took `actor_id` as an argument and trusted it
after checking that the account was an active administrator. Anyone holding
the staff login could therefore name any administrator. Version 2 (the only
version in `docs/deployment/staff-member-status-boundary.sql`; installing it
drops the v1 signature) requires a signed approval:

- After `authenticate` has verified the administrator's access token against
  the database (current `tokenVersion`, `ACTIVE`), the route asks
  `apps/api/src/database/status-approval.ts` to sign the change with
  HMAC-SHA256 under `STAFF_STATUS_APPROVAL_KEY` (hex, 32-64 bytes) and its
  `STAFF_STATUS_APPROVAL_KEY_ID`.
- The signed payload binds the key ID, actor, the actor's `tokenVersion`, the
  member, the target status, the expected `updatedAt`, a SHA-256 digest of the
  reason, a random 256-bit nonce and an expiry 60 seconds ahead. It is
  newline-joined plain text so PostgreSQL and Node sign identical bytes.
- `public.staff_set_member_status(key_id, nonce, expires_at, signature, actor,
  actor_token_version, member, status, expected_updated_at, reason)` verifies
  the HMAC with an owner-only copy of the key (retired keys never verify),
  rejects an expired approval or one more than 5 minutes ahead, records the
  nonce in an append-only table (a replay is `APPROVAL_REPLAYED`; refused
  approvals are recorded too, as evidence), then re-checks under `FOR SHARE`
  that the actor is still an active `ADMIN`/`SUPER_ADMIN` **with the same
  `tokenVersion`**. A logout or revocation between signing and use voids it.
- Then the same narrow transition as before: only a plain `USER` between
  `ACTIVE` and `SUSPENDED`, optimistic `updatedAt` under `FOR UPDATE`, refresh
  sessions deleted on suspension, `tokenVersion` unchanged, one audit row
  naming the boundary version, nonce, key ID and database login. Never `role`.
- With no key configured, or a malformed one, isolated status changes return
  503 and the API still starts. Dormant mode never signs or calls the boundary.

### Where the key and evidence live

They live in their own schema, `staff_status_approval` (`keys`, `approvals`,
`install_key`, `retire_key`), not in `public`. This was found by the native
suite: `ledger_apply_runtime_grants` grants the API runtime login `SELECT,
INSERT, UPDATE, DELETE` on **every** table in `public` and then revokes a fixed
list (which is how `ledger_approval_keys` stays private). A key table in
`public` would have become readable by the runtime login the next time grants
were re-applied. The private schema is outside that function's reach; nobody
but the owner has `USAGE` on it. The installer refuses, atomically, a
pre-existing schema of that name owned by anyone else, and any object there
owned by, or any schema, table, column or function privilege there held by,
anyone but the owner.

### Trust limits (decide before activation)

- The API process holds both the staff database credential and the signing
  key. A compromise of that process can still sign. What the signature adds is
  that the staff **database login alone** (a leaked URL, a misrouted
  connection, a second service given the staff role) can no longer impersonate
  an administrator, and every change is bound to a live, current
  administrator session and leaves a single-use record. Separating signer and
  caller (a separate approval service, or asymmetric keys with a hardware or
  KMS-held private key) would be the next step.
- Members of `pg_read_all_data` or `pg_write_all_data` and superusers can read
  the key, as with `ledger_approval_keys`. Check memberships with the inventory
  (`docs/deployment/staff-identity-inventory.sql`).
- The key must differ from `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`,
  `LEDGER_APPROVAL_SIGNING_KEY` and every other secret
  (`docs/deployment/signing-authority.md`).

### Installation properties

- `SECURITY DEFINER`, owned by the `users` owner, `search_path` pinned to
  `pg_catalog, pg_temp`, every object revoked from `PUBLIC`, created in one
  atomic `DO` block that grants `EXECUTE` to nobody. The installer refuses to run
  as anyone but the `users` owner, or if the guard trigger is missing or
  disabled, or if pgcrypto is not in `public`.
- An operator-applied file, not a Prisma migration, so merging changes no
  schema. Disable: `DROP FUNCTION IF EXISTS public.staff_set_member_status(text,
  text, text, text, text, integer, text, text, text, text);`. That keeps the key
  and evidence; see `docs/deployment/staff-identity-runbook.md` for rotation,
  retirement and rollback.

The API uses the boundary only in `enforce` mode. A missing function, grant or
key fails closed with 503 and changes nothing.

Verified on disposable PostgreSQL (`src/database/member-status-boundary.native.ts`,
13 tests):

- A non-owner install is refused with nothing left behind.
- Installing leaves every non-owner privilege in `public` and in the private
  schema, and the guard's definition and trigger state, byte-identical. This
  holds after re-applying the runtime grants twice and after reinstalling.
- After the runtime grants are re-applied, `PUBLIC`, the runtime login and the
  staff login have no `USAGE` on the private schema and no privilege on the key
  or evidence tables. A planted schema, table, column or function grant, a
  planted object, or a foreign-owned schema is refused atomically.
- Suspend and reactivate work under a staff login with only `SELECT` on `users`
  plus `EXECUTE`. The approval and audit evidence are checked.
- Forgery is refused: a zero signature, the wrong key under the right ID, an
  unknown key ID, a changed actor, `tokenVersion`, member, status, expected
  version or reason, an expired approval, an approval too far ahead, a replay,
  and a retired key.
- A stale administrator session is `ACTOR_FORBIDDEN` (HTTP 403).
- The staff and runtime logins cannot read the key or evidence, or install or
  retire keys. The evidence is append-only (no `UPDATE`, `DELETE` or
  `TRUNCATE`).
- 23 out-of-scope requests change nothing, and exactly one of two concurrent
  suspensions wins.
- HTTP end to end: with a key, refresh 401, `/me` 403 and sign-in 403 while
  suspended, then sign-in 200 after reactivation; without a key, 503 and no
  change.
- Revoking the grant, uninstalling or removing the key fails closed and
  recovers; dormant mode is unaffected.

Mutation checks: removing the HMAC comparison, the retired-key filter, the
single-use nonce, the expiry check, the `tokenVersion` re-check, the
stray-privilege check or the schema-owner check each makes at least one test
fail.

## Activation (operator, not done here)

1. In a disposable or staging database: create the staff role and grants above;
   confirm with `SELECT current_user` as that login.
2. Set `STAFF_DATABASE_URL` (same host/port/database as `DATABASE_URL`) and
   `STAFF_DATABASE_ROLE`, then `STAFF_DATABASE_ISOLATION=enforce`.
3. Check: create a synthetic agent account (201), member sign-in (200).
   A 503 on staff routes with member routes healthy means the identity was
   refused; the API log line `DATABASE_IDENTITY_REFUSED` carries the reason code.
4. Member status changes (separate decision): follow
   `docs/deployment/staff-identity-runbook.md`. In outline: as the `users`
   owner, run the boundary file; generate a key outside the database and
   install it with `staff_status_approval.install_key`; set
   `STAFF_STATUS_APPROVAL_KEY_ID`/`STAFF_STATUS_APPROVAL_KEY` on the API; then
   `GRANT EXECUTE` on the boundary to the staff role only. Re-grant after any
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
