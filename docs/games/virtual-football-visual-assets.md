# Virtual Football 3D visual and audio assets

Everything the match view draws or plays is original and generated in code. There is **no third-party model, texture, animation clip, audio file, font or CDN request** in the football feature, and no `.glb` or loader for one. Geometry uses the locally bundled Three.js package (MIT).

| Asset                                                                          | Source                                                                                      | Where                                                  |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Human players, referee, goalkeepers                                            | Procedural 19-bone skinned mannequin (about 2,480 triangles each), authored in code         | `components/football/engine/rig.ts`                    |
| Kit textures (solid, stripes, hoops, halves, sash), keeper kits, shirt numbers | Drawn at runtime on small canvases from each club's public colours                          | `rig.ts`, `players.ts`                                 |
| Club badges                                                                    | Original SVG shield plus a simple glyph per club (20 glyphs)                                | `components/football/club-badge.tsx`                   |
| Pitch, markings, goals, nets, crowd, boards, floodlights, skyline              | Procedural geometry and canvas textures                                                     | `components/football/engine/stadium.ts`                |
| Sponsor boards                                                                 | Invented, non-existent fictional brands drawn as text on canvases                           | `stadium.ts`                                           |
| Ball                                                                           | Sphere with a canvas pentagon pattern                                                       | `engine/engine.ts`                                     |
| Catalog card                                                                   | A render of this feature's own 3D scene (goal sequence, fictional clubs), encoded as WebP   | `apps/web/public/art/ruby-grand/virtual-football.webp` |
| Sound (optional, off by default)                                               | Web Audio synthesis: filtered noise crowd, triangle-wave whistle, filtered-noise goal swell | `lib/football/audio.ts`                                |

The catalog image was produced by `apps/web/football-lab.html?scene=match&t=8.9&goals=6000H&settle=1&key=vf-s1-w01-f05&home=5&away=14&hud=0` at 960 × 720, then recoded to WebP. No reference screenshot, no screenshot of any other product and no image-generation output is part of the repository, and no such image was used as a texture, backdrop or catalog image.

## What the figures are, honestly

- **Stylised mannequins**, not photorealistic players. Heads, hair, hands and faces are simple shapes; there is no facial animation, cloth or hair simulation. No likeness of any real person, club or kit is intended.
- **No motion capture and no licensed animation.** Gait, kicks, dives and celebrations are procedural. The skeleton has independent per-player bones (nothing is shared, so no player can move another), and two-bone IK keeps planted feet on the turf during stance. Strides are driven by the **distance a player has travelled on screen**, not a free-running oscillator, so feet do not skate; the lab and the unit tests measure foot slip during stance rather than relying on stills.
- **A screenshot alone does not prove gait.** Run `pnpm --filter web exec vitest run src/components/football/engine/poses.test.ts` for the foot-contact assertions, and watch the capture described in `virtual-football-handoff.md` for motion.
- **Match play between goals is decorative.** Run-ups, passing and positioning are a deterministic function of the match key and the released goals. They never feed any result, price or settlement. Only goals the server has already released (`elapsed` goals) are ever passed to the renderer; the final score is shown only after its last goal has been drawn.
- Browser viewport checks and software-rendered captures are **not** physical iPhone, Safari or low-end Android performance evidence. Pixel ratio is capped at 1.5, rendering at about 30 fps, drawing pauses when the tab is hidden or off screen, and reduced motion renders one still refresh per second with no camera movement. Context loss falls back to the text match centre and rebuilds every GPU resource on retry.

## Budgets measured in the dev lab (software GL, 1280 × 720)

About 94k triangles and 40–55 draw calls for 22 players, a referee, the stadium and the crowd (instanced). Per-look geometry is shared between identical looks; each player still owns its skeleton and mesh.

## If a licensed model is ever added

It needs a verified redistributable licence recorded here, per-player skeleton cloning (no shared mutable skeletons), independent animation mixers, mobile triangle and texture budgets, disposal tests, and a fallback that still works when the file cannot be loaded. No placeholder loader or guessed file path is included now.
