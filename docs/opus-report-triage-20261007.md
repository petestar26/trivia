# Opus report reconciliation — 2026-10-07

Source: uploaded final review of PR #33, head 57e094c3d9af50bec124c6a434e097db857b187b. Current work is on descendant PR #35 (Crash Point), with web follow-up 4cf6a9ad8eaf91fe3344854c9274949bd2be4819. The report does not review the later Ruby Grand / Crash Point changes. Its recorded old staging hosts/deployments are not evidence about the currently verified isolated staging environment.

## Confirmed and patched in this remediation

- P0: `setCountryFlags` passed the caller's object into Prisma. Restored an explicit two-boolean write whitelist. A strict Zod parser rejects unknown/nested fields and non-boolean values at the HTTP boundary and again at the service boundary. Regression tests include a combined nested-write PATCH returning 400 before any transaction/write/audit and valid pausing with only the intended flag.
- P1: the agent payout screen fetched the owner-only withdrawal route. It now uses `/withdrawals/agent/assigned/:id`. The regression fixture rejects the owner-only route with 403 and verifies the authorized details request and submission.

These changes do not activate payments, run transactions, or change database structure. The original P0 exploit has not been exercised against live accounts. The regression checks are local HTTP/service tests with mocked persistence, not an independent PostgreSQL exploit replay.

## Follow-up implementation and remaining verification

| Finding | Current assessment / follow-up |
|---|---|
| Deposit submit/settle readiness | Added locked current agent/user, country, account and method checks plus original immutable pricing expiry validation. Rejected paid settlements keep their reservation for dispute review. Native cases passed in the complete PostgreSQL 13/16/18 matrix. |
| CREATED order expiry/inventory reservation | Added 15-minute window bounded by original rate expiry, a serialized three-pending-order cap, idempotent replay before cap enforcement, audited staff cancellation and an independent expiry-worker step. Only CREATED orders expire. Native concurrency tests passed in the complete PostgreSQL 13/16/18 matrix. |
| Realtime membership revocation | Handshake checks current account status and token expiry; delivery rechecks every recipient's status/membership, evicts removed members and disconnects revoked/expired sessions. Fixed typing room/ID mismatch. Mocked delivery regressions pass; five actual Socket.IO handshake/delivery/expiry tests now pass locally (membership persistence is mocked). |
| Suspended payout agents | Participant locks now enforce active actor status, while allowing an active staff member to recover suspended customer funds. Four focused tests pass; native lifecycle suite passed on PostgreSQL 13/16/18. |
| TOTP policy | Activation atomically enables sensitive-operation step-up policy. Mocked transaction regressions pass; existing native enrollment contract extended. |
| Admin dispute completion | UI now gathers reference and payment timestamp for escalated PAYOUT_IN_PROGRESS completion, with validation and evidence payload. Other outcomes retain existing behavior. UI regressions pass. |
| Agent activation grants | New forward migration extends canonical grants with onboarding function execution; runtime verification checks capability and native activation uses canonical grants. Migration and restricted-role checks passed on PostgreSQL 13/16/18. |
| Paused pricing UI | Added explicit paused feedback without an endless loading state or price-preview request. UI regression passes. |
| P3 findings | Not independently re-run in this pass. Track separately; dormant financial bypasses, token expiry/logging, durable voice storage and worker identity need security prioritization, not merely cosmetic classification. |

The report's fee-policy question is partly resolved by the conversation: 7% PVP rake and a 10% gift-conversion choice were already discussed. Do not change economics during remediation without reconciling the existing rules. Platform revenue accounting and tie allocation still warrant review.

## Release status

CHANGES REQUIRED remains the correct production verdict. Passing CI is not evidence that these uncovered paths are safe. The eight P2 paths have source changes and passing database/socket regression coverage; operational payment recovery and financial-worker rollout remain open. This does not establish production readiness. Crypto options remain catalog entries, not completed provider integrations. Runtime identity/grants, cookies, worker configuration, backups and actual deployment contents must be checked from current configuration rather than inferred from the older report.

Patch reconciliation must cover PR #33 as well as descendant PR #35 before any merge: applying a fix only to the descendant does not make the older branch safe to release. No production merge/deployment or financial activation is authorized by the external report itself.

After remediation, prepare one consolidated independent-review prompt using the review's exact baseline and the then-current commit, covering both the original report findings and all later design/Crash Point changes. Do not ask Opus to repeat an unbounded review before resolving known blockers.

## Payment recovery and deployment caveats

