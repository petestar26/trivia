# Shared greyhound production candidate

> **Superseded on 2026-11-11 (local branch `claude/optimistic-pascal-yn3kf0`).** This
> candidate was never pushed or released. Its files were recovered from a surviving
> source archive and committed unchanged; the next commit retired the runner-1 2D
> artwork (PNG, NOTICE, loader and atlas review scripts) when every runner moved to the
> original procedural greyhound. The shared finish-line correction and the graphics
> failure/cleanup hardening were kept. The record below is preserved as history; see
> `docs/releases/greyhound-realism-20261111/README.md`.

## Base and boundaries

Prepared directly from the verified deployed web source
`1436fba5ae2bc68a2385258bf8645688428e2058` (tree
`293de50cd90751bdbdec475479825eaa8e45e115`), not from an animal-study branch.
Railway `salem.bet` resolves to account-web
`142f7064-d6f0-4c83-9f9e-b7028e00adb6`, project
`95bd9da5-59ea-4f49-b2b1-9114e8a1a0a2`, environment
`e48c2274-6993-446e-8a54-c33e4d6f698e`. Read-only verification found deployment
`0baeb501-eaa9-43f8-8ea7-c2df97bbd0f9` successful and no staged changes.
Recheck that identity before any later release action.

This preparation does not authorize push, merge, deployment, API/worker changes,
database operations or live bets/balances. Original checkouts and review packages
are preserved. Independent review and final local evidence are recorded outside
this source checkout so their reports can identify the exact final commit.

## Production behavior

- Shared runner 1 loads the accepted 22-frame 2D artwork on the actual group
  race page and embedded group watch area. There is no query flag or review
  injection. All eight outer roots and numbered markers remain owned by the
  existing renderer; the artwork is a local child of root 1.
- Trackside uses the image only when its authored front face is sufficiently
  visible. Follow, aerial, reduced motion, low quality, failed artwork loading
  and unsuitable actual camera angles retain the existing 3D animal. Camera
  controls, camera paths and other runners are unchanged. Backside rendering is
  disabled so the baked number cannot be mirrored.
- Shared finish progress 1 now maps to the start/finish line. Solo retains its
  1.06 normalization. Tests call the existing server recording/math functions
  to verify both contracts, including that no shared runner reaches 1 early.
  The backend and all official ordering, timing and result data are untouched.
- The frame is selected from already-disclosed lane distance, so replay,
  reload and delayed loading do not start a separate animation clock.
- The shared component now contains graphics draw failure and explicitly loses
  retired WebGL contexts after removing listeners and disposing resources.
  This cleanup/failure correction also applies to solo; solo visuals and its
  data conversion stay the same and are regression-tested.

## Verification and operational limits

Run focused art/lifecycle/finish tests, the web suite, web/shared typechecks,
changed-file lint, web build, gateway/PWA checks and language inventory. Compare
full lint failures against the untouched deployed base; do not silently repair
unrelated files to obtain a green global result. CI is not triggered during this
local preparation because nothing is pushed.

`scripts/review-shared-hound-release.mjs` runs against a built loopback preview.
It uses synthetic API disclosures, aborts external/WebSocket requests and never
places a wager. It exercises the real round and group pages, translated camera
controls, quality modes, artwork failure/delay, graphics loss/restoration,
replay, remounts and reconnect fixtures. Its browser telemetry is injected only
by the external test driver, not shipped in the application. Compare its images
against a separate build of the deployed base. Slow clips should be made by
slowing recorded video; never change the production round duration for capture.

No physical-device, Safari, authenticated live-round, real-network multiplayer,
financial/backend database or production acceptance is implied by these checks.
The accepted 2D artwork's size and baked lighting remain visual limitations.

## Bundle and rollback

Only the accepted PNG and its NOTICE are added as public art. Confirm the image
hash and absence of review entries, corgi/Mesh2Motion files and runner-one GLBs
in the final bundle. Existing models already in the deployed base are unchanged.
The image is opt-in, not added to the install precache.

Rollback is web-only: return account-web to successful deployment
`0baeb501-eaa9-43f8-8ea7-c2df97bbd0f9` / source `1436fba…`, using the normal
coordinated release approval. No API, worker, database, balance, policy or asset
migration needs reversal. No rollback or release action was performed here.
