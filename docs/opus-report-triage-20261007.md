# Opus report reconciliation — 2026-10-07

Source: uploaded final review of PR #33, head 57e094c3d9af50bec124c6a434e097db857b187b. Current work is on descendant PR #35 (Crash Point), with web follow-up 4cf6a9ad8eaf91fe3344854c9274949bd2be4819. The report does not review the later Ruby Grand / Crash Point changes. Its recorded old staging hosts/deployments are not evidence about the currently verified isolated staging environment.

## Confirmed and patched in this remediation

- P0: `setCountryFlags` passed the caller's object into Prisma. Restored an explicit two-boolean write whitelist. A strict Zod parser rejects unknown/nested fields and non-boolean values at the HTTP boundary and again at the service boundary. Regression tests include a combined nested-write PATCH returning 400 before any transaction/write/audit and valid pausing with only the intended flag.
- P1: the agent payout screen fetched the owner-only withdrawal route. It now uses `/withdrawals/agent/assigned/:id`. The regression fixture rejects the owner-only route with 403 and verifies the authorized details request and submission.

These changes do not activate payments, run transactions, or change database structure. The original P0 exploit has not been exercised against live accounts. The regression checks are local HTTP/service tests with mocked persistence, not an independent PostgreSQL exploit replay.

## Remaining report items

| Finding | Current assessment / follow-up |
|---|---|
| Deposit submit/settle readiness | Code still lacks the reported readiness rechecks. Define how an already-paid order is held for review rather than silently cancelled or refunded; add locked checks and real-DB races. |
| CREATED order expiry/inventory reservation | Code explicitly has no timed expiry. Needs bounded reservation lifetime, per-member limits, audited cancellation and worker recovery tests. |
| Realtime membership revocation | Socket handshake has no current-status lookup; verify removal/suspension propagation and room eviction with actual socket tests. |
| Suspended payout agents | Participant lock reads only user ID, not status. Add actor status enforcement without preventing safe refund/recovery of suspended customer funds. |
| TOTP policy | Activation route only activates the factor; verify/update policy atomically and test withdrawal enforcement. |
| Admin dispute completion | UI resolution body lacks verified-payment evidence fields. Add validated fields and matching state/authorization tests. |
| Agent activation grants | Canonical grants omit the onboarding activation function; staging helper differs. Requires a forward grant migration, positive privilege check and restricted-role activation test. |
| Paused pricing UI | Disabled pricing query is still rendered as pending/loading. Add an explicit paused state and regression. |
| P3 findings | Not independently re-run in this pass. Track separately; dormant financial bypasses, token expiry/logging, durable voice storage and worker identity need security prioritization, not merely cosmetic classification. |

The report's fee-policy question is partly resolved by the conversation: 7% PVP rake and a 10% gift-conversion choice were already discussed. Do not change economics during remediation without reconciling the existing rules. Platform revenue accounting and tie allocation still warrant review.

## Release status

CHANGES REQUIRED remains the correct production verdict. Passing CI is not evidence that these uncovered paths are safe. The current source fixes do not yet close eight P2s or establish production readiness. Crypto options remain catalog entries, not completed provider integrations. Runtime identity/grants, cookies, worker configuration, backups and actual deployment contents must be checked from current configuration rather than inferred from the older report.

Patch reconciliation must cover PR #33 as well as descendant PR #35 before any merge: applying a fix only to the descendant does not make the older branch safe to release. No production merge/deployment or financial activation is authorized by the external report itself.

After remediation, prepare one consolidated independent-review prompt using the review's exact baseline and the then-current commit, covering both the original report findings and all later design/Crash Point changes. Do not ask Opus to repeat an unbounded review before resolving known blockers.
