# Opus report reconciliation — 2026-10-07

Source: uploaded final review of PR #33, head 57e094c3d9af50bec124c6a434e097db857b187b. Current work is on descendant PR #35 (Crash Point), with web follow-up 4cf6a9ad8eaf91fe3344854c9274949bd2be4819. The report does not review the later Ruby Grand / Crash Point changes. Its recorded old staging hosts/deployments are not evidence about the currently verified isolated staging environment.

## Confirmed and patched in this remediation

- P0: `setCountryFlags` passed the caller's object into Prisma. Restored an explicit two-boolean write whitelist. A strict Zod parser rejects unknown/nested fields and non-boolean values at the HTTP boundary and again at the service boundary. Regression tests include a combined nested-write PATCH returning 400 before any transaction/write/audit and valid pausing with only the intended flag.
- P1: the agent payout screen fetched the owner-only withdrawal route. It now uses `/withdrawals/agent/assigned/:id`. The regression fixture rejects the owner-only route with 403 and verifies the authorized details request and submission.

These changes do not activate payments, run transactions, or change database structure. The original P0 exploit has not been exercised against live accounts. The regression checks are local HTTP/service tests with mocked persistence, not an independent PostgreSQL exploit replay.

## Follow-up implementation and remaining verification

| Finding | Current assessment / follow-up |
|---|---|
| Deposit submit/settle readiness | Added locked current agent/user, country, account, method and rate checks plus original immutable pricing expiry validation. Rejected paid settlements keep their reservation for dispute review. Native cases added; CI pending. |
| CREATED order expiry/inventory reservation | Added 15-minute window bounded by original rate expiry, a serialized three-pending-order cap, idempotent replay before cap enforcement, audited staff cancellation and an independent expiry-worker step. Only CREATED orders expire. Native concurrency tests added; CI pending. |
| Realtime membership revocation | Handshake checks current account status and token expiry; delivery rechecks every recipient's status/membership, evicts removed members and disconnects revoked/expired sessions. Fixed typing room/ID mismatch. Mocked delivery regressions pass; five actual Socket.IO handshake/delivery/expiry tests now pass locally (membership persistence is mocked). |
| Suspended payout agents | Participant locks now enforce active actor status, while allowing an active staff member to recover suspended customer funds. Four focused tests pass; native lifecycle suite remains required. |
| TOTP policy | Activation atomically enables sensitive-operation step-up policy. Mocked transaction regressions pass; existing native enrollment contract extended. |
| Admin dispute completion | UI now gathers reference and payment timestamp for escalated PAYOUT_IN_PROGRESS completion, with validation and evidence payload. Other outcomes retain existing behavior. UI regressions pass. |
| Agent activation grants | New forward migration extends canonical grants with onboarding function execution; runtime verification checks capability and native activation uses canonical grants. Migration and restricted-role CI pending. |
| Paused pricing UI | Added explicit paused feedback without an endless loading state or price-preview request. UI regression passes. |
| P3 findings | Not independently re-run in this pass. Track separately; dormant financial bypasses, token expiry/logging, durable voice storage and worker identity need security prioritization, not merely cosmetic classification. |

The report's fee-policy question is partly resolved by the conversation: 7% PVP rake and a 10% gift-conversion choice were already discussed. Do not change economics during remediation without reconciling the existing rules. Platform revenue accounting and tie allocation still warrant review.

## Release status

CHANGES REQUIRED remains the correct production verdict. Passing CI is not evidence that these uncovered paths are safe. The eight P2 paths now have source changes, but database, socket integration and deployment verification remain open. This does not establish production readiness. Crypto options remain catalog entries, not completed provider integrations. Runtime identity/grants, cookies, worker configuration, backups and actual deployment contents must be checked from current configuration rather than inferred from the older report.

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
