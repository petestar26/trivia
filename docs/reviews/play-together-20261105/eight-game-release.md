# Twelve-game practice expansion

This follows the four-game release recorded in `release-review.md`. The eight
additional contests are Roulette Keno, Lucky Six, Derby, Dog Racing, Football
Predictions, Blackjack Predictions, Sky Crash Challenge and Crash Point Challenge.
Cash remains disabled. The seven unreleased catalogue titles remain unavailable.

## Player-facing changes

All twelve games retain the same published entry, consent, deadline, refund and
settlement system. The expansion adds game-specific selection guidance and
recorded results: ordered draws, runner finishes, match scores, actual blackjack
cards, and crash-target comparisons. Each game has a complete static result on
reload. Optional reveal replays use the recorded outcome and never change a
wallet. Reduced-motion users receive the static result.

Race results identify the best **selected** runner separately from overall first
place. Football shows model probabilities before confirmation. Crash shows exact
target-survival probabilities and explicit shortcuts without selecting or paying
automatically. Blackjack explains its automated hands and unequal outcomes.
The existing solo 3D scenes are not used for these group presentations.

## Rollout and preservation

Migration `20261106020000_together_practice_catalogue` appends a twelve-game
practice policy only when the original four-game policy is still current. Fees,
entry limits and public-room settings are preserved; cash remains false. A later
administrator policy is never overwritten. Existing rounds keep their original
policy and immutable rules. The mathematical engine `salem-together-v1` is unchanged.

The migration check exercises a fresh upgrade, replay, unchanged cash gates and
preservation of an administrator's later fee, limits, game list and practice pause.
These probes run on a designated disposable database and roll back.

## Verification before deployment

- 55 native PostgreSQL16 contracts passed, including 16 new practice cases across
  all eight games. These test real journals, consent, sealed selections, duplicate
  receipts, automatic draw/settlement, late receipts, same-choice refunds and cash
  isolation. Only external beacon randomness is synthetic in this suite.
- 35 shared rule/guidance checks passed. The balance review exercised 240,000
  deterministic sampled rounds and identical-choice rescoring; all funds conserved.
- 102 synthetic Chromium checks passed at 1440, 390 and 320 pixels, including all
  eight selection/result screens, consent, reveal replay, refunds and reconnect.
  Authentication and API responses in that preview are mocked.
- API and web production builds passed. The page, selection, result and independent
  proof tests cover real user interactions and malformed/tampered data handling.
- A source review found no blocking privacy, selection, frozen-rule or policy
  preservation regressions. Visual review added an explicit group-winning runner.

Exact final CI and live authenticated acceptance are recorded with the deployment
and PR. Do not infer those from synthetic preview or local database checks.

## Completed live acceptance

Acceptance finished on 6 November in Asia/Vientiane. The API is pinned to
`84e4be4c6ef6aea457677762bdcaefa77426a41e` (deployment
`3007be11-b747-4849-93bb-51c01be519f5`). The web is pinned to
`793f5fac28af7af95a01f4e9436c9086bc076100` (deployment
`8685a1c3-d86d-47cd-b42e-3412570cad0e`); its follow-up shows the football
probabilities in the game overview as well as the prediction form.

The Play Together workflow passed on PostgreSQL 13, 16 and 18 for both runtime commits:
[API/initial web](https://github.com/petestar26/trivia/actions/runs/42051967056)
and [final web](https://github.com/petestar26/trivia/actions/runs/42056228003).
Managed backup `04278ee2-ad1a-4f71-9da0-b9d295702f93` preceded deployment. The live
policy is version 2 with twelve games, practice on, cash off and the original 700 bps
fee. Both GROUP_PLAY and CASINO_PLAY cash gates remain false.

Two ordinary QA accounts published and independently entered eight private
100-point rounds with normal 120-second deadlines. Seven paid automatically;
Roulette Keno refunded a tie. All eight actual future-beacon signatures, outcomes,
rosters and allocations independently verified. The 1,600-point pools returned
1,551 points and recorded 49 points in fees. Every debit and positive credit was
matched to the member's own receipt, including peer-only transaction IDs.

The existing first-group achievement separately credited 20 practice points to
the joining QA account. Its definition, unlocked achievement and journal reference
were checked independently. Final balances 10,265 + 9,706 plus 49 fees equal the
20,000 initial points plus that 20-point award. All holds released; available and
reserved real cash remained zero.

The final live Chromium run passed 50 checks across 1440, 390 and 320 pixels, including
all eight result screens, displayed payouts, reveal controls and actual browser
proof verification. It used real sign-ins and API responses. No page errors,
API server errors or unexpected API mutations occurred in the final run.

Initial verification evidence is retained: transport/navigation timeouts; a
balance expectation that initially omitted the independent first-group award;
an over-specific equality check on two valid timestamps 8 ms apart; and a browser
harness that initially blocked the app's normal activity heartbeat. The corrected
harness matches every journal row, records timestamps separately, and permits
normal activity recording while blocking entry/settings/financial mutations.
Its final nine offline adversarial probes passed. These corrections did not alter
game results, wallet balances or reward definitions. The final navigation limit
was 45 seconds; this is not a performance or physical-device acceptance claim.

## Limits

The wider legacy Scheduled rounds/payment workflow has the previously recorded
native-ETB fixture incompatibility. This work does not remove those checks or claim
a fully green financial release. Cash activation, real-device/Safari acceptance,
load/soak testing, original 3D-scene integration and production anti-collusion review
are not covered. See `eight-game-balance.md` for measured tie/refund rates and the
high refund frequency when crash targets are chosen uniformly across the full range.
