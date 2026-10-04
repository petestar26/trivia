# USD payment extension: implementation decisions

The existing agent order, inventory, withdrawal hold, fiat liquidity, settlement,
dispute and Coin ledger remain authoritative. No second wallet is introduced.

Existing rates multiply smallest local currency units, despite an ambiguous
schema comment. Existing transactions retain that interpretation. USD pricing is
an explicit, one-way country activation: new rates carry versioned terms, while
old transactions and already-issued withdrawal quotes retain their snapshots.
Disabling or expiring the latest USD rate must never restore a legacy rate.

New calculations use integer rational arithmetic: 96 Coins/USD, local currency
minor units, floor Coins on deposit and floor local payout on withdrawal. USD
reference amounts are stored as numerator/denominator, not rounded display cents.
The initial P2P thresholds are >= USD 2 and > USD 4 (192 and 385 Coins).
Crypto thresholds are >= USD 10 and > USD 20 (960 and 1921 Coins).

Package USD prices are derived display estimates, not independent exchange rates.
700, 1400 and 3500 Coins display USD 7.29, 14.58 and 36.46. A displayed rounded
price must never be used to recalculate a different Coin quantity. Packages below
a route minimum cannot bypass that minimum.

Rate observations have a source, timestamp and expiry; stale rates fail closed.
Manual, audited rates provide an explicit fallback. A scheduled source must have
a verified provider contract/API before automation is enabled. The suggested
ethiopianforexrates.com is an informational parallel-market reference, not a
verified settlement API. No scraping-based settlement integration is assumed.

Crypto remains unavailable until a provider, supported countries/networks,
webhook authentication, reconciliation and payout authorization are configured
and tested. A country selection is not proof of residence or eligibility.
Nonzero fees require an approved settlement/accounting policy; the initial
extension preserves existing zero-fee settlement instead of deducting money
without a corresponding recipient and ledger entry.
