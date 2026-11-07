# Sports football preview

The sportsbook feature card replaces the floating symbol with the existing detailed football renderer: two teams, a referee, authored player rigs, passing and shooting choreography, the ball, pitch, stadium and broadcast camera. This is a labelled decorative preview with a fixed local timeline. It receives no fixtures, scores, provider sessions or wallet data and never determines an outcome.

The renderer loads only when the card is visible and animation is enabled. Hidden tabs and offscreen cards stop rendering and freeze the local clock. Pause/resume preserves that clock; a short dissolve covers the loop seam. Reduced-motion and data-saving preferences start with the existing stadium image. Unsupported graphics, context loss, import failures and scheduled-render failures retain that still image and offer an explicit retry. All renderer resources are disposed on navigation.

Desktop rendering is capped at 30 frames per second and pixel ratio 1.25. Phone rendering is capped at 24 frames per second and pixel ratio 1, without the extra shadow pass. These are configured limits, not measured physical-device performance claims. The existing game engine and shared-game renderers are unchanged.

The preview label and controls are translated in all eight languages. The launch link, zero-wallet messaging, balance reads and betting eligibility remain governed by the existing sportsbook flow. The preview is silent and does not request autoplay, media or notification permissions.

Validation covers the clock, visibility and pause lifecycle, failure recovery, existing sports balance/session tests, all eight languages at 320–1440px, visible animation, still-frame pause/resume, offscreen stopping and unavailable WebGL. `scripts/review-sports-preview.mjs` runs only against a loopback website with synthetic account/wallet responses and rejects financial writes. Chromium/SwiftShader evidence does not establish physical-device, Safari or live sportsbook transaction acceptance.
