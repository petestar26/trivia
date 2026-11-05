# Native ETB wallet and crypto conversion

Cash wallets now store ETB santim (100 internal units = 1 Birr). Legacy column/API identifiers such as `coinsBalance` and `coinAmount` remain for ledger compatibility; they are integer ETB minor units, not a token balance. `/wallet` also explicitly returns `currency: ETB`, `minorDigits: 2`, and `balanceMinor`. Wallet, payment, treasury and pricing screens format these values as ETB. Practice game and gift balances stay independent and nonredeemable.

## Initialization and deployment

The live read-only preflight found zero nonzero cash wallets, cash transactions, economic operations, provenance lots, orders, withdrawals, crypto requests, agent inventories and exchange-rate records. Migration `20261104150000_native_etb_wallet` repeats these checks under exclusive table locks and also checks withdrawal quotes. It refuses populated financial history instead of relabeling or converting it. It records an immutable ETB denomination and disables obsolete token bundles. No balance, payment destination, financial policy or service gate is funded or activated.

API and database must deploy before the web client. Keep the practice worker and provider-demo restrictions unchanged. After this migration, roll forward to fix faults; old USD/token admission code is intentionally rejected by the database's ETB rate guards. A different funded installation needs a separately reviewed data migration.

## Reference and quotes

The server fetches `https://ethioblackmarket.com/api/latest-prices?period=all`. A persistent atomic lease limits attempts across replicas/restarts to once per 15 minutes, including failed attempts. The response is bounded to 2 MB with a 10-second timeout and redirects rejected. The current USD value must match both `allLastprice.USD` and the newest historical observation. Future/stale observations, nonpositive/nonfinite values, unmatched timestamps, and a move exceeding 10% from the previous accepted quote fail closed. Observations expire 30 minutes after the source timestamp. No default or hardcoded market rate is used.

The source is a reference feed, not an exchange or settlement provider. The product quotes 1 USDT as USD 1, disclosed in the customer rate details and admin pricing screen. Deposits round down to santim; payouts round down to USDT micro-units, using BigInt arithmetic. Neither reference changes nor outages revalue an existing ETB wallet.

Each new crypto request includes the reviewed rate ID. A changed or expired rate requires a new review. The server persists the source, exact rate, observation time, currency, pricing version, and amount. The database verifies the exact conversion, valid quote window, immutable terms and foreign-key relation to the retained rate. Deposit instructions last up to 15 minutes and never outlive the quote. Existing request retries return their original terms, even when new rates are unavailable.

Existing receipt verification, unique transfer evidence, ledger provenance, withdrawal holds, eligibility, limits, step-up, and cancellation/refund protections remain in place. A timely transfer discovered after expiry settles the original amount. Duplicate, wrong or late transfers still follow the existing review path. There is no user-accessible endpoint that can claim payment verification.

The public `/api/v1/wallet/exchange-rate` endpoint returns cached reference information only; it never allocates addresses or triggers a provider fetch. Admin pricing now shows this reference and its freshness. Older token-package endpoints return an empty catalog and refuse package writes.

## Validation

Focused tests cover guarded empty-ledger initialization, currency permanence, exact SQL conversion, saved-rate linkage, immutable payment terms, verified settlement proof, integer arithmetic/rounding, stale and malformed feed data, persistent refresh leasing, actual application invoice creation, changed-rate rejection, duplicate request replay, exact withdrawal holds, ETB inputs/display, admin funding, route access, and existing payment workflows. Type checks and production builds run for the web and isolated API release. Browser checks use clearly labeled local fixtures at phone/desktop widths; they are not evidence of a real transfer. Native concurrent PostgreSQL tests require the disposable database and have not been run in this environment.

## Remaining live-payment prerequisites

Currency configuration does not replace the missing payment setup: approved agent destinations and backed funding/payout liquidity; valid crypto receiving addresses, the configured TRON verification service and payout funding; and the existing country/account eligibility and service activation. The last readiness report had no active agents, receiving-address pool, financial policy or enabled financial gates. No real transfer was initiated in this work.
