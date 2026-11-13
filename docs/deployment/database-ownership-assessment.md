# Non-superuser database ownership: assessment

Status: assessment and disposable prototype only. No environment's ownership,
roles or grants are changed. Placeholders in angle brackets stand for the
names an operator chooses.

## Why it matters

`users_privilege_guard` lets a role change a user's `role` or `status` when
`pg_has_role(current_user, <users owner>, 'MEMBER')`. `MEMBER` follows **every**
membership chain, whatever its `INHERIT`, `SET` or `ADMIN` option, and a
superuser passes it for every role. The `SECURITY DEFINER` boundaries
(ledger approvals, the staff status boundary, agent activation) run as their
owner. So the set of roles that own, or can reach the owner of, `public` is
exactly the set that can change roles, statuses and ledger state without any
application check. If that owner is a superuser, the owner credential also
reaches the server's files, every database in the cluster, and row-security
bypass.

## Proposed layout

| Role | Attributes | Membership | Used by |
| --- | --- | --- | --- |
| `<owner>` | `NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`; owns the database, `public` objects and `staff_status_approval` | none | Nobody logs in as it |
| `<migrator>` | `LOGIN`, same restrictions | member of `<owner>` `WITH INHERIT FALSE, SET TRUE`; `ALTER ROLE <migrator> SET role = '<owner>'` | Migrations, owner CLIs, boundary and key installation. Held only by the operator |
| `<role_admin>` | `LOGIN CREATEROLE`, nothing else; never a member of `<owner>` | none | Creating and rotating login roles (PostgreSQL 16 gives it `ADMIN` only on roles it creates) |
| `<runtime>`, `<staff>`, worker logins | as the deploy docs require | **no membership of `<owner>` under any option** | Services |

## Prototype result (disposable PostgreSQL 16.15, synthetic data)

Using exactly the layout above in a throwaway database:

| Step | Result |
| --- | --- |
| All 130 Prisma migrations, applied by `<migrator>` (as `<owner>`, not a superuser) | Applied. No migration needs superuser |
| `CREATE EXTENSION pgcrypto` (first migration) | Allowed (pgcrypto is a trusted extension). Its 36 functions are owned by the bootstrap superuser, as PostgreSQL does for trusted extensions; the runtime-grant checks accept this |
| `ledger_apply_runtime_grants(<runtime>)` as `<owner>` | Applied |
| `ledger_install_approval_key`, staff boundary install, `staff_status_approval.install_key` | Applied |
| Guard | `<runtime>` refused on `users.status`; `<owner>` (through `<migrator>`) allowed |
| Key tables | `<runtime>` refused on `ledger_approval_keys` and on schema `staff_status_approval` |
| `preDeployCommand`: runtime identity check | Verified `<runtime>`; **refused** the `<migrator>` credential |
| `preDeployCommand`: `prisma migrate status` as `<runtime>` | Up to date |
| `preDeployCommand`: upgrade preflight | Clean |
| Owner reset CLI's database-owner check through `<migrator>` | Passes (`current_user` is the database owner) |
| Inventory (`staff-identity-inventory.sql`) | `<migrator>` member of `<owner>` (`set=true, inherit=false`); `<runtime>` reaches nothing; only the superuser can read either key table |

## What does not carry over unchanged

1. **Login provisioning needs a role administrator.**
   `practice-activation/provision.ts` runs `CREATE ROLE`. A non-superuser
   owner cannot, so that step needs `<role_admin>`, or pre-created roles.
2. **Converting an existing database takes one privileged session.** Moving
   ownership of existing objects needs a superuser (or a provider
   administrator) to run `ALTER ... OWNER TO <owner>` per object.
   `REASSIGN OWNED BY` cannot move objects from the bootstrap superuser.
   - Rehearse it on a restored copy and compare the inventory before and after.
   - Each `SECURITY DEFINER` function then runs as a non-superuser. No
     migration needs superuser powers: the scan found no event triggers,
     `LEAKPROOF`, `ALTER SYSTEM`, role creation, server-file access or
     replication settings.
3. **Who can `SET ROLE <owner>` is who can bypass the guard.** Keep it to
   `<migrator>`. The inventory's `reach` section must show
   `member_of_users_owner=false` for every service login.
4. **Default privileges.** None exist today. A later `ALTER DEFAULT PRIVILEGES`
   by the owner would grant future tables automatically; the inventory lists
   them.
5. **Managed providers.** Some providers offer no real superuser, or provide
   their own administrator role with special powers. Read the provider's role
   documentation, and record which provider-managed roles exist and their
   memberships.

## Metadata needed to verify actual roles and ownership

`docs/deployment/staff-identity-inventory.sql` (read only) collects the
in-database part. Run it as the owner before and after every step and diff:

- identity: server version, `current_user`, `session_user`, the users owner,
  and whether the running login is a superuser;
- every non-system role's attributes (`SUPERUSER`, `CREATEROLE`, `CREATEDB`,
  `REPLICATION`, `BYPASSRLS`, `LOGIN`, `INHERIT`, connection limit, expiry, role
  settings);
- every membership edge, with `ADMIN`, `INHERIT` and `SET` options and grantor;
- per login: superuser, member of the users owner, able to `SET` to it, member
  of the database owner, and membership of `pg_read_all_data`,
  `pg_write_all_data`, the server-file roles, `pg_signal_backend`,
  `pg_create_subscription` and `pg_checkpoint`;
- owners of the database, of every schema, and object counts per owner in
  `public` and `staff_status_approval` (extension members listed apart);
- `users_privilege_guard`, the boundary and append-only triggers: definition
  digests, owners and trigger state;
- every `SECURITY DEFINER` function's owner, pinned `search_path` and
  `EXECUTE` grantees. Seventeen pre-existing ones are executable by `PUBLIC`
  and gate themselves (trigger guards, signature-checked ledger approvals);
  the review should confirm each;
- every privilege held by a non-owner in `public` and `staff_status_approval`
  (schema, table, column, sequence, function), with grantor;
- default ACLs, extensions with schema and owner, key IDs and dates (never the
  secret), and which logins could read each key table;
- applied, failed and rolled-back migrations, and open connections per login.

Facts that are not in the database and must come from the operator:

- which service and person holds each credential (map each `DATABASE_URL`
  username to a service, without sharing the URL);
- whether a connection pooler sits in front of the database. In transaction
  pooling, `SET ROLE` and role settings may not apply per client;
- provider-managed roles, console access, and who can reset passwords;
- backup and replication identities, and where backups are readable;
- the secret holders listed in `signing-authority.md`.
