# Lucky Six practice game

Salem's original implementation uses the broad 48-ball, 35-result, eight-color,
five-minute format described at https://mohiogaming.com/games/lotteries/lucky-six.
It uses no vendor source, artwork, API, branding assets, or payout table. This is
an independent practice game, not an integration with MOHIO's licensed product.

## Published rules

Rules ID: `lucky-six-300-v1`. Every five-minute round accepts entries for 210
seconds, then reveals one ball every two seconds for 70 seconds. The final 20
seconds display the completed draw. All markets settle after ball 35, including
markets whose result becomes known sooner. Server time controls the cutoff.

The draw is a partial Fisher–Yates shuffle using Node's `crypto.randomInt`.
Numbers 1–48 are drawn without replacement. Colors repeat every eight numbers:
Red, Green, Blue, Purple, Gold, Orange, Teal, Pink. Each color contains six numbers.
For example, Red is 1, 9, 17, 25, 33, 41. A color label is never needed to identify
a selected number; selection also has a bold border, changed fill, and pressed state.

Each member starts with 1,000 separate, nonredeemable practice ETB. Bet 1 through
Bet 10 are independent entries in one round. Each entry costs 5–500 practice ETB
in steps of 5. All Colors has eight lines, so an amount of 5 costs 40; its maximum
line amount is 60, costing 480. Balances, receipts, and outcomes are stored only
in `ls_accounts`, `ls_tickets`, and `ls_rounds`.

| Market                   | Winning condition                                        | Gross return                                               |
| ------------------------ | -------------------------------------------------------- | ---------------------------------------------------------- |
| Pick six                 | All six chosen numbers appear in the 35-ball draw        | Sixth-match position table                                 |
| All colors               | Eight separate six-number lines, one per color           | Sum of each completed line's return                        |
| First 5 · number         | One chosen number appears in the first five              | 8.6×                                                       |
| First color / Last color | Chosen color of ball 1 / ball 35                         | 7.2×                                                       |
| Most color               | Chosen color is the unique most frequent among 35        | 7.2×; any tie for the lead refunds all bets on this market |
| First · odd / even       | Parity of ball 1                                         | 1.8×                                                       |
| First · low / high       | Ball 1 is 1–24 / 25–48                                   | 1.8×                                                       |
| First 5 · odd / even     | At least three of the first five share the chosen parity | 1.8×                                                       |
| First 5 · sum            | Sum of the first five is under / over 122.5              | 1.8×                                                       |
| Draw · odd / even        | At least 18 of 35 share the chosen parity                | 1.8×                                                       |

All listed multipliers include the stake. The full sixth-match table appears in
the game's How to Play dialog. `LS_SIX_TENTHS` holds exact integer
tenths for positions 6–35, independently duplicated in the database payout guard.
With a uniform draw, the six-number line's theoretical gross return is
`sum(C(k-1,5) / C(48,6) * multiplier[k], k=6..35)`, approximately 92.17694771%.
All Colors has that same return per unit staked. First-5 Number returns
89.58333333%; fixed parity/range/sum/color markets return 90%. Most Color returns
`0.9 + 0.1 * P(tied lead)` because any tied lead refunds every selection. These
figures describe long-run game mathematics, not a prediction of a player's results.

No cash admission, deposits, withdrawals, jackpots, auto-entry, or automatic
rebet is enabled. An empty practice balance cannot debit a cash wallet.

## Integrity and operation

- `LUCKY_SIX_PRACTICE_ENABLED=true` is required on API and practice worker.
- JWT authentication, active-account checks, rate limits, and private/no-store
  responses cover `/games/lucky-six` and `/games/lucky-six/tickets`.
- A round/user/slot key makes an exact retry idempotent. Different contents in
  the same slot conflict. Transactions lock the round and account before debit
  and check the entry cutoff after waiting for locks and again before completion.
- The UI stores an unacknowledged entry before posting, recovers its receipt on
  refresh, and permits only an identical retry. An uncertain result blocks a new
  submission. Confirmed selections stay visible and locked.
- Draw results and ticket contents are immutable. SQL validates every payout
  against the full outcome and rejects settlement before ball 35. Deferred SQL
  constraints reconcile practice balances against all receipts.
- Snapshots expose only the elapsed reveal prefix. The draw machine uses
  decorative unnumbered balls; its numbered ball comes only from that prefix.
- The worker retries bounded batches after interruption. Settlement locks each
  account and ticket and skips already settled receipts. Worker health requires
  progress from every enabled game loop.
- The migration extends only the already marked restricted practice-worker role,
  when present, with SELECT/INSERT/UPDATE on the three new tables. It creates no
  roles, credentials, memberships, financial grants, or default privileges.

## Validation

`vitest.lucky-six.config.ts` runs 36 backend tests, including real migration and
trigger execution in PGlite, a timed 35-ball reveal and settlement, every market
choice, every six-number completion position, color ties, duplicate retries,
immutable receipts, conservation, cash-wallet isolation, and authentication gates.
PGlite serializes transactions; these tests are not a production PostgreSQL
multi-connection load or contention benchmark.

The 17 UI tests cover exact six selection, all-color pricing, independent drafts,
review confirmation, stale clocks, storage failure, closed rounds, receipt recovery,
confirmed selection visibility, and released-results-only rendering. Catalog,
welcome, practice rollout, PWA, and production-build checks cover integration.
Browser review uses the actual page with a local practice API fixture at phone
and desktop widths; it is not physical-device or live cash-play validation.

Roll out the API and migration first, then the worker, then the web build. Check
all three service health states and the published game card. Lucky Six follows
the user's ten ordered games and precedes future/unimplemented games.
