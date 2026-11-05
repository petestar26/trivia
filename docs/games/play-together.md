# Play Together

Salem Bet group play, 5 November 2026. The initial four-game practice rollout
is deployed. The twelve-game expansion is in release verification; its actual
deployment evidence is recorded in the release review. Real-money play is off.

## Player journey

1. Open **Play together**. In-house discovery cards now open shared game rules.
   Casino and Sports remain separate provider destinations.
2. Create or join a group through the existing group and invitation flow.
   The owner publishes the game, equal entry, minimum and maximum players,
   and a two-, five-, or ten-minute betting window. Publishing is free.
3. Each player sees the game rules, entry, maximum loss, conditional payout,
   fee and available balance, then confirms their own selection. An invitation,
   viewing the room, and the owner's own publication never authorize a bet.
4. Confirmation reserves the entry immediately. Other members see that the
   entry is confirmed; selections remain sealed until closure. A player may
   cancel and receive the full entry back before the deadline. A different
   selection requires cancellation and a new explicit confirmation.
5. At the deadline, the server locks the accepted roster and selections.
   Spectators do not block a round. Fewer than the specified minimum receives
   a full refund; nobody needs to press a start button.
6. The backend obtains the exact future randomness record selected when the
   round was created, verifies its signature, records the outcome, and then
   pays or refunds every participant in one database transaction.
7. The room shows the result, participant scores, total pool, exact fee,
   individual returns and net results. Players can download their round
   receipt and verify a drawn result locally in the browser.

Public shared rooms use the same flow, with platform-selected entry, two to
twenty players and a two-minute window. Opening one never places an entry.
The administrator can enable public rooms independently of private groups.

## Rules for every implemented in-house game

These are new group contest rules, not the old solo multiplier paytables.
All use equal entries and the same winning-profit fee calculation.

| Game                  | Group contest                                                                          | Ties and unsuccessful rounds                                         | Initial setting      |
| --------------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | -------------------- |
| Group Spin            | One equal segment per accepted entry; one uniform winning segment                      | One winner                                                           | Enabled for practice |
| Turbo Keno            | Pick 5 of 80; draw 20; most matches wins                                               | Tied leaders share; zero matches for everyone refunds                | Enabled for practice |
| Dice Duel             | Two independent fair dice per player; highest sum wins                                 | Tied leaders share; everyone tied refunds                            | Enabled for practice |
| Number Challenge      | Pick 1–100; closest to the uniform shared target wins                                  | Equal distances share; everyone tied refunds                         | Enabled for practice |
| Roulette Keno         | Pick 5 of 72; draw 18; most matches wins                                               | Same Keno tie/refund rules                                           | Practice expansion   |
| Lucky Six             | Pick 6 of 48; up to 35 draws; earliest completion wins, otherwise most matches         | Tied leaders share; no matches or everyone tied refunds              | Practice expansion   |
| Derby                 | Pick one of 8 equally likely runners; best finish among the selected runners wins      | Players selecting the same best runner share; everyone tied refunds  | Practice expansion   |
| Dog Racing            | Same contest with 8 dogs                                                               | Same race rules                                                      | Practice expansion   |
| Football Predictions  | Predict home/draw/away for three simulated matches; most correct wins                  | Tied leaders share; nobody correct or everyone tied refunds          | Practice expansion   |
| Blackjack Predictions | Predict win/draw/loss for six automated hands against a dealer; most correct wins      | Tied leaders share; nobody correct or everyone tied refunds          | Practice expansion   |
| Sky Crash Challenge   | Preselect an exit score from 1.01× to 20×; highest score strictly below the crash wins | Equal leading scores share; nobody survives or everyone ties refunds | Practice expansion   |
| Crash Point Challenge | Same sealed target contest                                                             | Same crash rules                                                     | Practice expansion   |

All twelve adapters are implemented. The eight expansion games now have
game-specific selection guidance, recorded-result presentations and practice
settlement tests. The presentations replay saved outcomes; they do not reuse
the solo 3D scenes or determine results in the browser. Football probabilities
and exact crash-target survival probabilities are shown before confirmation.
See `../reviews/play-together-20261105/eight-game-balance.md` for the reproducible
balance review and remaining limitations. The expansion migration appends a
practice-only policy when the original four-game policy is still current; it
does not override a later administrator policy or change existing round terms.

Football uses the versioned shared simulator and three fixed published
strength configurations in TOGETHER_FOOTBALL_FIXTURES. Blackjack uses a six-deck
shoe without replacement, six player hands and one dealer, two initial cards,
then automatic draws while below 17. No player can change a hand mid-round.
Crash scores are not promised payout multipliers: U is uniform in
1..1,000,000 and the crash in hundredths is
min(2001, floor(100,000,000 / U)). Equality with the crash loses.

Trivia, Turbo Circuit, Starfall Nebula, Jungle Dash, Crystal Trail, Heat Vault
and Strait Rush remain unfinished catalogue placeholders. This work does not
advertise them as playable.

