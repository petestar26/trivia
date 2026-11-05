# Release review — 5 November 2026

Scope: the first four Play Together games using practice points, with cash
admissions disabled. The eight other implemented adapters remain disabled.
This review does not approve real-money activation.

## Repairs found during the release audit

- Group deletion now checks Play Together history before deleting memberships.
  A real PostgreSQL regression reproduced the previous generic foreign-key
  error and now verifies a clear 409 response for both open and cancelled
  rounds, with the group and every membership preserved.
- Completed rounds no longer show the pending-settlement message. This was
  caught during visual review of the live paid-round screen; the payout and
  proof checks were already correct.
- An older practice-route test now expects the existing authentication check
  to read `tokenVersion` as well as account status. Suspended users still
  receive 403 without reaching game storage.
- Funded-wallet test fixtures use their own `ZLP` jurisdiction. They previously
  collided with the recovery fixture's reserved `ZZ` jurisdiction when the
  current group and staff suites ran together. Production behavior is unchanged.
- The release workflow now also exercises current Birr pricing, administrator,
  agent, password-recovery, withdrawal and reward contracts on PostgreSQL
  13, 16 and 18.

## Evidence and boundaries

The original 291 focused checks passed again before the deletion repair. The
new deletion regression brings that set to 292. Gateway checks (11), PWA checks
(28), and the API build also passed. The feature workflow passed on all three
PostgreSQL versions at commit `40231b0`; the expanded final workflow must be
checked separately at its final commit.

The broader existing Scheduled rounds workflow was also run. Its original
failure was the outdated authentication test expectation described above.
Following that repair, local continuation exposed older payment and ledger
fixtures that try to create exchange rates rejected by the native ETB wallet
guard. The old populated-upgrade test also has a fixed migration inventory
that omits existing migrations and the two new group migrations. These wider
checks are **not green** and have not been removed or made permissive.

The native ETB migration, old purchase fixture, representative dispute test,
agent order service, and populated-upgrade test match the previously deployed
API commit `39eb0f309fdbcc8aa3d92625bc12d921be92ef7b` exactly. The old payment
fixture failures therefore do not demonstrate a new group-play regression.
Updating those legacy suites to current Birr terms remains separate work;
their failures must not be reported as a full passing financial release.

Additional local checks passed: current Birr contracts (27), reward contracts
(14), scheduled practice (56), legacy account/reward/challenge compatibility
(308), session renewal (17), and the compiled practice worker (4). Staff and
group suites were rerun together on an empty local database after correcting
the fixture collision. Final CI and live evidence belong in the deployment
record, rather than being inferred from these local runs.

## Live preflight

- Target: the `account-web` and `account-api` services that serve `salem.bet`
  in the existing Railway `account-test` environment.
- All 124 applied migration checksums match the release files. Only the two
  Play Together migrations are pending.
- Railway-managed database backup: `8e7cb84c-ac45-4412-b7f5-33d20ce75990`,
  created at `2026-11-05T11:54:08.959Z`. No user-data export was performed.
  A restore rehearsal was not performed.
- Existing administrator and agent profiles were checked as active.
- Deploy API before web, pin both to the reviewed commit, keep
  `PLAY_TOGETHER_CASH_ENABLED=false`, and verify actual authenticated practice
  confirmation, deadline processing, payouts, refunds and old-client update.
- The deployed API's existing database role is unchanged. This is not a
  least-privilege production-role or real-money readiness attestation.

## Completed practice rollout verification

The expanded Play Together workflow passed on PostgreSQL 13, 16 and 18 at
`0dcd53ebe5af495a67cf91b83de71b0f704b128c`. The API and initial web deployment
both passed Railway health checks. Both database cash gates remain false;
the policy enables only the four practice modes.

Two separate QA accounts used ordinary registration and their own cookies.
Live checks confirmed zero available cash, denied administrator access,
separate entry consent, durable declined receipts after a practice refill,
duplicate-charge protection, cancellation refunds, preserved group history,
and refusal of late entries. A two-player round paid automatically after its
published deadline; an underfilled round refunded automatically. The saved
future-beacon signature, committed result, roster and payouts verified
independently. The 2,000-point pool paid 1,930 points and recorded a 70-point
fee; final available balances and refunds reconciled exactly.

Live Chromium checks passed 26 assertions across 1,440-, 390- and 320-pixel
viewports, including profile, rewards, casino, sports and both staff sign-in
pages. No JavaScript or API-server errors were observed. A separate browser
with the old installed worker upgraded using its visible Reload app button.
Artwork loaded after scrolling into view. These are browser checks, not
physical-device or Safari acceptance. The final settlement-copy follow-up
passed the 15 page/proof tests and a fresh production web build.

Fresh managed backup immediately before rollout:
`2ac5e8ac-d15f-4a6c-a043-feba0423dc6f`, created
`2026-11-05T12:31:24.710Z`.
