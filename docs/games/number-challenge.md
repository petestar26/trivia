# Number Challenge — shared free-practice rounds

## Reference and scope

Reviewed 1xBet's catalog and Fair Higher vs Lower pages on 2026-10-12:
- https://eg1xbet.com/en/games
- https://eg1xbet.com/en/games/fair-higher-vs-lower
- https://1xbet.com/en/information/rules/34

The public pages expose number-game descriptions, but the playable embedded UI did not load in the research browser. No exact 1–100 proximity counterpart was verified. The user chose to retain PlayQube's closest-number format and then requested one-minute shared rounds with 30 seconds to enter. Original artwork, rules and implementation; no claim of equivalent RTP or provable fairness.

## Rules v2

Rounds align to UTC epoch minutes. During seconds 0–29, each active member may submit one integer 1–100. The server rejects submissions arriving at or after second 30, regardless of the client countdown. Accepted guesses are immutable. During seconds 30–59, the worker draws one shared target using Node crypto.randomInt(1,101) and the result appears for everyone. No target is selected before entries close. If the worker is delayed, the UI waits for a confirmed target; overdue rounds are drawn on recovery. The next minute opens a new round without submitting automatically.

Exact: 100 score; distance 1: 60; distance 2–5: 40; distance 6–10: 20; farther: 0. Edge numbers have fewer nearby targets. Exact probability is 1/100 for every guess. No stakes, bankroll, Coins, Game Points, bonuses, transfers, cash value or wallet writes. Legacy Coin admission remains hard-paused regardless of catalog mode/currency.

## API, authority and recovery

`/games/number-challenge-practice` is authenticated and gated by exact `NUMBER_CHALLENGE_PRACTICE_ENABLED=true` (default off). GET returns server time, the current shared round, the member's receipt and their latest 20 entries including legacy instant results. Target/score stay null until the draw. POST `/guesses` accepts exactly `{requestId,roundId,guess,rulesId:'number-challenge-timed-v2'}`. Old v1 clients fail closed and must reload. Responses are private/no-store; current account status is checked under a row lock.

A per-user advisory lock serializes admission across API instances; unique constraints enforce one entry per user/round and one receipt per user/request. Identical retries return the original receipt even after closing. A changed round or guess conflicts. The client stores and reads back the exact payload before sending; unresolved requests remain locked and require explicit retry across remount. Only definitive closed/already-entered responses clear a rejected intent. No autoplay.

The worker runs a separate, failure-isolated Number loop using a dedicated NUMBER_WORKER_DATABASE_URL client. Its existing DATABASE_URL remains unchanged for other games. An enabled Number loop refuses a missing connection, another database, or the shared API/social role. A global advisory lock serializes creation and drawing across workers; current and next rounds are created deterministically. API processes cannot create or draw rounds. Database guards enforce the deadline even for direct SQL, permit only a single post-close target transition, and prevent changes/deletions of receipts and round timing. Server CSPRNG is authoritative; this is not an independently verifiable precommitment scheme.

Client countdowns use server time anchored to monotonic elapsed time, refresh every two seconds, and close admission on stale snapshots after eight seconds. Server admission remains final; network latency can make a seemingly timely guess arrive too late. The target is never invented by the UI.

## Presentation

Teal/ivory shaded ball, prominent entry/next-round countdown and progress bar, number field, slider, presets, locked acceptance state, scoring bands, personal history and accessible Expand/Minimize. CSS depth; no new WebGL context or asset downloads. OS/manual Reduced Motion supported. Countdown remains visible in expanded mode and in the selection panel.

## Staging rollout — separate revision approval

1. Verify candidate CI and exact commit; production, payments and wagering stay off.
2. Run guarded `staging-number-upgrade.js --apply`, then without `--apply`. It validates staging owner and dedicated NUMBER_WORKER_DATABASE_URL targets, migration checksums, financial gates and restricted roles; permits only the original instant migration plus additive `20261012020000_number_timed_practice`.
3. API grants: SELECT legacy receipts and shared rounds; UPDATE(id) on rounds only for row locking; SELECT/INSERT timed entries. Legacy INSERT is revoked. Dedicated Number worker grants: schema USAGE, SELECT/INSERT shared rounds and UPDATE(target) only. No user, entry, wallet or payment access. Neither role receives financial permissions. Setup verifies effective privileges.
4. Deploy API, group worker and web at the same pinned candidate. Configure the approved dedicated NUMBER_WORKER_DATABASE_URL on setup/group worker and set NUMBER_CHALLENGE_PRACTICE_ENABLED=true on staging API/worker, preserving the existing DATABASE_URL and other settings. During the rollout, old clients are blocked and missing draws stay pending.
5. Verify an entire minute: accepted guess with hidden target, closed entries, shared result, immutable retry, next round unlock, historical receipts, phone countdown/Expand/Minimize. Physical Safari acceptance remains a separate user check.

## Previous deployment

Instant v1 was deployed at `11f2b071c5431158a8bf61c3c805b77ea7ef7c3e` with green CI across PostgreSQL 13/16/18. User reported the missing countdown during physical Safari acceptance. This v2 revision addresses that requirement; it must not be described as deployed until its rollout is verified.

## Staging role prerequisite discovered during rollout

The 2e378f5 migration applied, but grant setup stopped with NUMBER_ROLES_REFUSED because staging SOCIAL_WORKER_DATABASE_URL and PRACTICE_API_ROLE identified the same login. No Number runtime grants were applied and API/web/worker remained at their previous revisions. This follow-up uses a dedicated Number-only connection rather than cloning the existing broad role. Creating that persistent login and installing its connection secret requires explicit user approval before rollout resumes.