## Money and fees

Cash is integer ETB minor units: 100 units = 1 Birr. Practice uses integer
Game Points, with no cash value and no conversion to cash. An explicit free
practice refill tops the available plus reserved practice balance up to
10,000 at most once per UTC day. It does not alter the cash wallet.

Initial cash group entries accept only classified WITHDRAWABLE cash lots.
Reward principal and practice balances cannot fund or be converted through
these cash contests. Winnings from eligible cash entries return to
WITHDRAWABLE lots. Reward-funded group entries are deliberately outside this
first release; this does not change the existing reward-wallet rules.

For N players, entry S, W winners and fee rate f:

- Funded pool = N × S.
- Shared profit before fees = (N − W) × S.
- Platform fee = floor(shared profit × f), rounded down in minor units.
- Total paid = funded pool − fee.
- Winners share the total; each return includes the original entry exactly once.
- Remainder units follow a deterministic hash of round and entry IDs, with at
  most one minor-unit difference between winners.
- A cancelled, underfilled, all-tied or no-winner round refunds every entry,
  with no fee.

Example: ten members enter 50 Birr each, two tie for the lead, fee 7%.
The pool is 500 Birr; winning profit before fees is 400 Birr; fee is 28 Birr.
Each winner receives 236 Birr, including their 50 Birr entry, for 186 Birr net
profit. The two returns and the fee equal the entire 500 Birr pool.

The new default 7% applies to winning profit, not to the whole entry pool.
Existing legacy points rounds keep their original 7%-of-entry policy.
Administrators change the global policy once; no administrator awards
individual prizes. A new policy version applies to newly published rounds.
Existing rounds retain their entry, fee, deadline and rules. Emergency pauses
can stop new admissions without cancelling accepted payouts.

## Financial and fairness controls

- Round states: OPEN → LOCKED → DRAWN → PAID or REFUNDED. A void can go from
  OPEN directly to DRAWN with a permanent refund reason.
- Successful and rejected confirmations have permanent, payload-bound request
  receipts. A rejected insufficient-funds request cannot become a bet after
  a later deposit. Retrying an uncertain response reuses the original request.
- Cash reservations use the same wallet locks and provenance ledger as
  sportsbook and other spending. A held entry is no longer available to spend.
- Database clocks and row locks enforce deadlines and capacity. The deadline
  is checked again after waiting for wallet locks and at entry insertion.
  A late operation rolls back the complete reservation.
- Database guards require an exact wallet debit for each accepted entry;
  cash operations require their entry witness and pinned funding policy.
  Refunds release the original cash lots. No disconnected cash mint is allowed.
- Published terms and closed entries are immutable. The locked roster must
  equal the accepted entries. Direct mutation of outcomes or completed
  payments is rejected.
- Finalization requires all locked entries to close together. Wallet credits,
  receipt amounts, fee, pool and terminal round must agree. Every unit is paid
  to a player or recorded as the round's platform fee.
- A random server seed is committed before admission. An exact future drand
  quicknet round is pinned to the betting cutoff with the existing six-second
  future buffer. Signatures use the pinned chain/key. No latest-record or
  alternative-draw fallback is allowed.
- Player choices and stakes do not influence the random stream. Spin and dice
  allocate results by the locked entry-ID ordering. Sampling uses rejection
  to avoid modulo bias.
- The browser saves the first observed terms commitment and blocks confirmation
  if it changes. Independent verification checks the signature, commitment,
  roster, outcome, displayed ranking, allocation and individual receipts.
- A valid saved outcome is never redrawn. Settlement retries after process
  failure, disconnect, suspension, group closure or an admissions pause.
- If no valid result is saved within ten minutes after betting closes,
  recovery refunds the round. A payment failure after a saved result remains
  an amount owed and is retried rather than replaced with a different result.
- Legacy and new private rounds cannot be created concurrently for one group.
  Previously accepted legacy rounds remain accessible under the legacy page.

## Administrator controls and operations

The new **Group play controls** page is at /admin/group-play. Current database
role and account status are checked for settings changes and recovery actions;
an old administrator claim in a token is not sufficient.

Controls include enabled games, entry limits, fee, practice availability,
public rooms and cash availability. Updates reject stale policy versions.
The processing list exposes pending rounds and recorded fees. Recovery retries
the existing outcome and receipts; it cannot choose a winner or pay twice.

Defaults:

| Control                    | Default / requirement                                                                   |
| -------------------------- | --------------------------------------------------------------------------------------- |
| PLAY_TOGETHER_ENABLED      | Admission enabled unless exactly false                                                  |
| Practice policy            | On; twelve reviewed games after expansion of the original policy                        |
| Public room policy         | Off                                                                                     |
| Cash policy                | Off                                                                                     |
| PLAY_TOGETHER_CASH_ENABLED | Off unless exactly true                                                                 |
| GROUP_PLAY platform gate   | Created disabled                                                                        |
| CASINO_PLAY platform gate  | Existing gate also required for cash admission                                          |
| Cash eligibility           | Active account, cash policy/gates, eligible jurisdiction and required verified KYC tier |
| Worker health              | Fresh successful processing heartbeat required for admissions                           |

