# Scheduled Coin hold/refund foundation

Draft implementation; wagering remains disabled. There is no public endpoint,
settlement path, prize mint, treasury reservation or fee collection in this module.
The scheduled practice stream never calls these helpers.

A stable hold ID identifies one immutable set of terms. Reservation moves Coin
value from available to reserved on the same original lots, with an exactly
matched wallet debit. Cancellation releases those exact source entries back to
their original lots. No MINT, reclassification or playthrough progress occurs.
Restrictions, expiry and source lineage survive cancellation. New holds require
the `SCHEDULED_STAKE_HOLD` gate, seeded false; refunds remain possible when paused.

The caller must own the admission, identity and jurisdiction checks and run the
helper inside its transaction. The helper acquires its stable scope lock before
wallet and lot locks. This is not independently sufficient for player admission:
round cutoff, immutable ticket terms, policy eligibility and treasury backing
must be implemented before exposing it. No production permission setup or gate
activation is included.

Database constraints bind the hold/refund to its user, amount, policy, operation,
wallet transaction and original source entries. Runtime invariant I17 uses the
same proof query. Refunding twice is replay, not a second credit. Exact hold replay
returns the stored debit balance, even after refund. Different terms conflict.

Restricted lots with outstanding reserved value are not converted by an
unrelated instantaneous wager. Their obligation-share denominator includes
available plus reserved value. Cancellation preserves the obligation; it does
not grant qualifying progress or waive an unmet requirement.

Validation is run against isolated PostgreSQL 13 and 16 by the scheduled-rounds
workflow. The native stake test requires the exact acknowledged throwaway DB.
No passing native result should be inferred from compilation alone.

Still required: durable house capital accounting and capacity admission,
settlement and result linkage, private/group/challenge funded-pool settlement,
fee disclosures and consent, per-game adapters and UI, crash recovery tests,
and independent review of the complete candidate before activation.
