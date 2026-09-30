# Scheduled Coin hold/refund foundation

Draft implementation; wagering remains disabled. A dormant, owner-only Spin
Win draw and ticket settlement path exists elsewhere in the economics module,
but no public endpoint or worker calls it. The scheduled practice stream never
calls these helpers.

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
same proof query. A forward migration also compares each source lot's reserved
cache with the **sum of all active scheduled holds** against that lot. A deferred
lot trigger enforces this even when an unrelated operation changes the cache;
ordinary balanced transfers cannot consume backing owed to these holds.

Creation requires a matching ACTIVE published policy under a shared lock. A
later SUPERSEDED policy remains valid for historical proof, replay and refund.
DRAFT policies cannot become hold terms. Runtime setup grants UPDATE only on
`state` and `refund_operation_id`, with no DELETE permission; the verifier also
rejects immutable-field access through other reachable roles. Existing runtime
roles must rerun owner setup after this forward migration.

I3 checks the backing and no-truncate triggers along with the existing lot row,
entry-validation and cache-application triggers. Refunding twice is replay, not a second credit. Exact hold replay
returns the stored debit balance, even after refund. Different terms conflict.

Restricted lots with outstanding reserved value are not converted by an
unrelated instantaneous wager. Their obligation-share denominator includes
available plus reserved value. Cancellation preserves the obligation; it does
not grant qualifying progress or waive an unmet requirement.

Validation is run against isolated PostgreSQL 13 and 16 by the scheduled-rounds
workflow. The native stake test requires the exact acknowledged throwaway DB.
No passing native result should be inferred from compilation alone.

The dormant Spin Win path links holds to an owner-backed capital reservation,
committed round result, atomic payout or refund, game session, and capital
discharge. It remains off and has no operator worker or public route. Still
required for activation: independent/public randomness and commitment, external
funding reconciliation, supported recovery tooling, private/group/challenge
funded-pool settlement, fee disclosures and consent, per-game adapters and UI,
and independent review of the complete candidate.
