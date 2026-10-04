# Exact-head review: second revision

This revision responds to the external review of `63e07bd9d677b01dbfd265309e70c0b1fd3f44ef`. That reviewer verified the private bundle and reviewed the correct code. Its findings supersede the earlier baseline-only review. This document is a code handoff, not deployment approval.

## Findings and changes

| Finding | Revision | Verification boundary |
| --- | --- | --- |
| F1 — Keno guard fails ledger I3 | New forward migration `20261003230000_keno_guard_invariant_path` sets the invoker guard to `public, pg_temp`. Existing migrations and the invariant checker are unchanged. All explicit migration expectations include both new migrations. | Added native search-path assertion. Native/ledger/migration runs on this revision remain required. |
| F2 — refresh users share the proxy bucket | Refresh rate limiting runs after body/cookie parsing and verifies the refresh signature before selecting a hashed account bucket. The account key survives rotation and includes all that account's devices. Invalid, expired and access-only tokens fall back to the anonymous limit; login/register stay anonymous. | Real Fastify route tests isolate 20 accounts, alternate JSON/cookie refresh, retain the quota across rotations and reject forged identities. Rate identity is not authentication: session/status/version/rotation checks still run. |
| F3 — closed chat-only rooms can be deleted | Owner deletion checks status and the authoritative database deadline after acquiring the existing group/membership locks. Closed rooms return 409 and direct the owner to personal archive. | Native HTTP regressions cover both archived and expired-but-still-ACTIVE rooms. Pending database execution. |
| F4 — no closed-history moderation | A forward trigger change permits only false-to-true soft deletion, with every other field unchanged except updatedAt. It requires transaction-local server actor context, ACTIVE owner/admin membership and an ACTIVE account. API account/group/member/message locks enforce authority. The chat UI offers a confirmation dialog and handles failures. | Two browser-component regressions pass. Native direct-SQL, ordinary-member, edit, undeletion and owner cases are added but not yet run. No new platform-wide private-room access is introduced. |
| F5 — suspended refund requires a live token | Clarified the actual guarantee: suspended users need no session for automatic refund of an unstarted lobby at its deadline or room closure. The worker settles it idempotently. Optional manual withdrawal still requires a valid access token; there is no suspended-user refund UI and inactive sessions remain blocked. | Existing expiry regression now suspends the payer before running recovery without an HTTP session. Pending execution. Refund timing depends on an operating worker/database; a stored obligation survives an outage and is retried. |
| F6 — removed unpaid player blocks start | The member guard changes only unpaid JOINED entries in OPEN rounds to WITHDRAWN on removal, leaving, identity move or loss of ACTIVE membership. It never creates wallet entries. Paid READY protections remain unchanged. | Added native removal-to-start and leave tests. Existing paid-player and concurrency suites must pass on this revision. |
| F7 — ignored gift limit | Moved the legacy gift-send limit into Fastify route config. Swept route definitions for the same placement defect. | API bundle builds; no other top-level route rateLimit remains. |
| F8 — expiry prevents settlement / disappears when PVP is off | Room maintenance has its own independently caught/reported loop, always included when this worker starts, even if all three game switches are off. PVP tick no longer calls maintenance. Its deadline query still refunds expired rooms without waiting for status archival. | All eight flag combinations plus failed/stalled maintenance and payout progress pass. Restricted staging grants still require operator verification. |

## Local evidence for this revision

- HTTP gateway identity and worker contracts: **16/16 passed**.
- Cookie session/refresh contracts with the real rate-limit plugin: **13/13 passed**.
- Group/game/gift/chat/wallet/voice component contracts: **128/128 passed** across 9 files. This includes 11 message-page cases; do not count the earlier isolated rerun again.
- Web TypeScript check, web production build and API bundle build passed.
- No PostgreSQL suite passed locally for this revision. The existing disposable server refuses connections from this execution environment. Sandbox escalation is disabled by policy; no alternate access-control route was attempted.
- Whole-API TypeScript checking still fails with 324 diagnostics on repository-wide module/import/type issues. It is not a green gate. The optional group deadline diagnostic introduced during this revision was corrected; no diagnostic remains in the new identity/worker/lifecycle/native files.

The external review reported PostgreSQL 13/16/18 results for the previous head. It also reported 124 ledger, 30 two-connection, 70 financial and 6 Keno tests passing after its temporary one-line F1 fix on PostgreSQL 16. Those are external evidence supporting F1, not executed results for this complete revision.

## Isolated staging prerequisites

Do not deploy or enable cash features until the exact revised commit passes the workflow matrix, new native tests, existing group/chat concurrency suites and restricted-role checks.

The independent lifecycle task needs SELECT on the relevant groups columns and UPDATE on only `status` and `updatedAt`. An authorized owner must inspect the actual worker role first, then apply the missing grants without recreating users, changing passwords or resetting the database. Using psql, with `worker_role` set to the inspected restricted role name:

```sql
SELECT current_database(), current_user;
SELECT rolname, rolsuper, rolcreaterole, rolbypassrls FROM pg_roles WHERE rolname = :'worker_role';
SELECT has_column_privilege(:'worker_role','public.groups','status','UPDATE'),
       has_column_privilege(:'worker_role','public.groups','updatedAt','UPDATE');
GRANT SELECT (id, status, "expiresAt") ON public.groups TO :"worker_role";
GRANT UPDATE (status, "updatedAt") ON public.groups TO :"worker_role";
```

Verify actual execution under that role in a disposable rehearsal and rerun the runtime-identity checker. Do not run broad GRANT ALL, reset role setup, or production probes. These are additional lifecycle privileges, not a complete provisioning script for game/wallet tables. None has been applied by this revision.

Gateway deployment still needs matching dedicated API/web secrets and proof that Railway replaces forged X-Real-IP before selecting railway mode. The safe socket default is not sufficient for anonymous sign-in fairness behind a shared proxy. Keep the existing gateway trust prerequisite from `review-followup-20261004.md`.

Public source upload remains blocked: automatic approval review previously rejected publication because explicit public-source disclosure authorization was absent. No push, public upload or deployment was attempted in this revision. The private review bundle is the handoff.

## Remaining product and acceptance work

- Verify two real accounts, refresh/reconnect/countdown, mobile keyboard/IME, microphone recording, voice upload/playback and moderation on isolated staging.
- Practice credits remain finite with no audited refill flow. Voice upload does not yet have text-style idempotency receipts.
- Two simultaneous 1-second polling tabs may exhaust a user's 90/min allowance. Realtime chat invalidation can also create bursts. Address polling coordination/backoff before broad launch.
- Rate counters remain process-local; multiple API replicas require a shared store.
- An idle unpaid player who stays in the group still blocks start until they withdraw, the owner removes them, cancels, or the lobby expires. There is no round-only kick action.
- All cash/financial activation gates remain off. Game Points, practice credits and financial Coin balances retain their separate contracts.
