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
- Deployment and authenticated live acceptance are pending at this commit.

Previous twelve-game financial and live evidence remains in
`eight-game-release.md`. The unrelated Scheduled rounds CI payment fixture
failures remain visible; they are not fixed or relaxed by this follow-up.
