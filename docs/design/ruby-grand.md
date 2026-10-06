# Ruby Grand member design

Selected direction: burgundy, black marble, ruby glass and rose gold. The lobby reads every non-retired entry from the server's approved catalog rather than a hard-coded three-game list. Available destinations are shared with the casino catalog. Upcoming titles have individual cards without play links; a separate expansion card reserves space for future releases.

The dashboard displays open public groups and the viewer's own private groups from the active-group endpoint (up to 50 recent groups). It does not imply that group members are currently online. The group query is a child of the canonical groups cache key, so create/join invalidations refresh the dashboard too. Group list refreshes once a minute while visible.

Game and group carousels advance every 5.5 seconds when there is overflow. They pause for hover, keyboard focus, touch/manual navigation, hidden tabs, the explicit Pause control and reduced-motion preferences. All-games grid view stops autoplay and decorative floating. All items remain in the accessible DOM without cloned links. No wagers, gift purchases or group joins happen from carousel movement.

## Artwork

Built-in image generation created these decorative assets. They never represent live game results. Original generated artwork was encoded as WebP without compositional changes; combined payload is approximately 480 KB. UI typography and controls remain real HTML.

- `apps/web/public/art/ruby-grand/lounge.webp`: panoramic hero with dark left-side space and rose-gold roulette, ruby dice and ivory balls at right.
- `apps/web/public/art/ruby-grand/spin.webp`: rose-gold roulette close-up.
- `apps/web/public/art/ruby-grand/keno.webp`: ivory ceramic Keno balls on burgundy velvet.
- `apps/web/public/art/ruby-grand/dice.webp`: translucent ruby glass dice on black marble.

Shared generation prompt: "Production website artwork for PlayQube Ruby Grand casino member lobby, exceptionally high quality photorealistic luxury 3D product render, physically based materials, burgundy ruby glass, polished rose gold, warm ivory, matte black marble. Cinematic warm lighting, believable reflections, sculptural composition, rich depth, sophisticated premium casino private club. Wide landscape, no text, no logos, no UI, no watermark, no humans, no money or jackpots. Objects sit on a polished dark marble stage with deep burgundy background, restrained warm highlights."

Each asset adds its respective composition above. Future game previews use distinct decorative dimensional symbols until their actual artwork and implementation are ready.

No API changes, database migrations or payment configuration changes are required for this design. New approved game additions still follow the existing server catalog and migration policy.
