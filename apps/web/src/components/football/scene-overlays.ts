/**
 * Page overlays drawn over the 3D view (scoreboard, caption, preview controls) mark themselves
 * with `data-scene-overlay="top"` or `"bottom"` inside a container marked `data-scene-frame`.
 * The renderer composes its broadcast framing for the clear band between them, so the ball,
 * goalkeeper and goal are never hidden behind page UI.
 */
export interface SceneInsets {
  top: number;
  bottom: number;
}

/** CSS pixels of `host` covered by the marked overlays of `frame` along its top and bottom. */
export function measureSceneOverlays(host: Element, frame: ParentNode): SceneInsets {
  const view = host.getBoundingClientRect();
  if (!view.height || !view.width) return { top: 0, bottom: 0 };
  let top = 0;
  let bottom = 0;
  frame.querySelectorAll<HTMLElement>('[data-scene-overlay]').forEach((el) => {
    const r = el.getBoundingClientRect();
    // Hidden or off-view overlays do not cover the scene.
    if (!r.width || !r.height || r.bottom <= view.top || r.top >= view.bottom) return;
    if (r.right <= view.left || r.left >= view.right) return;
    if (el.dataset.sceneOverlay === 'top') top = Math.max(top, r.bottom - view.top);
    else if (el.dataset.sceneOverlay === 'bottom') bottom = Math.max(bottom, view.bottom - r.top);
  });
  const clamp = (v: number) => Math.min(view.height, Math.max(0, Math.round(v)));
  return { top: clamp(top), bottom: clamp(bottom) };
}

/**
 * Keeps `onChange` informed of the overlay insets over `host`: on resize of the view or of any
 * overlay, and when overlays are added or removed. Returns a cleanup function.
 */
export function observeSceneOverlays(
  host: HTMLElement,
  onChange: (insets: SceneInsets) => void,
  frame: Element | null = host.closest('[data-scene-frame]')
): () => void {
  if (!frame) return () => undefined;
  const update = () => onChange(measureSceneOverlays(host, frame));
  const resize = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(update) : null;
  const watch = () => {
    resize?.disconnect();
    resize?.observe(host);
    frame
      .querySelectorAll<HTMLElement>('[data-scene-overlay]')
      .forEach((el) => resize?.observe(el));
  };
  const mutation =
    typeof MutationObserver !== 'undefined'
      ? new MutationObserver(() => {
          watch();
          update();
        })
      : null;
  mutation?.observe(frame, { childList: true });
  watch();
  update();
  return () => {
    resize?.disconnect();
    mutation?.disconnect();
  };
}
