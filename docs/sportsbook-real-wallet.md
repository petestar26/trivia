# Salem Bet sportsbook

The Sports section uses the existing SoftAggregator operator credentials and
Nocturn Sport catalogue entry. Its `sr_` player identities are separate from
casino practice (`st_`). Opening Sports never grants money. The member sees
available, classified, withdrawable ETB from the existing wallet; reward and
practice balances are not eligible for this cash-only sportsbook.

## Initial release

Browsing is available at `/sports`. Betting remains closed. The provider's
balance callback returns zero while live play is closed, even for an account
that has cash. New preview identities cannot receive credits or place stakes.
The existing casino practice catalogue excludes sportsbooks, and the callback
blocks new stakes from older practice sportsbook sessions. Historical practice
credits can still settle into practice funds only.

API service settings:

- `SOFTAGGREGATOR_SPORTS_ENABLED=true`
- `SOFTAGGREGATOR_SPORTS_CALLBACK_ENABLED=true`
- `SOFTAGGREGATOR_SPORTS_LIVE_ENABLED=false`
- `SOFTAGGREGATOR_SPORTS_COUNTRY=ET`
- `SOFTAGGREGATOR_SPORTS_GAME_ID=x88c09ae664d9af4`
- `SOFTAGGREGATOR_SPORTS_LAUNCH_HOSTS`: exact public HTTPS launch hostname,
  verified by `sports-readiness.js --inspect-launch`; no wildcard.

The existing `/sg/callback` URL authenticates the fixed provider source,
timestamp, MD5 key and full-query HMAC before routing by player namespace.
The sportsbook never accepts a caller-selected player, market country, currency
or game ID. The operator's existing API keys and callback salt stay server-side.

## Cash activation is a separate operational step

Do not turn live betting on as part of the browsing release. Real payments must
first be operational and correctly funded. Activation requires all three:
the live environment flag, the `SPORTSBOOK_PLAY` gate, and the existing
`CASINO_PLAY` gate. A current enabled jurisdiction policy, an active payout
account, any required verified identity tier, active user status and sufficient
available cash are checked for every new stake. No per-user manual award or
test balance is needed. A funded user becomes eligible automatically when the
platform and account requirements are satisfied.

Before activation, confirm provider commercial/market/currency readiness and
perform provider-assisted settlement acceptance against the intended environment,
including cancellations, cash-out and rollback. Local database tests do not
replace that acceptance. An existing admitted live session may receive winnings
and adjustments after a pause or account suspension; new bets are rejected.

## Accounting and rollout

Apply the two forward migrations in order. They add the sportsbook identities,
immutable receipts, two named economic operation types and narrow cash-ledger
proofs. Existing deposits, bonuses, casino practice and withdrawals retain their
own accounting. `SPORTSBOOK_PLAY` is created disabled. The ledger integrity scan
includes the new proofs and permits only receipt-backed sportsbook winnings.
If using a restricted runtime role, run the existing owner-managed runtime-grant
procedure after migrations; the readiness command verifies required access.

Every movement is deduplicated globally by provider call ID. Conflicting retries
are refused, including reuse for another player. Wallet locks serialize bets with
other wallet operations. Failed stake receipts retain their original outcome.
Successful cash movements atomically write the wallet transaction, economic
operation, cash lot entries and immutable provider receipt. Deferred proofs are
flushed before returning success. Signed live payouts need no fabricated debit.

Pause with the live environment flag or sportsbook gate; keep callback processing
enabled so already admitted sessions can settle. Never delete identities or
receipts, reset balances, or substitute practice funds for a missing cash wallet.

Reference: https://softaggregator.com/docs.html (checked 2026-11-05).
