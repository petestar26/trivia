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
