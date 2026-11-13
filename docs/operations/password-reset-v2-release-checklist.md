# Reset v2: gated release plan

**Status: local candidate only. No production action authorized or performed.**
Source base: API line `3d8c9796292509e756e4f54e4ba2aa3e19fda753`.
The reset-only diff was transferred from release-based draft PR #79 without
removing or changing existing monitoring/provider runtime. PR #79 is not the
API deployment candidate.
This checklist is not evidence that current production has those revisions.

## 0. Resolve stop conditions before scheduling a rollout

- [ ] Obtain an authorized review path for the exact PR77 integration. Its
  `ff3d5f728a714b803c2bed1ebdf7ab71b4889339` source retrieval was denied; no
  alternate route has been attempted. Do not merge this candidate blind.
- [ ] Identify the exact deployed API revision, CLI revision and all instances.
- [ ] Verify the actual credential runtime login, owner, superuser flags,
  memberships, default ACLs and effective privileges. Local test roles say
  nothing about these production identities.
- [ ] Agree and test an approved way to block reset redemption on **every** old
  API instance and suspend all owner-CLI issuance during rollout. This branch
  does not implement a mixed-version kill switch. Merely omitting the new key
  cannot disable a v1 server. No ingress/routing change has been prepared or
  applied to production.
- [ ] Obtain approval for concrete migration, grants, secret provisioning and
  deployment once their actual targets and effects are known. This checklist
  does not grant that approval.

## 1. Prepare a reviewable release candidate

- Integrate without removing PR77's credential routing or narrow projections.
- Run migrations and the full targeted auth/reset suite on a fresh, disposable
  PostgreSQL cluster. Repeat restricted-login and hostile-default-ACL scenarios.
- Run API/config typechecks, lint, and exact-candidate CI. Local tests are not CI.
- Review the app artifact and migration together. Do not substitute legacy
  audit records for v2 issuance records. Verify no secret appears in artifacts,
  command output, application logs or web configuration.
- Record the deployment target, rollback artifact, operator and confirmation
  checklist. A rollback artifact must retain v2 validation or keep reset routes
  blocked; returning to accessible v1 is not acceptable.

## 2. Approved deployment order (not executed)

1. Block reset redemption everywhere and stop owner issuance; verify the block
   from outside the service before any mixed-version period. Ordinary login
   should remain available unless the approved maintenance plan says otherwise.
   Wait for all in-flight reset requests and owner-CLI processes to finish, and
   verify none remain before proceeding. An ingress block does not cancel
   already-running v1 operations. If termination is required, obtain approval
   for the exact affected processes/connections; do not kill unrelated traffic.
2. Take the approved recovery checkpoint. Retain issuance/audit data; no cleanup
   or destructive down-migration is part of this rollout.
3. Run the migration as the verified database owner. It is transactional and
   removes PUBLIC and inherited named default grants on the new private schema,
   ledger and consume function. A failed migration must not be marked applied.
4. Review effective ACLs. Grant only the approved credential login the required
   function EXECUTE and existing narrow credential/session/audit permissions.
   Do not grant private ledger access, owner membership or superuser privileges.
5. Provision a random independent `PASSWORD_RESET_SECRET` (32+ characters) to
   the owner CLI and API through the approved secret manager, never web services.
   The key must differ from both JWT keys. Record only presence/version, never
   its value. Deploy all API/CLI instances to the reviewed candidate.
6. Verify every instance is v2 and has the intended key version and database
   connection. Confirm zero old instances remain. Missing key or migration
   means reset stays unavailable, not bypassed. Keep the external block in place.
7. Perform only an explicitly approved synthetic-account smoke test, checking
   issuance, single redemption, session invalidation and replay denial. Do not
   reset a customer's password or issue a customer link for testing. Use only a
   separately approved isolated/direct test route while the global public block
   remains active; do not briefly reopen the public route to test.
8. Only after approval of the evidence, remove the block and resume owner
   issuance. Previously issued v1 links are invalid; reissue after exact account
   verification. No old-link grace period or audit-to-ledger backfill.

## 3. Abort and recovery matrix

| Failure | Safe response | Resume criterion |
| --- | --- | --- |
| Migration fails | Keep reset blocked; investigate/repair transaction state | Schema, function and migration history agree |
| Key absent/wrong/reused JWT key | Keep reset disabled; fix approved configuration | Independent key present consistently; synthetic check passes |
| Runtime permissions insufficient | Keep reset blocked; do not broaden to owner | Approved minimal grants and restricted-login test pass |
| Mixed v1/v2 instances | Keep global reset block; finish or abort deployment | All instances verified v2 |
| Password/audit/session write failure | Transaction must roll back; do not manually consume nonce | Cause fixed, same unexpired link can retry |
| Need rollback | Keep reset blocked; retain ledger; use reviewed v2-safe artifact | Never expose v1 completion route |
| Reset key rotation | Old links invalid; suspend issuance during inconsistent keys | Same new key version everywhere; owner reissues links |
| Owner/superuser runtime discovered | Stop release, record scope | Reviewed credential-isolation plan; no assumption of protection from owner compromise |

## 4. Evidence and limits

Local rollout runs passed 75/75 focused auth/reset tests on PostgreSQL 13.23,
16.15 and 18.6, including a real restricted authenticated login, owner-only
issuance, concurrency, replay, expiry, all ledger binding fields, legacy v1
rejection, hostile default grants, and full application rollback on actual audit
failure. API/config typechecks and focused ESLint passed. Independent static
review found no serious remaining issue.

The rollout tests additionally verify ordinary login with the reset key absent,
no credential or nonce mutation on failed reset, and recovery after the private
ledger is unavailable. A separate clean-process config-import smoke check
succeeded with the reset key omitted. These are local results, not production
availability guarantees.

Unverified: exact PR77 integration, current production revisions and identities,
production ACLs, secret inventory, rollout-block mechanism, remote CI, and any
production smoke test. No push, merge, deploy, production grants or funds/bets
are part of this work.
