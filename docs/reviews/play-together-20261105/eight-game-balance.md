# Eight additional group games: rules and balance review

5 November 2026. This review concerns practice-point group contests. It does not
approve cash activation or attest to a live deployment. The outcome, scoring and
settlement engine remains `salem-together-v1`; no existing round terms were changed.

## What is implemented

Roulette Keno, Lucky Six, Derby, Dog Racing, Football Predictions, Blackjack
Predictions, Sky Crash Challenge and Crash Point Challenge use the existing
committed-outcome and atomic pooled-settlement flow. Each player confirms an
equal entry. Selections stay private until the deadline. The owner cannot choose
the winner, place another member's entry, or edit published terms.

These are group contests with a common prize pool. Football and Blackjack score
predictions; Crash scores a preselected target. A target is not a payout multiple,
and the group crash modes have no live cash-out. Group presentations must replay
the saved result, never generate an outcome or decide a payout in the browser.

## Reproducible balance exercise

The review used the actual shared outcome, ranking and settlement functions with
deterministic synthetic seeds and synthetic beacon randomness. Signature
verification and live wallet writes were deliberately outside this exercise.
Each game ran 10,000 rounds at each of 2, 4 and 8 players: 240,000 sampled rounds.
Choices were independently and uniformly sampled from legal selections. Every
sample conserved all entries as player returns plus the recorded fee. The same
outcomes were also scored with identical choices for all players: every one of
those rounds returned all entries with no fee.

Engine source SHA-256:
`a33f488fd1e82b332e04384ca86dae4f32a258791319c370f96d0e339bb7e851`.

Reproduce after building the shared package:

```sh
pnpm --filter @socialplay/shared build
node scripts/review-together-balance.mjs --samples=10000 --players=2 --out=/private/tmp/salem-together-balance-2.json
node scripts/review-together-balance.mjs --samples=10000 --players=4 --out=/private/tmp/salem-together-balance-4.json
node scripts/review-together-balance.mjs --samples=10000 --players=8 --out=/private/tmp/salem-together-balance-8.json
```

Sampled refund frequency (all players tied or no qualifying winner):

| Game                  | 2 players | 4 players | 8 players |
| --------------------- | --------: | --------: | --------: |
| Roulette Keno         |    30.33% |     3.52% |     0.12% |
| Lucky Six             |    25.68% |     2.99% |     0.08% |
| Derby                 |    12.44% |     0.12% |     0.00% |
| Dog Racing            |    12.79% |     0.14% |     0.00% |
| Football Predictions  |    34.51% |     5.18% |     0.10% |
| Blackjack Predictions |    23.73% |     1.61% |     0.02% |
| Sky Crash Challenge   |    77.36% |    67.82% |    56.43% |
| Crash Point Challenge |    77.22% |    67.28% |    55.52% |

These are reproducible observations for the specified choice policy, not future
player behaviour, exact winning odds, or proof of randomness quality. Different
strategy populations can change refund and shared-prize frequencies substantially.

## Game-by-game findings

**Roulette Keno and Lucky Six.** Every valid equal-size number ticket has the
same marginal draw distribution. Shared numbers correlate the tickets and can
create ties. Lucky Six correctly ranks any completed ticket ahead of an
incomplete one, then ranks complete tickets by the first completing ball. A
two-player group refunds reasonably often; four or more players produce a
result more often. Shared winners are an intended outcome, not a draw to rerun.
In the four-player sample, 37.09% of Roulette Keno rounds and 33.76% of Lucky Six
rounds paid multiple winners.

**Derby and Dog Racing.** The finishing order is a uniform permutation of eight
equally likely runners. The best selected runner wins even when an unselected
runner finishes first overall. Players selecting the same best runner split the
prize; if every player selected the same runner, all entries return. The player
screen must explain this distinction and identify the best _selected_ finisher.
Runners have no hidden form or different prices in these group versions.

**Football Predictions.** Home, Draw and Away are not equally likely. The three
fixtures use different fixed strengths, and the score model also includes a home
advantage even when the supplied strengths match. The new guide derives the
following probabilities directly from the same finite score-weight model:

| Simulated match | Home win |  Draw | Away win |
| --------------- | -------: | ----: | -------: |
| 1               |    47.2% | 25.0% |    27.9% |
| 2               |    35.4% | 25.9% |    38.7% |
| 3               |    43.7% | 26.1% |    30.3% |

Percentages are rounded and may total 100.1%. They describe a match result, not
the chance of winning a group prize or a payout price. The available information
must be shown before confirmation to every player. A player choosing the most
likely result is not guaranteed to beat the group. Identical prediction cards
always tie or all miss and refund. Four-player uniformly chosen cards produced
shared prizes in 40.13% of rounds.

**Blackjack Predictions.** Every player predicts the same six automated hands
against one dealer. The six-deck shoe has no replacement; all hands draw below
17 and stand at 17, including soft 17. Player bust is a loss even when the dealer
also busts. A two-card blackjack outranks another 21. There is no hit, stand,
split, double, or standard blackjack payout decision. Sampled hand frequencies
were approximately 40–41% Win, 10% Draw and 49–50% Lose. The hands are correlated
through their common dealer and shoe, so treating six predictions as independent
equal-probability choices is incorrect. The guide explicitly discloses unequal
likelihood and shared scoring; four-player cards shared prizes in 34.12% of rounds.

**Both Crash Challenges.** For target `t` in hundredths, the exact probability
that the target is strictly below the crash is:

```text
floor(100,000,000 / (t + 1)) / 1,000,000
```

This includes the rule that exact crash equality loses and the 20.01× cap. The
guide's calculation was checked by exhausting all 1,000,000 equally likely input
values for seven representative targets, including both supported endpoints.

| Target | Chance of surviving the crash |
| ------ | ----------------------------: |
| 1.01×  |                      98.0392% |
| 1.50×  |                      66.2251% |
| 2.00×  |                      49.7512% |
| 3.00×  |                      33.2225% |
| 5.00×  |                      19.9600% |
| 10.00× |                       9.9900% |
| 20.00× |                       4.9975% |

Survival is not winning: a higher surviving target beats a lower one. There is
no universally dominant target. For example, against 2.00×, 2.01× wins 49.5049%
of rounds and 2.00× wins only 0.2463%; the rest refund. Against 3.00×, 1.01× wins
64.8167% and 3.00× wins 33.2225%; the rest refund. Against 20.00×, 1.01× wins
93.0417%. Identical targets always refund, whether they survive or both crash.

Uniform choices across the entire target range are a poor introduction: roughly
two thirds of four-player rounds have no survivor. Show the selected target's
survival probability and distinguish it from a group winning probability. Offer
explicit low-range quick picks such as 1.25×, 1.50×, 2.00× and 3.00× without
automatically placing an entry or promising a preferred strategy. Display the
fee-free refund reason clearly. Do not silently narrow the published range or
change the distribution of an accepted `salem-together-v1` round.

## Practice rollout requirements and remaining limits

The reviewed maths supports the documented pooled contests. For the eight-mode rollout, integrate the pre-confirmation guidance, outcome-driven results,
clear shared-winner/refund screens, and complete each mode's real authenticated
practice round through backend settlement. Explicitly verify high crash targets,
same-pick rounds, Football fixtures and Blackjack predictions in the interface.

This review does not include those live checks. It also does not establish
physical-device performance, accessibility acceptance, visual 3D integration,
financial activation readiness, or a production anti-collusion assessment.
Keep cash disabled. Use practice feedback to decide whether a future version
should adjust prediction variety or crash target choices; changes belong in a
new rules version for newly published rounds, never a redraw or alteration of
an existing round.
