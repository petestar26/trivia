# Thunder Derby 3D — practice specification

Reference inspected 2026-10-09: https://mohiogaming.com/games/racing/horse-racing . Public rules and both six/eight-runner screenshots inspected. The vendor presents prerecorded historical real-race footage, fixed displayed odds, numbered colored runners, a countdown, a central combination odds matrix, place/special side columns, and a recent-result strip. A private demo is offered through vendor contact; no playable demo, probability model, complete settlement policy, bonus schedule or footage license was publicly available. No vendor contact was made.

Our original implementation uses real-time 3D horses and a track, with mobile-friendly market/runner selections rather than shrinking the retail matrix. Six-runner races recur every three minutes, eight-runner races every four minutes. The final minute contains 45 seconds of racing and 15 seconds of results. Selection closes before racing. One immutable practice ticket per account per race. Winner, Perfecta (ordered two), Quinella (unordered two), Trifecta (ordered three), In first 3, lower/upper half, odd/even are supported. Double Chance and jackpots are not implemented: the reference does not publish sufficient economics and these are not silently invented.

All finish permutations are equally likely using SHA-256 rejection-sampled Fisher-Yates from a server-generated 256-bit seed. The round commitment is SHA256(`thunder-derby-uniform90-v1:${roundId}:${seed}`). The seed and final order are revealed only after the race. Current race positions are public once entries close. Animation and horse appearance do not affect the outcome. This is not MOHIO's undisclosed odds model or certification.

Fixed gross multipliers (include the returned stake):

| Market | 6 runners | 8 runners |
|---|---:|---:|
| Winner | 5.40 | 7.20 |
| Perfecta | 27.00 | 50.40 |
| Quinella | 13.50 | 25.20 |
| Trifecta | 108.00 | 302.40 |
| In first 3 | 1.80 | 2.40 |
| Lower/upper half, odd/even | 1.80 | 1.80 |

Expected gross return is 90% before whole-credit rounding. Losing tickets return zero. Starting balance 1,000, stake 10–500. These isolated practice credits cannot be bought, transferred or redeemed and never touch Coins or the financial ledger. No cash-out, autoplay or jackpot.

Server admission uses database time after row locks, immutable receipts and round/account uniqueness; exact retries return the existing receipt and changed retries conflict. Settlement locks the round/ticket/account, applies one credit, and can recover after worker downtime or on the member's next snapshot. PostgreSQL guards validate picks, odds, payout, settlement time and balance conservation. Deferred checks are flushed before success.

`THUNDER_DERBY_PRACTICE_ENABLED` must be exactly `true` to expose practice routes/catalog or start its worker. Default off. Financial admission is independently and unconditionally paused for `thunder_derby_3d`. Migration and restricted runtime grants must be validated before staging activation. Production payment/wagering gates remain off.

## Rendering and rollout

The race uses original stylized procedural 3D horses/jockeys, gallop joints, numbered silks, a tracking camera, textured course, trees, grandstands and finish arch. Static meshes are merged by material to reduce mobile draw calls; rendering caps pixel ratio at 1.5 and frame rate near 30. Reduced motion and a non-WebGL progress/result fallback remain available. Decorative catalog key art is generated separately and is not a screenshot of the real-time renderer. Three.js 0.180.0 is locally bundled (MIT), with no third-party model or runtime asset host.

Apply the forward migration through the normal migrator. A restricted existing application role needs only SELECT/INSERT/UPDATE on the two practice receipt/account tables and SELECT/INSERT plus UPDATE(id) on rounds (for row locking); `grantDerbyRuntimeTables` implements these grants. Existing user identity reads/locks are also required. Enable the practice flag on API and group worker only after migration/grant checks. Do not enable any financial flag or change the dormant financial catalog row. Staging and physical-device acceptance are separate from local tests; this change does not assert they have passed.

### Guarded staging preparation

`apps/api/dist/scripts/staging-derby-upgrade.js` is the owner-run preparation command,
compiled by the API build. It uses the existing exact disposable-rehearsal target
and acknowledgement guard, requires a matching worker database host/port/name,
and checks the owner, both restricted runtime roles and dormant catalog state
before any mutation. It refuses failed/changed migration history and any pending
migration other than `20261009120000_thunder_derby_practice`.

After the candidate has been reviewed, run without arguments to verify the
migration and runtime grants. Only an explicit `--apply` deploys the allow-listed
migration and grants the API and worker roles access to the Derby tables. The
command does not enable the practice flag, payments or wagering. Its readiness
message confirms this narrow preparation, not deployment or financial activation.
A real staging rehearsal and physical-device validation remain separate release
checks; unit tests do not substitute for them.
