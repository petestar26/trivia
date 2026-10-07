# Crash Point practice v1

Original Ruby Grand graph presentation inspired by the publicly described rising-multiplier/cash-out mechanic at https://eg1xbet.com/en/games/crash-point. No operator branding, proprietary artwork, timing, or payout formula is copied. No live reference session or third-party RNG certification was verified.

## Release boundary

Practice only. Dedicated 1,000-credit accounts have no relationship to Coins, Game Points, deposits, gifts, transfers, or withdrawals. The catalog row stays COMING_SOON/inactive for financial play. The public client has a practice route. API and independent scheduler are explicitly gated by CRASH_POINT_PRACTICE_ENABLED=true. Crash PVP is not available; a pool-funded contest requires separate rules.

## Rules and outcome

An epoch-minute round opens for 15 seconds, then its multiplier grows as exp(elapsedMs / 10000). Up to two tickets per player/round, independently keyed by immutable slot 1 or 2, integer stakes 10–500. Optional auto target is an integer hundredth multiplier from 101 to 2000, persisted with admission. Amounts and targets cannot change afterward.

The server uses a random 32-byte seed. SHA-256(seed + ':' + counter) is rejection-sampled from its first unsigned big-endian 32-bit word, accepting values below 4,000,000,000 and mapping modulo 1,000,000,000 plus one. Crash cents are clamp(ceil(90,000,000,000 / draw), 100, 2001). For a fixed allowed auto target c, survival probability is floor(90,000,000,000 / c) / 1,000,000,000, up to the vanishingly small exact-divisibility boundary; gross expected return is approximately 90% before credit rounding. An outcome equal to the target loses. Individual returns are floor(stake * paidCents / 100); small stakes have a larger rounding effect.

Flight terminates no later than 20.01x. Manual and automatic returns are capped at 20.00x. This leaves valid max-target auto cashouts before the terminal cutoff. Results remain visible until the next minute. There is a 1.00x immediate-crash probability of 10%.

Manual acceptance uses database processing time after round, ticket and wallet locks. Client timestamps, multiplier, outcome and payout are never accepted. Cash-out at/after crash time loses even without a scheduler tick. Automatic settlement takes priority once its persisted target was reached before the crash, regardless of client connectivity or later worker delays.

## Persistence and integrity

Round seed/outcome/commitment are immutable. Ticket uniqueness per round/user/slot, immutable fields, exact payout checks, cutoff checks and deferred account-vs-ticket balance constraints run in PostgreSQL. One transaction transitions the ticket and credits its practice account. Retry returns the saved receipt. Tick and snapshot recovery settle pending tickets from the original round, never rerolling. Snapshot reads lock the account while reading the wallet and receipts. Pending browser entry receipts preserve the exact admission payload through interrupted requests.

The public snapshot reveals neither seed nor crash point until database time reaches the crash. Commitment is SHA-256(roundId + ':' + seed). The browser verifies commitment and recomputed crash result after reveal. This is a seed-commitment check, not independent entropy certification or protection against a malicious operator who chose a seed before commitment.

## Visuals and accessibility

SVG curve with an extruded trail, dimensional CSS floor, ruby glow, rose-gold controls and accessible text. No WebGL requirement or raster game assets. Responsive stacked controls, keyboard focus states and reduced-motion beacon. Only server receipts confirm returns; interpolation is decorative, and inputs/manual cash-out pause on stale or unavailable data.

## Deployment

Forward-only migrations:
- 20261006190000_crash_point_practice (enum and guarded tables)
- 20261006190100_crash_point_catalog (dormant financial catalog row)

On the explicitly disposable staging setup service run node apps/api/dist/scripts/staging-crash-point-upgrade.js --apply. It checks the target, owner, prior checksums, allowable pending migrations and runtime roles, then grants only SELECT/INSERT on rounds and SELECT/INSERT/UPDATE on practice tickets/accounts. Run --verify afterward. It requires the existing SOCIAL_WORKER_DATABASE_URL, not the narrow Spin entropy worker role. Deploy API, web and group-pvp worker from the same reviewed commit. Enable CRASH_POINT_PRACTICE_ENABLED on API and group worker only after the upgrade succeeds.

