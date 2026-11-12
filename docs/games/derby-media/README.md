# Derby broadcast realism — review media

Synthetic, loopback-only captures from `scripts/review-derby-visuals.mjs` (see `docs/games/derby-visual-assets.md`). Every API response was a local fixture; published progress came from the API's own `derbyPositions` for one fixed eight-runner (or six-runner) race. No account, wallet, wager, payment or live service was used.

- **BEFORE**: deployed `b7c98f2091e35e5df07bf1a50dfa2fdc9c704ecc`, unmodified production build.
- **AFTER**: production build of `79a6ade` (identical runtime code to `7dbc4ab` and `ad0eed1`). Later commits change only review tooling, one console warning and the far tree line; `after-side-shot-final-head.webp` shows the final tree line.
- Renderer: headless Chromium with SwiftShader (software WebGL) in a Linux container. These images establish framing, composition and correctness, not phone frame rate or colour calibration. No physical device was used.
- Both builds use the same fixture, race times and default camera mode. Comparison stills are taken after an identical three-second run-up on a paused page clock.

| File | What it shows |
| --- | --- |
| `compare-still-8-desktop-gate-scene.webp` | Waiting at the start (8 s before the off): numbered stalls vs. an empty field |
| `compare-still-8-desktop-start-scene.webp` | 3 s after the off: the break from the stalls |
| `compare-still-8-desktop-mid-scene.webp` | Mid-race: long-lens side tracking with horizon, course boards and stands |
| `compare-still-8-desktop-late-scene.webp` | 38 s: head-on view of the final furlong with the grandstand behind |
| `compare-still-8-desktop-official-scene.webp` | Official result: field pulled up past the post; the old finish beam no longer crosses the frame |
| `compare-still-8-phone375-gate.webp` | 375×812 phone, stalls |
| `compare-still-6-phone320-late.webp` | 320×568 phone, six runners, final furlong |
| `compare-still-8-landscape-late.webp` | 844×390 landscape phone, final furlong |
| `compare-state-reduced-motion-desktop-scene.webp` | Reduced motion: one still overview, refreshed once per second (Low tier) |
| `compare-state-asset-failure-scene.webp` | Model download blocked: the procedural runners keep racing on the course |
| `after-rider-and-tack.webp` | Racing crouch, silks, cap, reins, conformal saddle cloth, saddle and girth |
| `after-saddle-cloth-number.webp` | Numbered cloth on the barrel below the saddle flap |
| `after-standing-hooves.webp` | Standing hooves resting on the turf (the CC0 Idle sank them up to 13 mm); socks with pale horn |
| `after-side-shot-final-head.webp` | Final-head side shot (lab render of the shipped rigs, course and director) |
| `after-follow-race-phone375-final.webp` | "Follow race" on a 375 px phone in the final furlong |
| `after-aerial-desktop-mid.webp` | "Aerial" camera mid-race |
| `compare-race-6-phone375-mid.mp4` | 10 s, normal speed, 30 fps, six runners mid-race on a 375 px phone, before on the left, after on the right |

### Group horse racing (camera and adaptive-quality fix)

Captured with `scripts/review-derby-group.mjs` from a synthetic settled group round (shared outcome/presentation code, invalid beacon signature, events disclosed only up to the fixture time). **BEFORE FIX** is the previous PR head `8779ec6`; **AFTER FIX** is `05d6b4d`. Same renderer caveats as above: simulated, software-rendered video, not phone performance.

| File | What it shows |
| --- | --- |
| `compare-group-phone375-mid.webp` | 375×812 phone, mid-race: group horse racing had no camera controls; now Trackside, Follow race and Aerial |
| `compare-group-desktop-mid-stage.webp` | The same on desktop |
| `group-clip-frames-after-fix.webp` | Frames from the after-fix clips: group countdown over the stalls, the break, side tracking, the stands, the head-on finish; Aerial (desktop) and Follow race (phone) |
| `group-follow-race-phone375.mp4` | 6 s, normal speed (25 fps simulated), Follow race on a 375 px phone mid-race |
| `compare-group-quality-change-phone375.webp` | 375×812 phone: Follow race chosen, then Graphics quality set to Low (the same remount as an Automatic step-down). Before (`8adb774`) the view snapped back to Trackside and the race-order strip used its own colours (#1 cream, #3 red); after (`214fc89`) Follow race holds and the strip matches the horses' cloths |

Full-length evidence (both builds: every race moment for 6/8 runners at 1440×1000, 375×812, 320×568 and 844×390, expanded views, camera presets, quality tiers, reconnect, asset failure, context loss/restoration, no-WebGL, reset; a 52-second full-race comparison and 30 fps clips with quarter-speed versions; per-frame workload counts) was produced outside the repository and shared with the requester; it is not committed.
