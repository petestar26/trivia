# Opus follow-up remediation — 2026-10-07

Reviewed the second report against implementation `1362cac628263474685db0030d6154dc357b2f58`. The previous staging release remains practice-only and payments paused. No production readiness is claimed.

## Evidence reconciliation

The reviewer's lack of Railway access is not an unperformed rollout: the isolated payment worker and exact API/web/migration deployments were verified in `recovery-staging-release-20261007.md`. Administrator empty-queue checks subsequently passed. Populated-case controls, operator refund rehearsal and physical devices remain unverified. The new code findings are independent of this deployment evidence.

## N2 — policy downgrade protection

Implemented a dedicated `DISABLE_STEP_UP_POLICY` authorization, bound to the authenticated user and JWT issuance time. Clients first use the existing `/security/step-up/verify` endpoint with that purpose, TOTP factor and current authenticator code, then PATCH `/security/policy`. A false policy write always requires the unexpired single-use proof, including when no policy exists. A withdrawal-purpose proof cannot authorize this action.

Proof consumption, policy mutation, audit and in-app SYSTEM security notification share one transaction. A notification or audit failure rolls back the policy and consumption. Enabling still requires an active factor. The route derives token issuance time from verified JWT claims, never the body. No frontend policy toggle exists to update.

Five focused unit regressions passed. A PostgreSQL test adds cookie-only refusal, wrong-token refusal, preserved protection, concurrent single-use consumption, exactly one notification and replay refusal. Database execution remains pending CI; mock transaction assertions are not database rollback evidence. This follow-up has not been deployed.

## Remaining work in order

1. N1: preserve paid-on-time orders' immutable price at settlement without incorrectly applying new-quote freshness. Retain submission expiry and operational readiness gates; add native coverage.
2. N3: audited supervisor reassignment/release, rejected state and queue pagination using forward migrations.
3. N4: inventory row locking with eight-member contention and real-shortfall coverage.
4. N5: resolved-dispute admission and transfer-reference reconciliation.
5. Direct API unsafe cookie-request Origin protection; token response/cache review.
6. N7 per-order expiry isolation/system audit actor; N6 member projections, append-only audit protection, rate limits and explicit runtime permissions.
7. PVP cancelled-round start, fee accounting/history and remaining P3 items listed in the independent report: withdrawal threshold/HELD recovery, package eligibility, reveal timing, media/legacy gifts, activation timezone, country override and runtime-role suite.

PR #33 requires separate backports and review. Financial provider integration, operational configuration and launch prerequisites remain separate from these fixes.

## N1 — accepted deposit price survives expiry

Settlement validates the saved USD policy at order creation time and recomputes the promised Coin amount from the saved fiat amount. It requires a recorded on-time submission and preserves operational country/account/method/agent checks. It neither selects a replacement quote nor extends the customer payment deadline. Submission timestamps now use the database clock, with a deadline check after readiness locks. Invalid paid terms return a 409 directing staff dispute review.

Local API review suite: 272 tests across 28 files passed; TypeScript passed. Native regression added for submit-before-expiry, settle-after-expiry with a replacement rate, concurrent exactly-once settlement and late-submission rejection. PostgreSQL CI is required before deployment. N2 CI run 37591113302 was still in progress at this checkpoint. No staging or production deployment was performed for these follow-ups.

## N3 — supervisor recovery lifecycle and paging

Added forward migration `20261007030000_late_payment_supervision`. It permits ASSIGNED → OPEN with cleared assignment and ASSIGNED → REJECTED with a mandatory resolution key, member-visible reason and timestamp. Reports and final outcomes remain immutable. Refund requirements remain unchanged.

Only a current active SUPER_ADMIN can release an assignment or reject a case. Self-review is forbidden. Rejection requires that supervisor to claim the investigation first. Release returns it to the shared queue; normal claim then assigns the new reviewer. Audited exact-key retries do not release a later assignment. The supervisor queue includes other administrators' assignments. Member and staff queues now page in stable openedAt/id order, 50 rows at a time, with Previous/Next controls. Concurrent queue changes can shift numbered pages; refresh before operational decisions. Member list responses omit assignment and request-key fields (other N6 work remains open).

Local validation: 273 API review tests, including PGlite forward-migration/immutable-resolution tests; 11 recovery UI tests; API/web TypeScript passed. Added native PostgreSQL tests for suspended-assignee recovery, ordinary-admin refusal, stale release retry, concurrent rejection, exactly-once refund after reassignment and 101-case paging. Those native tests still require CI. The previous N1 CI failed because its test selected pg_sleep's unsupported void return; the query now selects an integer from pg_sleep instead. No financial assertions were removed.

No new migration or follow-up code has been deployed. Original migration history is unchanged; owner-helper allowlist and fresh/populated upgrade inventories include the new migration. N4 and later findings remain open. Audit-log write protection (N6) remains a prerequisite before treating audit-backed decision receipts as tamper-proof under a compromised database runtime role.

## N4 — serialize deposit inventory admission

`reserveInventory` now locks the agent inventory row before reading available capacity. The existing version predicate remains as defense in depth; order, reservation, inventory and ledger changes still commit or roll back together. This addresses competing deposit admissions without blindly retrying financial writes or relaxing available-balance checks. Other inventory operations retain their existing contracts.

Added PostgreSQL regressions: three independent bursts of eight members must all succeed with sufficient inventory; exact-key retries must create no additional reservations; a burst with capacity for only three of eight orders must reject the other five as genuine shortfalls and leave exactly three orders, reservations and reserve-ledger entries. API TypeScript passed. These financial concurrency assertions require the new CI run; they have not been claimed as locally executed. No deployment or payment activation has occurred.
