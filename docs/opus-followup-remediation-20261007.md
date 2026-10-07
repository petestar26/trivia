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

## N5 — resolved disputes and structured transfer references

New reports are refused when the original deposit has a resolved dispute. Refund recording also rechecks this restriction for any older recovery case. The response directs staff to the existing dispute decision instead of treating recovery as a second resolution path. Exact retries of already-recorded successful outcomes retain their original behavior.

Recovery reference checks now compare normalized provider-scoped references with existing structured `PaymentEvidence` on other deposit orders (including evidence for disputed orders). A refund reference cannot reuse incoming evidence even on its own order. Unverified evidence is treated as a reason for reconciliation, never as proof of payment or an automatic refund. Evidence for the same order may support its incoming-payment reference.

Forward migration `20261007031000_recovery_reference_boundary` adds reciprocal evidence/claim guards sharing a transaction-level provider/reference lock. This prevents a concurrent evidence insert/update from bypassing the application precheck and stops later reuse of a recovery reference. Claims must use the original order's provider. Refund reference locks are acquired in a stable order. Native regression covers the competing evidence/refund write, rollback of step-up consumption after a conflict, and rejection after dispute cancellation.

Local: 274 API review tests passed, including PGlite guard checks in both directions and normalization/provider mismatch checks; API TypeScript passed. Native PostgreSQL and migration-upgrade CI remain required before deployment. No historical migration was edited. Free-text dispute notes, missing historic references, withdrawal-provider transfers and actual provider verification are not a globally reconciled external-payment ledger and remain operational/integration limitations. This does not claim duplicate external transfers can be detected when no structured evidence exists.

## Direct API cookie-origin and auth-response hardening

The real API plugin chain now rejects unsafe requests carrying access or refresh session cookies unless Origin exactly matches the configured frontend/trusted origins. The guard runs after cookie parsing and before handlers. A supplied Authorization header cannot exempt ambient cookies. Safe reads and bearer-only non-browser clients retain their existing contract. Browser login/signup are also origin-checked even before an authenticated cookie exists, preventing login CSRF.

All auth-route responses, including errors, send `Cache-Control: private, no-store` and `Pragma: no-cache`. Browser requests (Origin, Fetch Metadata or session cookies) receive HttpOnly session cookies plus expiry/user metadata without JSON access/refresh tokens. Cookie-free non-browser clients retain the existing token-response contract. Browser refresh with an explicit body token also suppresses JSON tokens. This is not a universal ban on token-based native clients.

Local validation: 282 API review tests, 17 cookie/session tests and API TypeScript passed. Added real-Fastify origin regressions and a database-backed registration/login response test for CI. Web auth consumes the user profile and already uses cookie refresh, so no frontend token migration is required. The exact configured staging origins and refreshed browser login still need validation after a successful combined CI/deployment.

Earlier N4 run 37593972475 was superseded/cancelled by the newer source run, not a complete pass. Follow-up runtime changes and migrations remain undeployed; the previously verified practice-only release remains the deployed baseline. N6/N7 and the remaining PVP/P3 items remain open.

## N6/N7 — runtime audit protection, recovery limits and resilient expiry

Forward migration `20261007032000_recovery_runtime_hardening` corrects the financial evidence trigger's required catalog-only search path, addressing the exact CI invariant failure in run 37595692249 without altering the earlier migration. The canonical runtime-grants function now removes audit UPDATE/DELETE/TRUNCATE/TRIGGER and column UPDATE privileges, and refuses reachable inherited paths that would retain mutation. Audit SELECT/INSERT remain available. Database owners retain maintenance authority; this is runtime-role protection, not a claim that owners cannot modify records.

Runtime preflight now checks recovery table capabilities. The isolated owner helper verifies recovery SELECT/INSERT/UPDATE requirements and audit append-only privileges after applying canonical grants. Deploying this migration requires reapplying the owner grant helper, not merely restarting the API.

Recovery creation is limited to 20 requests per 15 minutes; member queue reads to 120/minute; staff routes to 60/minute using the existing limiter identity mechanism. Member list projection already omits assignment and request keys. Remaining N6 privacy work should re-review all response shapes, not infer list coverage applies to every endpoint.

Deposit expiry now counts unexpected failures per order and continues the remaining batch. The worker logs the aggregate failed count and marks the cycle failed while continuing other maintenance/reconciliation work. Expiry audit entries use a null system actor with explicit expiry mode rather than identifying the customer as the actor. Each candidate's cancellation retains its own transaction. More than 200 persistently invalid candidates could still monopolize the bounded oldest-first batch; operator repair/queue isolation remains needed in that exceptional condition.

Local validation: 286 API review tests / 30 files and API TypeScript passed, including the corrected SQL search path, scoped route limit, continuation after a failed order, system audit actor and partial-failure worker reporting. Added native proof that a canonically configured runtime can append/read audit rows but cannot update/delete or obtain mutation privileges. Complete PostgreSQL 13/16/18 CI and deployment remain required. No production, payment activation or external refund action was performed.
