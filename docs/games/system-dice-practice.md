# System Dice practice

Dice Seven Up is a server-scheduled free practice table. A new round opens every epoch minute, accepts one explicit ticket per active account for 45 seconds, reveals for 10 seconds, then displays the result for 5 seconds. The browser derives the countdown from server time; reloads never create or restart rounds. A supervised worker creates and completes rounds even when nobody is watching.

Two independent uniform dice produce 36 equally likely pairs. A total of 7 or higher wins on 21 pairs. Stakes are 35–490 credits in steps of 35. A win returns 54 credits per 35 staked, including the stake; a loss returns zero. Thus (21/36) × (54/35) = 90% theoretical gross return and a 10% expected edge. No additional fee is charged. This is a long-run expectation, not a per-round profit guarantee.

Accounts start with 1,000 nonredeemable practice credits. They never enter Coin or Game Point wallets and cannot be bought, gifted, transferred or converted. This release does not add Dice to group PVP. Existing group games retain their separate 7% completion fee.

The forward migration pauses the historical Coin Dice catalog entry (7+ at 2× implied 116.67% gross return). It preserves immutable historical rules and completed sessions. Existing exact Coin play retries continue to replay before current catalog checks. No financial gate is enabled.

Rounds, tickets and balances are durable. One ticket per account/round prevents duplicate admission; changed amounts conflict. Cutoff is rechecked after lock waits and writes. The draw commits before settlement, so failed credits resume against the same dice. Database constraints enforce valid dice, cutoff, immutable history, exact payouts and the 1,000 + ticket returns − stakes balance. Browser storage saves an unresolved request before sending; retries preserve the original round and amount. Stale snapshots disable new entry.

Deployment requires the forward migration and SELECT/INSERT/UPDATE access on the three system_dice_practice tables for the isolated practice runtime. Its users-row read lock also requires an existing UPDATE privilege on a users column. Set SYSTEM_DICE_PRACTICE_ENABLED=true separately on the API and the supervised group practice worker. The API never starts the worker. Fresh/populated migration, native concurrency/recovery, restricted-role, exact 36-outcome math and browser contract tests cover this release.
