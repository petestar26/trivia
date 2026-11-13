# Owner password reset v2 (not deployed)

This change is based on release `a54696e`, independently of staff-access PR #77.
It does not authorize a production migration, grants, secret provisioning, merge,
or deployment. Review integration with PR #77's credential connection and narrow
user-update projections before combining branches.

## Security boundary

Reset links use a dedicated `PASSWORD_RESET_SECRET` (at least 32 characters,
cryptographically random, distinct from both JWT keys). No fallback is allowed.
The secret is optional at service boot for compatibility, but issuance and
redemption fail closed without it. Keep it only with the owner issuance process
and the API verifier; never web/browser services or logs. HMAC verification means
the API also holds signing capability: the private issuance ledger is the second,
independent authorization check, not the signing key alone.

The database owner CLI alone inserts the nonce, exact user, role, version and
expiry into `password_reset_private.issuances`. Audit rows are not authority.
A narrowly callable security-definer function atomically consumes a matching,
unexpired nonce. Consumption, password update, version increment, session deletion
and completion audit share one transaction. Failure rolls everything back.
User locking serializes reissue and redemption; old/superseded links fail version
checks. Issuance still revokes existing sessions and access tokens immediately.

The migration revokes PUBLIC and inherited named default grants. No runtime role
is granted anything automatically. Runtime accounts must not own this schema or
be superusers/members of the owner role. A compromised database owner can bypass
this boundary, as can a runtime with unrestricted credential-write authority;
this is not a claim of isolation from full API/database compromise.

## Rollout review required

1. Inventory actual database logins, owner-role membership, inherited privileges
   and the credential connection used by both CLI and API. Do not infer role
   separation from a different URL. Review PR #77 separately.
2. Rehearse migration using the database owner on a disposable clone. Confirm
   schema/table ACLs grant no runtime access and no PUBLIC function execution.
3. Pause reset issuance and redemption throughout mixed-version deployment.
   Old v1 API instances do not enforce the ledger. Install the migration as the
   database owner. A separately approved grant of EXECUTE on
   `public.consume_owner_password_reset(uuid,text,text,integer,timestamptz)` to
   the identified credential runtime role is required if it is not the owner.
   Do not grant ledger/schema access or owner-role membership to runtime roles.
4. Provision the independent secret through the approved secret manager, deploy
   v2 to **all** API/CLI instances, verify configuration privately, then re-enable
   reset flows. Do not include a real key in a command transcript or ticket.
5. All previously issued v1 links are deliberately invalid. Reissue only through
   the owner CLI after exact account verification. Do not migrate old audit rows
   into authorizations. Test with synthetic accounts, never customer passwords.

Do not roll back to v1 while reset endpoints are available: doing so restores the
original access-key-only reset vulnerability. Safe rollback disables reset flows
and keeps the ledger and v2 verification in place until a reviewed replacement.
Key rotation invalidates outstanding links and requires owner reissuance.
Retain consumed/expired issuance rows for the applicable audit-retention policy;
cleanup is a separate owner operation, not a runtime privilege.

## Verification

Run migrations on a disposable PostgreSQL database, then the API's
`vitest.password-reset.config.ts` suite. The native suite refuses non-local or
non-throwaway database destinations. Tests cover single winner, replay, reissue,
role/status/version checks, expiry, forged/no-record tokens, key absence/reuse,
rollback, ACLs, session revocation, browser origin and response secrecy. For
hostile default-ACL coverage create the disposable `reset_untrusted` role and
configure default table/function/schema grants before migrations; never run this
setup against a real database.

### Restricted runtime rehearsal

The native test creates a disposable, non-owner `LOGIN` with no superuser or
role-creation rights. It grants only public-schema usage; SELECT of user
id/role/status/tokenVersion; UPDATE of passwordHash/tokenVersion/updatedAt;
SELECT of session userId and session DELETE; audit INSERT and SELECT of its id;
and EXECUTE on the consumption function. It then uses a separate authenticated
Prisma connection to perform actual application redemption. Direct ledger reads
and issuance are denied. These are test grants, not a production grant script.
Password and audit writes explicitly return only id, avoiding Prisma's default
whole-row SELECT requirement.

A separate test installs a disposable completion-audit failure trigger and calls
actual `completePasswordReset`. It verifies password/version, session deletion,
ledger consumption and completion-audit insertion all roll back, then successfully
retries the same token after removing the trigger.

Exact integration with PR #77 head `ff3d5f728a714b803c2bed1ebdf7ab71b4889339`
is **not verified**: source retrieval for that review was blocked. Do not infer
compatibility from this release-based candidate. Preserve PR #77's narrow
projections and credential-routing safeguards during an authorized integration.
The actual production credential login and its memberships/permissions have not
been inspected or certified by these tests. Both remain rollout gates.

Use a fresh disposable cluster for each rehearsal (especially after an aborted
run). The restricted-login test removes its role and test grants on completion;
no production role or privilege is changed.
