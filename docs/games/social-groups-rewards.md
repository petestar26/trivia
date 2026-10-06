# Social groups, chat and reward Coins

Implemented on `feat/social-groups-rewards`, based on `6bbba5f4025ab37aa24cd90889a68249524f4b82`. This change is locally verified; it has not been published or deployed. Public GitHub upload was blocked by automatic approval review pending explicit permission for source disclosure.

## Product behavior

- Group owners choose one implemented game: Spin Win, Turbo Keno or Dice. A round pins its game, entry and policy; changing games requires another round.
- PVP uses Game Points. All participating players confirm the same entry. The owner starts only when at least two players have joined and everyone in that round is ready. The server runs the 30-second countdown, persists the draw, and settles winners exactly once. The completion fee remains 7%; prizes share the remaining 93%. Voids refund the full entries without a fee.
- Dice players choose a total from 2 through 12. The draw uses two independent six-sided dice, including doubles. Exact-total winners share the prize pool. Existing no-winner void/refund behavior is retained.
- A paid participant cannot be banned, removed or made to leave during OPEN, COUNTDOWN or DRAWN. They may withdraw their entry before countdown; completed/void rounds release the restriction. This rule is also enforced by a database trigger.
- A group closes 24 hours after creation. The immutable deadline is stored as `timestamptz`; existing groups use their UTC creation time plus 24 hours. The UI shows a server-based countdown.
- Closure makes the conversation read-only and removes the room from active discovery. It preserves chat, gifts and financial audit history. Expired OPEN rounds refund; COUNTDOWN/DRAWN rounds retain their committed outcome and settle. Deadline admission checks work even when the worker is unavailable.
- Archive/unarchive changes only the current member's inbox. Closed rooms remain in the archived inbox even after personal unarchive because they cannot be reopened.
- Chat has an inbox, mobile navigation, message bubbles, date separators, replies, six reactions, targeted gifts and voice messages. Text sends use client receipts and transaction locks to make retries safe. History pagination stays within the group. No unimplemented online status or read receipts are displayed.
- Closed rooms disable new group gift purchases/sends. Owned gifts remain readable and convertible. An uncertain existing gift request keeps its exact receipt for confirmation.

## Separate currencies and reward rules

System Spin/Keno/Dice are nonredeemable practice streams. Group PVP and the collectible gift shop use Game Points. Financial Coin gameplay/cash activation gates remain unchanged and off in isolated staging. There is no new Coin-to-Game-Point exchange.

New free Coin grants from the reward service and reward-producing games pin `NET_WINNINGS_V1`. Their principal is bet-only: gifts cannot spend it, withdrawal requires WITHDRAWABLE lots, and the existing Coin-transfer prohibition remains. A verified winning settlement converts only attributable net profit into a WITHDRAWABLE successor lot. For example, a 20-Coin reward stake returning 36 Coins restores 20 restricted Coins and unlocks 16 spendable Coins. Losses reduce principal; break-even results and refunds do not unlock it.

Mixed-funded payouts conservatively allocate profit, with integer bounds enforced in SQL. The same rule applies to immediate and scheduled settlements. Conversion must reference a proven wager/hold settlement, match the source lot/user/policy, and be unique per source lot and session. Historical grants with no new rule retain their pinned rollover terms; this release does not rewrite previously awarded terms.

Collectible gifts still cost Game Points with 0% purchase fee, free owned-gift sending, and a 10% conversion fee. Converting a gift returns Game Points, not Coins or cash. Legacy Coin gift spending now selects WITHDRAWABLE lots only.

## Verification and release gates

Local PostgreSQL 16 checks cover 57 native group/game/gift/reward cases, 70 financial admission/settlement/proof cases, 124 existing ledger contracts and 56 fresh/populated migration cases. The 728 group/chat API cases pass across the broad run and the corrected fixture rerun. Shared group/PVP contracts pass 32 cases. All 125 selected web cases, web typechecking, the web production build and the complete API bundle build pass.

Desktop/mobile browser checks use synthetic local data and validate sending, reaction controls, refresh, personal archive, closed-room rendering and horizontal layout. They are visual/interaction checks, not current staging acceptance evidence.

Whole-API TypeScript checking has pre-existing baseline errors; an API bundle is not proof that this repository-wide typecheck passes. PostgreSQL 13/18 CI and deployed end-to-end verification have not run for this unpublished branch.

After publication is approved: run the full configured CI matrix; apply both migrations through the existing isolated staging owner procedure; verify the restricted group worker has only the required group status/update permissions; deploy API, web and group worker; confirm all financial gates remain off; and verify two-account chat/PVP/closure/reconnection with the deployed revision. Never reset staging or target production. Existing groups older than 24 hours will close under the migration, so verify the target group inventory and refund recovery before rollout.