For other environments apply these migrations as database owner and grant the dedicated runtime roles equivalent limited access. This staging script refuses other targets. Financial launch requires a separate capital/exposure model, independently reviewed randomness/publication policy, configured wallet integration and jurisdiction-specific approval.

## Verification

PGlite tests execute the actual service SQL and PostgreSQL triggers but serialize transactions. The native CI test suite uses acknowledged disposable PostgreSQL 13, 16 and 18 databases for concurrent entry, concurrent payout, cutoff after wallet-lock wait, ownership, missed worker, automatic restart recovery and immutable-history guards. React tests cover entry payload, cash-out payload without a client multiplier, interrupted admission replay, restored receipts and disconnected availability. Full web tests/typecheck/build cover surrounding navigation.

## Public practice activity

The authenticated, feature-gated `/games/crash-point/activity?roundId=...` endpoint returns up to 100 ticket receipts and an exact total from the same SQL statement snapshot. It requires an active account and an already-open round. Only stake, settled payout, and settled multiplier are selected; pending payouts remain null. Round-specific pseudonyms are derived from random ticket IDs; account IDs, names, auto targets, seeds, and crash points are not returned. The UI refreshes every three seconds, supports current/previous round selection, and reports empty/loading/error states without invented players. The public leaderboard lists the 50 highest confirmed ticket returns from the last 24 hours, with the same anonymous labels. Returns include stake; it is not net profit or a prediction.


## Dual tickets and bounded autoplay

Migration `20261006210000_crash_point_dual_tickets` preserves existing tickets in slot 1 and changes uniqueness to round/user/slot. Slot is constrained to 1 or 2 and immutable; all existing payout, cutoff, and account reconciliation guards remain. Missing API slot defaults to 1 for old clients. Snapshots retain legacy `ticket` for slot 1 and expose `tickets` plus `maxTickets: 2` for new clients. Deploy the upgraded worker after migration and before enabling the new API/UI to ensure both slots settle unattended.

Each panel can explicitly start up to ten future entries using a fixed stake and automatic cash-out target. Autoplay exists only in the active page, never survives refresh, and stops on hidden tab, stale/disconnected data, storage failure, rejected/interrupted admission, or insufficient balance. Stop prevents future entries; it does not cancel an already sent request or accepted ticket. Each pending admission has a separate per-slot saved receipt and retains idempotent retry. No progression, loss-chasing, or unlimited autoplay is provided. The separate server auto cash-out on confirmed tickets survives disconnects.

Follow-up migrations pin the slot trigger search path. `20261006210200_crash_point_invoker_guard_path` sets `public, pg_temp`, the platform invariant required for this invoker trigger; it does not run as an owner or on a cascading foreign-key action. Earlier applied migrations are preserved.

## Review follow-up: 2026-10-07

The client review found that the shared arena status and current-round summary still described slot 1 only. They now show every accepted slot, total stake, individual targets and confirmed returns. Personal history identifies the bet slot. Both panels explicitly label their balance as shared. The public leaderboard caption now states its actual 24-hour window.

Dual controls use the available game-column width when deciding whether to stack, avoiding cramped panels next to the desktop activity rail. Coarse-pointer presets and auxiliary controls have a 44px minimum touch height. This is a CSS review and correction; a real mobile/tablet browser pass remains outstanding because the available browser interface does not expose viewport emulation.

Regression tests cover a Bet 2-only settled receipt across the arena, summary and history, and autoplay stopping on connection loss without silently restarting after reconnection. Existing tests cover dual admission/cash-out, ten-round bounds, interrupted retry, hidden-tab stopping, SQL concurrency and exactly-once settlement. No live browser wager is needed for these tests.

For the later independent review, compare the reviewer’s original baseline with the current PR head and include Crash Point’s dual tickets, activity feed, leaderboard, bounded autoplay, forward migrations and this display/responsiveness follow-up. Preserve the practice-only boundary; do not infer financial readiness from passing practice tests. Review the original report first and consolidate its findings before preparing the next review prompt.
