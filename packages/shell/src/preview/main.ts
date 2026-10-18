// The Preview page: a bar (situations, sizes, light and dark, reload) and one frame (or Before and After side by side).
// A frame is drawn at its real width and scaled down to fit, never stretched by its own content; a new drawing loads
// behind the old one and replaces it only when ready, so nothing flickers. Plain DOM, no framework.

import type { Size } from '../previews';
import type { Frame, FromPreview, ToPreview } from '../previewMessages';
import { addStyles, el } from '../ui/dom';

declare function acquireVsCodeApi(): { postMessage(message: FromPreview): void };
const vscode = acquireVsCodeApi();

const WIDTHS: Record<Exclude<Size, 'fit'>, number> = { mobile: 375, tablet: 768, desktop: 1280 };
const SIZE_WORDS: Record<Size, string> = { mobile: 'Mobile', tablet: 'Tablet', desktop: 'Desktop', fit: 'Fit' };
const GAP = 16;
const LABEL = 24;

addStyles(`
  body { display: flex; flex-direction: column; }
  .bar { display: flex; align-items: center; gap: 8px; padding: 0 12px; height: 44px; flex: none; border-bottom: 1px solid var(--vscode-panel-border, #8883); overflow: hidden; }
  .title { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .sub { font-size: 12px; opacity: .65; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1; min-width: 0; }
  .group { display: flex; border-radius: 5px; overflow: hidden; flex: none; }
  .group button { border-radius: 0; padding: 3px 9px; }
  .group button.on { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
  select { color: var(--vscode-dropdown-foreground); background: var(--vscode-dropdown-background); border: 1px solid var(--vscode-dropdown-border, #8884); border-radius: 4px; padding: 3px 6px; }
  .stage { flex: 1; position: relative; overflow: hidden; padding: ${GAP}px; display: flex; gap: ${GAP}px; justify-content: center; }
  .frame { display: flex; flex-direction: column; min-width: 0; }
  .frame .label { height: ${LABEL}px; font-size: 11px; font-weight: 600; letter-spacing: .05em; text-transform: uppercase; opacity: .65; }
  .box { position: relative; overflow: hidden; border-radius: 6px; border: 1px solid var(--vscode-panel-border, #8884); background: #fff; }
  .box.dark { background: #1e1e1e; }
  .box iframe { position: absolute; left: 0; top: 0; border: 0; transform-origin: 0 0; background: transparent; }
  .box iframe.waiting { visibility: hidden; }
  .error { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; text-align: center; padding: 16px; color: var(--vscode-errorForeground, #e55); background: var(--vscode-editor-background); font-size: 13px; }
  .drawing { position: absolute; top: ${GAP + 6}px; right: ${GAP + 6}px; font-size: 11px; opacity: .6; }
`);

const bar = el('div', 'bar');
const title = el('span', 'title');
const sub = el('span', 'sub');
const situationPick = el('select');
situationPick.title = 'Situation';
const sizes = el('div', 'group');
const themes = el('div', 'group');
const reload = el('button', undefined, 'Reload');
reload.title = 'Draw it again';
bar.append(title, sub, situationPick, sizes, themes, reload);
const stage = el('div', 'stage');
const drawingNote = el('div', 'drawing', 'Drawing…');
drawingNote.hidden = true;
document.body.append(bar, stage, drawingNote);

let last: Extract<ToPreview, { type: 'show' }> | undefined;
let boxes: { box: HTMLElement; frame: Frame }[] = [];
let sentWidth = 0;

for (const size of ['mobile', 'tablet', 'desktop', 'fit'] as Size[]) {
  const b = el('button', undefined, SIZE_WORDS[size]);
  b.dataset.size = size;
  b.title = size === 'fit' ? 'As wide as the space here' : `${WIDTHS[size as Exclude<Size, 'fit'>]} px wide`;
  b.addEventListener('click', () => vscode.postMessage({ type: 'size', size, width: fitWidth() }));
  sizes.append(b);
}
for (const theme of ['light', 'dark'] as const) {
  const b = el('button', undefined, theme === 'light' ? 'Light' : 'Dark');
  b.dataset.theme = theme;
  b.addEventListener('click', () => vscode.postMessage({ type: 'theme', theme }));
  themes.append(b);
}
situationPick.addEventListener('change', () => vscode.postMessage({ type: 'situation', name: situationPick.value }));
reload.addEventListener('click', () => vscode.postMessage({ type: 'reload' }));

