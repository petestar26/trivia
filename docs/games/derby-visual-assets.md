# Thunder Derby visual assets

The horse mesh, articulated rig, tack and rider are original procedural geometry authored in `horse-model.ts`. The renderer interpolates only between published server positions; it cannot predict or choose outcomes. Four separate hind/hind/fore/fore contacts and an airborne interval replace independent leg oscillations. This is a lightweight real-time approximation, not motion capture or race footage.

Gait reference: [University of Arizona, Horse Gaits](https://opentextbooks.library.arizona.edu/app/uploads/sites/274/2023/11/Horse-Gaits.pdf), four-beat gallop and suspension. Geometry uses the locally bundled Three.js package; no third-party models or runtime CDN requests.

`apps/web/public/art/ruby-grand/derby-racecourse.webp` is original artwork generated with the built-in image-generation tool, encoded as WebP (2172 × 724). It decorates the distant scenery; the turf, rails, horses and finish line remain real-time 3D geometry. Image load failure hides only the backdrop. Mobile pixel ratio is capped at 1.5 and rendering at approximately 30 fps; reduced motion holds a standing pose.

Generation prompt:

> Create an original photorealistic panoramic background texture for a premium 3D horse racing game, 3:1 wide landscape. Empty sunlit green turf racecourse, distant white rail and sophisticated historic cream stone grandstand with dark slate spires along the far side, small spectators in stands, lush mature leafy trees to both sides, wooded rolling hills behind, warm late afternoon golden sunlight from upper left, luminous pale blue sky with soft cream clouds. Camera looks sideways across the course, horizontal level horizon at lower third; foreground bottom fifth only empty grass. Grandstand occupies middle distance right half, trees left half, all architecture below middle horizontal line so generous sky above. Realistic fine texture, natural colors, cinematic but restrained, no foreground objects, NO HORSES, NO RIDERS, NO TEXT, NO LOGOS, no watermark. This is a distant backdrop behind separately rendered real-time 3D horses and rails, not an interface mockup.

The original PNG is retained outside the repository in the image-generation output directory. The deployable asset is checked into this repository.

## Visual completion after the interrupted loader experiment

The visual-upgrade branch starts from `a2734ee76473d249f0f6a9a0a021f6bb8bcb562f`. The interrupted experiment referenced `/models/horse.glb` but supplied no model and left missing exports and an asynchronous React effect that failed typecheck. That loader is not part of this implementation. No third-party horse model or unverified CC0 claim is included.

The original horse now has continuous, tapered deforming leg surfaces with defined upper-leg muscles, knees, cannon bones and fetlocks, a leaner flank/deeper chest, refined jaw proportions, quieter coat highlights, and numbered saddlecloths. The gait clock advances from **displayed distance travelled**, keeping contacted hooves stationary in world space during stance; it ignores round resets, finish snaps and invalid samples. Independent runner phases and the existing four-contact gait remain. It never changes published runner positions or official outcomes.

Closer, higher framing and balanced daylight improve visibility. Backdrop coverage is checked for both field sizes and wide/narrow views. The renderer stops scheduling frames after context loss and releases its resources when the field changes or the scene unmounts. Reduced motion retains the standing pose and official numbered progress stays outside WebGL.

These are original real-time procedural horses, not photorealistic scanned or artist-rigged assets. Fine facial detail, natural muscle deformation and cinematic mane/tail simulation remain limited. Browser viewport checks are not physical iPhone performance evidence. A future production-model replacement needs a verified redistributable asset, stable skeleton cloning, independent animation mixers, mobile budgets and disposal tests before integration.
