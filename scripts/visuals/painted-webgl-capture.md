# Completed-paint Derby evidence capture

`painted-webgl-capture.mjs` is a Playwright-side observation helper. It is never imported by the game or production build. The caller supplies a real page fixture exposing `window.__derby` (`renderer`, `camera`, `live`, `peek()`), plus the existing deferred-RAF observer (`__nativeRAF`, `__heldRAF`, `__holdRAF`). The fixture must keep outcomes and published snapshots simulated and reject writes.

```js
import { installPaintObserver, capturePaintedStage } from './painted-webgl-capture.mjs';
await installPaintObserver(page);
// Perform Expand/reconnect with normal UI actions, then capture the next real draw.
const proof = await capturePaintedStage(page, outputPNG, () => measurePage(page));
```

Install Playwright clock controls before installing the caller's deferred-RAF observer. A later clock installation can replace requestAnimationFrame and bypass the hold; the evidence retains a negative setup-order probe demonstrating this. The helper rejects a missing immutable readback and verifies the final frame even if callbacks unexpectedly continue.

The helper observes each completed `renderer.render`. Every `renderer.setSize` increments a clear generation, including a resize to the same dimensions. It freezes RAF immediately after the requested draw and records the rendered frame, clear generation, actual canvas dimensions/rectangle, camera, round, published/displayed facts and movement mode. An observer callback changing the canvas after rendering invalidates the capture even if width and height did not change.

It reads the actual GL framebuffer immediately after drawing, waits for screenshot pixels, then decodes the PNG in an independent 2D canvas. At least 80 in-viewport samples, more than 16 distinct RGB values in both sources and at least 90% RGB agreement within 12 levels are required. The grid avoids the lower HTML caption. This rejects a flat CSS background/transparent WebGL stage that dimensions and draw counters alone could accept. This conservative threshold is evidence validation for the textured Derby fixture, not a general game-image similarity score.

Pixels, page metadata and post-screenshot state are taken while the same rendered frame remains held. A clear-generation, viewport, camera or fact change rejects the attempt. Rejected screenshot bytes and metadata are retained; at most five attempts are allowed. On completion or rejection, native callbacks resume.

No call advances or changes authoritative progress, animation clocks, runner roots or targets. `gl.finish`/`readPixels` deliberately synchronize evidence capture and must not be used as runtime FPS evidence. This protocol remains browser emulation/software-renderer evidence until separately exercised on physical devices.

The PR60 repair evidence retains the complete local fixture/configuration, original captures, matching published snapshots, new PNGs and raw proof ledgers. Their paths and source hashes are listed by the evidence manifest. Reproduction requires the repository dependencies plus Playwright Chromium; the helper itself adds no dependency or production API.
