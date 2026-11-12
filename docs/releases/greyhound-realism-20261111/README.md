# Greyhound realism pass — local review candidate

Status: **local branch only — not pushed, merged or deployed.** Prepared on
`claude/optimistic-pascal-yn3kf0` on top of the latest guest-website work
(`origin/codex/casino-catalogue-20261107` at `831f3a8`, "Merge PR #71: verified guest
browsing and animated artwork"). Production settings, the API, worker, database,
wallets, odds, wagers, payouts and settlement are untouched.

## 1. Recovery of the earlier candidate

Input: `salem-dog-surviving-source-20261110.tar.gz`
(SHA-256 `f3f290dd55a8379c5277f4cd323a95d8a7435768d57b1d08ff6370fea558fcdb`). It is a
surviving source snapshot plus historical reports, **not** a Git checkout or bundle; its
Git metadata pointed at a deleted temporary directory and was not included.

What was verified:

- All 1,649 files match the archive's own `HANDOFF.json` sizes and SHA-256 hashes.
- Against the accessible base commit `1436fba` (tree `293de50`), the archive differs by
  exactly the 14 files named in `candidate-identity.json`, plus two build artifacts
  (`packages/shared/*.tsbuildinfo`, not committed) and the deliberately excluded
  `.env.example`.
- Writing those 14 files onto the base tree reproduces Git tree
  **`e7df1363c8cb2d12530e8b0b0c8a2eab27881c38`**, the tree recorded for candidate
  `2cc2e88`. The recovered files are therefore byte-identical to that candidate's tree.
- The commit object `2cc2e88` itself was never pushed and could not be verified (its
  hash also covers author, dates and message). `24bb9e5` is likewise absent.
- None of the 14 paths changed between `1436fba` and the latest branch `831f3a8`, so
  they were committed unchanged as the first commit on this branch.

The historical reports (2,664 web tests, 171 shared tests and so on) were not re-run
as such; this branch's own results are in section 5.

## 2. What changed and why

The earlier candidate showed one supplied 2D sprite (CodeThisLab artwork, number "1"
baked in) for runner 1 on suitable side views, with stylized models for the other
runners. Its licence rested on an owner affirmation; the original terms were never
supplied. It could not provide a 3D gallop, other numbers or other camera angles.

This branch replaces every runner with an **original procedural greyhound** and keeps
the candidate's two real fixes:

- **Kept:** shared progress `1` maps to the finish line (solo keeps `1.06`), and graphics
  draw failure, context loss and cleanup are contained, with retired contexts released.
- **Retired:** `shared-runner-one.png`, its NOTICE, loader, atlas tests and the two
  atlas-specific review scripts. Nothing under `images/dog-racing/` ships now. The
  recovery commit keeps them in history if they are ever wanted again.

Renderer (`apps/web/src/components/dog-racing/`):

| File             | Role                                                                                          |
| ---------------- | --------------------------------------------------------------------------------------------- |
| `gait.ts`        | Skeleton in real anatomical metres; rotary gallop timing; spine flexion; two-link IK for paws |
| `greyhound.ts`   | Continuous skinned surface, 31 bones, per-vertex coats, numbered jacket, materials            |
| `world.ts`       | Sky, light, reflections, track, runners, contact shadows, dust, lure; stride from travel      |
| `camera.ts`      | Trackside, follow and aerial framing solved to fit all runners; shot changes eased            |
| `track.ts`       | Same `trackPoint`/`TRACK_LENGTH`; new sand ribbon, rails, traps, finish, scenery              |
| `race-scene.tsx` | Same props and fallback; HTML number chips, pixel budget, visibility pause                    |

Authoritative state: runners are placed exactly at `trackPoint(published progress, lane)`
as before. The gait phase advances only by distance actually moved between frames, so a
held checkpoint stops the legs and nothing runs ahead of the race. No server, result,
timing, order or financial code changed.

## 3. Assets and licences

- No external model, texture, animation, font or image was added. All geometry,
  skinning weights, coat colours and textures (fur bump, sand, grass, jacket numbers,
  trap faces, grille) are generated at runtime by code in this repository.
- Runtime dependency: Three.js 0.180.0 (MIT), already bundled. No new package or
  lockfile change.
- The procedural greyhound is a generated 3D mesh with a code-driven skeleton. It is
  not a scanned animal or an artist-rigged model, and the gait is procedural rather than
  motion capture.
- Editable source of the "assets" is the code itself: anatomy in `gait.ts`
  (`SPINE_JOINTS`, `FRONT_JOINTS`, `REAR_JOINTS`) and cross-sections in `greyhound.ts`
  (`TORSO`, `legSections`, `COATS`).

## 4. Phone performance and accessibility design

- **Download:** dog scene chunk 15,503 → 39,303 bytes (7,047 → 17,266 gzip, +10.2 KB);
  shared Three.js chunk −5.1 KB; total shipped files −871 KB because the 889 KB sprite and
  its NOTICE are gone. The scene stays lazy-loaded and out of the install precache.
- **Geometry:** per runner (body + jacket) 9,900 triangles on High, 6,440 Balanced,
  2,976 Low. Each runner is two skinned draws on a shared skeleton (body, jacket) plus a
  contact shadow, instead of roughly 30 separate meshes.
- **Texture memory (calculated, with mipmaps):** Balanced ≈ 4.1 MB — jackets 8 × 256×192
  (2.1 MB), sand and grass 256² (1.0 MB), sky reflection 336×256 half-float (0.7 MB),
  fur bump, trap faces, grille and contact-shadow disc (0.3 MB) — plus the 1024² shadow
  map the old scene also used. High uses 512×384 jackets (8.4 MB) and a 2048² shadow
  map. For comparison, the recovered candidate's runner-one atlas alone decoded to
  5.3 MB. GPU memory was not measured.
- **Resolution:** a drawing-buffer pixel budget (High 1.1 MP, Balanced 0.36 MP, Low
  0.22 MP) instead of a fixed device-pixel-ratio cap. A small phone renders at about
  1.85× on Balanced (the old cap was 1.25×); large desktop canvases stay at 1×.
- **Frame rate and battery:** Balanced/Low 30 fps, High 60 fps; about 10 fps when nothing is
  moving and in reduced motion; no drawing while the course is scrolled off-screen or the
  tab is hidden (verified: 0 frames in both states, the old renderer kept drawing when
  scrolled away).
- **Quality tiers:** Low uses matte materials, fewer segments, no shadow maps,
  reflections, dust or lure. The velvet coat sheen and soft shadow filtering are High only.
- **Reduced motion:** one still overview of the whole oval with a held running pose and
  no camera movement; leaving reduced motion is a cut, not a camera flight.
- **Fallbacks unchanged:** WebGL construction or draw failure and context loss show the
  numbered SVG track with published positions; recovery rebuilds a single canvas.

## 5. Validation

All on the final local commit unless stated. Synthetic data only; no bets, payments or
real accounts.

| Check                            | Result                                                                                                       |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Web tests (vitest, all files)    | 201 files, 3,007 tests passed                                                                                |
| Renderer suites                  | gait 5, geometry 5, camera 5, world 7, race scene 12                                                         |
| Shared package tests / typecheck | 15 files, 171 tests passed / passed (package unchanged)                                                      |
| Web typecheck, production build  | passed; existing large-chunk warnings unchanged                                                              |
| PWA + recovery, gateway          | 30/30, 11/11                                                                                                 |
| Lint                             | changed files clean; full web lint 60 errors / 65 warnings on untouched `831f3a8` → 59 / 64, none introduced |
| Server dog-racing service tests  | `dog-racing.test.ts` 4/4 (server code unchanged)                                                             |
| Server dog-racing routes suite   | **not run**: its setup seeds a real PostgreSQL service, unavailable here                                     |
| Browser review, before and after | 21/21 checks each, no page errors, no external request                                                       |

The browser review (`scripts/review-greyhound-realism.mjs`) ran against built loopback
previews of the baseline (`184636b`: latest site plus the recovered candidate) and of this
branch, with identical fixtures: gate, break, mid-race trackside/follow/aerial, home
straight, official finish, solo page, 360×780, Pixel 7 and iPhone 13 emulation, 844×390
landscape, High/Low quality, reduced motion (desktop and phone), no WebGL, mid-race
reload, aborted then resumed polling, portrait↔landscape resize and WebGL context loss and
restore. Full-race (34 s) and phone (10 s) clips were captured frame by frame on a fake
clock, so they play at true speed even though rendering was slow.

Two defects were found only by inspecting moving frames, fixed, and guarded by tests that
fail on the earlier code: the camera trailed a 10 m/s field by several metres (leaders
left the frame), and on small phones a bunched field's number chips stacked off the top.

**Performance probe (simulated, not a phone).** Headless Chromium 153 with SwiftShader
software WebGL on a 4-core Linux container, balanced quality, 5-second samples during a
running race, alternating builds in a quiet window. Pixel 7 rows use Playwright device
emulation and CDP 4× CPU throttling. Software rasterisation makes pixel shading look far
more expensive than on a phone GPU, so only the draw-call and triangle counts carry over.

| Stage (Balanced unless noted)  | Build  | Drawing buffer | Draws / frame | Triangles / frame | Median frame interval* | JS per frame |
| ------------------------------ | ------ | -------------- | ------------: | ----------------: | ---------------------: | -----------: |
| Desktop 1440×1000              | before | 771×434        |           468 |              245k |             148–162 ms |   4.1–5.2 ms |
|                                | after  | 771×434        |        **58** |          **142k** |             303–308 ms |   4.6–4.7 ms |
| Pixel 7 emulation, 4× CPU      | before | 442×375        |       413–448 |          217–235k |             198–206 ms | 16.9–19.1 ms |
|                                | after  | 651×552        |        **58** |          **142k** |             395–400 ms | 19.1–19.5 ms |
| Pixel 7 emulation, 4× CPU, Low | before | 354×300        |       284–286 |              139k |             155–174 ms | 13.8–16.4 ms |
|                                | after  | 509×431        |        **40** |           **56k** |           **82–89 ms** | 10.4–12.6 ms |

\* Software rasterisation on the CPU; not a phone frame time. Before: four rounds, after:
two rounds, alternating, nothing else running. Raw data: `perf-comparison.json`.

Reading it: draw calls fall by about 88% and triangles by 42% (60% on Low), which is what
costs CPU, driver time and battery on real phones; JavaScript per frame is unchanged on
Balanced and lower on Low. Balanced now renders 2.2× more pixels (about 1.85× density
instead of 1.25×) with PBR shading, which a software rasteriser punishes heavily, so its
software frame time doubled; Low got about twice as fast despite twice the pixels. Whether
Balanced holds 30 fps on mid-range phones must be confirmed on devices. On the shared
group page, Auto quality already drops to Low when the 75th-percentile frame interval
exceeds 48 ms. The solo page has no quality control and always uses Balanced; giving it
the same automatic fallback is a recommended follow-up.

Pausing (solo page, 390×844): 0 frames drawn while the tab is hidden and 0 while the course
is scrolled away; the baseline drew 26 frames in two seconds while scrolled away.

**Which build produced which evidence.** Stills, states, the pre-start gate and the
pausing probe come from the final commit. The two race clips and the performance rounds
come from `caa86d5`; the only later code change is the per-field trap layout, which is
identical for eight-dog fields, so every shared-round frame and measurement is unchanged.
The baseline is `184636b` (latest site plus the recovered candidate).

## 6. Not verified

- No physical phone or tablet was used. All browser work ran in headless Chromium 153
  with SwiftShader **software** WebGL on a 4-core Linux container. Frame times there are
  CPU rasterisation and say nothing reliable about phone GPUs, heat or battery.
- Safari/WebKit, Firefox and real Android/iOS GPUs were not tested.
- No CI ran (nothing was pushed). No authenticated live round, real multiplayer
  network, proof verification, database or financial operation was exercised; all data
  was synthetic.
- The server dog-racing routes suite and any database-backed test were not run.
- Texture and GPU memory figures are calculations, not measurements.
- Realism was judged visually against reference knowledge of the rotary gallop; no
  veterinary or locomotion specialist reviewed it.

Known visual limits: runners are drawn 1.25× life size so they read on phones, and the
existing track length and race duration make the field run at roughly half a real
sprint relative to body length. Stride frequency is kept at a realistic ~3.2 strides/s,
so strides are shorter than a flat-out greyhound's. The distant tree line is deliberately
simple. In 844×390 landscape the existing fixed header and bottom navigation leave little
room for the course (unchanged page layout). The lure and paw dust are decorative and
derived only from published positions.

## 7. Preview

```bash
pnpm install --frozen-lockfile
pnpm --filter @socialplay/shared build
pnpm --filter web dev
```

Then open `/greyhound-lab.html?view=side` (single dog), `?view=quarter`, `?dogs=8&view=trackside`,
`?dogs=8&view=trackside&lap=0&running=0` (gate) or `?reduced=1`. The lab is dev-only and is
not part of production builds. To review the real pages with synthetic data:

```bash
pnpm --filter web build
pnpm --filter web preview --host 127.0.0.1 --port 4311
HOUND_REVIEW_ORIGIN=http://127.0.0.1:4311 HOUND_REVIEW_OUTPUT=./greyhound-review \
  node scripts/review-greyhound-realism.mjs
```

The review script needs Playwright with Chromium and FFmpeg on the machine; Playwright is
not a repository dependency (set `PLAYWRIGHT_MODULE` or `NODE_PATH` to a global install).
`HOUND_REVIEW_PARTS=stills,states,clips,perf` selects parts. It only ever talks to the
loopback origin and fails if the app sends anything but GET to the API.
