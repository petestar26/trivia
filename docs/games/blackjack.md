# Blackjack practice

Salem's original six-seat prediction table, informed by the interaction format at
https://mohiogaming.com/games/casino/black-jack. It contains original UI, card artwork,
rules, prices and code. It is not a licensed MOHIO game or provider integration.

## Rules

- A fresh six-deck shoe and a 160-second round; dealer is seat 0, players are 1–6.
- Stage 0 starts with one visible card per hand. Stage 1 at 40 seconds adds each
  hand's second card. Stage 2 at 80 seconds adds one card only to hands below 17.
- Entry closes at 120 seconds. Showdown completes all hands to at least 17;
  all hands stand on soft and hard 17. The last 40 seconds show results.
- Markets: player Win/Draw/Lose against the dealer; player/dealer exact 17–21,
  natural Blackjack, or Bust. The 21 market excludes natural Blackjack.
- Aces count as 1 or 11. Naturals beat multi-card 21. A busted player loses even
  when the dealer busts. Equal surviving values draw unless only one is natural.
- Each stage's prices estimate 6,000 independent completions of the public cards.
  Gross price is `floor(92 / estimated_probability)` hundredths, capped at 200×.
  Unobserved or certain outcomes are closed. These approximate practice prices
  do not establish a fixed theoretical RTP.
- Up to ten independent tickets per round; stake 5–500 ETB in steps of 5.
  A correct prediction returns stake × confirmed price, including the stake.
  Other predictions return zero; predicting Win does not refund a Draw.

## State and persistence

Only already-dealt cards exist in a persisted round. Later cards are sampled
with Node's cryptographic random generator from the remaining shoe at their
stage; pricing simulations do not preselect the actual future result.

`bj_accounts`, `bj_rounds` and `bj_tickets` are separate practice tables. Each
member receives 100,000 virtual minor units (1,000 ETB). Stakes and returns are
accounted in integer minor units. Database guards independently validate card
prefixes, dealing times, stand rules, ticket prices and settlement calculations.
Deferred reconciliation requires every balance to match its immutable receipts.
The API requires an active authenticated member and the exact
`BLACKJACK_PRACTICE_ENABLED=true` flag. Cash/coin admission remains closed.

Round locks serialize admission and dealing; account locks serialize spending
and settlement. A round/user/slot identifies an exact retry; a different request
for that slot conflicts. The client saves pending entries before sending them
and rechecks the same receipt after uncertain network results. Both client and
server reject expired stages and changed prices; the server clock is authoritative.

The existing practice worker owns timed progression and settlement. Deploy the
API and additive migration before the worker, then enable its Blackjack task,
then publish the web page and API practice flag. Worker privileges extend only
to the new practice tables and scoring helpers. Existing games keep their flags.
Disable admission with the API flag; keep the worker running to settle receipts.
No financial tables, real payments, provider credentials or provider sessions
are involved.

## Verification

37 engine, route and SQL service checks; 25 Blackjack UI checks; 77 shared
catalog checks; and 167 provider/worker/availability/activation regressions pass.
SQL tests execute the new migration with only its wall clock redirected to a
fixture clock, exercising stage boundaries without real waiting. PGlite serializes
transactions; these checks do not establish native PostgreSQL contention behavior.
API typecheck and main/isolated API builds pass. Browser fixture checks cover two
independent stakes, review/confirmation, persistent selection, results, and
320/390-pixel layouts; no horizontal overflow at 320 pixels. Hosted authenticated
member gameplay and physical-device acceptance are separate from fixture testing.
