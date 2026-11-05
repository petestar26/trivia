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

## Limits

The wider legacy Scheduled rounds/payment workflow has the previously recorded
native-ETB fixture incompatibility. This work does not remove those checks or claim
a fully green financial release. Cash activation, real-device/Safari acceptance,
load/soak testing, original 3D-scene integration and production anti-collusion review
are not covered. See `eight-game-balance.md` for measured tie/refund rates and the
high refund frequency when crash targets are chosen uniformly across the full range.
