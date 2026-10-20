# Single Football player: finishing and renderer repair

This continuation follows independently reviewed PR59 head `10a27bc3dea2cab35e417cd4a16ab7fb620308c6`. Only the existing home review actor (formation slot 1, shirt 2) receives the continuous surface. Visual acceptance and roster expansion remain held. The accepted fictional face, 49-joint rig, contacts, released-event clocks, server authority, practice rules and phone layout remain the reference. No deployment or activation is authorized by this document.

## Retained asset foundation

The body derives from MakeHuman core commit `a8bc2d54ff0ac92e78ff71431b1023eda42bf482`, its pinned native rig and weights. The body GLB remains SHA256 `e289e53df6336872c567383bf7d008d52a148765fc65000aeed25834a6f240a1` (10,212 vertices, 18,440 triangles, 49 joints, eight morph channels). The accepted head source and editable correspondence files remain unchanged.

The preferred CC0 MargaretToigo/MRT `toigo_basic_tucked_t-shirt` retains its 1,391 MHCLO rows and original OBJ UV corners. The source jersey GLB remains SHA256 `e9a27e27e7cc313bde95d1e80ea568902a3a446676722d808c7ef5333a22ce9f` (1,644 vertices, 2,700 triangles). Source licenses, native OBJ/MHCLO, hashes, export helpers and mappings are retained in the evidence. No external asset, purchased asset, scan, console-game content or new animation package was added for this repair. New tailoring and adapter code are original repository code, not a relicensing of the underlying source assets.

## Boot upload correction

The reviewed implementation changed a morph BufferAttribute after its first upload. Three.js 0.180 caches a morph DataArrayTexture by geometry and target count; marking that attribute updated does not refresh the atlas. CPU probes therefore saw fresh intended geometry while the browser rendered stale data. The supplied reviewer reproduction was run against the reviewed checkout before editing and reproduced a 109.94 mm maximum CPU/cache discrepancy in both upload orders.

`continuous-kit.ts` now keeps actor-private neutral boot data and writes ordinary DynamicDrawUsage position and normal attributes. Changed poses update the same buffers and bounds. Repeated identical poses skip deformation; no per-frame geometry or texture is created. Native normal calculation still has temporary vector allocations, and changed poses recompute the normals/bounds; this is not an allocation-free or device-performance claim.

The regression exercises installed Three.js WebGLAttributes in forward/reverse sequential neutral, run, kick, follow-through, reset and reduced states, including stable buffers and independent actors. A separate actual WebGL silhouette comparison uses resident geometry versus a freshly baked reference after each pose. On reviewed code it differs by 3,158 pixels in the bent-foot pose, 1,036 in run and 1,717 at kick contact; the repaired sequence matches exactly in this local software renderer. The frozen evidence records the final rerun and exact source head.

### Correct ball-distance interpretation

The earlier 86.4 mm figure was nearest sampled **vertex to ball centre**, not clearance from the ball surface. Subtracting the 110 mm ball radius gives **−23.6 mm**, a sampled overlap. The review's unit-scale contact samples give legacy/raw/deformed centre distances of 116.509/137.595/90.129 mm, or signed sampled surface gaps of +6.509/+27.595/−19.871 mm. Vertex samples are not complete triangle/sphere collision tests. Neither the upload repair nor the historical CPU metrics establish global footwear clearance. The inherited solver's sole marker can cross turf; visual flex does not preserve exact visible sole-to-marker correspondence. Bones, targets and clocks remain unchanged.

## Garment and resting-pose repair

The original parametric shorts remain an editable connected waist/seat, sewn rise, crotch saddle and two returned hems. Construction-time horizontal sections fit them to the retained anatomical body. Production body weights are transferred barycentrically from that same surface, reduced to four normalized influences, and shared at welded seams. Seven millimetres of nominal cloth ease and additional transition rows replace the oversized side panel and abrupt row-weight changes. These are original runtime constructions, not cloth physics.

The source neutral hand/body surfaces themselves intersect when the arms hang in their raw bind pose. Outfield resting shoulders now use a small outward angle; reduced motion uses the same fixed rest without breathing/history. Keeper contact poses bypass that rest correction. This is a production posture correction, not a diagnostic-only pose substitution. Evidence distinguishes production idle from the raw bind diagnostic. Bounded vertex/triangle samples and rendered views document the result; they do not certify all future poses or full collision clearance.

The jersey retains original source vertices/UVs and adds original edge tailoring: rounded Catmull boundary midpoints and connected 1.5 mm radial / 2 mm deep returns. An attempted cuff taper also affected lateral torso vertices and introduced visible skin intersections; it was removed before the final candidate. Original source positions now remain exact at construction. Each derived position has explicit four-point Catmull coefficients; UV/weight interpolation is recorded separately. Tests reconstruct the derived data and preserve the source. An activation onset of0.26radians keeps the measured natural resting shoulders below the fairing path; a20-second actual idle sweep checks unchanged position/normal upload versions, with raised-arm activation and exact neutral reset tested separately. Eight alternating fairing passes replace the former24 shrinking passes on the posed shoulder/underarm surface, retaining the 45 mm displacement cap and seam adjacency. Collar shading, cloth folds and extreme-pose interaction still require visual review.

## Detail, cost and cleanup

The existing low-detail pipeline retains continuous head/neck identity and licensed hair/brows; high/mid retain body hinge correctives, while low skips them. Accepted facial morph synchronization still runs per released frame and immediately on real detail changes. Repeating an unchanged detail selection no longer duplicates the same deformation work. Initial visibility and both detail directions are tested. The one-player change does not expand the roster.

Use the frozen evidence's measured component totals and full-roster work counts for this head; historical 31,287/high and 22,519/low totals describe the reviewed input. Geometry counts are not GPU-memory or frame-rate measurements. Software-browser callbacks, instrumented deformation timings, renderer counters, encoded clip frame rates and physical-device performance are different measurements.

Owner tracing attributes the residual extra texture counter to Three.js's PMREM ping-pong target: its dispose event follows WebGLProperties reset, without a corresponding explicit GL delete in that trace. The main PMREM output is deleted; the inherited shadow target is separate. The engine requests context loss and the browser reports it. This explains the observed counter and does not prove a persistent driver leak, leak-free cleanup or physical-device behavior. No engine/library lifecycle repair is included here.

## Validation and acceptance

The frozen handoff supplies exact commits/files, failing-before and passing-after upload evidence, matched production-rest/front/side/back and deformation views, run/turn/brake/kick/reset clips, actual match-camera views, UI/fallback checks, full focused tests, web typecheck/build and PWA results. Historical test failures remain accounted for, rather than being replaced by a later pass.

All browser evidence uses local simulated fixtures and released facts, with explicit diagnostic versus production camera labels. Physical-phone GPU, thermal, touch and live-server acceptance remain pending. No console-quality realism, global cloth collision clearance, roster acceptance, backend/gateway/retired-chunk repair or production readiness is claimed. PR59 remains draft; PR57/PR58 and other games are separate.
