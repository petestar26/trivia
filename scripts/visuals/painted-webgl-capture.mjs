import fs from 'node:fs/promises';

/** Observation-only Playwright capture gate for a live Three.js renderer. */
export async function installPaintObserver(page) {
  await page.evaluate(() => {
    const d = window.__derby;
    if (!d) throw Error('The Derby observation fixture is not ready');
    if (d.renderer.__captureObserved) return;
    d.renderer.__captureObserved = true;
    const resize = d.renderer.setSize;
    const render = d.renderer.render;
    window.__paintGeneration = 0;
    d.renderer.setSize = function (...args) {
      // setSize can clear the drawing buffer even when dimensions are unchanged.
      window.__paintGeneration++;
      return resize.apply(this, args);
    };
    d.renderer.render = function (...args) {
      const result = render.apply(this, args);
      const c = this.domElement;
      const rect = c.getBoundingClientRect();
      window.__completedPaint = {
        frame: this.info.render.frame,
        generation: window.__paintGeneration,
        width: c.width,
        height: c.height,
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        aspect: d.camera.aspect,
        cameraPosition: d.camera.position.toArray(),
        cameraQuaternion: d.camera.quaternion.toArray(),
        roundId: d.live.current.round.id,
        published: [...d.live.current.round.positions],
        displayed: [...d.peek().displayed],
        running: d.live.current.running,
        reduced: d.live.current.reduced,
      };
      if (window.__captureNextPaint) {
        window.__captureNextPaint = false;
        window.__holdRAF = true;
        const gl = this.getContext();
        const pixels = new Uint8Array(c.width * c.height * 4);
        gl.finish();
        gl.readPixels(0, 0, c.width, c.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        const samples = [];
        // Avoid the page's HTML overlays at the bottom of the stage.
        for (let row = 0; row < 12; row++)
          for (let col = 0; col < 16; col++) {
            const x = Math.round(rect.x + ((col + 0.5) / 16) * rect.width);
            const y = Math.round(rect.y + (0.05 + ((row + 0.5) / 12) * 0.7) * rect.height);
            if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) continue;
            const px = Math.floor(((x - rect.x) * c.width) / rect.width);
            const py = c.height - 1 - Math.floor(((y - rect.y) * c.height) / rect.height);
            const i = (py * c.width + px) * 4;
            samples.push({ x, y, rgba: Array.from(pixels.subarray(i, i + 4)) });
          }
        window.__completedPaint.samples = samples;
        window.__captureArmed = false;
      }
      return result;
    };
  });
}

export async function releasePaint(page) {
  await page.evaluate(() => {
    window.__captureNextPaint = false;
    window.__holdRAF = false;
    window.__heldRAF.splice(0).forEach((callback) => window.__nativeRAF(callback));
  });
}

export async function paintedState(page) {
  return page.evaluate(() => {
    const d = window.__derby,
      c = d.renderer.domElement,
      p = window.__completedPaint;
    const r = c.getBoundingClientRect();
    const equal = (a, b) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) < 1e-10);
    const coherent =
      !!p &&
      p.generation === window.__paintGeneration &&
      p.frame === d.renderer.info.render.frame &&
      p.width === c.width &&
      p.height === c.height &&
      ['x', 'y', 'width', 'height'].every((k) => Math.abs(p.rect[k] - r[k]) < 0.01) &&
      Math.abs(p.aspect - d.camera.aspect) < 1e-10 &&
      Math.abs(d.camera.aspect - r.width / r.height) < 0.001 &&
      equal(p.cameraPosition, d.camera.position.toArray()) &&
      equal(p.cameraQuaternion, d.camera.quaternion.toArray()) &&
      p.roundId === d.live.current.round.id &&
      equal(p.published, d.live.current.round.positions) &&
      equal(p.displayed, d.peek().displayed) &&
      p.running === d.live.current.running &&
      p.reduced === d.live.current.reduced;
    return {
      coherent,
      held: window.__holdRAF,
      paint: p,
      currentGeneration: window.__paintGeneration,
    };
  });
}

export async function capturePaintedStage(page, path, measure = async () => ({})) {
  const attempts = [];
  try {
    for (let attempt = 0; attempt < 5; attempt++) {
      await releasePaint(page);
      await page.evaluate(() => {
        window.__captureArmed = true;
        window.__captureNextPaint = true;
      });
      await page.waitForFunction(() => !window.__captureArmed && window.__holdRAF, null, {
        polling: 100,
        timeout: 90000,
      });
      const before = await paintedState(page);
      if (!before.coherent) {
        attempts.push({ attempt, reason: 'Resize/layout changed after paint', before });
        continue;
      }
      const metadata = await measure(page);
      const png = await page.screenshot({ path, timeout: 90000 });
      const pixelProof = await page.evaluate(async (base64) => {
        const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
        const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
        const decoded = new OffscreenCanvas(bitmap.width, bitmap.height);
        const ctx = decoded.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(bitmap, 0, 0);
        const p = window.__completedPaint;
        const values = p.samples.map((s) => {
          const actual = Array.from(ctx.getImageData(s.x, s.y, 1, 1).data);
          return {
            ...s,
            screenshotRGBA: actual,
            difference: Math.max(...actual.slice(0, 3).map((v, i) => Math.abs(v - s.rgba[i]))),
          };
        });
        const unique = new Set(values.map((s) => s.rgba.slice(0, 3).join(','))).size;
        const uniqueScreenshot = new Set(values.map((s) => s.screenshotRGBA.slice(0, 3).join(',')))
          .size;
        return {
          samples: values,
          sourceUniqueRGB: unique,
          screenshotUniqueRGB: uniqueScreenshot,
          within12Ratio: values.filter((s) => s.difference <= 12).length / values.length,
          maxDifference: Math.max(...values.map((s) => s.difference)),
          actualPNG: [bitmap.width, bitmap.height],
        };
      }, png.toString('base64'));
      const after = await paintedState(page);
      const same =
        after.coherent &&
        before.paint.frame === after.paint.frame &&
        before.paint.generation === after.paint.generation;
      if (
        same &&
        pixelProof.samples.length >= 80 &&
        pixelProof.sourceUniqueRGB > 16 &&
        pixelProof.screenshotUniqueRGB > 16 &&
        pixelProof.within12Ratio >= 0.9
      ) {
        await releasePaint(page);
        return {
          metadata,
          capture: { coherent: true, attempt, before, after, pixelProof },
          attempts,
        };
      }
      const rejectedPath = `${path}.rejected-${attempt}.png`;
      await fs.writeFile(rejectedPath, png);
      attempts.push({
        attempt,
        reason: 'Paint-state or screenshot-pixel verification failed',
        rejectedPath,
        before,
        after,
        pixelProof,
      });
    }
    await releasePaint(page);
    const error = Error('No completed, nonblank, same-frame screenshot after five attempts');
    error.attempts = attempts;
    throw error;
  } finally {
    // A failed wait/measurement/screenshot must not strand the real page paused.
    if (!page.isClosed()) {
      try {
        await releasePaint(page);
      } catch (error) {
        if (!page.isClosed()) throw error;
      }
    }
  }
}