Do not enable cash as part of deploying these files. Before cash activation,
perform staging acceptance with real authentication, current jurisdiction and
payment controls, database runtime grants, cross-instance workers, independent
security/financial review, monitoring and operational approval.

The worker scans due rounds in bounded batches. Database state is the source
of truth; restart the API to resume recovery. A failed round is retried after
ten seconds and does not prevent processing other due rounds in that batch.
An unhealthy worker pauses new admissions. Monitor pending age, retry failures,
ledger invariant scans, database clock synchronization and wallet reconciliation.

Existing wallet balance ceilings remain in force. A prize or refund that would
exceed a ceiling leaves the entire settlement pending with no partial payment.
Resolve the underlying capacity problem and retry the recorded settlement.
A claimable-overflow policy and load/soak acceptance are required before cash
launch; this candidate does not silently bypass existing wallet limits.

Deployment order: take the normal backup, apply the two migrations, regenerate
Prisma/build packages, apply ledger_apply_runtime_grants for the configured API
role, deploy the API with cash off, verify worker and practice round recovery,
then deploy the web build. Older web clients keep their existing legacy APIs.
Rollback by disabling admissions while retaining the recovery worker and
forward-compatible schema; never delete financial rows or remove enum values.

## Original implementation evidence

The following records the pre-deployment implementation checks. Later CI and
live results are recorded in `../reviews/play-together-20261105/release-review.md`.

Local evidence, separate from production readiness:

The final focused runs passed 291 tests: 38 new PostgreSQL tests, 17 legacy
group tests, 12 sportsbook tests, 57 shared-rule tests, 7 API route tests and
160 interface/catalogue tests. Production builds and all 15 synthetic browser
screen checks passed. PostgreSQL 16 was tested locally; the new CI workflow
is configured for PostgreSQL 13, 16 and 18 but has not run on GitHub yet.

- Shared rule, allocation and conservation tests.
- PostgreSQL tests covering all twelve adapters, request replay, insufficient
  funds, reward isolation, concurrent sportsbook spending, cancellation,
  locked rosters, tied prizes, interrupted settlement, delayed confirmations,
  suspension/pause recovery and restricted runtime permissions.
- Existing legacy group and sportsbook native suites.
- API authentication, current role, revoked-token and payload-ownership tests.
- Web tests for consent, zero cash, saved request retries, changed terms and
  disconnected controls. Independent verifier tests use a genuine signed
  offline quicknet record, including altered proof/receipt rejection.
- Production web/API builds and TypeScript checks.
- The backend fetched and cryptographically verified public quicknet round 1
  through its actual network adapter. This checks the historical-record path,
  not live timed-round availability or future service reliability.
- Synthetic Chromium review at 1440, 390 and 320 pixels covering lobby, owner
  setup, confirmation, accepted entry and admin controls. These screenshots
  mock authentication and APIs; they are not live wallet evidence or
  physical-device/Safari validation.

Focused commands from the repository root:

    pnpm build:packages
    pnpm --filter @socialplay/shared exec vitest run src/play-together.test.ts src/group-pvp.test.ts src/pvp-entry.test.ts
    pnpm --filter api exec vitest run --config vitest.together.config.ts
    pnpm --filter web exec vitest run src/lib/together-proof.test.ts src/pages/play-together.test.tsx src/lib/member-game-catalog.test.ts src/pages/home.test.tsx src/app-game-sections.test.tsx
    pnpm build:web
    pnpm build:api

Native tests require DATABASE_URL pointing to a loopback-only database named
playqube_scheduled_throwaway and SCHEDULED_NATIVE_DB_ACK=throwaway. They create
their own users, cash funding fixtures and, for the privilege test, a temporary
NOLOGIN role. Use a disposable local PostgreSQL cluster, never production:

    pnpm --filter @socialplay/database exec prisma migrate deploy
    pnpm --filter api exec vitest run --config vitest.together-native.config.ts
    pnpm --filter api exec vitest run --config vitest.scheduled-native.config.ts src/games/group-pvp/group-pvp.native.ts
    pnpm --filter api exec vitest run --config vitest.sports-native.config.ts

For the browser review, build the web app, serve Vite preview on
127.0.0.1:57426, and run scripts/review-play-together.mjs. Set PLAYWRIGHT_MODULE
to an installed Playwright module if it is not available through normal Node
resolution. Evidence defaults to /private/tmp/salem-together-review.

This candidate was developed in an isolated checkout combining the current web
baseline e91317c and API baseline 39eb0f3; integration baseline 8451ff8 preserves
the recent rewards, account, agent and sportsbook work. No live accounts,
balances, provider credentials or production settings were changed.
