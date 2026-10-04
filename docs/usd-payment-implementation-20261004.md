# USD payment implementation report — 4 October 2026

## Current release status

Application candidate: `5bb4fbcc2520ff0e09c780be0cb3d00d9476fe5f`.
Local application: `446b5f79185cc41a4753d6fd123c035043e4ba41`.
Verified identical tree: `cfcbdd80abd4e91695837fddce7a8afd0be173c7`.
**All required PostgreSQL 13/16/18 jobs passed** in [run 37197251003](https://github.com/petestar26/trivia/actions/runs/37197251003).
**This candidate has not been deployed.** Railway returned “Cancelled — the user did not approve this action. No changes were made.” The staged upgrade remains pending. No migration was applied to staging and API/web remain on the earlier verified application `6377b040da935e88e52cb01ffbd055c9210a31a9`. Production and live financial activation remain unchanged.

## Implemented

- Extend existing Agent/P2P deposit and withdrawal services; retain the existing wallet, Coin ledger, reservations, liquidity, settlement, dispute and idempotency mechanisms.
- Add explicit country USD-pricing activation. Historical transactions and issued quotes retain their existing numbers; new USD-priced transactions carry immutable policy snapshots.
- Use exact integer-rational calculations with 96 Coins per USD. Preserve local minor-unit amounts. Floor Coin credits and local payouts without reciprocal floating-point drift.
- Enforce P2P deposits at or above USD 2 and withdrawals strictly above USD 4: initial boundaries are 192 and 385 Coins respectively. Admin rate versions may increase these minimums.
- Store rate source, observation time, expiry, USD numerator/denominator, local rate, local amount, Coin amount and zero fee in new transaction snapshots. Cap quote expiry at rate expiry.
- Expire rate observations after at most 24 hours. A stale/disabled latest USD rate cannot silently restore an older or legacy rate.
- Add six configurable reference Coin bundles with derived USD displays. Correct 700/1400/3500 Coins to approximate USD 7.29/14.58/36.46. Bundle displays do not override conversion or route minimums.
- Extend the processing desk with rate publication and package editing. Require current active admin status, existing permissions and transactional audit records.
- Show active countries independently of agent availability. Crypto is explicitly unavailable rather than presenting an unconnected payment button.
- Correct wallet amounts previously rendered as major units despite being stored as minor units; e.g. 30000 becomes 300.00 ETB. Convert input to minor units exactly and format large withdrawal amounts without float precision loss.
- Protect pricing snapshots and terms with database triggers and include the new guards in the existing ledger invariant scan.

## Verification

Local: API/web strict typechecks and production builds passed, alongside 84 API review/pricing/SQL/operator checks and 12 targeted wallet/currency/idempotency checks. The staging command rejects production and unrelated database/role targets.

The current native matrix passed on all three database versions. Per version:

| Check | Result |
| --- | --- |
| Payment lifecycle, authorization and recovery | 440 passed |
| Legacy API/task compatibility | 301 passed |
| Ledger protections | 124 passed |
| Financial admission/settlement/refund | 70 passed |
| Concurrent database connections | 30 passed |
| Group games/gifts/social/rewards | 66 passed |
| API review, pricing and operator | 84 passed |
| Economics | 329 passed |
| Scheduled practice | 37 passed |
| Practice frontend | 162 passed |
| Group/chat/wallet frontend | 147 passed |
| Cookie session renewal | 15 passed |
| PWA and gateway | 3 and 7 passed |
| Migration regression | 56 passed on PG16/18; 55 passed and one documented version-specific skip on PG13 |

Typechecks and API/web production builds also passed in CI. Counts overlap and should not be added as unique tests.

Native CI runs 37196354105 and 37196794373 blocked deployment on database guard search-path requirements. Forward migrations correct both the cascading guard paths and the separate non-privileged country guard path. Run 37197251003 verified the corrected candidate successfully on PostgreSQL 13, 16 and 18. No security gate was bypassed.

No real payment, withdrawal, wager, country activation or balance adjustment has been performed during this work.

## Not implemented / external dependencies

- Crypto deposit, withdrawal and direct purchase settlement: no provider integration or payment credentials are configured. Proposed crypto thresholds are recorded in policy, not active processing routes.
- Automatic FX refresh: a verified source API is still required. The suggested website is an informational rate reference; no settlement API contract has been verified. Audited manual rate publication is implemented and stale prices fail closed.
- Nonzero payment fees: remain zero until the fee recipient, agent settlement, ledger entries and refund treatment are defined. Existing game/gift fees are unchanged.
- Master conversion-rate editing: deliberately fixed at 96 to avoid implicit revaluation. A future rate change needs a versioned economic migration and liability review.
- Coin bundles are reference/configuration data; direct provider checkout is unavailable until provider settlement is implemented.
- Country/method/agent activation, liquidity and account eligibility remain existing operational prerequisites. No countries were automatically opened for payments.

The independent final review should follow completion of the remaining provider implementation, not be used to label these incomplete routes production-ready.

## Database and deployment

Three forward-only migrations add USD metadata, packages and guard protection. The staging-only operator validates the exact isolated database and migration checksums, refuses unrelated pending migrations, applies the USD migrations and adds only the required package-table/new-country-column permissions. Production is refused by the operator.

The pending staging patch is `6fb331da-a762-412b-88a5-a279b933d4eb` in project PlayQuibe, environment `staging`. It updates only `spin-practice-setup-20261002`:

1. Source branch: `feat/casino-wallet-review`.
2. Source commit: the tested `5bb4fbcc2520ff0e09c780be0cb3d00d9476fe5f`.
3. Start command: `node apps/api/dist/scripts/staging-usd-payment-upgrade.js --apply`.

Railway reports the patch as non-destructive; it contains no service, volume or data deletion. Its deployment approval was cancelled. Approve this staging-only action to continue.

After approval, verify the schema upgrade, switch the owner helper to `--verify`, deploy API/web at the tested commit, then perform browser smoke checks. The new candidate has **not** received post-deployment browser verification yet. The existing signed-in staging wallet was observed healthy before rollout.

Production has a separate pending deletion which is not part of this patch. Live payment availability additionally needs configured country/method/rate policy, approved agents and inventory/liquidity, account eligibility and an operator-supervised settlement rehearsal.

## Changed files

- `.github/workflows/scheduled-rounds.yml`
- `apps/api/build.js`
- `apps/api/src/agents/agent-orders.test.ts`
- `apps/api/src/agents/agent-service.ts`
- `apps/api/src/agents/config-routes.ts`
- `apps/api/src/agents/config-service.ts`
- `apps/api/src/agents/order-service.ts`
- `apps/api/src/agents/usd-config-service.ts`
- `apps/api/src/agents/usd-migration.test.ts`
- `apps/api/src/agents/usd-pricing.test.ts`
- `apps/api/src/agents/usd-pricing.ts`
- `apps/api/src/economy/ledger-invariant-checker.ts`
- `apps/api/src/ledger/ledger-upgrade.migration.test.ts`
- `apps/api/src/routes/wallet.ts`
- `apps/api/src/scripts/staging-usd-payment-upgrade.test.ts`
- `apps/api/src/scripts/staging-usd-payment-upgrade.ts`
- `apps/api/src/withdrawals/quote-service.test.ts`
- `apps/api/src/withdrawals/quote-service.ts`
- `apps/api/src/withdrawals/withdrawal-service.ts`
- `apps/api/vitest.review-unit.config.ts`
- `apps/web/src/lib/payment-money.test.ts`
- `apps/web/src/lib/payment-money.ts`
- `apps/web/src/pages/wallet-operations.tsx`
- `apps/web/src/pages/wallet-payments.test.tsx`
- `apps/web/src/pages/wallet-payments.tsx`
- `apps/web/src/pages/wallet-pricing-admin.tsx`
- `docs/payments-usd-impact.md`
- `packages/database/prisma/migrations/20261004120000_usd_payment_pricing/migration.sql`
- `packages/database/prisma/migrations/20261004121000_usd_pricing_guard_paths/migration.sql`
- `packages/database/prisma/migrations/20261004122000_usd_activation_guard_path/migration.sql`
- `packages/database/prisma/schema.prisma`
