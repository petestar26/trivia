# Number Challenge — free practice

## Reference and scope

Reviewed 1xBet's catalog and Fair Higher vs Lower pages on 2026-10-12:
- https://eg1xbet.com/en/games
- https://eg1xbet.com/en/games/fair-higher-vs-lower
- https://1xbet.com/en/information/rules/34

The public pages expose number-game descriptions, but the playable embedded UI did not load in the research browser. No exact 1–100 proximity counterpart was verified. Higher/Lower is a different mechanic. The user explicitly chose to retain PlayQube's closest-number format. Reference influence is the compact choice/reveal/results structure; this implementation, artwork, rules and assets are original, with no copied brand or proprietary code. No claim of equivalent RTP or provable fairness.

## Rules v1

Pick an integer 1–100. A new independent target is chosen uniformly by Node crypto.randomInt(1,101). Exact: 100 score; distance 1: 60; distance 2–5: 40; distance 6–10: 20; farther: 0. Edge numbers have fewer nearby targets and thus different proximity score probabilities. Exact probability is 1/100 for every selection. All 10,000 guess/target pairs are tested.

No stakes, bankroll, Coins, Game Points, bonuses, rewards, transfers, cash value or wallet writes. Scores are per-round only. These are deliberately isolated practice rules, not the legacy unapproved Coin multiplier rules. Legacy Coin admission remains hard-paused regardless of catalog mode/currency.

## API and recovery

`/games/number-challenge-practice` is authenticated and gated by exact `NUMBER_CHALLENGE_PRACTICE_ENABLED=true` (default off). GET returns the user's latest 20 receipts. POST `/guesses` accepts exactly `{requestId,guess,rulesId}`. No client target, score, identity or payout fields. Both authenticate current account status; the transaction locks the user against concurrent suspension. Responses are private/no-store.

Per-user PostgreSQL advisory lock serializes requests across instances, with a unique `(user_id,request_id)` backstop. Same key/body returns the original receipt; changed guess conflicts. At most 15 new guesses per minute per user across instances; existing receipts remain recoverable. The client persists and reads back its exact request before sending, locks edits while unresolved, times out slow transports, and offers explicit retry across remount. Requests are scoped per user. No automatic play or autoplay.

`number_practice_rounds` is append-only with range checks and an immutable trigger. The API requires only SELECT/INSERT on this new table. No scheduler/worker changes. Server CSPRNG is authoritative, but this is not an independently verifiable precommitment scheme; the rules disclose that distinction.

## Presentation

Original teal/ivory shaded ball, scoring bands, direct number entry, slider, presets, keyboard controls, local result history and accessible Expand/Minimize. CSS-only depth avoids a new WebGL context or downloaded 3D model. OS Reduced Motion and manual Reduced Motion disable the reveal effect. The catalog has its own original SVG artwork. No external asset license dependency.

## Staging rollout (separate approval)

1. Verify candidate CI on PostgreSQL 13/16/18 and the exact commit.
2. In the existing guarded staging owner environment, run `staging-number-upgrade.ts --apply` (or its built script) to apply only migration `20261012010000_number_challenge_practice`, validate migration checksums and grant the restricted API role SELECT/INSERT only. The script rejects unrelated pending migrations and production targets. Run again without `--apply` to verify.
3. Deploy API and web at the same pinned candidate. Worker unchanged. Enable only NUMBER_CHALLENGE_PRACTICE_ENABLED in staging after migration verification; all payment/wagering flags stay off.
4. Verify catalog gating, authenticated snapshot, phone controls, expansion, scoring, result persistence and recovery in a synthetic staging account. User Safari confirmation remains required for device acceptance. No production activation authorized.

## Local verification (2026-10-12)

- Full frontend: 1,428 tests / 105 files passed. Latest page/home/catalog follow-up: 17 passed.
- Number/API catalog, availability, authentication, request validation and staging refusal: 41 passed.
- PostgreSQL 16: fresh full migration chain applied; 5 native tests passed covering concurrent identical requests, changed-payload conflicts, per-user privacy, direct-SQL bounds/immutability, multi-request pacing, and SELECT/INSERT-only runtime with no wallet permission.
- The immutable receipt guard uses the platform-required invoker search path `public, pg_temp`. After correcting this configuration, the fresh migration chain and all 20 combined Number Challenge/payment native tests passed, including the global ledger invariant scan.
- Shared scoring: 2 tests, including all 10,000 guess/target combinations.
- API and web typecheck/build passed; PWA/recovery: 27 passed; changed Number Challenge TS lint passed.
- Local Chrome synthetic preview: desktop and 390px phone layouts, expand/minimize, exact and near scores, rules disclosure, Reduced Motion and no horizontal page overflow verified. Synthetic preview is excluded from commits and the production build. Physical Safari and deployed API behavior await staging rollout.
- Staging unchanged: web still 22cd770, successful deployment 31310e26-5339-4b1c-8186-c4bc51c582fe; no pending Railway changes during inspection.
