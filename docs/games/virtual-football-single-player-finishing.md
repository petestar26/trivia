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

## 2026-10-25 material source and response study

The existing licensed anatomical/garment foundation was assessed before this
material pass. The original requested `e7688bb` shader ignored its existing
linear roughness map. During this work, accepted upstream `bb2ed040` independently
restored bounded roughness and matte skin/hair response. This integration retains
those accepted values: skin .59–.71, lips .48, eyes .12, specular intensity .32,
dry clearcoat .006, skin environment intensity .32 and matte standard hair
roughness .84/environment .16. The licensed diffuse retains source pigmentation
and baked lighting. These preserved settings are now an editable study in
`review-material-study.json`, not measured human PBR data, a new skin scan, a new
hair groom or a completed artist material package.

The source shirt's own material names `T-shirt_basic-bump.png`. That existing
MargaretToigo/MRT asset is part of the pinned official CC0 Shirts 01 pack. Its
2048px height image has ribbed collar/cuff strips and flat shirt panels. The
unchanged PNG and material definition are now retained in
`scripts/assets/sources/football-review-materials`, with author, license,
archive/entry hashes and source notices. A reproducible lossless 1024px grayscale
WebP derivative supplies a conservative 0.28mm artistic bump scale using the
original garment UVs. The fictional club diffuse and number projection continue
independently. The artist bump replaces the review jersey's generic normal map
because Three's normal-map path otherwise takes precedence over bump mapping.
The editable sheen setting defaults to zero, retaining the accepted matte cloth response.

The accepted `borrowReviewFabric` API, ownership and shorts/sock use are retained.
They borrow the original pool fabric maps, independently of the new jersey bump.
The accepted upstream physical boot material remains unchanged in `continuous-kit.ts`.
Boots additionally use immutable
material response values captured from their existing neutral vertex color and
sole height, so rubber, upper and lace roughness stays attached during toe flex.
This adds one material scalar per boot vertex; position, normal, index, fit/cache
arrays, the 55mm cap and contact datums remain unchanged. `continuous-kit.ts`
remains unchanged by this material pass. Shared maps retain their original
ownership; the extra bump participates in the optional atomic review asset load
and its existing cleanup/fallback path. All changes apply to the same fixed
review actor.

The new derivative transfers 19,120 bytes and adds one 1024² texture, approximately
5.33MiB of decoded RGBA storage with a full mip chain. There is no new mesh, draw
call, shadow pass, simulation or post-process. These are dimensions/storage
estimates, not measured GPU residency or physical-device performance.
`build-football-review-materials.py --check` verifies source identity and exact
derivative/provenance reproduction. The public
`review-material-provenance.json` records color space, UV orientation and hashes.
Rendered material quality and browser/device acceptance remain separate gates.

## 2026-10-25 collar, normals and explicit action studies

Assessment traced the dark closed outer neckline curve to a tight original
source fold: eleven 26-point collar rings included 83 adjacent face pairs folded
beyond 90 degrees. An original editable control mesh now records 286 explicit
positions, forming a continuous Hermite strip from cleaned opening controls to
the fixed body ring and its following tangent. The private derivative is authored
once before high/low construction; the raw CC0 GLB, original UV corners, indices
and skin weights remain unchanged. Maximum neutral editing is 13.245mm within an
18mm guard. Source upper-strip folds beyond 90 degrees reduce from 83 to zero.
The existing posed fairing count and 45mm cap remain. This is numerical source
authoring, with no claim of a DCC sculpt or human artist authorship. The original
requested `e7688bb` captures remain historical; final comparison uses accepted
upstream `bb2ed040` as the integration baseline.

The source body normal-continuity repair is inherited unchanged from accepted
`bb2ed040`, including its hard-neutral-crease guard. R9 retains additional
regression coverage that reproduced the earlier `e7688bb` 0.52427 normal-vector
gap between equivalent UV corners and verifies zero gap for 600 equivalent
corners across sampled flexion poses. This integration adds no new body adapter
runtime fix. Body positions and the inverse-volume knee formula remain unchanged. The front closed collar line is visibly removed in
the local study; inherited profile shoulder pinching and deep-knee/jagged-sock
shape remain artist work. A shading repair does not establish natural knee
anatomy or full cloth clearance.

