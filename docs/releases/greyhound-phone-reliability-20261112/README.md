# Dog Racing on phones — smoothness and reliability pass

Status: **local branch only — not pushed, merged or deployed.**
Branch `claude/greyhound-phone-reliability`, started from the previous realism candidate
`99b684800a503da997962dbf1f672a7407bed637` (branch `claude/optimistic-pascal-yn3kf0`,
itself on the guest-website base `831f3a8`). The earlier branch, its commits and its
evidence are untouched. The live guest interface is untouched.

The race picture only **reads** published server state. Results, betting, odds, wallets,
payouts and settlement code are not changed by this branch. All runs used synthetic
fixtures on loopback; any non-GET API request fails the review scripts, and none occurred.

## 1. What changed

| Area                                                     | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Frame governor (`dog-racing/frame-governor.ts`, new)     | Measures real intervals between drawn frames. Under sustained overload (p75 > 1.45× target) it lowers render resolution 1 → 0.8 → 0.64 → 0.6; at the floor, two more overloaded windows ask for one quality tier down. It only climbs with clear headroom (p90 < 1.15× target), after a 1.5 s settle, and every failed climb doubles the wait (15 s → 4 min). Gaps ≥ 1 s (hidden tab, scrolled away) are pauses, not slowness. Idle, reduced-motion and post-resize frames are not measured. |
| Quality choice (`together/use-game-quality.ts`)          | Adds `degrade()` (Automatic only, High → Balanced → Low, never back up automatically) and `adaptive` (Automatic and not reduced motion).                                                                                                                                                                                                                                                                                                                                                     |
| User choice                                              | An explicit High/Balanced/Low choice disables all automatic tier **and** resolution changes. It is stored in `salem-game-quality` and shared by solo and group play. The solo page now has the same "Graphics quality" select as group play (existing translated strings, no new i18n keys).                                                                                                                                                                                                 |
| Rendering cost (`dog-racing/track.ts`, `race-scene.tsx`) | Below High, matte scenery uses Lambert shading (PBR and environment lighting stay on the dogs). Balanced skips MSAA when the planned pixel density is ≥ 1.5 (phones). Dogs, gait, shadows and numbers are unchanged.                                                                                                                                                                                                                                                                         |
| Short landscape phones (`dog-racing.css`)                | The course fits between the app's top and bottom bars at ≤ 480 px height.                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Solo scene download failure (`dog-racing.css`)           | **Pre-existing bug fixed:** the "3D view could not load / Reload game view" panel collapsed to zero height on the solo page (`min-height: 0 !important` + absolute panel), so the course box vanished silently. The panel now stays in flow.                                                                                                                                                                                                                                                 |
| Review tooling                                           | `scripts/review-greyhound-sync.mjs` (new, two clients), and `review-greyhound-realism.mjs` gained loading/chunk-failure, 320 px, short-landscape and adaptation probes. Dev-only lab flags for frame-cost studies.                                                                                                                                                                                                                                                                           |

## 2. Balanced vs Low on software rendering — reproduced, explained, reduced

Method (same as the earlier report): headless Chromium 1243 (Playwright 1.63.0) with
SwiftShader software WebGL, CDP CPU throttling 4×, Playwright fake clock, synthetic race,
median rAF interval over the measured window, phone profile 390×844. 4-core Xeon 2.1 GHz.
**These are simulator numbers to compare builds, not real-device frame rates.**

| Build                           | Phone Balanced              | Phone Low    | Desktop Balanced |
| ------------------------------- | --------------------------- | ------------ | ---------------- |
| Base `184636b` (before realism) | 192–202 ms (442×375 canvas) | 150–160 ms   | 156–159 ms       |
| Previous `99b6848`              | **424–451 ms** (651×552)    | 88–93 ms     | 306–332 ms       |
| This branch                     | **197–202 ms** (651×552)    | **80–84 ms** | **203–208 ms**   |

JS time per frame (phone Balanced): 18–20 → 21–24 → **15 ms**.

Cause, from a one-factor-at-a-time study in the lab at 651×552 (median, Balanced = 293 ms):
environment/PBR lighting on every surface 293 → 167 ms without it; Lambert scenery
179 ms; no MSAA 202 ms; no shadows 240 ms; bump, dust or receive-shadow on track only
279–282 ms; Low 76 ms. Combined Lambert scenery + no MSAA: 114 ms. In plain terms, the
previous Balanced paid for physically based shading of the whole stadium at multisampled
resolution; per-pixel shading cost, not the dogs, was the gap to Low.

## 3. Automatic quality in practice (final build, same simulator)

| Run                           | Result                                                                                      |
| ----------------------------- | ------------------------------------------------------------------------------------------- |
| Shared, Automatic, 45 s       | balanced → low once (≈3 s), resolution 1 → 0.8 → 0.64 → 0.6, then steady.                   |
| Solo, Automatic, 45 s         | balanced → low once, 1 → 0.8 → 0.64, one backed-off probe to 0.72 after ~30 s, back to 0.6. |
| Shared, Balanced chosen, 25 s | No tier or resolution change (1.00 throughout).                                             |