- Expiry is not a refund and never credits a wallet. Only an unpaid CREATED reservation can be released. PAYMENT_SUBMITTED and DISPUTED orders remain reserved.
- A transfer made without timely confirmation needs staff investigation using its order number and external receipt. Automated late-payment recovery after EXPIRED is not implemented; do not enable live payments until that operational recovery path is agreed and tested.
- The financial timeout worker must run the updated entrypoint for expiry to operate. Updating the social/group worker alone is insufficient.
- Apply the new forward migration as the database owner and re-run canonical grants for the intended API runtime role. No existing migration is edited. Production and payment enablement remain unchanged.
- The UI now shows the deposit payment deadline and disables expired payment confirmation. Client time is display-only; database time and locked state govern acceptance.

Socket expiry follow-up: the member client now uses the existing cookie-session renewal coordinator for one bounded reconnect attempt after expiry/UNAUTHORIZED. It stops after a rejected recovery and never reconnects after unmount. Four socket-provider tests and fifteen existing session tests passed locally. Five actual Socket.IO integration tests additionally pass locally; database membership writes are mocked in that harness.

The isolated staging owner helper now allows exactly the new activation-grant migration alongside the existing Crash Point migrations, applies canonical grants to the validated API role, and verifies the activation capability. Its production refusal, database target checks and migration-history checksum checks remain in place. The financial timeout worker is still a separate deployment task.

Full PostgreSQL payment regression caught an overly strict rate-row activation check. Replacement-rate publication must not invalidate an existing immutable quote; that check was removed while preserving original snapshot expiry and all payment destination/actor availability checks. The existing native frozen-price/idempotency test remains unchanged and passed on PostgreSQL 13/16/18.

## Verified remediation release evidence

- Verified code commit: `147f74b3417e08809d1cf0910f9a20ca1a707906`. Full PostgreSQL 13/16/18 CI succeeded: https://github.com/petestar26/trivia/actions/runs/37559364354 .
- P0/P1 backport on PR #33: `3bf48be483734108f08568d4b433e405c12a0895`. Its complete matrix also succeeded: https://github.com/petestar26/trivia/actions/runs/37558979635 . P2/P3 reconciliation on that older branch remains open.
- Local focused checks: 204 API tests across 23 files, 13 wallet tests, 19 socket/session tests and completed API/web TypeScript checks passed.
- Isolated staging owner deployment `87b7b232-b0a2-44c4-844a-762d26d0d136` succeeded, emitted `CRASH_POINT_STAGING_READY`, included the new activation-grant migration and confirmed `financialPlay: false`.
- Financial timeout-worker deployment remains blocked on proving its database target is isolated. Existing worker credentials are redacted through the available connector; do not infer target identity or repurpose it blindly.
- API deployment `aa4e8f06-3919-4102-9517-39376271ac5b` and web deployment `eb6cb2f7-a8b6-49e5-b20e-0feaa69e053c` succeeded at the verified code commit in isolated staging.
- Browser verification after the app update: Ethiopia now displays “Payments are paused in this country. New quotes are unavailable.” instead of the previous endless rate loader. Wallet requests loaded with truthful empty states. No transaction was submitted. Captured console errors were browser-extension metadata errors, not application errors. Physical mobile/tablet testing remains outstanding.
- Production, financial activation and PR merges were not changed. The social/group worker remains on its prior verified Crash Point build.

## Dispute recovery prerequisite — authorization follow-up

Inspection of the late-payment recovery path found a separate dispute replay authorization defect: an exact order ID/idempotency key/payload replay returned an existing dispute before checking the caller's relationship to the order. The service now checks current active-account status and order participation before any replay, rechecks active status under a shared User lock before opening a dispute, and rejects inactive accounts on private dispute reads. The unique-conflict recovery path reauthorizes before returning a winner.

Validation: 213 focused API tests across 24 files passed, including nine new dispute access regressions; API TypeScript passed. A native PostgreSQL regression exercises an unrelated exact-key replay, verifies 403, and verifies that the legitimate owner still receives the single original dispute. Its CI result must be checked before deployment.

Late-payment recovery remains unimplemented. Current disputes only transition PAYMENT_SUBMITTED orders and assume an ACTIVE reservation. Expired orders have RELEASED reservations with existing ledger entries; silently reactivating them would erase lifecycle meaning and conflict with the ledger's operation identity. Recovery needs a separate audited case with receipt verification, explicit external refund or separately funded settlement, duplicate-payment-reference protection and concurrent resolution tests. Do not extend the existing RELEASE action to expired orders without those controls.

## Worker log redaction follow-up

The financial worker previously logged raw exception messages, names and stacks. Those fields may contain database URLs, SQL parameters or payment evidence. They are now replaced by fixed error text and a small allowlist of database error codes; the operation label, failure result and independent reconciliation behavior are preserved. All 27 worker tests and API TypeScript passed. Three new redaction cases cover Error objects, plain objects and string throws containing synthetic sensitive values. This source fix does not verify the deployed worker identity or activate its rollout.

