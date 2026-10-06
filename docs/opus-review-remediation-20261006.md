# Opus review remediation — 6 October 2026

Candidate follows reviewed public revision f529842c190f40b4e820d0a641fc5f64e3660b45. Verification is in progress; this is not financial activation approval.

## Changes

- H1: country activation is transactional and requires an active country, versioned current USD pricing, an active agent/user and an approved destination on an active matching method. New deposits/quotes reject legacy pricing. New withdrawals reject historical quotes without USD snapshots. Existing admitted transactions retain settlement/refund semantics. Legacy rate creation is closed; history/deactivation remain available.
- H2: Number Challenge and legacy Dice Coin wagers are paused by server admission and public catalog presentation, independently of database availability flags. Historical rules/sessions remain intact. The code gate needs no migration and cannot be bypassed by a catalog flag. Corrected payout models require a future reviewed implementation.
- M1: Profile includes time-based authenticator enrollment, code confirmation, expiry, bounded requests and reconciliation after uncertain activation. Withdrawal verification links to setup. Secrets remain component-local and are cleared on cancel, expiry, confirmed activation and unmount.
- M2: pending payment reviews include destination country and payment method. Self-service creation/edit and approval reject a destination outside the agent service country (current order admission already requires this relationship).
- L1: settlement and receiving-account creation/edit check the actor user under a transaction lock, as well as the existing agent checks.
- L2: the Dice snapshot subtracts unrevealed payouts using one SQL snapshot, while retaining durable settlement.
- L3: startup session failures other than 401 retain loading/reconnection state, retry with bounded backoff and offer manual retry. Transient refresh failures preserve the known user.
- L4: Keno distinguishes permanent unavailability from reconnecting; brand labels no longer create duplicate h1s; admin payment/pricing pages have page headings. Suspension, funding and each review have independent reason fields.

## Validation

Initial local checks passed 171 API tests and 83 frontend tests plus API/web typechecks and builds. Subsequent refinements and full PostgreSQL 13/16/18 CI must pass before deployment. The local environment lacks a PostgreSQL server; no database-backed test success is claimed here. Payment lifecycle fixtures use synthetic ETB/USD policies with real minimums and expiry; they are not live exchange rates. The final per-candidate results will be recorded in PR 33.

## Remaining operational work

No new migration or environment variable is introduced by this patch. Production still needs reconciliation with the previously added USD/onboarding schema and restricted runtime grants. This patch does not apply production grants, enable payments, fund balances or create real destinations. Approved receiving accounts, current verified rates, backed inventory/liquidity and an operator-supervised settlement rehearsal remain required. Direct crypto integration, physical-device checks and the accounting treatment of nonredeemable PVP Game Point fees remain separate follow-ups. Production secure-cookie configuration must be verified before rollout.
