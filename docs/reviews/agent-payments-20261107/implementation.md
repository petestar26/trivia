# Agent payment orders and appeals

Each member and assigned agent can open the same private deposit or withdrawal order from the wallet history, processing desk or payment notification. The page shows the immutable wallet amount, payment amount, fee, recipient details, human-readable order number, deadline, held-funds state, conversation and appeal decision. Support uses the existing independent review desk and must claim a case before replying. Desktop places the conversation beside the order; phone layouts stack them. Interface copy is available in all eight supported languages.

## Payment journey

- Deposit: choose an approved receiving agent/account, accept the quoted amount, then transfer to the frozen account details before the deadline. The platform reserves agent Birr inventory. The member marks payment sent; the agent verifies actual bank/mobile-money receipt and releases the order once.
- Withdrawal: select a saved payout destination and confirm the quote, fees and required security verification. The backend atomically holds eligible wallet funds and matches a funded approved agent. The agent claims the payout, makes the external transfer and records its reference. The member checks actual receipt before confirming completion.
- Every financial action remains protected by the existing backend transaction, state, authorization, idempotency and ledger checks. A screenshot or chat message does not trigger release. Bet-only rewards and practice funds remain subject to the existing withdrawal exclusion rules.
- Either party can appeal a deposit while it is awaiting payment or marked paid. Either can appeal a withdrawal while held, processing or marked paid. An appeal pauses ordinary payment actions and preserves the reservation. An independent administrator claims the case, reviews both parties and records the decision. Completing an appeal opened before a payout submission requires verified transfer details.
- A transfer reported after a deposit expired or was cancelled uses the existing recovery process. Both parties can report and see that case. It does not credit a wallet or reopen a terminal deposit. Existing refund evidence, duplicate-reference and security-verification protections remain in place.

These are off-platform bank/mobile-money transfers. The platform holds its own order balances; it cannot inspect or reverse a bank transfer. Agents must verify money in the actual receiving account. The interaction follows the familiar held-funds, payment confirmation and appeal pattern described by [Binance P2P](https://www.binance.com/en/support/faq/detail/ed6efa0d16054aaa82f701fd7f0c7288), using Salem's own rules and identity.

## Repairs and safeguards

- A suspended agent login is excluded from new deposit admission and withdrawal assignment even when its Agent record remains active.
- Appeals are available before payment submission, including when a transfer was sent but marking it paid failed.
- Failed appeal and resolution submissions retain their explanation and evidence fields. Uncertain requests preserve the exact retry key. An HTTP success without a positive application acknowledgement is not treated as a confirmed payment.
- Explicit confirmations protect cancellation of unpaid deposits and confirmation of actual receipt. Stale or failed order refreshes disable mutations.
- Payment updates link directly to the order. Notifications no longer describe minor Birr units as a number of coins. Payout assignment, submission, settlement and automatic appeals generate notices in their respective transaction.
- A bounded maintenance loop runs with the API: expired unsubmitted deposits release only the agent reservation; overdue processing/submitted withdrawals enter review without automatic payout or refund. The loop does not overlap itself, continues independent checks after a failure, logs a redacted warning and waits for in-flight work during shutdown. Existing database locks also protect multiple processes.

## Private evidence

`payment_order_messages` is append-only, with exactly one deposit or withdrawal parent and an author-scoped idempotency key. Receipt images are stored in PostgreSQL, independent of container-local files. Only the parties and currently authorized support can retrieve them. Responses are private/no-store; downloads use attachment disposition, a restrictive CSP and nosniff. PNG, JPEG and WebP receipts are limited to 2 MB, ten per order; conversations are bounded to 500 messages and paginated in stable timestamp/id order. HTML/SVG uploads and MIME mismatches are rejected. Conversation text is rendered as text.

The migration grants a restricted runtime SELECT/INSERT only and explicitly denies UPDATE, DELETE, TRUNCATE and TRIGGER. Apply the normal owner-managed migrations and runtime grants before starting a restricted API. The new invariant checker recognizes the new pinned database functions. Deploy API/schema before the website. Do not roll an old API back over the new schema without accounting for its old function-name invariant list. No payment activation gate, rate, agent funding, receiving account or banking credential is changed by this release.

## Verification boundaries

The payment native suite uses a fresh disposable PostgreSQL database and actual financial services and HTTP routes. It covers both parties, all supported appeal phases, one-time settlement, concurrent release versus appeal, held-fund preservation, recovery, private downloads, suspended agents, message retries/pagination, append-only grants and deadline processing. The frontend suite covers consent, failed/stale refreshes, retained forms, uncertain retries, notification destination validation and existing wallet/notification behavior.

`review-payments-preview.mjs` uses a built loopback website and synthetic account/order responses. It checks all eight languages at desktop and phone widths, a 320 px layout, both parties' appeals and conversations, and unclaimed support access. It does not perform or prove a real bank transfer. CI repeats the native suite on PostgreSQL 13, 16 and 18. A successful build or simulated browser flow does not establish authenticated live bank, mobile-money, physical-phone or commercial payment acceptance.
