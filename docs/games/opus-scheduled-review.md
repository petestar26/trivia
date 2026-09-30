# Opus review handoff: shared rounds and Coin hold/refund foundation

This is **not a full-platform completion or wagering-activation review**.
Review the exact head of draft PR #10 (`feat/shared-game-economics`) and record
its SHA before beginning. Base implementation started at master
`ed03d13570df66629dd794885eb41841b918f15a`. Do not use an old checkout's generated
Prisma client or dependency symlinks.

## Review instructions

Use an isolated checkout with independent dependencies and disposable PostgreSQL
13 and 16 databases. Preserve other checkouts. Do not merge, deploy, enable gates,
access production or publish review comments. Read the entire base-to-head diff.

Verify independently:

1. The 90% house-return calculations for all proposed wager models, especially
   Dice's 36 elementary outcomes and Keno's 20 simultaneous winning numbers.
   Risk limits must consider the worst aggregate payout, not expected payout.
2. The 15% contest planner conserves funded contributions, refunds voids in full,
   and does not imply that its inputs have actually been escrowed.
3. Practice round creation/result persistence, exact ticket replay, cutoff under
   lock contention, pause behavior and recovery after worker interruption.
   Results must not depend on stakes, bankroll or prior results.
4. Hold/refund operation linkage to exact user, amount, policy, wallet transaction
   and original lots. Test ordinary SQL for orphan operations, extra entries,
   mismatched refunds and unrelated operations claiming reversal identities.
5. Restricted-source preservation, playthrough while a source is reserved,
   double/refund replay, concurrent overspend, transaction rollback and
   operation under the documented restricted runtime role.
6. Existing entry validator guards remain unchanged apart from the explicitly
   added hold/refund types and qualified name resolution. I3 must require strict
   function paths and proof triggers; I17 must agree with deferred constraints.
7. Fresh and populated-master migrations, replay, schema/model agreement and
   disabled default gates. No Coin API or worker may call the hold primitives.
8. Browser practice behavior and meaningful assertions. Do not treat pure math,
   an API build, or mocked tests as evidence of complete financial integration.

Use `.github/workflows/scheduled-rounds.yml` as the reproducible focused matrix.
Inspect its actual run logs on the candidate SHA. It includes native races,
existing financial guards, three selected migration tests and web checks; it is
not the full API suite or a broad mutation campaign. Full API typecheck has an
existing baseline; compare diagnostic identities rather than totals.

Report findings with severity, exact lines, deterministic reproduction, smallest
correction and regression test. Separate code readiness, migration readiness,
and deployment readiness. Explicitly distinguish missing planned integration
from a claimed implemented feature. Never approve activation from this review.

## Implemented versus outstanding

| Area | Current implementation | Still required |
| --- | --- | --- |
| 13-game economics | Versioned registry and exact proposed models; Trivia BONUS-only | Publish/review new rules for unfinished games |
| Scheduled public play | Durable shared Spin Win practice, authenticated API, worker and web page | Other 12 scheduled experiences and production scheduling |
| Coin holds | Disabled internal hold and exact-source refund, guards, I17 | Round/ticket/jurisdiction admission and result settlement |
| House risk | Pure aggregate liability and reserve calculation | Durable treasury ledger, backed-capital funding and reconciliation, atomic capacity reservation |
| Private/group/challenge | Pure funded-pool 15% fee plan | Durable event/escrow/results/fee ledger, scoring adapters, invitations and consent UI |
| Game clients | Existing clients plus shared Spin Win practice | Remaining game interactions, animations, accessibility and device validation |
| Release | Focused PG13/16 automated workflow | Complete integrated suite, independent review, target configuration and separately authorized activation |

A 10% expected house edge and a 15% funded-pool fee do not guarantee net business
profit. Neither changes outcomes to force the house to win. Customer balances
and pending withdrawals cannot serve as house risk capital.
