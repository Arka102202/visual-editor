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

/** Line icons (24×24, drawn with the text colour), so the bar stays small; each button names itself on hover. */
const ICONS = {
  mobile: '<rect x="7" y="2" width="10" height="20" rx="2"/><path d="M11 18h2"/>',
  tablet: '<rect x="4" y="2" width="16" height="20" rx="2"/><path d="M11 18h2"/>',
  desktop: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>',
  fit: '<path d="M3 12h18M7 8l-4 4 4 4M17 8l4 4-4 4"/>',
  light: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  dark: '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>',
  reload: '<path d="M21 12a9 9 0 1 1-2.6-6.4L21 8"/><path d="M21 3v5h-5"/>',
  popOut: '<path d="M15 3h6v6M10 14L21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  back: '<path d="M4 14h6v6M3 21l7-7M14 4v6h6M21 3l-7 7"/>',
  versions: '<rect x="3" y="7" width="13" height="13" rx="2"/><path d="M8 7V5a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-3"/>',
  choose: '<path d="M20 6L9 17l-5-5"/>',
  pictures: '<path d="M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"/><circle cx="12" cy="13.5" r="3.5"/>',
} as const;

/** An icon-only button with a name (shown on hover, read out by screen readers). */
function iconButton(icon: keyof typeof ICONS, name: string): HTMLButtonElement {
  const b = el('button', 'icon');
  setIcon(b, icon, name);
  return b;
}

