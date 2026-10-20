// Windows over a page (Focus): moved by dragging their title bar, and made full screen (and back) with a
// button or by double-clicking the title bar. Plain DOM; the window sits in a backdrop that centres it.

import { iconButton, setIcon } from './buttons';

/** The styles for movable windows; add them to the page once. */
export const WINDOW_CSS = `
  .ve-win { will-change: transform; }
  .ve-win .ve-handle { cursor: grab; user-select: none; }
  .ve-win.moving .ve-handle { cursor: grabbing; }
  .ve-win.full { width: 100vw !important; height: 100vh !important; max-width: none !important; max-height: none !important; border-radius: 0 !important; border: 0 !important; transform: none !important; }
  .ve-win.full .ve-handle { cursor: default; }
`;

/**
 * Makes a window movable by its title bar (`handle`) and gives it a full-screen button (returned, to put in its title
 * bar). Clicks on the title bar's buttons and fields don't move it. It stays where it was left until `reset()`.
 */
export function windowControls(box: HTMLElement, handle: HTMLElement): { fullButton: HTMLButtonElement; reset(): void } {
  box.classList.add('ve-win');
  handle.classList.add('ve-handle');
  const fullButton = iconButton('maximize', 'Full screen');
  let x = 0;
  let y = 0;
  const place = () => (box.style.transform = x || y ? `translate(${x}px, ${y}px)` : '');
  const setFull = (on: boolean) => {
    box.classList.toggle('full', on);
    setIcon(fullButton, on ? 'restore' : 'maximize', on ? 'Back to a window (double-click the title bar too)' : 'Full screen (double-click the title bar too)');
    fullButton.classList.toggle('on', on);
  };
  setFull(false);
  fullButton.addEventListener('click', () => setFull(!box.classList.contains('full')));
  const onControl = (t: EventTarget | null) => !!(t as Element | null)?.closest?.('button, input, select, textarea, a, [contenteditable="true"]');
  handle.addEventListener('dblclick', (e) => {
    if (!onControl(e.target)) setFull(!box.classList.contains('full'));
  });
  let drag: { px: number; py: number; x: number; y: number } | undefined;
  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || box.classList.contains('full') || onControl(e.target)) return;
    drag = { px: e.clientX, py: e.clientY, x, y };
    handle.setPointerCapture(e.pointerId);
    box.classList.add('moving');
  });
  handle.addEventListener('pointermove', (e) => {
    if (!drag) return;
    // The title bar stays reachable: the window can't be dragged off the screen.
    const r = box.getBoundingClientRect();
    const baseLeft = r.left - x;
    const baseTop = r.top - y;
    const nx = drag.x + e.clientX - drag.px;
    const ny = drag.y + e.clientY - drag.py;
    x = Math.min(window.innerWidth - baseLeft - 80, Math.max(-baseLeft - r.width + 80, nx));
    y = Math.min(window.innerHeight - baseTop - 40, Math.max(-baseTop, ny));
    place();
  });
  const end = () => {
    drag = undefined;
    box.classList.remove('moving');
  };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
  return {
    fullButton,
    reset() {
      x = 0;
      y = 0;
      place();
      setFull(false);
    },
  };
}
