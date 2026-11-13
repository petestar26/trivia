# Signing authority

Status: investigation for the staff-identity security review. Nothing here is
deployed or changed by the PR #77 branch except the new, dormant
`STAFF_STATUS_APPROVAL_KEY`. Recommendations are decisions for the operator and
reviewers, not applied changes.

## Who can sign what

| Secret | Held by | A holder can | Database copy | Rotating it |
| --- | --- | --- | --- | --- |
| `JWT_ACCESS_SECRET` | API (signs and verifies access tokens). **Also derives the password-reset key**, and is the cookie plugin's secret (no cookie is signed today). Every worker and the owner reset CLI must have *a* value, because `@socialplay/config` requires it at import | Mint access tokens for any account, admins included, valid up to `JWT_ACCESS_EXPIRY` (15 minutes); **mint password-reset links (finding 1)** | None | Ends every access-token session (users refresh) and every outstanding reset link |
| `JWT_REFRESH_SECRET` | API; workers must have a value | Little on its own: `/auth/refresh` requires the exact token string stored in `sessions`, then the locked status and `tokenVersion` check. Also used to verify refresh tokens when picking a rate-limit bucket | None | Ends every refresh session (everyone signs in again) |
| `LEDGER_APPROVAL_SIGNING_KEY` | API | Sign ledger approval decisions. The database verifies them against its own copy | Owner-only `public.ledger_approval_keys`, explicitly revoked from the runtime by `ledger_apply_runtime_grants` | Re-install under a new key ID; pending approvals must be re-signed |
| `STAFF_STATUS_APPROVAL_KEY` (new, dormant) | API, in `enforce` mode only | With the staff database login: suspend or reactivate a plain member, only for an administrator whose **current** `tokenVersion` it names. Each approval is single use and recorded | Owner-only schema `staff_status_approval` | Install the new key ID, switch the API, retire the old key ID. Approvals expire within 60 s, so nothing is pending for long |
| `WEB_GATEWAY_SECRET` | Web gateway and API | Attest any client IP, so it chooses its own anonymous rate-limit bucket (for example, to avoid per-IP sign-in limits). Grants no access | None | Restart both together |
| `SECURITY_TOTP_ENCRYPTION_KEY` | API | Combined with read access to the database, decrypt stored TOTP secrets | None | Requires re-encrypting stored secrets |
| `PUSH_VAPID_PRIVATE_KEY` | API | Send push messages as the site | None | Subscribers must re-subscribe |
| Owner database credential | Migrations, the owner reset CLI, boundary and key installation | Everything in the database, including bypassing `users_privilege_guard` | n/a | Out of scope here; see the ownership assessment |

## Findings

### 1. A reset link needs only `JWT_ACCESS_SECRET`, not the owner (pre-existing, high)

`auth/password-reset.ts` derives its HMAC key from `JWT_ACCESS_SECRET`.
Issuance (`issueOwnerReset`, owner CLI only) checks that the database login is
the database owner, advances `tokenVersion` and writes an
`OWNER_PASSWORD_RESET_ISSUED` audit row. Completion (`completePasswordReset`,
public route `POST /auth/password-reset`) checks only:

- the HMAC;
- the expiry;
- that the account is `ACTIVE` and its role equals the claimed role;
- that its **current** `tokenVersion` equals the claimed version.

It never checks that the owner issued the link. A holder of `JWT_ACCESS_SECRET`
can therefore write a link with `version` set to the account's current
`tokenVersion`, which is a small counter, and set a new password for any
active account. That turns a 15-minute impersonation into a lasting takeover.
The "database-owner authority" recorded at issuance is not enforced at
completion.

Demonstrated locally on disposable PostgreSQL with a synthetic administrator.
This demonstration is not committed. A link computed from the secret alone was
accepted by the public route with HTTP 200, the password was replaced, and there
were zero issuance records.

### 2. One secret does four jobs (pre-existing, medium)

`JWT_ACCESS_SECRET` signs access tokens, keys reset links, is the cookie
plugin's secret, and must be present in every worker and in the owner CLI. The
staging guide said workers may reuse the API's value; it now says they must
not. Anything that obtains a worker's environment with a shared value gains
findings 1 and 3.

### 3. A forged access token reaches admin routes as that admin (inherent)

Roles always come from the database (`requireRole`, `requirePermission`), so a
forged token cannot raise a member to administrator. It can, however, act as
an existing administrator if it names their ID and current `tokenVersion`.
`authenticate` answers 401 or 200, which shows when the version is right. The
staff status signer trusts the authenticated session, so this also applies to
signed status approvals (recorded as a trust limit in
`staff-database-identity.md`).

### 4. `tokenVersion` is guessable (low)

It starts at 0 and advances by one at logout and reset. It is a revocation
counter, not a secret, so nothing should rely on it being unknown. Finding 1
is what makes it matter.

## Recommendations (decisions, not applied)

1. **Bind reset completion to an issuance record.** The owner CLI inserts the
   nonce digest, account, version and expiry into an owner-only table. The
   public route consumes it through an owner-defined function (single use)
   before changing the password. Then a signing key alone cannot produce a
   usable link, and completion enforces the owner authority the audit row
   claims. This needs operator SQL and a short window (links last at most 15
   minutes).
2. **Give resets their own key** (`PASSWORD_RESET_SIGNING_KEY`), held only by
   the API and the owner CLI, never derived from `JWT_ACCESS_SECRET`. Rotating
   it voids outstanding links only.
3. **Keep JWT secrets out of workers.** Split the configuration so worker entry
   points do not require them. Until then, give every worker its own random
   values (the staging guide now requires this).
4. **Give the cookie plugin its own secret, or none**, since no cookie is
   signed.
5. **Keep every key unique.** Compare digests of the keys out of band, never
   the keys. No login should be a member of `pg_read_all_data` or
   `pg_write_all_data`, because those can read both key tables. The inventory
   reports this.
6. **Asymmetric access tokens** (for example EdDSA) only help once
   verification moves out of the process that signs. Today the API does both,
   so this is lower priority than recommendations 1 to 3.

## Verifying without exposing a key

- `docs/deployment/staff-identity-inventory.sql` (read only) lists the logins
  that could read each key table, and the key IDs and dates. It never selects
  a secret.
- That a key pair matches is shown by behaviour, never by printing:
  - the ledger preflight verifies its key;
  - a status change with a matching key returns 200, a mismatched one 403.
