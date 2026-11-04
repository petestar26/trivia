# Wallet payment access

The wallet routes previously replaced every deposit, withdrawal, activity and account-setup page with a practice-only explanation when `VITE_PRACTICE_ETB_ENABLED=true`. Wallet routes now open the existing Agent and USDT/TRON forms independently of the practice game setting. The overview distinguishes the cash payment wallet from noncash practice ETB. The subsequent native ETB initialization is documented in [wallet-etb-conversion-20261104.md](wallet-etb-conversion-20261104.md).

Members can prepare their own payout destination in an active country while payments are paused. Country/method validation and destination ownership remain enforced. Quotes and actual withdrawals retain the country, financial-policy, balance, liquidity and gate checks. The wallet reports the server's withdrawal availability, and the crypto options require both deposit gates and an unused receiving address before presenting deposits as available. No receiving addresses are disclosed by the options endpoint.

## Live prerequisites

A read-only deployment report on 2026-11-04 confirmed that this environment had no payment countries, zero unused crypto receiving addresses, and all withdrawal/crypto gates disabled. This is a configuration blocker beyond the UI routing issue.

The guarded `payment-setup.js --initialize-etb` command adds Ethiopia/ETB and Telebirr/bank-transfer method definitions. Existing records are preserved. It creates no agents, receiving account details, exchange rates, funding, policy approvals, KYC records or financial gate activation. It is restricted to the existing Salem API service/project/environment.

Actual payment processing still requires:

- An active agent with an approved receiving destination, a current verified ETB/USD quote, backed ETB deposit funding, and payout liquidity.
- Configured and activated country financial policy and the withdrawal gate through the existing invariant-checked process.
- For crypto, unused platform-controlled USDT/TRON receiving addresses, the separately restricted receipt-verifier worker and its provider credentials, and the crypto gates/policy.

The read-only `payment-readiness.js` report logs counts and configuration states only. PostgreSQL enforces a read-only transaction. It never logs destinations, user records, balances or credentials.

## Validation

- 48 focused web checks: payment routing with practice enabled, separate balances, unavailable states, payout-account preparation, request retries, and deposit/withdrawal review.
- 23 API readiness checks, including paused-country profile preparation, quotes remaining blocked, country/method validation and withdrawal availability reporting.
- 22 crypto checks covering availability, authentication, network/amount validation, receipt verification and database migration constraints.
- Web production build, API build and API typecheck passed.
- Actual components visually checked with local fixtures at 375px and 850px widths.

No real payment was initiated or settled during this verification. Frontend/API checks do not constitute an end-to-end bank or on-chain settlement test.
