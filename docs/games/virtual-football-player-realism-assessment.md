# Football players: realism assessment and asset requirements (November 2026)

Scope: the player characters seen through the broadcast renderer (single-player match, group game and sports preview). This experiment deliberately does **not** change player geometry, rigging, skinning or motion. This document records why, what the repository's licensed assets can and cannot do, and exactly what would be needed for convincing realism. Nothing here is a claim of photorealism. The current players are anatomical real-time figures with hand-authored motion.

## What ships today (measured from the repository)

| Element                    | Current asset                                                                                                                                                                                                                           | Licence                                                                                  |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Roster body (22 + referee) | `player-body-{high,mid,low}.glb`: 14,102 / 6,000 / 2,800 triangles, 49 joints, no embedded textures or animation                                                                                                                        | CC0 (Mesh2Motion human, pinned in `player-body-provenance.json`)                         |
| Roster heads               | `player-head-{high,mid,low}.glb`: 9,984 / 3,736 / 750 triangles                                                                                                                                                                         | CC0 (MakeHuman, pinned in `player-head-provenance.json`)                                 |
| Kits                       | No garment geometry. Shirt, shorts and socks are body regions coloured per vertex; only the shirt region samples a small runtime-drawn club atlas. There are no folds, hems or cloth volume, and boots are added detail meshes.         | Original repository code                                                                 |
| One review actor (slot 1)  | Separate continuous body (18,440 triangles), separately modelled tucked jersey (2,700), hair cards (3,870) and review head (9,984); a 34,007-triangle native-player variant                                                             | CC0 (MakeHuman core and MRT/Toigo shirt; see the review provenance files)                |
| Motion                     | 14 hand-authored keyframe clips (`run`, `acceleration`, `plantedTurn`, `idle`, `kick`, `keeperReady`, `keeperDive`, five celebrations, `dejected`, `runSwing`) blended procedurally, with travel-driven gait phase and two-bone foot IK | Original (`authored-motion-clips.json` states "No imported animation or motion capture") |

## Why they still read as stylised

At the broadcast framing, players are about 25–90 CSS px tall. Their silhouette and movement matter far more than faces:

1. **Painted-on kits.** Shirts and shorts have no thickness, hem, fold or sleeve opening, so torsos read as smooth mannequins under floodlights. Colour regions end abruptly at the body's region borders.
2. **One motion source for everyone.** Every outfield player uses the same authored run cycle at the same cadence-to-speed mapping. There is no per-player gait signature, no ball-control touches, no shoulder checks, no jockeying, no deceleration steps and no secondary motion (shirt, hair). Crowds of identical cycles are a strong "game" tell.
3. **Choreography between goals is decorative.** Positions follow formation lanes derived from the public fixture id (by design: the client may not know results early). Players glide between lanes rather than reacting to each other.
4. **Hands and boots** are simplified at roster level. This matters only in close views, which the fixed broadcast camera mostly avoids.

## Why this experiment does not change them

- **No better, cleared roster asset exists in the repository.** The review actor is the best character available, but it is deliberately limited to one slot. It has documented open defects (collar/shoulder neckline, knee and sock-cuff notches; see `virtual-football-realism-milestone.md`), and its per-frame garment and boot correctives are too costly to run for 22 actors on phones.
- **Retuning the authored clips without new source data** would trade one synthetic look for another and risk the extensively tested contact, foot-slip and kick-timing guarantees (`poses.test.ts`, `review-player-motion.test.ts`, `continuous-boot-*.test.ts`).
- **Importing third-party characters or motion was out of scope** unless clearly licensed for commercial redistribution. Nothing was imported.

## What would be needed (asset and motion specification)

The single-character work order in `virtual-football-continuous-player-artist-brief.md` remains valid for the hero actor. A believable **roster** additionally needs the following.

1. **Base characters.** Two or three body builds plus height and weight morphs on the existing 49-joint contract (`virtual-football-continuous-player-contract.json`). Triangle budgets for the phone path: LOD0 ≤ 12k, LOD1 ≤ 5k, LOD2 ≤ 1.8k (head included), with at most two materials per LOD.
2. **Modelled kit.** Separate shirt (short and long sleeve, goalkeeper variant), shorts, socks with shin-guard volume, and boots, skinned to the same rig. The shirt needs a baked fold normal map and a tileable fabric detail. Club colour comes from masks (primary, secondary, trim, number, badge) so the existing club palette system can recolour it. Kit and boot designs must be fictional, with no real club or manufacturer marks.
3. **Textures.** PBR (albedo, normal, ORM) at 1024² for LOD0 and 512² for LOD1–2. Skin needs 6–8 tone variants with matched roughness, and a small set of hairstyles as cards with alpha.
4. **Motion library.** About 80–120 clips at 30 fps with foot-contact markers, root motion extracted, and retargeted to the 49-joint rig:
   - Locomotion: idle variants, walk, jog, run and sprint at several speeds; starts and stops; turns of 45/90/135/180° (planted and running); backpedal; side-steps.
   - Ball work: first touch, dribble touches, short and long passes (both feet), driven shot, side-foot finish, volley, header, cross.
   - Defending: jockey, block and tackle.
   - Goalkeeper: set, shuffle, low and high dives both ways, catch, parry, get-up, throw and kick.
   - Referee: run, point, whistle.
   - Celebrations and dejections, with several variants of each.

   Motion capture is strongly preferred; skilled hand-keyed animation is the alternative.

5. **Runtime work** (repository code, separate from the assets):
   - a locomotion blend tree driven by the director's speed and turn rate, with per-player cadence, stride and posture variation;
   - warping clips to the director's authoritative paths and the released kick and dive contacts, so presentation never changes a result;
   - LOD-aware evaluation (full blending only for the few largest on-screen players);
   - keeping the existing foot IK and contact tests as the acceptance gate.

## Licensing requirements

Any new asset must permit commercial use and redistribution as part of a publicly served web application, since every GLB and texture is downloadable from the site.

- **Acceptable:** CC0; CC-BY with an attribution file shipped with the assets; or bespoke work-for-hire or buy-out contracts that explicitly grant redistribution of runtime derivatives and source.
- **Needs written confirmation before use:** marketplace or "royalty-free" EULAs that forbid redistributing raw files, which a public GLB URL may be. This also applies to motion libraries from character services whose terms restrict standalone redistribution.
- **Not acceptable:** assets or motion extracted from commercial games, real-player likenesses, club or manufacturer marks, and any source whose author or licence cannot be pinned with a hash, as the existing provenance files do.

Every accepted asset needs a provenance record like the existing ones: source URL and version, licence text and hash, author, conversion steps and output hashes.

## Acceptance before a roster upgrade could ship

- Matched broadcast-camera captures at desktop, the 4:3 phone stage and the group-game panel; close-ups of kit deformation through sprint, turn, kick and keeper dive.
- Unchanged released-fact timing (kick contact, ball in net, goal reveal) and passing contact and foot-slip tests.
- Measured renderer cost on physical phones (not a simulated viewport or software renderer), within the current frame caps.
