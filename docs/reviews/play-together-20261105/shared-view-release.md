# Shared group viewing — release verification

The follow-up makes active rounds and saved results visible from group Chat,
Members and Gifts, and promotes them above the Games catalogue. All members can
watch without entering. A shared server-time reveal catches up after a late join
or reconnect; final results and payouts remain directly accessible. Personal
replays are explicitly local. No game rules, fees, wallet mutations, database
schema or cash activation settings are changed.

## Local validation

- 172 web checks passed: 19 page/group navigation checks, 43 result component
  checks covering all twelve games, and 110 consent/proof/catalogue regressions.
- 40 shared rule/timeline tests and 10 API route tests passed.
- 57 native PostgreSQL tests passed. The final completed-round ordering change
  passed its focused native regression. API and web production builds passed.
- Twelve synthetic multi-client scenarios passed: six common-flow checks at
  each of 1440 and 390 pixels, using separate owner, participant and zero-balance
  spectator contexts with one canonical mocked Roulette Keno round. No browser
  errors or entry/settings writes occurred. Normal reward activity heartbeats
  were recorded separately. These are not live-server or physical-device tests.
- The initial browser harness treated normal activity heartbeats as financial
  writes. That harness-only failure is preserved in the local evidence directory;
  the corrected harness still blocks all entry and settings mutations.
- Seven offline live-helper probes passed, including spectator journal isolation
  and rejection of altered receipt/achievement references.
- A separate all-eight-game synthetic regression passed 108 checks at 1440,
  390 and 320 pixels, with zero browser errors. It covers selections, confirmation,
  paid results, personal replay, refunds and reconnect behaviour.

## Deployment

Both API and web are deployed at `56400afa426242b448a66fc93975ea0b79c11c9f`.

- API deployment: `38d26a77-66ec-4a01-b571-2506285ee88a`.
- Web deployment: `1ba5af68-3221-449d-8d36-d040697baf59`.
- [Play Together CI](https://github.com/petestar26/trivia/actions/runs/42114834379)
  passed on PostgreSQL 13, 16 and 18, including production builds.
- Only the environment-specific API/web source pins changed. No schema,
  policy, fee or cash gate changes were deployed. Policy version 2 has twelve
  practice games; both database cash gates remain disabled.
- Final hosting check: all four services online, no recent deployment failures
  and no pending staged changes.

## Authenticated live acceptance

Three ordinary QA accounts used one private Roulette Keno round: two players
confirmed 100 practice points each; the third only watched. The round followed
its normal 120-second entry window and automatic signed settlement.

- All three accounts received the same outcome, immutable settlement time,
  participant list and payouts. All three browsers independently verified the
  actual signed result and payouts.
- The first live browser run recorded 21 successful functional checks, including
  simultaneous shared reveal and spectator reload. The sampled viewer progress
  spread corresponded to about 40 ms, then 90 ms after reload. These are observations
  from this test, not guarantees for other devices or connections.
- That run's overall harness failed because its allowlist blocked 12 normal
  reward-activity heartbeats. There were no JavaScript or API server errors, and
  no attempted entry/settings mutations. Original evidence is preserved unchanged
  at `/private/tmp/salem-shared-live-browser/report-initial-harness-failure.json`.
- The corrected harness reran the same completed round: 17 checks passed, with
  six normal activity heartbeats allowed and no blocked mutations or browser/API
  errors. It verified results, signed proof, saved links, local replay isolation,
  unchanged spectator balances and desktop/phone layouts. This completed-round
  rerun does not claim another live reveal; its report explicitly records that.
- Three API acceptance contracts passed with exact wallet journal reconciliation.
  The 200-point pool paid 193 points and collected a 7-point fee. Separate first-group
  achievements awarded 20 points each to the joining player and spectator. Final
  balances were 10,093 / 9,920 / 20; total 20,033 plus 7 fee equals the initial
  20,000 plus 40 verified achievement points. The spectator had no game entry,
  debit, credit or hold. All cash and reserved balances were zero.
- All three QA accounts were suspended, their private group archived, and their
  three sessions revoked. Wallet and round history is preserved. Temporary QA
  passwords/cookies were removed. Real user accounts were untouched.

Local artifacts: `/private/tmp/salem-shared-live-report.json`,
`/private/tmp/salem-shared-live-browser/completed/report.json`,
`/private/tmp/salem-shared-view-review-final/report.json`,
`/private/tmp/salem-shared-all-game-review/review.json`, and
`/private/tmp/salem-shared-close-qa.log`.

Previous twelve-game financial and live evidence remains in
`eight-game-release.md`. The unrelated
[Scheduled rounds CI](https://github.com/petestar26/trivia/actions/runs/42114834277)
remains failing on all three database versions in the existing native stake-hold
fixtures. The inspected PostgreSQL 16 job records 14 failed and 16 passed tests
at that step: the old fixtures are rejected by `Native ETB wallet requires ETB
pricing terms`. Those checks were not removed or relaxed. No physical-device,
Safari, load-test or real-money activation claim is made.
