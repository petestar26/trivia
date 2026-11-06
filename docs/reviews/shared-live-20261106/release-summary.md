# Shared group games: deployed practice release

All twelve group games now follow a shared server schedule: fixed betting deadline, committed result, five-second countdown, game-specific playback, official result, automatic settlement and personal replay. Authorized group members can watch inline beside chat without placing an entry or funding a wallet. Existing published game rules, fees, explicit confirmations and wallet protections remain authoritative.

## Deployed versions

Application commit: `be97e2d7658aebd3a69f642dca9721b17dc6f4e9` (tree `863ae159316993c195dd0e4cebc917f195037dc8`). All three services are pinned to this commit in the verified Salem.bet environment. This evidence-only update does not change application code.

| Service             | Successful deployment                  |
| ------------------- | -------------------------------------- |
| account-api         | `adcd3e68-c4e4-476f-b931-3145fdec74c7` |
| account-web         | `088128a9-a670-4973-86bc-3a9958a1f50e` |
| shared-round-worker | `7697ad1b-783c-4716-9760-be10c4d8c2df` |

The real domain was verified against account-web. The existing practice-games-worker and database service were not replaced. Cash betting and provider sportsbook live gates remain disabled. No PR was merged.

## Verification

- Authenticated acceptance used ten designated disposable practice accounts. All ten watched the same countdown, game and result; only three confirmed entries. Seven spectators had zero balance, and six had no wallet record.
- Thirteen real practice rounds covered all twelve games plus an additional Football worker-restart test. Exactly 39 confirmed entries produced 39 stake debits; spectators and cash wallets had no debits. Every pool conserved stakes across payouts/refunds and fees. All thirteen completed proofs independently verified offline against saved terms.
- Reconnect, refresh, late viewing and suspended-tab recovery returned to current progress. The sampled ten-browser spread after recovery was 34 ms. Personal replay did not affect another viewer.
- An in-place worker restart during Football preserved the committed outcome, proof, recording and schedule. Settlement occurred after finish. Genuine outcome-based refund rounds also waited until finish.
- [Shared-game CI](https://github.com/petestar26/trivia/actions/runs/42166812582) passed on PostgreSQL 13/16/18, including 61 native contracts. [Chat/support/upload CI](https://github.com/petestar26/trivia/actions/runs/42166812514) passed at the same application commit.
- Local native regressions passed: 46 staff/reward/recovery/withdrawal, 12 sportsbook and 17 legacy group tests. Both type checks and production builds passed. Gateway/PWA/recovery checks: 40 passed.
- Full web run: 2,587 passed and two timed out; both affected files passed their 32-test focused rerun. Synthetic browser checks: 122 across twelve games and eight languages. Static translation audit: 3,049 reachable messages covered, zero missing placeholders/messages.
- The initial lease-batch test mixed retained native fixtures into its four-job expectation. The corrected test prioritizes only its disposable jobs; production concurrency and financial guards were not changed.

The separate [Scheduled rounds CI](https://github.com/petestar26/trivia/actions/runs/42166812422) still fails on legacy native ETB fixture pricing. PostgreSQL 16 has the same fourteen failing names and pricing diagnostic as baseline run 42148886579. This is not an all-green CI claim.

## Persistence and operations

Both additive migrations completed: `20261106030000_together_live_timeline` and `20261106031000_together_practice_worker`. The dedicated worker uses restricted practice-only database grants. Durable jobs, immutable schedules, numbered outbox events, snapshot recovery and database timing guards preserve settlement independently of browsers.

The API's persistent volume is mounted at `/data`, with uploads in `/data/uploads`. An upload canary retained its checksum across both API replacements and was then removed. A historical missing voice file was already absent and was not recovered. Persistence across replacements is not a backup test.

All disposable test accounts were suspended, their sessions revoked and private groups archived after settlement; historical receipts and ledgers were retained. Temporary local credentials were removed. Final homepage/API health checks passed. Detailed authenticated artifacts remain local and are not included in this repository summary.

To stop new v2 admission, set `PLAY_TOGETHER_LIVE_PRESENTATION_ENABLED=false` while keeping the v2-capable API/worker running until accepted obligations finish. Keep the additive migrations; do not roll back to an engine that cannot settle v2. See [engineering and rollback](engineering.md).

Physical phones, Safari, GPU/thermal performance, native-speaker translation quality, real-money payment rails and cross-replica socket delivery remain outside this verification.
