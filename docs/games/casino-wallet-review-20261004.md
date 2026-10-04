# Casino and wallet review — 4 October 2026

## Release status

Application candidate: `f1e1441438ff7c596c8eb5cdde2aaf61656f2ba5` in [PR 33](https://github.com/petestar26/trivia/pull/33), based on `feat/social-groups-rewards`. This review does not merge either feature branch into master.

**Database verification passed; deployment is blocked by a cancelled Railway approval.** Exact-commit CI run 37185151403 completed successfully on PostgreSQL 13, 16 and 18. The API and web source changes are staged in Railway staging, pinned to the application candidate above, but are not applied.

The first deployment call returned a connector metadata error. A read-only check confirmed the patch was still staged and no deployment existed for the candidate. The next deployment call returned: “Cancelled — the user did not approve this action. No changes were made.” No alternative deployment path was attempted.

Production was not changed. Staging still serves the prior API `4126a3a` and web `d26a512`. Live browser verification of the new screens remains pending; the existing signed-in staging tab was located but the new application was not represented as deployed.

This is a CI-verified staging candidate, not an unconditional production-readiness certification. Financial activation remains off. The release limitations below must be considered before a production rollout.

## Findings and fixes

### Dice

The routed system Dice game is a scheduled practice game with two dice and a fixed sum-of-seven-or-more rule. It does not let the player pick a winning total. Selected-total Dice belongs to group PVP. A selection made before the draw may legitimately win; rejecting it merely because it matches the eventual draw would be unfair.

- The server snapshot now withholds the persisted Dice outcome and ticket payout until the scheduled reveal time. Previously the visual animation hid a result that was already present in the API response.
- The frontend refuses admission if an inconsistent snapshot already contains an outcome, even if its countdown appears open.
- Existing authoritative admission locks, database-clock cutoff checks, immutable outcomes, atomic balance credits, idempotent replay and settlement recovery were reviewed and included in native regression checks.
- Added coverage for concealed results and rejection of fresh entries after the draw. Existing tests cover concurrent confirmations/workers, changed amounts, failed settlement recovery, incorrect payouts and database tampering.
- Legacy Coin Dice remains paused. The practice rule remains `dice-sum7-practice90-v1`: stake in multiples of 35, gross winning return 54 per 35, theoretical return 90%. This change does not activate Coin wagering or alter historical rules.

### Deposit and withdrawal recovery

The repository already contained extensive financial services. Deposits are agent-assisted Coin purchases, not a direct bank/payment-gateway integration. Withdrawals use quotes, payout accounts, holds, agent liquidity, receipt confirmation, disputes and ledger settlement. The principal missing piece was a complete connected interface; production was also on an older commit (`247d6ee`).

New customer routes:

- `/wallet/deposit`: enabled country, approved agent/method, amount and explicit request confirmation; exact server-created order instructions and lifecycle actions.
- `/wallet/withdraw`: saved/masked payout accounts, method-specific account fields, server-priced quote, confirmation, and existing authenticator step-up verification.
- `/wallet/activity`: deposit and withdrawal request status, payment confirmation, cancellation, receipt confirmation and problem reporting.
- `/wallet/operations`: approved-agent processing and current-role-protected admin dispute review, with underlying request details and evidence confirmation.

Other changes:

- A minimal authenticated payment-options directory exposes approved method labels and identifiers, not payout destinations or agent contact information.
- Deposit amounts are bounded safe integers. Admission rechecks buyer, agent, country, payment account and payment method inside the transaction with row locks. Disabling a method during preflight cannot leave an admitted order or reserved inventory.
- Wallet mutations preserve the original user-scoped idempotency key and request across uncertain failures/reloads, prevent rapid duplicate submission, and provide a retry action. Browser storage failure prevents sending a new financial intent.
- Monetary values, rates, outcomes and identity remain server-authoritative. Withdrawal confirmation sends quote/account identifiers, not a client-computed payout.
- Sensitive wallet, order, dispute, withdrawal and step-up responses use `private, no-store`.
- Administrative permission/role guards read the current account role and ACTIVE status rather than trusting stale role claims in an access token.
- Assigned deposit disputes remain in their assigned administrator's queue after claiming; previously they disappeared because the queue selected only OPEN rows.
- Total, spendable and bet-only Coin balances are visible alongside payment requests. Eligibility remains enforced by the server.

### Interface and structure

- Consistent PlayQube branding in navigation, authentication, document title and PWA metadata.
- Casino contains the practice tables; Free games is explicitly separate. Active practice tables no longer inherit the misleading Coming Soon presentation of their paused legacy Coin definitions.
- A cohesive casino lobby, game icons/cards and a simpler home dashboard replace scattered diagnostic content.
- Wallet sections use consistent navigation, readable request cards, confirmation controls, empty/error/loading feedback and responsive layouts.
- Wallet transaction history supports currency filtering, paging and retry.
- Mobile navigation uses a focus-managed dialog with Escape/close support and a skip-to-content link. Profile layout adapts to narrow screens.
- Removed nonfunctional Remember me and Forgot password controls. Recovery needs a real backend flow before that link returns.
- Existing group/chat, gifts/reactions and notification implementations were retained and included in the available regression suites; this is not a claim that every historical screen was redesigned.

## Verification

- Full frontend suite: **1,084 tests across 65 files passed**.
- API review-unit suite: **35 tests passed**.
- Web TypeScript and production build passed. API bundle build passed.
- Exact-commit database matrix: **all three jobs passed**, [run 37185151403](https://github.com/petestar26/trivia/actions/runs/37185151403).
- Per database version: 66 games/gifts/social/reward native checks; 421 payment lifecycle checks; 30 two-connection checks; 124 ledger checks; 70 financial admission/settlement/refund checks.
- Fresh/populated migration checks: 56 passed on PostgreSQL 16 and 18; 55 passed and one documented version-specific skip on PostgreSQL 13.
- CI also passed worker/runtime guards, cookie renewal, shared/economics contracts, web TypeScript/build, PWA navigation and gateway/WebSocket checks. Counts overlap the local suites and should not be added as unique tests.
- Full API TypeScript still reports **324 existing diagnostics** and is not green. Successful bundling does not replace this check.
- No real fiat was sent, no user-account financial transaction was performed, and no financial activation flags were enabled during verification.

## Deployment continuation

Approve the existing staging deployment through Railway, then apply only patch `637ec8de-737e-42b0-ab1e-60da2fe6287b` after checking it still contains only the API/web source changes for `f1e1441438ff7c596c8eb5cdde2aaf61656f2ba5`. Check both deployment statuses and runtime identity, then verify casino, Dice reveal/countdown, wallet navigation and payment empty/error states in the signed-in browser. Do not mark live payment flow or browser acceptance complete based solely on CI.

## Remaining work and release gates

1. Resolve the existing full-API TypeScript backlog before describing the whole repository as production-ready.
2. Production remains behind the feature branch. Reconcile and review the complete release, run the documented ledger preflight/migration/grant procedure, verify runtime identities and backups, and deploy a separately approved release candidate. Do not run native destructive tests against staging or production.
3. Live payment availability requires enabled country/method/rate policy, approved/funded agents, withdrawal liquidity, account eligibility/KYC and the existing operational launch controls. These are not fabricated or enabled by adding the screens.
4. Complete an operator-supervised real-provider/agent reconciliation rehearsal before live financial launch. CI exercises database lifecycle behavior with disposable fixtures, not actual bank settlement.
5. Account recovery and authenticator enrollment do not yet have complete customer UI. The new withdrawal screen can verify an already-enrolled authenticator.
6. Immediate general access-token revocation is broader than the current-role admin fix. The existing refresh-token revocation behavior is tested; a full access-session revocation design remains a separate security task.
7. The payment directory currently returns at most 100 agents and the withdrawal dispute UI shows the first backend page. Add country-scoped search/pagination and operational queue pagination before those volumes are reached. Existing request list endpoints are not yet paginated.
8. Exceptional admin completion without an agent payment submission remains an investigation/API workflow; the UI supports the standard verified-payment resolution path and does not bypass required evidence.
9. Physical-device microphone/keyboard/installed-PWA testing and a real 24-hour group expiry observation are not covered by this desktop browser review. Do not represent them as completed.

No new database migration is introduced by this review. No secret rotation, broad runtime-role reset, capital funding, fee-policy change or financial enablement is required for the staging interface update. Production's older baseline may still require migrations from earlier work; follow the existing deployment runbooks rather than assuming a web deploy applies them.

## Changed files

- `.github/workflows/scheduled-rounds.yml`
- `apps/api/src/agents/agent-orders.test.ts`
- `apps/api/src/agents/dispute-routes.ts`
- `apps/api/src/agents/dispute-service.ts`
- `apps/api/src/agents/dispute.test.ts`
- `apps/api/src/agents/order-routes.ts`
- `apps/api/src/agents/order-service.ts`
- `apps/api/src/games/group-pvp/system-dice.native.ts`
- `apps/api/src/games/group-pvp/system-dice.ts`
- `apps/api/src/middleware/auth.ts`
- `apps/api/src/middleware/current-permission.test.ts`
- `apps/api/src/routes/wallet-options.test.ts`
- `apps/api/src/routes/wallet.ts`
- `apps/api/src/security/routes.ts`
- `apps/api/src/withdrawals/routes.ts`
- `apps/api/vitest.review-unit.config.ts`
- `apps/web/index.html`
- `apps/web/src/App.tsx`
- `apps/web/src/components/layout/header.tsx`
- `apps/web/src/components/layout/layout.tsx`
- `apps/web/src/components/layout/sidebar.tsx`
- `apps/web/src/hooks/use-wallet-action.test.tsx`
- `apps/web/src/hooks/use-wallet-action.ts`
- `apps/web/src/pages/casino/casino.test.tsx`
- `apps/web/src/pages/games/dice-system.test.tsx`
- `apps/web/src/pages/games/dice-system.tsx`
- `apps/web/src/pages/games/index.tsx`
- `apps/web/src/pages/home.tsx`
- `apps/web/src/pages/login.tsx`
- `apps/web/src/pages/profile.tsx`
- `apps/web/src/pages/register.tsx`
- `apps/web/src/pages/wallet-operations.tsx`
- `apps/web/src/pages/wallet-payments.css`
- `apps/web/src/pages/wallet-payments.test.tsx`
- `apps/web/src/pages/wallet-payments.tsx`
- `apps/web/src/pages/wallet.tsx`
- `apps/web/vite.config.ts`
