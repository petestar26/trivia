# Thunder Derby visual assets

The horse mesh, articulated rig, tack and rider are original procedural geometry authored in `horse-model.ts`. The renderer interpolates only between published server positions; it cannot predict or choose outcomes. Four separate hind/hind/fore/fore contacts and an airborne interval replace independent leg oscillations. This is a lightweight real-time approximation, not motion capture or race footage.

Gait reference: [University of Arizona, Horse Gaits](https://opentextbooks.library.arizona.edu/app/uploads/sites/274/2023/11/Horse-Gaits.pdf), four-beat gallop and suspension. Geometry uses the locally bundled Three.js package; no third-party models or runtime CDN requests.

`apps/web/public/art/ruby-grand/derby-racecourse.webp` is original artwork generated with the built-in image-generation tool, encoded as WebP (2172 × 724). It decorates the distant scenery; the turf, rails, horses and finish line remain real-time 3D geometry. Image load failure hides only the backdrop. Mobile pixel ratio is capped at 1.5 and rendering at approximately 30 fps; reduced motion holds a standing pose.

Generation prompt:

> Create an original photorealistic panoramic background texture for a premium 3D horse racing game, 3:1 wide landscape. Empty sunlit green turf racecourse, distant white rail and sophisticated historic cream stone grandstand with dark slate spires along the far side, small spectators in stands, lush mature leafy trees to both sides, wooded rolling hills behind, warm late afternoon golden sunlight from upper left, luminous pale blue sky with soft cream clouds. Camera looks sideways across the course, horizontal level horizon at lower third; foreground bottom fifth only empty grass. Grandstand occupies middle distance right half, trees left half, all architecture below middle horizontal line so generous sky above. Realistic fine texture, natural colors, cinematic but restrained, no foreground objects, NO HORSES, NO RIDERS, NO TEXT, NO LOGOS, no watermark. This is a distant backdrop behind separately rendered real-time 3D horses and rails, not an interface mockup.

The original PNG is retained outside the repository in the image-generation output directory. The deployable asset is checked into this repository.
