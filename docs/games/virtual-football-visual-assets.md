# Virtual Football 3D visual and audio assets

The match uses locally hosted CC0 human geometry plus original procedural stadium, crowd, kits, motion and sound. No external runtime service or paid asset is required. Geometry uses the locally bundled Three.js package (MIT).

| Asset                                                                          | Source                                                                                      | Where                                                  |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Human players, referee, goalkeepers                                            | CC0 anatomical surface retargeted to the original 19-bone rig; complete procedural fallback | `components/football/engine/rig.ts`                    |
| Kit textures (solid, stripes, hoops, halves, sash), keeper kits, shirt numbers | Drawn at runtime on small canvases from each club's public colours                          | `rig.ts`, `players.ts`                                 |
| Club badges                                                                    | Original SVG shield plus a simple glyph per club (20 glyphs)                                | `components/football/club-badge.tsx`                   |
| Pitch, markings, goals, nets, crowd, boards, floodlights, skyline              | Procedural geometry and canvas textures                                                     | `components/football/engine/stadium.ts`                |
| Sponsor boards                                                                 | Invented, non-existent fictional brands drawn as text on canvases                           | `stadium.ts`                                           |
| Ball                                                                           | Sphere with a canvas pentagon pattern                                                       | `engine/engine.ts`                                     |
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