`review-authored-poses.json` supplies an original editable numerical key-pose
study for idle, jog, drive, brake, turn and kick, with action-specific per-digit
hand keys. Monotone cubic channel sampling replaces the selected player's former
formula-based free-arm offsets and near-fixed finger cascade. The accepted idle
arm abduction remains 12/-13 degrees; reduced motion retains its fixed pose.
The existing kick time/direction is forwarded to the hands. Pelvis, root, leg
articulation, distance phase, contact targets, ball facts and all reveal/action
clocks retain their original ownership. Shared roster clips remain unchanged.
This provides restrained arm/body lead and hand variety, without claiming new
full-body choreography, motion capture or a physical centre-of-mass simulation.

Current diagnostic visible character totals are 33,777 triangles at high/mid
and 24,993 at low, excluding two ground triangles. The current boot construction
is 3,776 triangles; older manifest totals undercounted it by 960. That geometry
is byte-identical to the accepted baseline. New neutral collar positions reduce
the clustered low shirt from 2,004 to 1,988 triangles; high remains 2,950. These
counts describe this one actor and are not runtime FPS, GPU-memory or physical
phone acceptance measurements. Native source/corrective/PBR/action deliverables,
artist acceptance, physical-device checks and roster expansion remain open.


## 2026-10-22 single-player finishing continuation

The continuation base is independently reviewed `97cc8a65c72d4b5b227ae9b79d5874cea3284018`. Earlier R6 archives and the Astra review remain unchanged. The current source manifest records the exact finishing recipes and source hashes; final committed identities, render ledgers, failure accounting and checks belong to the new frozen evidence.

The raised shoulder cap receives eight additional localized positive fairing passes after the retained shape-preserving shoulder/underarm passes. The 45 mm posed displacement bound, pinned collar positions, inactive idle path, exact reset and private geometry ownership remain. Collar shading uses area-weighted canonical UV seam normals, with separate inset cloth-return normals. Equal averaging of normalized split normals was rejected after it produced a conspicuous dark collar band; that iteration is retained. The final views improve the triangular shading patch and cap notch; thin collar seam lines and the angular inner neckline remain visible.

The returned sock cuff and upper-calf transition are fitted to same-leg intersections of the retained anatomical mesh. Barycentric production49 weight transfer retains the source's tiny cross-leg influences; source-derived binding is asserted rather than falsely assuming they are zero. Six cyclic pose-space cuff fairing passes use smooth knee activation and a 15 mm displacement bound. Stable private attributes, canonical UV seam continuity, inactive skips and one-shot reset remain. This improves the scalloped rim in sampled flexion; the underlying extreme knee silhouette remains angular and no complete garment clearance is claimed.

Boots retain the ordinary dynamic position/normal upload repair. The original generated last now has a flat bottom and a sole lip following the same profile, removing the detached elliptical rim. After final contact solving, an optional read-only envelope of the current already-visible ball produces a coherent horizontal forefoot retreat with a smooth ankle fade, 3 mm requested margin and 55 mm bind-equivalent retreat ceiling (scaled into world metres per actor). The adapter never changes the ball, rig, contact targets, root or clocks. The cache includes active nearby ball geometry; distant ball travel is normalized away so fixed normal/reduced actors stay cached. Moving or removing a nearby envelope updates/restores the same attribute buffers. Final displacement metadata measures the complete fitted geometry in bind metres, separately from world-space retreat. The smoothstep displacement derivative remains below0.825 in the production uniform-scale rig, preserving longitudinal section ordering. These are visual fitting rules, not a new contact solver; measured triangle/sphere and turf cases are bounded evidence. The reviewed unit-scale contact sample improves to a positive gap, but post-contact/scale stress can saturate the fitting bound and retain overlap.

The evidence capture script now applies `view` to the shoulder close camera and records its position, target, Euler rotation, quaternion, projection and light transforms after positioning. Fresh corrected10a/97 historical views and matched97/final views are distinct from retained rejected/camera-only iterations. High/mid/low intermediate angles, deterministic motion clips, fresh sequential GPU upload comparisons and actual roster/production views are browser software-renderer diagnostics. Encoded playback rate is not runtime FPS. Physical phone GPU/thermal/touch and authenticated live-server acceptance remain pending. PR59 remains draft; visual acceptance and roster expansion remain held. No merge, deployment or activation is authorized.
