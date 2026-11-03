# One review player: surface and coordination milestone

Continuation baseline: `e7688bb8042e95cbd7b1e01318c261e3453c54fb`. PR59 remains draft. Only the existing fixed home review actor is affected. This is a small presentation milestone, not visual acceptance, a roster replacement or console-quality realism.

## Assessment before implementation

The retained CC0 MakeHuman body/head, anatomical hands and native production49 binding and the CC0 MRT/Toigo tucked shirt remain usable foundations. Their original artist/source/licence records remain in the existing provenance files. No new third-party asset, texture, geometry, UV or skin weight is introduced here. Existing clothing has already accumulated bounded pose fairing; more inflation or smoothing cannot honestly replace a finished garment or authored action set.

The visible angular collar/shoulder neckline and extreme knee/sock-cuff notch are still geometry/weighting defects. Material or normal changes do not solve them. The existing running legs/contact solver also remain an approximation; upper-body coordination does not establish physical weight transfer or a mocap-quality action.

## Small implementation

- Existing body hinge correction now computes area-weighted normals across matching smooth UV corners and the incident one-ring. Unchanged neighbours on a moved triangle no longer retain stale neutral normals. Neutral normal/position bytes, morphs, hard creases, skeleton/contact ownership, per-instance buffers and unchanged-pose skips remain. No position corrective or displacement bound is added.
- Head/body/hands share the same restrained skin roughness/specular treatment using their existing licensed diffuse and pool-owned grain maps. Hair is more matte; shorts/socks borrow existing cloth maps; the existing boot material slot receives restrained physical highlights. No new texture/material slot or draw call is introduced. Shader/sampler cost may increase and must be measured separately.
- Existing upper-body posture sampling uses distance-phase-delayed shoulder/elbow recoil, coordinated braking arm balance, and kick counterbalance through the unchanged contact/follow-through/end markers. Root, hips, legs, hands, foot targets, ball facts, reveal clocks, keeper paths and reduced-motion inputs remain unchanged.

The accepted clear-boot deformation/upload/clearance code remains exact. Remaining follow-through overlap is deliberately shown rather than hidden by moving the ball, target, root or action clock.

## Required specialist deliverable

Supply editable, properly licensed DCC source for this same fictional identity and49-joint rig: a fitted crew-neck band and shoulder/armpit edge flow/weights; authored knee/patella/posterior-knee and sock-cuff correctives through0–120degrees; finished relaxed/curl/grip hand poses; coherent skin/cloth/boot PBR maps; and authored run/acceleration/braking/moving-turn/kick takes. Retarget to the retained distance phase and `.30`contact, `.34`follow-through, `.85`duration. Preserve all server facts and contact datums. Demonstrate the full swept boot/ball interaction, including the unresolved follow-through overlap. No such artist package is claimed delivered by these code changes.

## Evidence and acceptance

The separate exact-source milestone archive records matched full-body/collar/knee views, diagnostic and actual broadcast-camera motion at phone/landscape/desktop viewports, clear-boot/contact/follow-through measurements, triangle/draw-call budgets, source/asset hashes, test/failure accounting and browser timings. Deterministically encoded playback, browser callback/render performance and physical-device testing are distinct. Browser fixtures are simulated released facts, not live-server acceptance. Physical iPhone/Safari/Android checks are unrun.

Reduced motion, accessibility, text/WebGL/asset fallbacks, one-player selection, UI/reveal tests and PWA checks remain required. Passing tests do not establish visual acceptance. Existing PMREM/callback concerns and untested hardware performance remain open. No PR57/58, other-game, backend, shared-rule, ticket, balance, migration, flag or financial change; no merge, deployment or activation.
