# Football skinned body LOD authoring

The three local `player-body-{high,mid,low}.glb` files derive from the individually pinned CC0 Mesh2Motion human already shipped as `/models/derby/jockey.glb`. They contain the production 49-bone rest hierarchy and inverse binds, four normalized skin weights, vertex normals, UVs, `_REGION` and `_THETA`. All player instances retain independent runtime skeletons. No source animation or bitmap is imported.

## Source identity and license

The packed source SHA-256 is `0fde4cc25d0998a7e2f37db5f60109ce48bee9c0bd262b58786c013b54d16c80`. Its upstream [human-base-animations.glb](https://github.com/Mesh2Motion/mesh2motion-app/blob/653a9698f5f315523072f1c3ff3496100401317b/static/animations/human-base-animations.glb) is pinned at commit `653a9698f5f315523072f1c3ff3496100401317b`, upstream SHA-256 `406eb0a8dc4ab366e623b79b6e3005a4951392e1bda78ae39c1099d31147733c`. The existing Derby packing recipe removes the human animation clips while retaining referenced human geometry/skin data.

The [exact pinned asset license](https://github.com/Mesh2Motion/mesh2motion-app/blob/653a9698f5f315523072f1c3ff3496100401317b/LICENSE-CC0.MD), checked 2026-10-15, explicitly covers all 3D models, rigs and animations with CC0. The retained `/models/derby/LICENSE-CC0.txt` SHA-256 is `52fec1c484df708c16b4c27b2bf0d7f0d3994105c57adc4b9e6f95bcfd9de65f`. No upstream application code, third-party clothing or vendor texture was imported.

`player-body-provenance.json` records every imported source, version, license/hash, export hash, authoring-script hash, production retarget/rig/helper source hashes and reproduction steps. The authoring scripts/helper are original repository code; Three.js, GLTFLoader and esbuild are existing dependencies. Blender/MPFB is not installed or required.

## Offline recipe

```sh
node scripts/assets/build-football-bodies.mjs
node scripts/assets/build-football-bodies.mjs --check
node scripts/assets/validate-football-bodies.mjs
```

Run from the repository root with the frozen workspace dependencies installed. `--check` regenerates bytes in memory and compares all three assets without model writes. `--manifest-only` compares models and refreshes provenance after a non-geometric authoring/formatting change. Run the builder before the independent validator, which reads its source-to-cluster map. Scratch compilation and maps use `path.join(os.tmpdir(), "playqube-football-authoring")`, outside shipped assets, on every supported platform.

| LOD | Vertices | Triangles | Bytes |
| --- | ---: | ---: | ---: |
| high | 7,912 | 14,102 | 600,584 |
| mid | 3,118 | 6,000 | 245,168 |
| low | 1,506 | 2,800 | 122,792 |

The high surface retains the source body detail but includes original edits: bone-aware neck clipping; upper-clavicle compression into the shoulder envelope; a flexible neck seal and overlapping annular crew collar/yoke; source-height plane subdivision with duplicated waist/short/sock/boot material boundaries; and a visual shoe surface fitted to the existing contact datum. These are geometry/material edits, not a new contact rig or source pose.

The former rectangular head-removal rule cut jersey/shoulder triangles. The new helper keeps shoulder/arm anatomy, removes mixed neck transitions above the neck cut, and binds surviving old outer-clavicle jersey surfaces to chest. The original neck tube spans approximately y=1.455–1.595 m, with chest-bound collar inner radius .060 m at y=1.470 and outer yoke radius .180 m at y=1.450. It overlaps the head's separate runtime neck trim. Material cuts follow the original source height thresholds .105/.43/.66/.96 with smooth shared shading normals; they avoid triangular color gradients across thighs and waist.

Mid and low use original offline vertex clustering by dominant bone, material region, UV wrap side and influence band. Hand/finger/foot cells are finer; six extrema per dominant-bone group are protected. Weights are aggregated, restricted to four, and normalized. The original production inverse binds and local 49-bone hierarchy are preserved. There is no runtime quadratic decimator or per-frame simplification.

## Visual sole fit and measured limits

The inherited source sole reached y=-.025327 m in rest. Its visible foot surface is remapped below the unchanged .08 m ankle to y=.01 m; heel z=-.073211 becomes -.07 and the anterior toe z=.241244 becomes +.20. Ankle/rig anchors remain fixed. The unchanged BALL push-off pivot is z=.15. The visual forward sole rises by `max(0,z-.15)*tan(.85)`; this prevents the fixed foot skin from passing through the turf during terminal push-off. Normals are transformed with these surface maps. It is an authored sole profile, not simulated shoe flex or a changed gait clock.

The independent validator checks exact source/license/current export/code hashes; 49 named joints and inverse-bind rest displacement; finite geometry, unit normals and normalized weights; local shoe bounds; 30 original authored FK keyframes; and the production contact-solved `poseRun` at 80 phases for speeds 2/6/8 (240 cases per LOD), scanning every visible BOOT vertex in its stance window. Its result also records the exact production pose-source SHA.

Before the toe profile, the independent production sweep found 34.84 mm penetration in every LOD. Afterward, measured maximum stance penetration is below 0.9 mm in high/mid and below 0.5 mm in low, within the explicit 6 mm surface tolerance. Neutral planted sole yaw probes report zero penetration. Rest inverse-bind error is under 0.0001 mm. Cluster skin deformation differs from the high-member average by roughly 1.4 mm mid / 3.7 mm low across the authored FK keys; posed boot envelope differences are roughly 3 mm mid / 12 mm low.

These probes cover the stated samples. They do not establish every moving world anchor, sharp turn, transition, scale variation, kick/keeper contact, runtime overlay boot/stud or physical device. The parent renderer validates overlays separately. Genuine rendered collar/face/body checks remain distinct from coordinate probes.

The source is real-time anatomical geometry with original detailing, not a scan, real-player likeness, motion capture or console photorealistic asset package. Kits are shader/material regions plus original collar/boot geometry, without separate simulated cloth shells. Brows/skin can read as stylized. Physical iPhone/Safari and low-end Android performance remain separate acceptance.
