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
