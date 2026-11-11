# Virtual Football 3D visual and audio assets

The match uses locally hosted CC0 human geometry plus original procedural stadium, crowd, kits, motion and sound. No external runtime service or paid asset is required. Geometry uses the locally bundled Three.js package (MIT).

| Asset                                                                          | Source                                                                                      | Where                                                  |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Human players, referee, goalkeepers                                            | CC0 anatomical surface retargeted to the original 19-bone rig; complete procedural fallback | `components/football/engine/rig.ts`                    |
| Kit textures (solid, stripes, hoops, halves, sash), keeper kits, shirt numbers | Drawn at runtime on small canvases from each club's public colours                          | `rig.ts`, `players.ts`                                 |
| Club badges                                                                    | Original SVG shield plus a simple glyph per club (20 glyphs)                                | `components/football/club-badge.tsx`                   |
| Pitch and markings                                                             | Analytic shader markings and mowing bands over a generated 256² grass-detail canvas         | `components/football/engine/turf.ts`                   |
| Goals, nets, bowl, roofs, floodlight banks, LED boards, skyline                | Procedural geometry, generated canvas/data textures                                         | `components/football/engine/stadium.ts`                |
| Crowd                                                                          | Original canvas-drawn spectator cards animated in the shader                                | `components/football/engine/crowd.ts`                  |
| Floodlit lighting environment, night sky, floodlight shadow decals             | Procedural PMREM scene, gradient canvas, generated data textures                            | `environment.ts`, `contact-shadows.ts`                 |
| Sponsor boards                                                                 | Invented, non-existent fictional brands drawn as text on canvases                           | `stadium.ts`                                           |
| Ball                                                                           | Generated truncated-icosahedron panel data texture on the sphere's own UVs                  | `engine/ball.ts`                                       |
| Catalog card                                                                   | A render of this feature's own 3D scene (goal sequence, fictional clubs), encoded as WebP   | `apps/web/public/art/ruby-grand/virtual-football.webp` |
| Sound (optional, off by default)                                               | Web Audio synthesis: filtered noise crowd, triangle-wave whistle, filtered-noise goal swell | `lib/football/audio.ts`                                |

The catalog image was produced by `apps/web/football-lab.html?scene=match&t=8.9&goals=6000H&settle=1&key=vf-s1-w01-f05&home=5&away=14&hud=0` at 960 × 720, then recoded to WebP. No reference screenshot, no screenshot of any other product and no image-generation output is part of the repository, and no such image was used as a texture, backdrop or catalog image.

## What the figures are, honestly

- **Anatomical real-time figures, not scanned photorealistic players.** Human hands and facial anatomy improve the silhouette; there is no facial animation, cloth or hair simulation, or likeness of a real player. Seated spectators are original lightweight figures.
- **No motion capture and no licensed animation.** Gait, kicks, dives and celebrations are procedural. The skeleton has independent per-player bones (nothing is shared, so no player can move another), and two-bone IK keeps planted feet on the turf during stance. Strides are driven by the **distance a player has travelled on screen**, not a free-running oscillator, so feet do not skate; the lab and the unit tests measure foot slip during stance rather than relying on stills.
- **A screenshot alone does not prove gait.** Run `pnpm --filter web exec vitest run src/components/football/engine/poses.test.ts` for the foot-contact assertions, and watch the capture described in `virtual-football-handoff.md` for motion.
- **Match play between goals is decorative.** Run-ups, passing and positioning are a deterministic function of the match key and the released goals. They never feed any result, price or settlement. Only goals the server has already released (`elapsed` goals) are ever passed to the renderer; the final score is shown only after its last goal has been drawn.
- Browser viewport checks and software-rendered captures are **not** physical iPhone, Safari or low-end Android performance evidence. Pixel ratio is capped at 1.5, rendering at about 30 fps, drawing pauses when the tab is hidden or off screen, and reduced motion renders one still refresh per second with no camera movement. Context loss falls back to the text match centre and rebuilds every GPU resource on retry.

## Free asset provenance and reproduction

