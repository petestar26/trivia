# Thunder Derby visual assets

## Horse and jockey

The primary presentation now uses Mesh2Motion's skinned horse with its authored `Run` and `Idle` clips, plus its skinned human posed as a racing jockey. The public models, rigs and animations are CC0; no paid assets, account or external runtime service is required.

Pinned upstream commit: `653a9698f5f315523072f1c3ff3496100401317b`.

- [horse-animations.glb](https://github.com/Mesh2Motion/mesh2motion-app/blob/653a9698f5f315523072f1c3ff3496100401317b/static/animations/horse-animations.glb), source SHA-256 `c6f890c307e457b9aa7cceda1fbc1e39f8e6723ef340f23e3e667e122673b51c`.
- [human-base-animations.glb](https://github.com/Mesh2Motion/mesh2motion-app/blob/653a9698f5f315523072f1c3ff3496100401317b/static/animations/human-base-animations.glb), source SHA-256 `406eb0a8dc4ab366e623b79b6e3005a4951392e1bda78ae39c1099d31147733c`.
- [Asset license](https://github.com/Mesh2Motion/mesh2motion-app/blob/653a9698f5f315523072f1c3ff3496100401317b/LICENSE-CC0.MD), copied to `apps/web/public/models/derby/LICENSE-CC0.txt`. The upstream application code has a separate MIT license; no application code was imported.

`node scripts/assets/pack-derby-models.mjs SOURCE_DIR` reproducibly retains only the horse Run/Idle clips, removes all human animation clips and repacks referenced binary buffers without changing mesh geometry or skeleton weights. The shipped assets are:

- `horse.glb`: 337,128 bytes; SHA-256 `0bb96ac93bcb9db7a3c5606e5648b2d02657dbe865d779b6e32d2ccb1b442223`.
- `jockey.glb`: 533,136 bytes; SHA-256 `0fde4cc25d0998a7e2f37db5f60109ce48bee9c0bd262b58786c013b54d16c80`.

The original runtime additions in `rigged-horse.ts` clone skeletons independently, pose anatomical limbs toward stirrups and reins, add helmets/goggles/tack, color racing silks and horse coats, and move the jockey against the horse's vertical stride. Reins join the animated bridle to the hands. Each runner owns its mixer and cloned materials; shared geometry/textures are released once with the scene. Late model loads after unmount/context loss are disposed without attaching anything. A complete procedural horse remains the fallback if assets cannot load. Models are fetched only when Derby is opened and are not part of unrelated PWA precaching.

These are lightweight authored real-time rigs, not scanned photorealistic horses or motion-captured jockeys. The horse is 3,414 triangles; the human is 13,757 triangles before small original accessories. The two downloads total about 850 KiB, reused across all six/eight runners. Rendering remains capped near 30 fps and device pixel ratio 1.5. Physical iPhone smoothness and subjective realism still need user acceptance; desktop browser viewport checks cannot establish device heat or performance.

## Motion and official results

A buffered, monotone cubic position interpolator uses only published server positions and cannot advance past them. It preserves velocity between polls and leaves 1.5 seconds of initial polling headroom instead of reaching a hard two-second stop. If updates exceed the buffer or become stale, it stops at the last published location rather than predicting a result. The travel-driven gait no longer drops ordinary slow frames above one unit of travel. The authored Run clip is calibrated to its measured fore-hoof backward speed (about 10 model units/second during the central contact, at 1.5 world scale), rather than inheriting the faster procedural cadence. The export's leading frame hold is removed and the first pose is appended at the cycle boundary so gallop loops continuously. Stale data, reduced motion, finish and round reset retain their existing explicit stop/snap behavior. The camera fits every horse and number marker in phone, landscape and desktop views. No outcome, market, ticket, balance or payment logic changes.

## Racecourse

`apps/web/public/art/ruby-grand/derby-racecourse.webp` is original artwork generated with the built-in image-generation tool, encoded as WebP (2172 × 724). It decorates the distant scenery; the turf, rails, horses and finish line remain real-time 3D geometry. Image load failure hides only the backdrop. Mobile pixel ratio is capped at 1.5 and rendering at approximately 30 fps; reduced motion holds a standing pose.

Generation prompt:

> Create an original photorealistic panoramic background texture for a premium 3D horse racing game, 3:1 wide landscape. Empty sunlit green turf racecourse, distant white rail and sophisticated historic cream stone grandstand with dark slate spires along the far side, small spectators in stands, lush mature leafy trees to both sides, wooded rolling hills behind, warm late afternoon golden sunlight from upper left, luminous pale blue sky with soft cream clouds. Camera looks sideways across the course, horizontal level horizon at lower third; foreground bottom fifth only empty grass. Grandstand occupies middle distance right half, trees left half, all architecture below middle horizontal line so generous sky above. Realistic fine texture, natural colors, cinematic but restrained, no foreground objects, NO HORSES, NO RIDERS, NO TEXT, NO LOGOS, no watermark. This is a distant backdrop behind separately rendered real-time 3D horses and rails, not an interface mockup.

The original PNG is retained outside the repository in the image-generation output directory. The deployable asset is checked into this repository.

## Motion and framing follow-up (October 2026)

The camera uses a slightly elevated side view, larger numbered markers with contrasting text and an outline, and a wider fit envelope for their full height. It fits widening fields immediately and eases only zoom contraction, so smoothing cannot crop a newly published runner. The authored horse Run/Idle clips, measured hoof-contact calibration, buffered position interpolation and model files are unchanged. The jockey absorbs the stride with a small phase-linked pitch/roll and fore/aft adjustment. A horse returns to its standing pose when displayed travel stops; it cannot gallop ahead of the last published position. Reduced motion refreshes the standing view once per second.

Scheduled renderer failures now stop the loop and expose an explicit 3D rebuild. The page also contains lazy-import failures before the scene mounts, preserving the numbered progress and official result while offering a full-page reload. This closes the unhandled-chunk failure surface; it does not claim automatic repair of a cached old chunk or physical-device acceptance.

The added broadcast label distinguishes published live positions from the official finish. All new UI and motion adjustments are original code. Existing CC0 geometry, clips, locally generated backdrop, hashes and licences above remain unchanged. Browser viewport checks and software-rendered recordings do not establish physical phone smoothness, thermals or Safari acceptance.

## Four-hoof contact and articulated rider follow-up (15 October 2026)

The unchanged authored Run is sampled at 192 phases once per loaded asset set. All four hoof windows derive from actual FK height and speed (7–13 model units/s around the retained 10-unit travel calibration). Sparse vertices dominated by each hoof chain supply visible sole-clearance profiles. Three anatomical joints with six bounded solver passes correct stance; outside stance, an upward correction capped at 0.05 model units applies only when the sampled sole would penetrate. Positive authored clearance and natural suspension remain unchanged. No per-frame vertex scan or outcome prediction is used.

Whole-cycle tests include 384 actual skinned samples (profile samples and midpoints). Maximum measured floor penetration is below 1.9 cm; central stance world slip is below 2.1 mm, while eased landing/lift windows retain up to 9.8 cm of slip. This is a bounded visual contact solver, not collision physics or a guarantee that every skin vertex stays exactly on the turf. The sole envelope uses vertices with at least 50% hoof-chain weight. The complete runner is placed 0.035 world units above the model datum to match the track box's actual top surface.

The rider's pelvis, knees and elbows now articulate each stride through limb IK. Boots follow the moving stirrup centers; the rein targets and lines follow the actual hands, and the helmet follows the head. Direct and sequential samples agree within 1e-7 for tested joints. Independent runner skeletons, distance-linked stride phases, published-position interpolation and standing stops remain intact.

Number billboards are enlarged within the tested six/eight-runner fit envelope. Broad fill reveals dark coats and rider detail without another shadow pass; distant artwork shares scene fog for depth. No meshes, textures, clips or asset bytes were added. Contact profile calibration measured approximately 62 ms in a local Node process before rendering; this is not a mobile startup benchmark. Browser render timing and software-rendered diagnostic playback are reported separately, with physical-device/live-server acceptance still open.

## Hoof loading and broadcast follow-up (25 October 2026)

The same CC0 horse, human and Run/Idle bytes remain in use. The complete original measured stance window now keeps its backwards-moving contact anchor, with a smooth recovery interval on either side equal to 75% of that hoof's original half-window. Positive-clearance authored XYZ remains unchanged beyond those declared intervals. Phase-specific visible-sole offsets and bounded solver compensation are calibrated in five stages once per shared asset set. Runtime retains three joints, six solver passes, the existing 0.28 model-unit total correction cap and 0.05 outside-stance upward cap; it performs no vertex scan. Four additional 192-float profiles per hoof total 12 KiB shared across the field.

The rider absorbs the measured support pattern with a 15 ms visual lag, within the existing pitch/roll/fore-aft/pelvis amplitude limits. Stirrup, hand/rein targets, published root movement, buffered position interpolation and the distance-driven stride clock remain unchanged. Eight runners share one calibration, also after repeated animation calls.

Dense actual-skin CPU sampling at the shipped scale compares the exact `b899e158` baseline with this contact implementation:

| Measurement | Before | After |
| --- | ---: | ---: |
| Maximum central-half stance hoof-joint world-X range | 2.045 mm | 1.180 mm |
| Maximum complete original stance-window range | 97.768 mm | 3.307 mm |
| Worst selected-sole running penetration | 18.649 mm | 0.836 mm |
| All four selected soles above 40 mm | 131 / 768 | 131 / 768 |

These measurements use the existing vertices with at least 50% hoof-chain weight; they are not full collision/friction physics or a guarantee for every vertex. Positive release clearance still reaches about 23.19 mm within the retained 25 mm bound. Idle retains an approximately 13.10 mm sampled penetration. The original Run's loop velocity kink remains; only the new contact blend weights claim smooth boundary derivatives. A paired Node 24.19.0 calibration observation increased from about 49 to 184 ms; a contended prototype reached 422 ms. These are CPU observations, not browser/device startup or FPS.

Broadcast changes fit horse silhouettes separately from the numbered annotations. The numbered silks and runner identities remain fixed; badge placement decorates current published positions and never selects a rank or finish. Course palette, turf repetition and broad lighting use the existing original textures and lights, with no new model, image, shader asset or runtime host. Normal and expanded views retain the mounted scene. A stale connection now also appears in the existing arena heading, where it remains visible in short landscape views without adding another alert region.

The camera fits each runner's real lane/position bounds instead of phantom corners combining unrelated runners. Number badges remain 28 CSS pixels, with separation and per-scene bounded movement rather than jumping between free layout regions. Round/viewport resets snap to a valid layout; stationary annotations reuse the same dynamic leader buffer without uploads. Async model adoption also restores the 0.035 turf datum: the procedural fallback animates its root height, whereas the authored horse carries vertical motion in its bones. Only displayed X/lane Z transfer from that fallback; official progress and the stride clock do not change.

Scene-owned geometry, materials, textures and the sun's shadow target are disposed before the renderer clears its bookkeeping. A software-WebGL API trace reproduced ten uploaded material handles still live after the old ordering; the corrected production path issues deletion for every uploaded material handle. This establishes owner disposal, not physical driver-memory reclamation. The diagnostic still observes the internal shared Sprite geometry and renderer-default handles while retaining the context.

The retired-chunk limitation remains separate. A two-release fixture using the real Derby view and generated service worker caches release A without its optional renderer, then removes A's chunk in release B. The boundary retains text progress, but `Reload game view` repeats the stale A import/404. The separate explicit `Reload app` activates the waiting B worker and imports B's module in that controlled fixture, with WebGL deliberately unavailable. No PWA recovery code changed; automatic/live-server recovery is not established.

The asset geometry, authored clip and materials remain stylized. Browser emulation, software-WebGL callbacks and encoded normal/slow playback are separate evidence categories; physical-phone GPU, thermal, touch/Safari and live-server acceptance remain pending. No outcome, odds, clock, rule, admission, receipt, balance, financial or activation behavior changes belong to this work.