The dispute authorization fix was also backported to PR #33 at `93024259082ceb43bd13af38af34b24028a031dd`; its nine focused access tests passed and full CI is tracked at https://github.com/petestar26/trivia/actions/runs/37562421424 .

## Dedicated staging payment worker

Added a separate staging-only launcher. Before any sweep it validates the exact rehearsal environment, host, database name, restricted API-role family and safe connection parameters, rejects owner credentials, confirms the connected database name, and runs the existing full read-only runtime identity/grant verifier. It defaults to verification only; `--run` explicitly starts the worker, with optional `--once`. Child processes receive shutdown signals and failures produce sanitized output. The worker receives ephemeral local JWT values solely to satisfy shared configuration, not the API's JWT signing keys; it serves no authentication endpoints.

The dedicated Railway service must use only a reference to the already-isolated API DATABASE_URL plus the rehearsal acknowledgement, NODE_ENV=production and LOG_PRETTY=false. It must not receive an owner credential, JWT signing key, TOTP key or ledger-approval signing key. No public domain is required. This addresses target verification without altering the existing generic worker. Deployment evidence is tracked on PR #35. Late-payment recovery remains open.


## Late-payment recovery implementation — awaiting native CI and staging rollout

This supersedes the earlier “no recovery case flow” implementation note; it does not approve live payments.

- Added a separate support case for a member's EXPIRED/CANCELLED deposit with a RELEASED reservation and no settlement. Original orders, reservation history, inventory and financial balances are never changed by recovery.
- Member reports include transfer reference, actual amount in minor units, time and description. Staff can claim a case; only that active assigned administrator can record a verified full external refund. Self-review is prohibited. Every transition has an audit record.
- Refund recording requires mandatory case-specific, single-use TOTP step-up tied to the request token's issued-at time. Exact successful retries return the original record without requiring a second step-up. Verification consumption rolls back with failed resolution.
- Provider-method-scoped unique references prevent reusing incoming/refund references across recovery cases. Member claims do not reserve those verified references. Database guards preserve report and resolution history.
- Added member reporting/status and admin investigation/refund UI, bounded verification requests and independent saved-request scopes. Verification notes are visible to the member; receipt file uploads are not implemented.
- Fixed two pre-existing dispute issues found while reviewing this path: malformed/oversized input now returns validation errors, and administrator claims recheck current status/role under a transaction lock.
- Local checks: 253 API tests across 26 files, 19 wallet/UI tests, API/web TypeScript and production builds passed. Native concurrency/duplicate-reference/no-credit regression added to payment-readiness.native.ts; full PostgreSQL CI must pass before deployment.
- Additive migration: 20261007020000_late_payment_cases. Apply with the isolated owner upgrade first, reapply canonical runtime grants, then deploy API and web. Staging owner helper allowlist includes this migration. Current deployed services remain on their earlier verified commits until this rollout is performed.
- Limits: this records a staff-verified external refund; it neither sends money nor credits Coins. Partial refunds, rejected/incorrect claims, evidence file upload, provider API verification and cross-checking references against legacy payment evidence remain follow-up work. There is at most one case per order. Live payment activation remains blocked on operational review and the remaining platform findings.


## Additional security and regression corrections

- Full native CI detected that the new invoker guard functions did not use the canonical `public, pg_temp` search path. Additive migration `20261007021000_late_payment_guard_paths` corrects both functions; the original migration remains unchanged. The explicit fresh/populated migration test inventory now includes both recovery migrations.
- The complete local frontend suite passed 1,173 tests across 76 files after repairing obsolete socket mocks and waiting for the existing autoplay-disconnect effect in its assertions. CI now includes the previously omitted connection, login/signup return-path, Crash Point and recovery UI contracts.
- Authenticated reads now recheck current ACTIVE account status. Optional authentication clears the decoded request identity after inactive-account rejection or lookup failure. Database failures on required authentication remain server errors rather than being reported as invalid credentials.
- Malformed JSON parser messages and stacks are neither logged nor echoed; an actual HTTP/parser regression verifies that submitted password fragments remain absent. Production access/refresh cookie set/clear options always require Secure regardless of an omitted COOKIE_SECURE setting.
- Added a root React error boundary with generic recovery controls and a reminder to reconcile confirmed requests before retrying. It never renders exception details.
- Focused API review checks: 260 tests across 27 files passed locally. Two new error-boundary tests passed; the complete native matrix and staging verification of the final candidate remain required.
