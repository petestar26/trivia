# USDT on TRON payments (dormant)

This feature implements USDT deposits with automatic Coin credit and withdrawals paid manually by an administrator. It does not enable production payments or wagering. The migration inserts three disabled gates and changes no existing gate or country approval.

## Member and administrator workflows

- Members open Wallet → USDT / `/wallet/crypto`. The server requires their active payment-profile country, approved country policy containing `USDT_TRC20`, required identity tier, and fresh USD pricing. One USDT is explicitly quoted as one USD at 96 Coins; this is a product quote, not a live USDT/USD price feed. Fractional Coins and fractional payout micro-USDT round down. The existing crypto thresholds apply (deposit at least $10; withdrawal greater than $20, or higher configured limits).
- Deposit requests receive a unique address from the administrator's pool. The address is permanently reserved even if the request expires. Never add reused addresses or private keys. A request lasts at most 15 minutes and never outlives the accepted pricing window. Retry uses the same member/request identity and immutable terms.
- The dedicated verifier discovers TRC20 history, then independently checks each successful solidified receipt, pinned contract, recipient, amount, log index and block timestamp. History alone cannot authorize credit. One exact transfer within the window credits Coins atomically with receipt/settlement/ledger evidence. Amount mismatches, multiple transfers or late transfers go to review without credit. An on-time block may be discovered after expiry. Expired addresses remain monitored; failed or incomplete scans never credit. This implementation does not combine partial payments.
- Members enter a TRON withdrawal address. The request snapshots it, holds only eligible withdrawable Coins, applies holding periods and combines P2P and crypto usage for daily/monthly limits. Members may cancel only before an administrator claims payout; cancellation restores original lots once.
- Administrators use `/admin/crypto` to add/retire unused addresses, inspect deposits and see the member's exact payout address and amount. Adding an address, claiming payout, and confirming payout require authenticator step-up. The assigned administrator transfers externally, checks TRON success/address/amount, enters a unique transaction hash, then confirms. No private key, transaction signing or broadcasting exists in this application. Confirmation is administrator-attested, not automated outgoing-chain verification. A claimed payout cannot be cancelled because an external transfer may already exist. Another administrator cannot take over or confirm it silently.

## Deployment and trust boundary

Apply all migrations before deploying the API. Run the existing owner-only runtime grant setup again: `ledger_apply_runtime_grants(api_role)` grants the API the new tables but explicitly denies creation or mutation of receipt evidence. Runtime identity preflight now checks this boundary.

Provision a **separate restricted database login** for the verifier; the API must not inherit or be able to SET ROLE to it. As owner only, run `crypto_apply_verifier_grants(verifier_role)`. This preserves canonical ledger restrictions, then gives that identity receipt INSERT permission. Never supply an owner/superuser database URL to the worker. Re-running the ordinary runtime grant helper for this identity intentionally removes its receipt INSERT capability; reapply verifier grants explicitly afterward.

The standalone entry point is `node apps/api/dist/scripts/crypto-payment-worker.js` (`--once` for a bounded pass). It requires its own DATABASE_URL, `CRYPTO_VERIFIER_ENABLED=true`, and `TRONGRID_API_KEY`. No worker starts with the API or existing payment worker. It contacts only `https://api.trongrid.io`, refuses redirects, bounds responses and pagination, and pins official mainnet USDT contract `TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t` with six decimals. Mainnet and testnet tokens are not interchangeable. A mocked/synthetic test proves application behavior, not a real external payment.

Only an independently approved release may enable `CRYPTO_DEPOSIT_CREATE`, `CRYPTO_DEPOSIT_CREDIT` or `CRYPTO_WITHDRAWAL_CREATE`, the existing `WITHDRAWAL_CREATE`, or jurisdiction policies. No UI or API in this feature enables these gates. Country payment pauses remain enforced. Existing production activation blockers remain outstanding.

Before activation, verify the restricted API and worker identities, authenticator enrollment, address custody, provider key/rate limits, successful controlled deposit and manual payout, mismatch/expiry recovery, monitoring capacity and reconciliation. The first version requires operators to supply a new address for every invoice; it does not derive HD-wallet addresses or sweep balances. Monitor available address count and oldest `lastCheckedAt`: permanently monitored expired invoices increase scan load. Review deposits and uncertain externally started payouts require a separately audited recovery procedure; no force-credit/refund button is supplied. Extra transfers to an already credited address require support investigation and are not automatically credited or monitored by this worker.

## Withdrawal safety follow-up

All crypto actions, including member cancellation of a HELD withdrawal, require a currently ACTIVE actor. An active authorized administrator can still return a suspended owner's held funds. The PVP own-entry reversal exception does not apply to crypto withdrawals.

Withdrawal creation and payout claim/confirmation reject any address in the platform deposit pool, including retired addresses. Address registration and withdrawal admission share a per-address transaction lock, and an address used by a HELD or PAYOUT_IN_PROGRESS withdrawal cannot be registered as a deposit address. Existing conflicting requests cannot be claimed or confirmed; HELD requests retain the normal authorized cancellation path. Exact successful completion retries remain idempotent. Operators must verify recipient control before an external transfer; these checks do not establish ownership of arbitrary external wallets.

## Source contracts

- [Tether supported protocols and official TRON contract](https://tether.to/en/supported-protocols/)
- [TRON confirmation semantics](https://developers.tron.network/docs/confirmation-semantics)
- [TRONGrid account TRC20 transaction history](https://developers.tron.network/reference/get-trc20-transaction-info-by-account-address)
- [TRON transaction receipt query](https://tronprotocol.github.io/documentation-en/api/http/block-and-tx-query/gettransactioninfobyid/)
