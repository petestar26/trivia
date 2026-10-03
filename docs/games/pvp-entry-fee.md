# PVP entry fee — approved 7% policy

Approved on 2026-10-03. Policy ID: `pvp-entry-fee7-v1`.
This supersedes the 15% proposal for newly created PVP contests. Historical
contests retain the fee terms explicitly pinned when they were created.

For each completed PVP contest:

- 7% of player entry funds is the platform fee.
- 93% of player entry funds goes to prizes.
- No additional fee is deducted from winnings.
- Sponsor contributions go to prizes in full.
- Voided or cancelled contests refund every contribution in full, with no fee.
- The fee applies once per contest, including contests with multiple rounds.

For example, ten entries of 100 units form a 1,000-unit pool: 70 fee units and
930 prize units. Tied winners split the available prize; whole-unit remainders
are allocated in canonical player-ID order.

House games retain their separate 10% theoretical edge and 90% theoretical
return. That house edge is not added to a PVP pool. Public or private group
visibility does not change the PVP fee.

## Entry quote

`quotePvpEntry(policyId, entryAmount)` returns the entry amount, completion fee,
prize contribution, full cancellation refund and zero additional winner fee.
Amounts are decimal strings in smallest ledger units so they stay exact during
JSON transport. Entries use multiples of 100 smallest units to avoid fee
rounding. This does not define a fiat conversion rate or a displayed currency.

The settlement planner uses the same calculation as the quote. The quote is
informational and does not accept an entry or prove payment. The future entry
screen must display these terms before confirmation, and the server must
recalculate the quote from the contest's pinned terms.

## Implementation status

The shared quote, settlement calculation, offline preview and tests are present.
The player entry screen, persisted consent, funded entry handling and durable
payout integration remain to build. Live PVP has not been activated.