/** The width one frame gets on screen (frames share the space). */
function fitWidth(): number {
  const n = Math.max(1, last?.frames.length ?? 1);
  return Math.max(200, Math.floor((stage.clientWidth - GAP * 2 - GAP * (n - 1)) / n));
}

/** Sizes each frame: drawn at its real width, scaled down to fit; its height fills the space at that scale. */
function layout() {
  if (!last) return;
  const avail = fitWidth();
  const height = Math.max(120, stage.clientHeight - GAP * 2 - (boxes.some((b) => b.frame.label) ? LABEL : 0));
  const width = last.size === 'fit' ? avail : WIDTHS[last.size];
  const scale = Math.min(1, avail / width);
  for (const { box } of boxes) {
    box.style.width = `${Math.round(width * scale)}px`;
    box.style.height = `${height}px`;
    for (const f of box.querySelectorAll('iframe')) {
      f.style.width = `${width}px`;
      f.style.height = `${Math.round(height / scale)}px`;
      f.style.transform = `scale(${scale})`;
    }
  }
}

/** Shows a page in a box: the new frame loads hidden behind the old one, then takes its place. */
function load(box: HTMLElement, url: string, own: boolean) {
  const old = box.querySelector('iframe:not(.waiting)');
  if (old?.getAttribute('src') === url) return;
  const frame = el('iframe', 'waiting');
  // Scripts run, but apart: a plugin's HTML gets no origin at all; a dev server page keeps its own. Neither can
  // reach VS Code or this page.
  frame.setAttribute('sandbox', own ? 'allow-scripts allow-forms' : 'allow-scripts allow-forms allow-same-origin');
  frame.title = 'Preview';
  frame.addEventListener('load', () => {
    for (const f of box.querySelectorAll('iframe')) if (f !== frame) f.remove();
    frame.classList.remove('waiting');
    vscode.postMessage({ type: 'shown', frames: stage.querySelectorAll('iframe:not(.waiting)').length });
  });
  frame.src = url;
  box.append(frame);
  layout();
}

function show(m: Extract<ToPreview, { type: 'show' }>) {
  const shape = (x?: typeof last) => (x ? x.frames.map((f) => f.label ?? '').join('|') : '');
  const sameShape = !!last && boxes.length === m.frames.length && shape(last) === shape(m);
  last = m;
  drawingNote.hidden = true;
  title.textContent = m.title;
  sub.textContent = m.sub ?? '';
  situationPick.replaceChildren(...m.situations.map((s) => Object.assign(el('option', undefined, s), { value: s, selected: s === m.situation })));
  situationPick.hidden = m.situations.length < 2;
  for (const b of sizes.querySelectorAll('button')) b.classList.toggle('on', b.dataset.size === m.size);
  for (const b of themes.querySelectorAll('button')) b.classList.toggle('on', b.dataset.theme === m.theme);
  // Keep the boxes (and their frames) when only the content changed, so the swap is smooth.
  if (!sameShape) {
    stage.replaceChildren();
    boxes = m.frames.map((frame) => {
      const wrap = el('div', 'frame');
      if (frame.label) wrap.append(el('div', 'label', frame.label));
      const box = el('div', 'box');
      wrap.append(box);
      stage.append(wrap);
      return { box, frame };
    });
  }
  m.frames.forEach((frame, i) => {
    const { box } = boxes[i];
    boxes[i].frame = frame;
    box.classList.toggle('dark', m.theme === 'dark');
    box.querySelector('.error')?.remove();
    if (frame.url) load(box, frame.url, !!frame.own);
    else {
      for (const f of box.querySelectorAll('iframe')) f.remove();
      box.append(el('div', 'error', frame.error ?? 'Nothing to show.'));
    }
  });
  layout();
  if (m.size === 'fit') sentWidth = fitWidth();
}

// The space changed: lay out again; with Fit, the plugin draws for the new width (only when it changed enough).
new ResizeObserver(() => {
  layout();
  if (last?.size === 'fit' && Math.abs(fitWidth() - sentWidth) > 24) {
    sentWidth = fitWidth();
    vscode.postMessage({ type: 'size', size: 'fit', width: sentWidth });
  }
}).observe(stage);

window.addEventListener('message', (e: MessageEvent<ToPreview>) => {
  if (e.data?.type === 'show') show(e.data);
  else if (e.data?.type === 'drawing') drawingNote.hidden = false;
});
vscode.postMessage({ type: 'size', size: 'fit', width: fitWidth() });
vscode.postMessage({ type: 'ready' });
