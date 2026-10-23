# Single-player continuous Football character: artist work order

Status: authoring specification only. No new body, garment, motion or runtime integration is delivered by this document. Scope is the existing PR59 home review actor (formation slot 1, shirt 2), shown as the **same person** in outfield and goalkeeper diagnostic clothing. Do not replace the roster or alter match logic. This order uses the current review head and asks for a convincing continuous neck/body, fitted kit, deformation and complete football action package.

A viable CC0 foundation exists: MakeHuman core `base.obj` and its native default rig/weights at commit `a8bc2d54ff0ac92e78ff71431b1023eda42bf482`. The missing deliverable is a finished, fitted, production-ready football character and cleared action package. The core foundation does not establish football garment, corrective deformation or motion quality. Use the [source/license assessment](virtual-football-continuous-player-assets.md) and [renderer contract](virtual-football-continuous-player-contract.json) for exact accepted inputs, hashes and current rig values; retain the [pinned asset grant](https://github.com/makehumancommunity/makehuman/blob/a8bc2d54ff0ac92e78ff71431b1023eda42bf482/LICENSE.ASSETS.md). Application code licensing is separate. No vendor contact, purchase, real-player likeness, proprietary football extraction or uncleared motion is authorized.

## Deliverables and approval boundary

Deliver one organized editable `.blend` project, original source textures, high/mid/low export GLBs, baked clips, PBR maps, rig mapping, corrective catalog and provenance/marker manifest. The editable project must include fitted geometry, original garment construction, source-native weights, retarget setup, animation controls and non-destructive corrective setup. Include exact Blender/exporter versions and a repeatable export recipe. Ship runtime-ready derivatives separately from authoring-only geometry, controls and native rig. Do not claim this brief or a neutral preview completes authoring.

The manifest must identify every source URL, commit/version, license text, source and output SHA-256, author/rights grant, original additions, scale/axis conversion, source-to-production joint map, weight transfer rules, corrective drivers, clip names/durations/markers, LOD topology/material counts and texture dimensions/color spaces. Original commissioned work must explicitly permit raw source and derivative redistribution. Uncertain assets remain outside the package. Approval of these deliverables is separate from renderer integration and broad roster adoption.

Read [body authoring](virtual-football-body-authoring.md), [head authoring](virtual-football-head-authoring.md), [review surfaces](virtual-football-review-player.md), [review runtime pipeline](virtual-football-review-player-pipeline.md) and [motion authoring](virtual-football-motion-authoring.md). Some historical sections of [visual assets](virtual-football-visual-assets.md) describe earlier 19-joint/procedural stages; the current `engine/rig.ts` and authored-motion sources are authoritative for the 49-joint contract.

## Achievable artist milestones

1. **Source and bind proof:** retain the four pinned inputs from the [asset assessment](virtual-football-continuous-player-assets.md), reconstruct the native rig without losing vertex identity, and present the continuous neutral body with native skinning plus the complete 163-to-49 influence/rest mapping. Gate: valid indices, all anatomical vertices bound and documented normalization/truncation; no claim of final deformation.
2. **One fitted character:** fit the continuous neck/body to the existing head, author original outfield and goalkeeper kit/boots/gloves, and supply neutral plus extreme-pose turnarounds. Gate: reviewer accepts anatomy, identity, neckline and garment fit before motion polish.
3. **Deformation and action pass:** complete the specified 20 clip exports and corrective catalog; show contact-aligned transitions and uncut keeper landing/recovery. Gate: artist review of full-speed motion and documented fixed-marker/contact compliance, with unresolved limitations explicit.
4. **Export handoff:** deliver editable project, GLBs/PBR maps, LODs and hashed manifest plus repeatable recipe. Gate: structural/rig/marker validation and visual review of exported derivatives. Later browser integration and physical-device acceptance are separate work, and this documentation revision delivers none of those runtime improvements.

## Body and clothing construction

Use the continuous MakeHuman anatomical foundation to author one coherent body from neck through shoulders, chest, pelvis, hands and feet. Keep the existing review head's facial identity, eye fit, eight morph targets, hair/brow fit and source UV alignment. Its world-rest head transform is `x=sourceX*.12`, `y=1.50+(sourceY-5.89)*.12`, `z=(sourceZ-.161)*.12`. Preserve this identity while fitting the body; do not independently scale a generic body and conceal the mismatch with rings.

Provide a single anatomical neck transition: match boundary position, tangent, normals, material/UV continuity and weighting from the current head's lower neck to the new torso. A welded shared boundary or explicitly matched boundary with a documented separation plan is acceptable; facial targets must not be lost when assembling the character. Remove superseded duplicated neck skin, internal seal and yoke/tube constructions from the new visual package at integration. Do not stack overlapping tubes, annular plates or flared collars to hide an anatomical seam. Keep the existing pipeline as fallback until the replacement is approved.

Author a fitted continuous jersey with purposeful shoulder topology, sleeve openings, collar and hems, plus separate fitted shorts with proper crotch/hip/seat topology. Garments are continuous surfaces with intentional seams, thickness/hem returns and drape; material-region recoloring or offsetting the old torso is insufficient. Hide only genuinely covered skin with an explicit mask, leaving neck, forearm/hand and lower leg boundaries intact. Inspect armpit, sleeve, collar, waist and crotch through the full action range. Do not require runtime cloth simulation. Supply original outfield color/pattern masks and number layout plus an original goalkeeper long-sleeve/glove variant. Use fictional markings, no copied branded shirt design, sponsor or boot logo. Both variants retain the same anatomy and rig.

Hands need believable palms, finger webs, relaxed cascade and thumb opposition, plus open goalkeeper reach and recovery support. Glove thickness must not move wrist/palm contact targets. Football boots need shaped toe box, heel counter, ankle opening, sole and original studs; visible sole and stud extrema must respect current ground/contact datums across all LODs. Geometry must deform naturally through toe push-off, kick and landing rather than passing through turf or separating from the ankle.

## Fixed production rig and native-weight retarget

Production uses +Y up, +Z forward, +X character left, metres, and independent actor skeletons. Preserve these **19 ordered body names** exactly:

`hips spine chest neck head upperArmL foreArmL handL upperArmR foreArmR handR upperLegL lowerLegL footL toeL upperLegR lowerLegR footR toeR`.

Append the existing 30 finger joints in current order: left then right; within each side `thumb1/2/3`, `index1/2/3`, `middle1/2/3`, `ring1/2/3`, `pinky1/2/3`, with side suffix `L` or `R`. This gives exactly 49 production joint names. Three.js root Group is not an additional deforming joint.

| Joint/chain | Production parent | Local rest offset metres |
| --- | --- | --- |
| hips | root Group | (0,.95,0) |
| spine | hips | (0,.10,0) |
| chest | spine | (0,.22,0) |
| neck | chest | (0,.24,0) |
| head | neck | (0,.10,0) |
| upperArm L/R | chest | (±.20,.17,0) |
| foreArm L/R | corresponding upperArm | (0,-.29,0) |
| hand L/R | corresponding foreArm | (0,-.26,0) |
| upperLeg L/R | hips | (±.10,-.02,0) |
| lowerLeg L/R | corresponding upperLeg | (0,-.43,0) |
| foot L/R | corresponding lowerLeg | (0,-.42,0) |
| toe L/R | corresponding foot | (0,-.045,.17) |

Finger chains are hand → joint1 → joint2 → joint3. Copy their exact asymmetric decimal rest offsets and complete inverse-bind contract from `apps/web/src/components/football/engine/rig.ts` and the [source-derived rig contract](virtual-football-continuous-player-contract.json); do not round, symmetrize or infer those offsets from this table. The table verifies the body contract only. Rest rotations, bind frame and inverse binds must match production; never introduce a global retarget pose into a rest mesh. Current dimensions: height 1.8, hip datum .95, thigh .43, shin .42, upper arm .29, forearm .26, ankle .08, foot length .27 and ball radius .11 metres. Preserve uniform dressed-scale behavior at .96 and 1.04.

Retain the native MakeHuman rig and weights in the editable authoring project. Explicitly map each native deform/helper joint to production chains, explain omitted/merged influences, and transfer weights using the continuous anatomical source. Show elbow/knee/shoulder/hip/palm results before and after transfer. Do not claim native weights can be copied unchanged between different skeletons. Export at most four normalized nonnegative joint weights per vertex, with no unbound vertices or detached joint surfaces. Retain seam-correspondence data for consistent body/garment weights and LOD transfer.

Native helper/twist bones may remain in the DCC setup. Any required runtime twist helpers or pose-space correctives belong to an explicitly proposed **visual adapter**, separate from the fixed contact rig; they must not become a silent change to the 49-joint authority. Prefer baked deformation/morph correctives compatible with the existing rig. Document corrective drivers for shoulder elevation, elbow flexion, forearm pronation, hip/knee flexion, ankle/toe push-off, neck turn and finger curl. Show combinations, not only isolated axes. Any future helper adapter must be reviewed for bone textures, bounds/culling, LOD, cleanup and contact preservation before integration.

## Exact action package and transition matrix

Deliver **20 separately named runtime clips** below, plus editable action takes and original contact/IK control curves. This count excludes diagnostic captures and facial targets. Bilateral clips may be derived by mirroring only after artist correction and independent inspection; export each named derivative and record its origin.

| Clips | Count | Required content/inputs |
| --- | ---: | --- |
| `idle`, `keeperReady` | 2 | Stable supported breathing/rest and goalkeeper preparation; loop seams |
| `jog` | 1 | Full alternating-support cycle, normalized phase 0–1, source reference speed and stride length |
| `accelerateLeftSupport`, `accelerateRightSupport` | 2 | Drive/load to jog, each initial support; signed speed change and phase markers |
| `brakeLeftSupport`, `brakeRightSupport` | 2 | Controlled deceleration from jog to supported idle, each initial support; no skate |
| `turnLeftLeftSupport`, `turnLeftRightSupport`, `turnRightLeftSupport`, `turnRightRightSupport` | 4 | Moving approach, quarter-turn and exit; heading/curvature reference and initial support |
| `kickLeft`, `kickRight` | 2 | Load, opposite-foot plant, strike at .30 s, follow-through and settle by .85 s |
| `keeperDiveLeft`, `keeperDiveRight` | 2 | Complete continuous launch/interception/landing/get-up to ready by 1.8 s |
| `keeperLandLeft`, `keeperLandRight` | 2 | Editable/exported landing sections of the same full dives, with mapped parent-action time |
| `keeperRecoverLeft`, `keeperRecoverRight` | 2 | Editable/exported recovery sections of the same full dives, with mapped parent-action time |
| `runSwingControls` | 1 | Authored swing target/pitch curves with preserved stance endpoint tangents |

Landing/recovery section exports are for authoring/inspection and controlled future blending; the existing runtime full dive remains the primary clock. They must not add extra sequential duration to the 1.8-second action. New clip names are proposed delivery names, not a claim the runtime already supports them. The current runtime has original `run`, acceleration/planted-turn/idle/kick/keeper actions; braking currently comes from posture offsets. Supply a mapping plan rather than modifying those consumers in this work order.

| Transition input | Required take/coverage | Blend and support requirement |
| --- | --- | --- |
| idle → jog | acceleration for both support choices | Weight transfer before first swing; match initial and final velocity |
| jog → idle | braking for both support choices | Planted deceleration, stable final support; match both endpoint velocities |
| jog ↔ drive/brake | phases 0,.25,.5,.75; speeds 1.2,2.4,4.4 m/s | Match distance-driven phase; preserve foot target, knee direction and arm counter-swing |
| jog → moving turn → jog | both directions × both support feet; approach/arc/exit | Continuous curved translation, plant/release and body lead; no stationary spin substitute |
| jog/idle → kick → jog/idle | both feet; low/high loft and low/high power | Opposite foot stays supported; boot reaches unchanged ball target at .30 |
| keeperReady → dive → land → recovery → keeperReady | both directions, current legal reach/height envelope | Hand target/orientation retained; sensible side landing and sequential supports during get-up |
| any supported action entry | first frame, near contact and late refresh | Random-access sampling and .14 s current blend; no transient loss of contact |
| all applicable actions | scales .96/1.04, reduced motion, LOD changes | Same identity, support datums and no bind/pose reset |

Clips must contain full-body coordination: pelvis weight transfer, chest counter-rotation, head/gaze stabilization, arm swing, knee/ankle articulation and appropriate hands. A new torso-lean overlay alone does not fulfill this order. Provide clean loop endpoints, compatible entry/exit poses, velocity/acceleration curves and contact windows in the manifest. Bake at documented 30 fps or higher, retain exact marker samples, and validate interpolation between keys; sampling rate is not a runtime FPS claim.

## Unchanged timing and contact ownership

`KICK.contact=.30`, `KICK.duration=.85`, `KICK.through=.34`; `DIVE_CONTACT=.45`, `DIVE_DURATION=1.8`; `GOAL_SEQUENCE.moment=2.05`, sequence length 4 seconds. Kick and keeper markers are relative to their action starts; goal crossing is relative to a released goal-sequence start. They do not all share one clip origin. Keep current director start offsets, ball trajectory, interception targets, result/reveal publication and all server authority unchanged. Never let clip events publish goals, choose save/miss, reveal unreleased score, affect odds/admission/balance/settlement or write backend state.

Run phase remains distance / current stride length; it cannot free-run on elapsed clip time. Cadence is `1.45+.085*min(speed,9)`, stride `max(.4,speed/cadence)`, stance travel `min(.95,.45+.07*min(speed,9))`, duty `clamp(stanceTravel/stride,.2,.5)`, with opposite feet .5 cycle apart. Keep current stance heel-to-ball handoff and swing tangents. Final foot support runs **after** base clip sampling, crossfade, posture/correctives and any visual overlay; preserve hips translation where the solver owns it. Re-solve keeper wrists with their original position and orientation after torso mixing. Correctives may alter visible shape but must not move these authority targets.

Production contact datums: heel local (y=-.07,z=-.07), ball/push-off local (y=-.068,z=.15), stance ankle .078 m; fixed foot rest y=.08. Current visual forefoot reaches z=.20 with raised surface beyond z=.15. Maximum held-foot yaw twist π/4, bounded support pelvis drop .06 m, and current lifted release/replant must remain. A required visual sole/stud profile should be authored to these constraints. Do not hide penetration by lifting the entire root, changing event time, extending bones or dragging a world anchor.

Keeper landing must visibly load forearm/hand/hip/leg supports and protect head/neck rather than merely rotate a rigid body onto turf. Artist poses must make the current target reach possible at .45, then recover within 1.8; if a physically convincing pose cannot satisfy a target, document the incompatibility for review instead of changing clocks. Current full dive has launch through .55, documented ground .55–1.15, and rise 1.1–1.8. Decorative review overlay envelopes differ; they are not authority event markers.

## Export and provisional budgets

These are **proposed authoring budgets, not measured passes or device guarantees**. Target one high review actor at ≤35k total dressed triangles including head/hair/boots/gloves, mid ≤18k, low ≤6k; report actual counts by component and explain necessary exceptions before export approval. Start with one 2048² body/kit atlas and 1024² ORM/normal maps where detail permits, reusing accepted face/hair maps; propose texture reductions if seams/face quality would suffer. Limit new material slots to six for the high body/kit package, fewer at mid/low; report full-character draw calls separately. No additional shadow pass, simulation or post-process is part of this order.

Use metallic/roughness PBR: base color/emissive sRGB, normal and ORM linear, documented normal handedness and UV orientation. Supply sensible skin/cloth/glove/boot roughness and restrained skin normal detail without baked light or false metallic skin. Keep original/licensed source images editable, alpha masks explicit and glTF texture transforms recorded. Compressed transfer bytes do not imply compressed GPU residency. Supply decoded/mipped memory estimates and measure actual upload/runtime cost only during later integration.

Every LOD must preserve neckline, fingers/palm silhouette where visible, boot contacts and material masks. Transfer skin weights/correctives from high rather than rebuilding unrelated deformation. State which facial/corrective features are omitted at low detail, and verify transitions in both directions without a neutral-frame flash. Existing pool caps/hysteresis and one-player selection remain owner of detail changes. Per-actor skeleton/material/morph state remains independent. Shared geometry/textures and per-actor wrappers need explicit disposal ownership, atomic load failure fallback, rejection cleanup and late-load disposal behavior.

Reduced motion must retain a supported static pose with fixed resting hands and restrained/static expression; zero optional motion overlay weight and keep existing fixed camera/refresh behavior. Asset failures, unsupported WebGL and context loss retain complete baseline player/text match centre and existing retry semantics. This brief authorizes no changes to those systems.

## Acceptance evidence required before integration approval

Provide the same character at neutral front/three-quarter/profile/back, open and closed eyelids, neck turn, raised/lowered shoulders, full elbow/hip/knee flexion and pronated hands. Include visible and wireframe close views of collar, neck/body boundary, armpit, crotch, fingers and boot sole at high/mid/low. Show source-native weighting and production-retarget deformation side by side. Reject hard shoulder shelves, collapsed elbows/knees, candy-wrapper forearms, inflated neck rings, garment/body z-fighting, torn seams and detached hands/boots.

Capture continuous real-time normal-speed front/side/three-quarter sequences of jog, acceleration, braking, moving turns, both kicks and both full keeper dives, with contact-marker overlays and uncut landing/recovery. Include the exact .30/.45/1.8 samples and the released goal sequence at 2.05; attractive stills cannot establish motion. Record camera, view size, clip/input/time, asset hashes, runtime/build identity and capture method. Label authoring viewport renders separately from actual application captures and synthetic software rendering.

Later integration validation must retain the existing foot/ball/wrist, twist/reach/support, mirror/scale, independent instance, blend, random-access/late-entry, reduced-motion, LOD and cleanup checks. No new tests are added by this documentation task; baseline regression validation is recorded separately. A coordinate test pass does not certify believable anatomy, cloth motion or safe-looking landing; an artist and reviewer must inspect the moving character.

Physical iPhone/Safari and low-end Android remain pending until tested on named actual devices with browser/OS, thermal/load duration, frame-time distribution, GPU/memory observations, touch/rotation/context-loss checks and the full scene load. Browser viewport emulation, offline bounds or a desktop capture are not substitutes. Single-player artist approval, local browser integration, device acceptance, roster expansion and deployment are distinct gates; this order does not pass any of them.