Unit model of a device on a fill-rate cliff: the old governor made 76 resolution changes in
five minutes, the new one ≤ 12, ≤ 3 after the first two minutes.

At the 0.6 floor on Low the picture is soft, but every dog is recognisable and the numbered
chips (HTML, not WebGL) stay sharp. See `adapt-solo-auto-scene.png`.

## 4. Two clients, one race (synthetic server)

Client A 390×844 portrait, client B 844×390 landscape, `review-greyhound-sync.mjs`,
**9/9 checks pass** on the final build:

- B joins mid-race at 10 s; at 12 s both draw every runner at the published position (exact,
  compared via each chip's `data-lap`).
- B offline 4 s: shows "Reconnecting to the shared game…", never draws a runner ahead of A;
  both match again at 20 s.
- A reloads mid-race, resumes from the disclosed snapshot; both match at 24 s.
- Finish: both show the server order 1-4-8-5-6-2-3-7 and draw runner 1 on the line.
- Solo page: neither client ever draws a runner beyond its latest published position; both
  show the same result.

## 5. States, sizes and pausing

Checked with screenshots (`states/`, re-run after the recovery fix: 17/17): loading and download failure of the 3D chunk (shared and
solo), no-WebGL fallback, context lost and restored, reduced motion, resize portrait ↔
landscape, reload mid-race, 320×568 (Automatic and Low), 360×780, iPhone 13 and Pixel 7
profiles (Chromium emulation), 667×375 and 844×390 landscape, High/Low tiers.
Pause probe: 40 frames in 2 s visible, **0 while hidden**, 38 after showing again,
**0 while the course is scrolled away**.

Clips: shared desktop, phone portrait and phone landscape, real time and quarter speed.

## 6. Tests and checks (final tree)

- Web unit tests: 202 files, **3,020 tests pass** (frame governor 7, race scene 15,
  quality hook incl. degrade/explicit/reduced).
- TypeScript: `pnpm -r typecheck` pass. Prettier: changed files clean. ESLint: 59 errors /
  64 warnings in the whole web app, same as before this branch (base 60/65); none in
  touched files except two pre-existing warnings in `dog-racing.tsx`.
- Local equivalent of the repository CI, 23 steps all exit 0, with a disposable
  PostgreSQL 16 cluster (created and deleted locally, synthetic data): build packages,
  130 migrations + replay + catalogue check, together-native 61, scheduled-native 17,
  sports-native 12, ETB 27, staff-native 46, member-rewards 5, shared rules 84,
  API together 10, scheduled practice 56, web together 244, catalogues 52, sports 38,
  i18n 80, PWA 30/30, i18n coverage strict, inventory 4/4, API and web builds,
  derby/dog-racing config 98 tests.
- CI browser jobs against the final build: shared-game capacity 168 checks / 0 failures /
  0 writes; lobby chat visuals 222 checks / 0 errors / 0 financial writes; sports preview
  37 checks / 0 writes. (Run with Playwright 1.63.0; CI pins 1.62.1.)

## 7. Licences and assets

No new assets, fonts, textures or dependencies. Three.js r180 (MIT) unchanged. Dogs,
track and textures remain procedural and original (see the 2026-11-11 report). The lab
page is dev-only and not in the production bundle.

## 8. Not covered — needed before release

1. **No physical iPhone or Android.** Every timing above is SwiftShader on a server CPU.
   Real GPUs behave very differently (fill rate vs. CPU), so thresholds should be confirmed
   on at least one low-end Android and one older iPhone.
2. **No Safari/WebKit or Firefox.** Only Chromium was available. iOS Safari is the most
   important gap (all iOS browsers use WebKit).
3. **No real CI run.** The CI equivalent was run locally; GitHub Actions has not run this
   branch because nothing was pushed.
4. Observed, unchanged: the shared page re-renders its whole live-game component every
   32 ms. It did not dominate in profiles here, but it costs battery on phones and is worth
   a follow-up.
5. Decision for the owner: Automatic never moves back **up** a tier during a visit (it may
   raise resolution within a tier). This avoids flicker between looks; a reload re-tests.

## 9. Commits

`539a252` Lambert scenery below High + lab study · `39e2c2a` frame governor and solo
quality choice · `f9c30b8` two-client review · `e9c4548` back-off and adaptation probe ·
`200ecd1` race order by content · `fe4a105` short landscape fit · `3861725` loading,
chunk failure and smallest phones · `066493f` adaptation probe logs the select · then the
`7c761b1` solo recovery-panel fix · this report. After the fix: dog-racing, games and
quality tests 30 files / 483 pass, web build pass.
