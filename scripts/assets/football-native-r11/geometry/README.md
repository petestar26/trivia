# R11 single-player source geometry — native visual review candidate

Current native preview: `Player_Combined.blend`, SHA-256 `a7d496c22dea5775c5f53318e795a44884b3869fd0e4004060e53055636947fc`. Runtime is unchanged. This is original numerical source authoring on licensed existing assets, not a human artist sculpture, mocap, or console-quality acceptance. Roster expansion remains held.

## Editable changes

- `author-deformation.py` retains canonical49 rest frames/inverses, accepted fictional head and all eight facial targets/defaults. It rewrites the entire jersey weight field, preventing neck/head contamination, anchors every collar row to chest, reserves actual sleeve cuff loops for the upper arm and excludes torso hem from arm heuristics. Native shoulder45/90 and knee60/120 guide shapes remain editable and are driven by normalized anatomical joint angles, separately from face channels.
- `sock-source-authoring.py` creates an anatomically fitted 726-vertex/1280-triangle sock mesh. All660 original vertices survive in an explicit mapping; an extra33-vertex ring per leg at sourceY .417m covers the actual calf peak. No body skin faces are deleted. Exact source UVs/point attributes survive on old vertices; the66 new values interpolate documented original parents. Protected original rows8/9 retain position, UV and weights exactly. The original sock MeshData is retained as nonrendering reference.
- Four named `R11_SockBodyFit_<L/R>_<60/120>` source shapes bind upper-sock vertices to fixed original same-leg bodytriangle+barycentric correspondences and an explicit6–7.5mm cloth ease. They are baked bind-space keys, editable in Blender, not a nearest-posed-thigh runtime correction. Their native angle drivers are active after save/reopen without Python auto-execution.
- The102 restored body triangles are explicit original-source upper-calf faces, in unchanged10212-vertex/body-morph/UV space. A future runtime asset mode must validate their exact source IDs/hash instead of relaxing the old coverage check.

`deformation-authoring-source.json` contains the actual neutral deltas, all changed skin rows with native readback, canonical group ordering, full new topology/UV/point attributes, old→new map, new-row parents, body triangle bindings, every corrective delta and every semantic/shape driver expression. Source arrays and numerical checks, rather than byte-identical Blender rebuilds, define reproducibility.

## Preserved source context

The `merge-deformation-jog.py` helper reads the motion-owned restrained V2 source and appends this geometry into a new copy. It retains accepted241-phase CPU boot deformation only within the explicitly validated supported-jog context, on BOTH before and after. Those boot samples are existing accepted behavior, not new R11 art or a universal pitch adapter. The phase property is FLOAT;13 legacy reference actions force context0 and the two paired jogs own context1. A saved diagnostic z0 ground (2 preview triangles) and tracking camera affect no actor/target data. Metadata-safe packed-image reuse removes only byte/semantics-identical native append duplicates. This does not establish a Three.js texture leak repair.

## Rebuild

Use verified Blender4.5.15 LTS in background with `--disable-autoexec --python-exit-code 1`.

1. Open immutable `verified-source/native/PlayQube_ReviewPlayer_Baseline.blend`; execute `geometry/author-deformation.py`.
2. Open `motion/v2/Player_Jog.blend`; execute `geometry/merge-deformation-jog.py`.
3. Read-only reopen strict validation and `geometry/render-geometry-pairs.py` (optional `--held-gate` for90-degree shoulder/60/90/120knees). Do not save a render process over the source file.

The helper paths derive from the package root; retain the whole source tree. Motion rebuilding is documented by its owner. Native save compression/Blender metadata can change binary hashes on rebuild; compare source arrays/rig/weights/UV/shape/driver results.

## Evidence and limitations

`held-gate-v4/` contains true same-FK, same-camera/light geometry pairs, including60/90/120-degree knees and90-degree shoulders. `matched-source-pose-views-v4/` extends this to intermediate30/60-degree shoulders and three actual authored jog phases. Every pair ledger records identical full49-pose hashes, world camera matrices/positions/targets/rotations and light setup. `inspection-sweeps-v4/` adds three49-frame slow diagnostic clips (shoulderfront/profile and kneeprofile) with active-key/pose/camera ledgers; their10fps encoded playback is not measured runtime performance. Baseline geometry is the verified R10 surface and retained CPU sample where explicitly stated; it is a native authoring comparison, not an implemented browser/render-performance proof.

The V4 targeted views remove the previous visible torso hem wings and calf skin diamond/posterior sock fin. Visual acceptance remains independent of numerical validation and requires the complete motion views. Sleeve geometry still has broad facets; collar lip/small folds, knee anatomy, hands/hair/boots and realistic cloth compression remain stylized. No new artist-painted PBR textures or specialist animation takes were supplied. The73.156mm follow-through overlap remains OPEN. No physical-phone, live-server or runtime performance claim is made here.

## Retained failures

`iterations/` and validation logs retain the live-weight-removal defect, integer phase adapter defect, numerically green but visually failing ca4 clothing, initial V4 group-table failure, and a defensive alias assertion that was wrong for the actual sock source. V4 now preserves the actual material's RuntimePreviewColor/runtime_normal/UV source attributes; it does not invent missing shader aliases. Native normals are recomputed for new geometry; `runtime_normal` is a mapped historical reference channel, not a claim of equality to new native normals.
