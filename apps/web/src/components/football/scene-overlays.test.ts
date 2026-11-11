import { afterEach, describe, expect, it, vi } from 'vitest';
import { measureSceneOverlays, observeSceneOverlays } from './scene-overlays';

type Box = { top: number; bottom: number; left?: number; right?: number };
function place(el: Element, box: Box) {
  const { top, bottom, left = 0, right = 360 } = box;
  vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({
    top,
    bottom,
    left,
    right,
    width: right - left,
    height: bottom - top,
    x: left,
    y: top,
    toJSON: () => ({}),
  } as DOMRect);
}
function stage() {
  const frame = document.createElement('div');
  frame.setAttribute('data-scene-frame', '');
  const host = document.createElement('div');
  const board = document.createElement('div');
  board.dataset.sceneOverlay = 'top';
  const caption = document.createElement('div');
  caption.dataset.sceneOverlay = 'bottom';
  frame.append(host, board, caption);
  document.body.append(frame);
  // A 360x260 view at y=100 with a 78px scoreboard and a caption 68px from the bottom.
  place(host, { top: 100, bottom: 360 });
  place(board, { top: 108, bottom: 178 });
  place(caption, { top: 292, bottom: 352 });
  return { frame, host, board, caption };
}
afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe('scene overlays', () => {
  it('measures how far the marked overlays reach into the view', () => {
    const { frame, host } = stage();
    expect(measureSceneOverlays(host, frame)).toEqual({ top: 78, bottom: 68 });
  });

  it('ignores hidden overlays and overlays outside the view', () => {
    const { frame, host, board, caption } = stage();
    place(board, { top: 0, bottom: 0, left: 0, right: 0 });
    place(caption, { top: 400, bottom: 440 });
    expect(measureSceneOverlays(host, frame)).toEqual({ top: 0, bottom: 0 });
  });

  it('never reports more than the view height', () => {
    const { frame, host, board } = stage();
    place(board, { top: 0, bottom: 900 });
    expect(measureSceneOverlays(host, frame).top).toBe(260);
  });

  it('reports insets at once and again when overlays are added, then stops cleanly', async () => {
    const { frame, host } = stage();
    const seen: Array<{ top: number; bottom: number }> = [];
    const stop = observeSceneOverlays(host, (insets) => seen.push(insets));
    expect(seen).toEqual([{ top: 78, bottom: 68 }]);
    const label = document.createElement('div');
    label.dataset.sceneOverlay = 'top';
    place(label, { top: 100, bottom: 200 });
    frame.append(label);
    await Promise.resolve();
    expect(seen.at(-1)).toEqual({ top: 100, bottom: 68 });
    stop();
    const count = seen.length;
    frame.append(document.createElement('div'));
    await Promise.resolve();
    expect(seen).toHaveLength(count);
  });

  it('does nothing outside a scene frame', () => {
    const host = document.createElement('div');
    const onChange = vi.fn();
    observeSceneOverlays(host, onChange)();
    expect(onChange).not.toHaveBeenCalled();
  });
});