function setIcon(b: HTMLElement, icon: keyof typeof ICONS, name: string) {
  b.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[icon]}</svg>`;
  b.setAttribute('aria-label', name);
  b.dataset.tip = name;
}
const GAP = 16;
const LABEL = 24;

addStyles(`
  body { display: flex; flex-direction: column; }
  /* One line always: when the space is too small the bar scrolls sideways; nothing in it changes shape. */
  .bar { display: flex; align-items: center; gap: 8px; padding: 0 12px; height: 44px; flex: none; border-bottom: 1px solid var(--vscode-panel-border, #8883); overflow-x: auto; overflow-y: hidden; white-space: nowrap; scrollbar-width: thin; }
  .bar::-webkit-scrollbar { height: 4px; }
  .bar::-webkit-scrollbar-thumb { background: var(--vscode-scrollbarSlider-background, #8886); border-radius: 2px; }
  .bar > * { flex: none; }
  .title { font-weight: 600; }
  .bar > .sub { font-size: 12px; opacity: .65; overflow: hidden; text-overflow: ellipsis; flex: 0 1 auto; min-width: 40px; max-width: 280px; }
  .bar > .spacer { flex: 1 0 0; min-width: 0; }
  .group { display: flex; border-radius: 5px; overflow: hidden; }
  .group button { border-radius: 0; }
  button.icon { display: inline-flex; align-items: center; justify-content: center; width: 30px; height: 26px; padding: 0; flex: none; }
  button.icon svg { display: block; }
  .group button.on, button.icon.on { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
  select { color: var(--vscode-dropdown-foreground); background: var(--vscode-dropdown-background); border: 1px solid var(--vscode-dropdown-border, #8884); border-radius: 4px; padding: 3px 6px; height: 26px; }
  .tip { position: fixed; z-index: 10; pointer-events: none; padding: 3px 7px; border-radius: 4px; font-size: 12px; white-space: nowrap; color: var(--vscode-editorHoverWidget-foreground, var(--vscode-foreground)); background: var(--vscode-editorHoverWidget-background, #252526); border: 1px solid var(--vscode-editorHoverWidget-border, #8886); box-shadow: 0 2px 8px #0004; }
  .stage { flex: 1; position: relative; overflow: hidden; padding: ${GAP}px; display: flex; gap: ${GAP}px; justify-content: center; }
  .frame { display: flex; flex-direction: column; min-width: 0; flex: none; }
  .frame .label { height: ${LABEL}px; display: flex; align-items: center; gap: 8px; font-size: 11px; white-space: nowrap; overflow: hidden; }
  .frame .label .name { font-weight: 600; letter-spacing: .05em; text-transform: uppercase; opacity: .65; overflow: hidden; text-overflow: ellipsis; flex: 0 1 auto; min-width: 40px; max-width: 60%; }
  .frame .label .checks { opacity: .8; overflow: hidden; text-overflow: ellipsis; cursor: help; flex: 1 1 0; min-width: 0; }
  .frame .label .checks.bad { color: var(--vscode-editorWarning-foreground, #d9a400); }
  .frame .label button.icon { width: 24px; height: 20px; margin-left: auto; flex: none; }
  .tip { white-space: pre-line; max-width: 360px; }
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
situationPick.dataset.tip = 'Situation';
const sizes = el('div', 'group');
const themes = el('div', 'group');
const versionsButton = iconButton('versions', 'Versions: show the other versions side by side');
versionsButton.hidden = true;
versionsButton.addEventListener('click', () => vscode.postMessage({ type: 'versions', on: !last?.comparing }));
const picturesButton = iconButton('pictures', 'Pictures: save what is shown at mobile, tablet and desktop size');
picturesButton.addEventListener('click', () => vscode.postMessage({ type: 'pictures' }));
const reload = iconButton('reload', 'Reload: draw it again');
const windowButton = iconButton('popOut', 'Pop out');
windowButton.addEventListener('click', () => vscode.postMessage({ type: 'window' }));
bar.append(title, sub, el('span', 'spacer'), situationPick, versionsButton, sizes, themes, picturesButton, reload, windowButton);

// Hover names: right away, below the button, kept on screen (a title tooltip is slow and the bar would clip one).
const tip = el('div', 'tip');
tip.hidden = true;
document.body.append(tip);
document.addEventListener('mouseover', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('[data-tip]');
  if (!b) return void (tip.hidden = true);
  tip.textContent = b.dataset.tip ?? '';
  tip.hidden = false;
  const r = b.getBoundingClientRect();
  tip.style.top = `${r.bottom + 6}px`;
  tip.style.left = `${Math.max(4, Math.min(window.innerWidth - tip.offsetWidth - 4, r.left + r.width / 2 - tip.offsetWidth / 2))}px`;
});
document.addEventListener('mouseleave', () => (tip.hidden = true));
bar.addEventListener('scroll', () => (tip.hidden = true));
const stage = el('div', 'stage');
const drawingNote = el('div', 'drawing', 'Drawing…');
drawingNote.hidden = true;
document.body.append(bar, stage, drawingNote);

let last: Extract<ToPreview, { type: 'show' }> | undefined;
let boxes: { box: HTMLElement; frame: Frame }[] = [];
let sentWidth = 0;

for (const size of ['mobile', 'tablet', 'desktop', 'fit'] as Size[]) {
  const b = iconButton(size, size === 'fit' ? 'Fit: as wide as the space here' : `${SIZE_WORDS[size]}: ${WIDTHS[size as Exclude<Size, 'fit'>]} px wide`);
  b.dataset.size = size;
  b.addEventListener('click', () => vscode.postMessage({ type: 'size', size, width: fitWidth() }));
  sizes.append(b);
}
for (const theme of ['light', 'dark'] as const) {
  const b = iconButton(theme, theme === 'light' ? 'Light' : 'Dark');
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
    // The frame (and its label) exactly as wide as its box, so long labels never push frames into each other.
    if (box.parentElement) box.parentElement.style.width = box.style.width;
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
  setIcon(windowButton, m.floating ? 'back' : 'popOut', m.floating ? 'Back into the main window' : 'Pop out: its own window (full screen, or another screen)');
  sub.textContent = m.sub ?? '';
  situationPick.replaceChildren(...m.situations.map((s) => Object.assign(el('option', undefined, s), { value: s, selected: s === m.situation })));
  situationPick.hidden = m.situations.length < 2;
  versionsButton.hidden = !m.versions;
  versionsButton.classList.toggle('on', m.comparing);
  versionsButton.dataset.tip = m.comparing ? 'Versions: back to just this card' : `Versions: show the ${m.versions} other version${m.versions === 1 ? '' : 's'} side by side`;
  for (const b of sizes.querySelectorAll('button')) b.classList.toggle('on', b.dataset.size === m.size);
  for (const b of themes.querySelectorAll('button')) b.classList.toggle('on', b.dataset.theme === m.theme);
  // Keep the boxes (and their frames) when only the content changed, so the swap is smooth.
  if (!sameShape) {
    stage.replaceChildren();
    boxes = m.frames.map((frame) => {
      const wrap = el('div', 'frame');
      if (frame.label) wrap.append(el('div', 'label'));
      const box = el('div', 'box');
      wrap.append(box);
      stage.append(wrap);
      return { box, frame };
    });
  }
  m.frames.forEach((frame, i) => {
    const { box } = boxes[i];
    // Its label: the name, what the checks found (hover for each), and for a version, a button to choose it.
    const label = box.parentElement?.querySelector<HTMLElement>('.label');
    if (label) {
      const name = el('span', 'name', frame.label ?? '');
      if (frame.notes) name.dataset.tip = frame.notes;
      label.replaceChildren(name);
      if (frame.checks) {
        const c = el('span', `checks${frame.checks.problems ? ' bad' : ''}`, frame.checks.summary);
        c.dataset.tip = frame.checks.items.map((x) => `${x.ok ? '✓' : '⚠'} ${x.text}${x.line ? ` (line ${x.line})` : ''}`).join('\n') || frame.checks.summary;
        label.append(c);
      }
      if (frame.version) {
        const pick = iconButton('choose', `Choose ${frame.label}: make it the real one (shown in Review first)`);
        pick.addEventListener('click', () => vscode.postMessage({ type: 'choose', version: frame.version! }));
        label.append(pick);
      }
    }
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
  // A preview page talking (from inside a frame): passed on to the shell.
  const d = e.data as unknown as Record<string, unknown> | undefined;
  if (d && typeof d === 'object' && d.source === 'visual-editor-preview') {
    vscode.postMessage({ type: 'frame', data: d });
    return;
  }
  if (e.data?.type === 'show') show(e.data);
  else if (e.data?.type === 'drawing') drawingNote.hidden = false;
});
vscode.postMessage({ type: 'size', size: 'fit', width: fitWidth() });
vscode.postMessage({ type: 'ready' });
