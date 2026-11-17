# Isolated ETB payment requirements

Base: combined candidate `6a023641a9cbbbff0098f7da9023090afbfdb84f`.
New ETB_V1 agent/P2P deposits require at least 10,000 santim (100 ETB), and
new withdrawal quotes require at least 50,000 santim (500 ETB), inclusively.
USD_V1 arithmetic and crypto conversion/minimum rules are unchanged. Existing
idempotent orders and valid accepted quotes keep their recorded terms. Country,
agent/account, eligibility, available-balance and technical maximum checks remain.
New pricing snapshots record the minimum-policy identifier.

No casino stake control was changed. `/casino` mounts a provider lobby. The
reported 100 ETB ceiling and 500,000 ETB payout cap were not identified in this
source. The supplied screenshot is another platform's reference, not Salem
runtime evidence. The analogous owned Sky Crash uses practice credits with a
500-credit server/database maximum. No game policy or constraint was changed.
Crypto applicability remains unresolved; its existing behavior is preserved.

No new schema or migration files, live configuration, real credentials/customer
transactions, publication, merge or deployment. Explicit later approval covered
existing migrations and synthetic transactions only in newly created loopback
PostgreSQL infrastructure. That approval was used for the native checks below.

PR81 paths were checked: this patch avoids its wallet.tsx, layout, account setup,
order-room and auth-provider changes. Independent review and combined-branch
verification remain required before integration.

## Validation evidence

- `pnpm --filter api exec vitest run --config vitest.etb-requirements.config.ts`:
  **69/69**, including pricing, 13 mocked service-boundary tests and 26 lifecycle
  tests (eight accepted-policy regression cases). Database operations are mocked;
  an inert loopback port-1 URL satisfies module configuration validation only.
- `pnpm --filter web exec vitest run src/pages/wallet-payments.test.tsx src/pages/payment-requirements.test.tsx src/pages/wallet-pricing-admin.test.tsx`:
  **26/26**.
- `pnpm --filter api typecheck` and `pnpm --filter web typecheck`: passed.
- `node apps/web/src/lib/i18n/tools/coverage.mjs --strict`: **3,161/3,161** keys,
  no missing keys or validation issues. This does not prove translation quality.
- `pnpm --filter api exec vitest run --config vitest.payments-native.config.ts`:
  **80/80 across seven files**, including the new 12-case ETB suite.
- `pnpm --filter api exec tsx src/scripts/ledger-invariant-scan.ts --json`:
  passed with **zero violations**; scan transaction rolled back.
- Native environment: fresh PostgreSQL **18.7/macOS**, SCRAM authentication,
  listen address127.0.0.1 only, port55455. Exact existing130 live-prefix migrations
  matched candidate history; four existing candidate migrations brought it to134.
  No real data was imported. Owned cluster removed; listener absent afterward.

Five existing native fixture files were rescaled coherently for the new floors,
retaining authorization, step-up, pending-order limits, rollback, concurrency and
idempotency assertions. Token timestamps were not rescaled. Historical inert
recovery fixtures were retained, not reinterpreted as new deposit admission.

## Native proof and limits

The new suite exercises persisted99.99/100 deposit and499.99/500 withdrawal
boundaries;100 ETB settlement at150 ETB/USD; a persisted legacy50 ETB deposit
settlement, unchanged snapshot and replay; new500 ETB quote consumption once
under concurrent replay; unchanged valid legacy100 ETB withdrawal quote
consumption; inventory shortfall rollback; concurrent three-order admission;
restricted runtime admission, quoting and signed settlement; missing policy
SELECT rollback; insufficient balance rollback; post-quote country pause; and
another member's quote denial. All transactions and identities are synthetic.

Legacy accepted records are constructed from the prior snapshot shape in a
fixture transaction; this is not a production data migration or a full prior
application deployment rehearsal. The test harness retains an owner connection
for setup/assertions; application calls in restricted-role cases use the runtime
connection. No claims about all production roles, Linux or PostgreSQL13/16 are
made from this local run. CI configuration now includes these tests with an
explicit synthetic acknowledgement in its disposable PostgreSQL job, but no
remote workflow has been run for this unpublished branch.

## Independent-review correction: accepted-deposit settlement

The first draft reused the new admission floor when validating legacy accepted
deposits. `assertDepositReady(..., 'settlement')` now uses
`priceAcceptedDeposit`: no immutable minimum-policy marker selects the original
USD-equivalent minimum; the exact supported marker selects the recorded new ETB
minimum. Unknown, null or altered markers fail closed. New-request pricing always
uses current admission policy. No stored snapshot, amount, safety hold, expiry
or submission-window requirement is rewritten or bypassed.

## Remaining release requirements

Independent final source/CI/evidence review, CI on the supported PostgreSQL
matrix/Linux, rendered interface QA and native-language review remain necessary.
No casino/provider integration, real-money activation or legal-policy assessment
is included. Publishing, merging and deployment require separate approval.
