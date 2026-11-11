# Guest 3D-style artwork

Visual-only successor to 03ffa90e. Original generated raster artwork replaces
outline illustrations in guest casino categories and feature pages. These are
3D-style pictures with CSS motion, not interactive 3D models or live game scenes.

## Coverage and safety

- Casino: slot cabinet, unnumbered roulette wheel, cards and counters, rocket.
- Groups/invitations/profile: abstract community scene.
- Messages/support: decorative speech bubbles, not actual chat activity.
- Wallet: closed wallet with blank cards, no balances.
- Gifts: gift box. Rewards/challenges/competitions: trophy.
- Existing routes, authentication, private APIs, prompts and launch controls unchanged.
- No new JavaScript dependency, remote image host, WebGL, video, or API call.
- Decorative images have empty alt text and aria-hidden parents.
- Local lazy-loaded WebP images preserve alpha; longest dimension 640px.
- All nine assets total 344,402 bytes. Only page-relevant images are requested.
- Artwork moves gently once for 1.8 seconds, then rests. Hover/focus gives a
  small lift; text and controls remain stationary. Reduced motion disables both.
- The existing isolated preview server denies every API and non-GET request,
  blocks frames/external connections/workers, and serves no service worker.

## Provenance

Generated with the built-in image_gen tool on 2026-11-11, then resized/encoded
to WebP for shipping. Original PNGs remain outside the repository. No provider
logos or third-party game screenshots are used.

Common prompt: "Original premium 3D decorative illustration for a dark emerald
and warm gold mobile app. Rich glossy emerald enamel, brushed champagne gold,
soft ivory accents, realistic dimensional bevels and soft studio reflections,
polished sophisticated collectible miniature style, three-quarter perspective.
Full isolated subject centered, generous margin all sides, genuinely transparent
background, no floor or backdrop. Strong silhouette readable at 160px. No text,
letters, logos, currency, watermarks, photo-real people or account information.
Not a working interface."

Subject variants: miniature slot cabinet with nonmatching abstract reels;
unnumbered roulette with no result; cards and unmarked counters; retro rocket
without chart/flame; abstract people around a table; two speech bubbles;
closed wallet with blank cards; gift box; unlettered trophy.

## Verification

TypeScript and scoped ESLint pass. Gateway/PWA/isolated-preview: 41/41 pass.
Full web suite: 196 files, 2,971 tests passed. Final guest-shell rerun after
image-load animation gating: 46/46 passed. Production build passes with the
existing large engine chunk/PWA precache warnings. Rendered desktop/mobile
review is a separate check; this document does not claim deployment or live testing.

Mobile QA correction: pictures are absolutely bounded inside their artwork panel
with a 12px inset, preventing intrinsic image sizing from overflowing the 130px
phone casino panel. The inset also leaves room for the finite decorative motion.