The body reuses `/models/derby/jockey.glb` (533,136 bytes), the pinned Mesh2Motion CC0 human documented in [Derby visual assets](derby-visual-assets.md). Football retargets its inverse-bind rest geometry to independent existing player skeletons; it does not use the source preview pose or import game code.

The facial surface comes from MakeHuman's CC0 base mesh at commit `a8bc2d54ff0ac92e78ff71431b1023eda42bf482`:

- [Source base.obj](https://github.com/makehumancommunity/makehuman/blob/a8bc2d54ff0ac92e78ff71431b1023eda42bf482/makehuman/data/3dobjs/base.obj), SHA-256 `8e761e6624b8f54536409135d1636da63b32486a90d4897f84e121d144f6fb4c`.
- [Asset licence](https://github.com/makehumancommunity/makehuman/blob/a8bc2d54ff0ac92e78ff71431b1023eda42bf482/LICENSE.ASSETS.md), copied to `public/models/football/LICENSE-CC0.txt`. Application code is separately licensed and was not imported.
- `python3 scripts/assets/pack-football-face.py SOURCE_OBJ`, followed by `node scripts/assets/simplify-football-face.mjs`, extracts the head/neck and reduces it to 1,200 vertices / 2,338 triangles.
- Shipped `face.glb`: 29,120 bytes, SHA-256 `3149887222ffa0ce42b0f7d0fa2374ea75db58e9f8da91d3b82ed179b9c68143`.

Models load only in Football; load failures retain complete fallback figures. Late loads after disposal release their geometry without reattaching players. All player bones remain independent. Combined downloaded model size is 562,256 bytes, with the larger body shared with Derby's browser cache. Each dressed player is about 15,958 triangles; each instanced seated fan is 420 triangles. Desktop preview measured about 837k triangles and 61 draw calls. This is desktop evidence, not a physical-phone benchmark; the existing 30 fps / 1.5 pixel ratio caps and reduced-motion behavior remain.

## Club presentation

`lib/football/clubs.ts` maps the existing 20 stable simulation IDs to Premier League club names and original generic kits/badges. Membership reference: [official 2026/27 squad lists](https://www.premierleague.com/en/news/4706139/see-all-the-202627-premier-league-squad-lists), checked 2026-10-10. These are simulated fixtures, not real fixtures, real player likenesses or real team ratings. Immutable model codes, strengths, rules digest, ticket IDs, server outcomes and settlement remain unchanged. History uses the same display aliases consistently; it does not become a record of real-world matches.

## Related open-source research

No verified public source release of MOHIO Virtual Football was found. [Google Research Football](https://github.com/google-research/football) is a related native C++/Python football environment, not a drop-in browser game. [Striker 3D](https://github.com/kendrekaran/striker-3d) is a related browser project, but its game-code reuse licence was not established; no code was copied. [Quaternius](https://quaternius.com/packs/universalanimationlibrary.html) offers CC0 animation assets, but none were imported in this revision.

## Broadcast presentation follow-up (October 2026)

The scoreboard now uses burgundy and rose-gold accents, club codes on narrow screens, an explicit simulated-match label and a compact match caption. Both caption and scoreboard consume the existing delayed `DisplayFixture`; a pending last goal cannot become a final-result caption. A bounded portrait field-of-view adjustment improves scene coverage. Reduced motion holds one fixed broadcast camera while refreshing released match facts. The existing anatomical geometry, travel-driven gait, foot-contact IK, goal scripts and source assets are unchanged.

An outer boundary catches renderer lazy-import failures before the inner renderer can mount, retaining the live text match centre and offering a full-page reload. The reload is explicit because a rejected ESM chunk may remain cached; this is containment, not proof of automatic stale-version recovery. Existing saved confirmations remain managed by the original receipt code.

All new presentation, camera calculations and UI are original source code. No new model, texture, animation, audio, vendor media or asset licence was introduced. Software-rendered local synthetic screenshots/captures are separate from physical iPhone/Safari and low-end Android acceptance.

## Motion and readable framing follow-up (15 October 2026)

The existing 140 ms pose blend now preserves its target before interpolation; previously it copied the source over the target. Stance anchors are stored per player in world space and re-solved after blending. A loaded sole can pivot about its contact once torso/boot yaw reaches 45 degrees. A bounded support-height correction (at most 6 cm) and a short lifted replant handle unreachable anchors during a sharp reversal, rather than forcing an anatomically impossible fixed-foot twist. IK lengths respect the existing 0.96–1.04 uniform player-height variation. Kick preparation/settling and goalkeeper load, landing compression and recovery are articulated without changing the released ball sequence, KICK contact clock or goal reveal gate. Heading response is continuous, limited to 9 rad/s and tested across frame steps.

Tests measure actual FK heel/forefoot contacts under both directions, scale variation, sharp turns during blending, loaded pivots, exact released kick contact, reach bounds and explicit short replant phases. These proxies do not establish every skinned boot surface or a complete hip-twist/collision simulation. Hands/fingers remain constrained by the existing 19-bone retargeted rig; there is no new geometry, cloth, facial animation or motion capture.

The reduced camera retains geometry-only pitch/net/aerial coverage and immobility, now with an elevated fixed angle that gives the pitch depth rather than a thin horizon strip. Portrait expanded stages use a compact 4:3 proportion. Broad unshadowed fill improves dark goal-area body/kit visibility without adding a shadow pass, mesh or texture. The shell uses burgundy/black/rose gold; short wide landscape headers/history are compact, and the caption explicitly labels the released last-goal minute. No server clock, score, odds, admission, receipt or credit path changed.

All additions are original renderer/UI code; shipped CC0 source assets and hashes above are unchanged. Deterministic matched-time production-camera captures and labelled pivot/rig diagnostics are separate from actual running-browser timing measurements and physical/live acceptance.

## Single-player visual review continuation

One home outfield review actor uses individually pinned CC0 core skin, short01 hair and eyebrow001 assets with exact source UVs and MHCLO fitting. Source/version/license/entry hashes and exported GLB/WebP identities are in review-head-provenance.json and review-player-provenance.json; original source notices are retained beside them. Runtime garments, physical-material adapter, posture offsets and hand cascade are original. Remaining roster actors keep their previous pipeline. See virtual-football-review-player-pipeline.md for ownership, cold-load/GPU estimates, deliberate one-player scope and outstanding visual/device acceptance. No server/reveal clock or game rule changes.

## Floodlit broadcast presentation (November 2026)

Base: production website commit `1436fba5ae2bc68a2385258bf8645688428e2058`, which contains the sports-preview commit `7fc1a2c` with identical football source. Only the shared renderer changed, so the single-player match, the group game and the sports preview all receive it. Released facts, goal times and the `GOAL_SEQUENCE.moment` reveal, decorative choreography, player assets, rig, motion, LOD selection, UI, server, rules, tickets, balances and every wallet path are unchanged.

- **Camera.** A fixed "camera 1" gantry on the halfway line, 21 m up and 33 m behind the near touchline (`BROADCAST_RIG`). It pans, tilts and zooms but never dollies. Zoom is distance-compensated so players keep a steady on-screen size toward either goal. A critically damped operator spring (`camera-operator.ts`) replaces first-order smoothing. Goals stay on the same camera with a modest zoom; the existing cut and dissolve still happen only on entering and leaving a goal sequence. Reduced motion keeps its separate fixed overview. Tests cover ball and post visibility through every goal variant on desktop, phone portrait and phone landscape, with and without operator lag.
- **Light.** A floodlit night rig: a main-stand key with the only shadow map, whose frustum follows the framing and is snapped to shadow texels so it does not shimmer while panning; an opposite-roof rim; an end-stand side light; a 64-texel procedural PMREM environment (about 0.7 MB on the GPU); and a world-aligned night sky. The ACES tone mapping that the review-player materials were tuned under is retained.
- **Grounding.** Instanced floodlight "star" shadows and contact patches for every actor and the ball, in four draw calls. When the shadow map is active, the real key shadow replaces its decal. Low quality and the phone preview, which have no shadow map, therefore still ground players. Artwork is identical across graphics tiers.
- **Pitch.** Markings are computed per pixel in world metres using Laws of the Game distances, with box-filtered coverage measured across the nearest line and a perceptual floor, so the far touchline stays continuous. Mowing bands parallel to the goal lines vary with viewing direction. Restrained goalmouth, spot and kick-off wear is included. A 256² tiling detail canvas replaces the former 2,200 × 1,360 painted turf canvas (about 16 MB with mipmaps).
- **Stadium.** A two-tier bowl with aisles, rake-following end caps, an LED ribbon fascia, roofs with floodlight banks and additive glare, rotating LED perimeter boards using the existing fictional sponsors, goal stanchions, and subdivided mesh netting that keeps the original ripple. Static structure is one vertex-coloured draw call.
- **Crowd.** Canvas-drawn supporters on per-row cards. Each supporter bobs individually and some stand with raised arms as excitement rises. Rows are split into short segments that turn up to 60° toward the fixed camera, so oblique stands keep natural proportions. This replaced roughly 460,000 triangles of instanced 3D seated fans with a few thousand. The fans' now-unused geometry (`spectator.ts`) and its unit test were removed.
- **Ball.** A generated truncated-icosahedron panel texture (12 pentagons, 20 hexagons, seams) on the sphere's own UVs, at the unchanged 0.11 m contact radius.

All additions are original repository code with generated textures. No model, texture, animation, audio, font, photograph or third-party asset was added, and the existing CC0 assets and hashes above are unchanged. Sponsors remain invented.

First-iteration measurements, captured at commit `42e7749` (its docs-only successor `04403e8` has identical application code), with matched lab captures (`football-lab.html?scene=match`, fixture `vf-s1-w01-f05`, clubs 5 and 14, the same clock and viewport, pixel ratio 1). Timings come from headless Chromium 153.0.8010.12 with SwiftShader software rendering on a 4-vCPU cloud Xeon, interleaved A/B over two rounds. Each figure is a mean of 40 consecutive live-play frames, synchronised by reading back from the GPU.

| 1280 × 720 / 390 × 844        | base `1436fba`          | this change             |
| ----------------------------- | ----------------------- | ----------------------- |
| Triangles                     | 640k / 559k             | 217k / 111k             |
| Draw calls                    | 104 / 93                | 127 / 109               |
| GPU-synchronised frame        | 555–560 ms / 315–319 ms | 469–474 ms / 181–186 ms |
| Main-thread JavaScript, frame | 8.3–8.6 ms / 7.1–7.5 ms | 8.2–8.4 ms / 7.3–8.7 ms |

A first pass applied the environment light to every material and was 37 % slower per desktop frame. Ablation moved the large matte surfaces to Lambert shading, which removed that cost. Software-renderer figures compare builds on one machine only; they are not phone, GPU or Safari frame rates. The lazy engine chunk grew by 20.9 KB (7.9 KB gzip), and the main bundle is unchanged.

Limits: crowd cards are flat and are designed for this fixed camera distance; a future close-up camera would need 3D or impostor spectators. The goal moment is now wide, as on live television; the former low close-up is gone, and the shipped catalog card still shows it. Player bodies, garments and motion are unchanged and keep the open specialist requirements recorded above. Physical-device performance, thermal behaviour and Safari remain unverified.

### Second iteration: stage-aware framing, goal push-in and natural turf

Review feedback found that goals were too distant, especially on phones, and the grass too noisy. In the shipped layout, phones never draw a portrait 3D stage. The 3D view is a 4:3 box of about 390 × 292 CSS px on the match page and its expanded view, about 390 × 222 in the group game and about 362 × 254 on the sports card. A landscape phone gets a wide strip of about 844 × 265. Only the lab produces a truly portrait canvas.

- **Stage-aware framing** (`broadcast-framing.ts`). Desktop framing is unchanged.
  - Smaller stages zoom until a 1.8 m player is at least 24 CSS px tall in live play, never narrower than 14 m across.
  - Small and portrait stages tilt so the far boards sit near the top and the stand is mostly cropped.
  - Portrait stages use a higher position on the same gantry axis. For a given stage the camera never moves; only aim and zoom change.
- **Goal push-in.** The director's zoom intent rises from 1.3× to 1.9× through the move and eases to 1.55× for the celebration. The director also states what the shot must contain: the ball always, and the goal mouth and goalkeeper once the ball is within about 20–32 m. The framing never zooms tighter than that.
  - Tests cover the ball, the goalkeeper (from 1 s before the finish) and both posts (from 0.5 s) for every goal variant on eight stage sizes. They pass both for the director's framing and with the live operator's lag.
  - The operator zooms out quickly and in slowly, so widening for the action never lags.
- **Cuts.** Entering and leaving a goal remains a cut, because players are restaged when a goal is released and the client may not anticipate it. The overlay is now a 30% dip held for 120 ms that eases out over 420 ms, replacing a 55% flash. The sports preview has no goals and never cuts.
- **Turf.** The detail tile no longer has large clumps, which repeated every 2.6 m as visible blotches. Blades are low-contrast on a 3.4 m tile. Broad variation comes from one non-repeating 64² noise map over the whole surface. Mowing bands blend over about 0.4 m, and turf colour is partly desaturated toward a warm grey.
- **Players.** Unchanged. See `virtual-football-player-realism-assessment.md` for the assessment and the exact asset, motion and licence requirements.

The measurements, matched three-way captures (`1436fba`, `04403e8` and this iteration's commit) and device/browser details for this iteration are reported in the pull request, tied to the exact captured commit.

### Third iteration: no void beyond the near touchline, play kept clear of page overlays

A review clip of the portrait lab showed black ground beyond the near touchline for about half a second as the goal push-in tilted the camera down. The same geometry reached the shipped stages: the turf ended 6 m past the near touchline, and nothing was built on the near side because the gantry looks over it. Any shot aimed close enough to the near touchline exposed the empty ground below the stage.

- **Hard limit on the bottom edge** (`broadcast-framing.ts`). Rays through the bottom edge of the clear band (at five points across it) may not reach ground beyond 36 m from the halfway line, 2 m past the near touchline. The solver finds the steepest tilt that respects this limit and keeps every point the director asks for inside the band. If no tilt can do both, it widens the shot (up to 16 steps of 8 %) rather than giving up either. Tests run three full matches on thirteen stages and check every frame.
- **Dressing as a second line of defence.** The turf now extends 12 m past each touchline, and a 24-row near lower tier, merged into the existing stands draw call, meets it. The asphalt apron is a neutral grey. Any operator overshoot therefore lands on grass or seats, never on the background. The reduced-motion overview now ends on seats instead of empty ground.
- **Framing for the visible band, not the canvas.** The scoreboard and caption drawn over the 3D view cover up to 146 of 260 CSS px on a portrait phone. Overlays now mark themselves with `data-scene-overlay="top" | "bottom"` inside a `data-scene-frame`. `scene-overlays.ts` measures them, follows resizes, language changes and overlays appearing or disappearing, and passes the insets to the engine (`Engine.setSafeArea`).
  - The engine renders with an off-centre projection (`setViewOffset`), so the composition sits in the clear band while the pitch still runs under the translucent overlays.
  - This applies to the match page, the group game and the sports card.
- **Ball always readable.** Live play and goals pass focus points to the framing: the ball always, plus the goalkeeper and goal mouth near the finish. The tilt keeps each focus point within 86 % of the clear band's half-height. Before this change, the whole-match test found the ball up to 2.2 band half-heights outside the clear band (behind the scoreboard or caption) on 330 × 260, 788 × 218 and 360 × 253 stages.
- **Unchanged.** Event timing, the goal reveal moment, the cut and dissolve, the fixed camera position for a given stage, and all player assets and motion.
