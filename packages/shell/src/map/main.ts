// The map page inside the editor tab: draws the cards and lines the shell laid out. Drag the background to move
// around, pinch or Ctrl+scroll to zoom, double-click a card to open its code. Plain DOM, no framework.
// Built to stay smooth with tens of thousands of cards: only the cards on screen exist as elements (zoomed in);
// folder boxes, lines and (zoomed out) the cards themselves are painted on one canvas the size of the screen, which
// the GPU draws. Moving around only paints what's in view.

import type { Layout, PlacedCard } from '../layout';
import { MAX_FIELDS } from '../layout';
import type { CardMemory, FromMap, ShowMap, ToMap } from '../mapMessages';
import type { Item } from '@visual-editor/contract';
import type { MemoryEntry } from '../memory';
import { addStyles, ago, el } from '../ui/dom';
import type { Tone } from '../styles';

declare function acquireVsCodeApi(): { postMessage(message: FromMap): void };
const vscode = acquireVsCodeApi();

addStyles(`
  /* One line always: when the space is too small the bar scrolls sideways; nothing in it wraps or changes shape. */
  .bar { position: absolute; inset: 0 0 auto 0; height: 40px; display: flex; align-items: center; gap: 8px; padding: 0 12px; border-bottom: 1px solid var(--vscode-panel-border, #8883); background: var(--vscode-editor-background); z-index: 2; overflow-x: auto; overflow-y: hidden; white-space: nowrap; scrollbar-width: thin; }
  .bar::-webkit-scrollbar { height: 4px; }
  .bar::-webkit-scrollbar-thumb { background: var(--vscode-scrollbarSlider-background, #8886); border-radius: 2px; }
  .bar > * { flex: none; }
  .bar select, .bar button { font: inherit; color: var(--vscode-dropdown-foreground); background: var(--vscode-dropdown-background); border: 1px solid var(--vscode-dropdown-border, #8884); border-radius: 4px; padding: 3px 8px; }
  .bar button { cursor: pointer; color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); border-color: transparent; }
  .bar .name { font-weight: 600; }
  .bar .chips { display: flex; gap: 4px; }
  .bar > .tabs { display: flex; gap: 2px; flex: 1 0 auto; margin-left: 8px; }
  .tabs button { background: transparent; color: var(--vscode-foreground); opacity: .7; padding: 3px 10px; border-radius: 4px; white-space: nowrap; }
  .tabs button.on { opacity: 1; background: var(--vscode-toolbar-activeBackground, #8883); font-weight: 600; }
  .tabs button .n { opacity: .6; font-weight: normal; margin-left: 4px; }
  .bar input.find { width: 150px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, #8884); border-radius: 4px; padding: 3px 8px; font: inherit; }
  /* A card chosen: the cards it has no line to step back. */
  .world.picked .card { opacity: .25; }
  .world.picked .card.near { opacity: 1; }
  .zoom { font-size: 11px; opacity: .7; min-width: 36px; text-align: right; }
  .stage { position: absolute; inset: 40px 0 0 0; overflow: hidden; cursor: grab; touch-action: none; }
  .stage.dragging { cursor: grabbing; }
  .world { position: absolute; left: 0; top: 0; transform-origin: 0 0; }
  .sky { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }
  /* Folder names float above the map at reading size, pinned to their box (they don't scale with it). */
  .labels { position: absolute; inset: 0; pointer-events: none; overflow: hidden; }
  .labels .tag { position: absolute; font-size: 12px; font-weight: 700; padding: 2px 8px; border-radius: 6px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; background: color-mix(in srgb, var(--vscode-editor-background) 85%, transparent); transform: translateY(-50%); }
  .card .strip { position: absolute; left: 0; top: 0; bottom: 0; width: 5px; }
  .card .head, .card .field { padding-left: 16px !important; }
  .card .used { font-size: 10px; padding: 0 6px; border-radius: 6px; background: color-mix(in srgb, var(--vscode-foreground) 12%, transparent); white-space: nowrap; }
  .card.busy .label { font-weight: 700; }
  .card.lonely { opacity: .55; }
  .legend { position: absolute; left: 12px; bottom: 12px; z-index: 2; display: flex; flex-wrap: wrap; gap: 6px 14px; max-width: 60%; padding: 8px 12px; border-radius: 8px; font-size: 11px; background: color-mix(in srgb, var(--vscode-editor-background) 88%, transparent); border: 1px solid var(--vscode-panel-border, #8883); }
  .legend .k { display: inline-flex; align-items: center; gap: 5px; white-space: nowrap; }
  .legend .dot { width: 10px; height: 10px; border-radius: 3px; }
  .legend .ln { width: 18px; height: 3px; border-radius: 2px; }
  .legend .n { opacity: .6; }
  .legend .k, .card .kind { cursor: help; }
  .tip { position: fixed; z-index: 10; max-width: 280px; padding: 8px 11px; border-radius: 8px; font-size: 12px; line-height: 1.45; pointer-events: none; background: var(--vscode-editorHoverWidget-background, #252526); color: var(--vscode-editorHoverWidget-foreground, inherit); border: 1px solid var(--vscode-editorHoverWidget-border, #8885); box-shadow: 0 4px 14px #0006; }
  .tip .tt { display: flex; align-items: center; gap: 6px; font-weight: 700; margin-bottom: 3px; }
  .tip .sw { width: 10px; height: 10px; border-radius: 3px; flex: none; }
  .tip .sw.line { height: 3px; width: 16px; border-radius: 2px; }
  .tip .ct { opacity: .65; margin-top: 4px; }
  .arrange { display: flex; border-radius: 5px; overflow: hidden; flex: none; }
  .bar .arrange button { border-radius: 0; padding: 3px 9px; }
  .bar .arrange button.on { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
  .card { position: absolute; box-sizing: border-box; border-radius: 8px; background: var(--vscode-editorWidget-background, #2a2a2a); border: 1px solid var(--vscode-editorWidget-border, #8884); box-shadow: 0 1px 3px #0003; cursor: default; overflow: hidden; }
  .card.proposed { border: 2px solid #d9a400; }
  .card.changed { border: 2px solid #2f6fdb; }
  .card .mark { font-size: 10px; font-weight: 600; padding: 0 6px; border-radius: 6px; }
  .card.proposed .mark { background: #d9a400; color: #1e1e1e; }
  .card.changed .mark { background: #2f6fdb; color: #fff; }
  .bar .chip.proposed, .bar .chip.changed { cursor: pointer; border: 0; font: inherit; font-size: 11px; padding: 1px 8px; }
  .drawer { position: absolute; top: 40px; right: 0; bottom: 0; width: 300px; box-sizing: border-box; padding: 16px; overflow-y: auto; background: var(--vscode-sideBar-background, var(--vscode-editor-background)); border-left: 1px solid var(--vscode-panel-border, #8883); z-index: 3; }
  .drawer h2 { font-size: 15px; margin: 0 24px 2px 0; word-break: break-word; }
  .drawer .close { position: absolute; top: 10px; right: 10px; padding: 2px 8px; }
  .drawer .sub { font-size: 12px; opacity: .7; margin-bottom: 12px; word-break: break-all; }
  .drawer .buttons { display: flex; gap: 6px; margin-bottom: 14px; flex-wrap: wrap; }
  .drawer h3 { font-size: 11px; font-weight: 600; letter-spacing: .05em; text-transform: uppercase; opacity: .6; margin: 16px 0 6px; }
  .drawer .entry { padding: 7px 9px; border-radius: 6px; background: var(--vscode-editorWidget-background, #8881); margin-bottom: 6px; font-size: 12px; }
  .drawer .entry.link { cursor: pointer; }
  .drawer .entry.link:hover { outline: 1px solid var(--vscode-focusBorder, #39f); }
  .drawer .entry .t { font-weight: 600; font-size: 13px; }
  .drawer .entry .d { opacity: .85; margin-top: 2px; }
  .drawer .entry .m { opacity: .6; margin-top: 3px; font-size: 11px; }
  .drawer .none { font-size: 12px; opacity: .6; }
  .card.selected { border-color: var(--vscode-foreground); box-shadow: 0 0 0 2px var(--vscode-foreground); }
  .card .head { padding: 8px 12px 6px; border-bottom: 1px solid #8882; height: 56px; box-sizing: border-box; }
  .card .top { display: flex; align-items: center; gap: 6px; }
  .card .label { font-weight: 600; flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .card .kind { font-size: 10px; text-transform: uppercase; letter-spacing: .05em; opacity: .6; }
  .card .sub { font-size: 11px; opacity: .65; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .card .fields { padding: 4px 0; }
  .card .field { display: flex; gap: 6px; height: 22px; align-items: center; padding: 0 12px; font-size: 12px; }
  .card .field .n { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .card .field .v { opacity: .65; font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 50%; }
  .card .field .t { font-size: 10px; padding: 0 5px; border-radius: 6px; background: #8883; }
  .card .more { opacity: .6; font-style: italic; }
  .empty { position: absolute; inset: 40px 0 0 0; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; padding: 24px; gap: 6px; }
  .empty h2 { margin: 0; font-size: 16px; font-weight: 600; }
  .empty p { margin: 0; opacity: .7; max-width: 420px; }
`);

// The page: a bar on top, the stage below, and a message for when there's nothing to draw.
const bar = el('div', 'bar');
const picker = el('select');
picker.title = 'Choose the project to show';
const projectName = el('span', 'name');
const chips = el('div', 'chips');
const zoomText = el('span', 'zoom');
const fitButton = el('button', undefined, 'Fit');
fitButton.title = 'Show the whole map';
const proposedBadge = el('button', 'chip proposed');
proposedBadge.title = 'Changes waiting for your OK: open Review';
const changedBadge = el('button', 'chip changed');
changedBadge.title = 'Cards whose code changed outside review (by hand, a formatter, git…). Click to clear the marks.';
const tabs = el('div', 'tabs');
const find = el('input', 'find');
find.placeholder = 'Find a card…';
find.title = 'Type part of a name; Enter goes to the next match';
const arrangeGroup = el('div', 'arrange');
/** How each arrangement places the cards, and when it helps (shown on hover). */
const ARRANGE_HELP = {
  flow: 'Cards in columns that follow their lines, left to right: a component on the left, what it draws to its right, and so on. Best for following how one part leads to the next. Cards with no lines sit in a grid below.',
  folders: 'Cards grouped by the folder their file is in, one tinted box per folder (like "Editor › InspectorPanel"). Best for seeing the parts of the app at a glance. Lines still join the cards across boxes.',
} as const;
const arrangeButtons: [HTMLButtonElement, keyof typeof ARRANGE_HELP][] = [];
for (const [mode, words] of [['flow', 'Flow'], ['folders', 'Folders']] as const) {
  const b = el('button', undefined, words);
  b.dataset.mode = mode;
  b.addEventListener('click', () => vscode.postMessage({ type: 'arrange', arrange: mode }));
  arrangeGroup.append(b);
  arrangeButtons.push([b, mode]);
}
const windowButton = el('button', undefined, '⤢');
windowButton.addEventListener('click', () => vscode.postMessage({ type: 'window' }));
bar.append(picker, projectName, chips, tabs, find, arrangeGroup, proposedBadge, changedBadge, zoomText, fitButton, windowButton);
const legend = el('div', 'legend');
const tip = el('div', 'tip');
tip.hidden = true;
let meanings: ShowMap['meanings'] = { cards: {}, lines: {} };

/** A small popup above (or below) an element: what a colour means, in plain words. */
function hint(target: HTMLElement, what: { name: string; text: string; colour?: string; line?: boolean; count?: string }) {
  target.addEventListener('mouseenter', () => {
    tip.replaceChildren();
    const head = el('div', 'tt');
    if (what.colour) {
      const sw = el('span', what.line ? 'sw line' : 'sw');
      sw.style.background = what.colour;
      head.append(sw);
    }
    head.append(el('span', undefined, what.name));
    tip.append(head, el('div', undefined, what.text));
    if (what.count) tip.append(el('div', 'ct', what.count));
    tip.hidden = false;
    const r = target.getBoundingClientRect();
    const t = tip.getBoundingClientRect();
    const left = Math.min(Math.max(8, r.left + r.width / 2 - t.width / 2), window.innerWidth - t.width - 8);
    const above = r.top - t.height - 8;
    Object.assign(tip.style, { left: `${left}px`, top: `${above > 8 ? above : r.bottom + 8}px` });
  });
  target.addEventListener('mouseleave', () => (tip.hidden = true));
}

for (const [b, mode] of arrangeButtons) hint(b, { name: mode === 'flow' ? 'Flow' : 'Folders', text: ARRANGE_HELP[mode], count: 'Click to arrange the map this way' });

const cardMeaning = (kind: string) => meanings.cards[kind] ?? `Cards the plugin calls “${kind}”.`;
const lineMeaning = (kind: string) => meanings.lines[kind] ?? `Lines the plugin calls “${kind}”.`;
const stage = el('div', 'stage');
const sky = el('canvas', 'sky');
const world = el('div', 'world');
const labels = el('div', 'labels');
stage.append(sky, world, labels);
/** Folder names, with the box each is pinned to. */
let tags: { el: HTMLElement; x: number; y: number; w: number }[] = [];
const empty = el('div', 'empty');
const emptyTitle = el('h2');
const emptyDetail = el('p');
empty.append(emptyTitle, emptyDetail);
const drawer = el('div', 'drawer');
drawer.hidden = true;
document.body.append(bar, stage, empty, drawer, legend, tip);

// The view: moved by (x, y), zoomed by k.
let view = { x: 40, y: 40, k: 1 };
let layout: Layout = { sections: [], links: [], width: 0, height: 0 };
/** The project and map last fitted; a new one starts fitted, updates to the same one keep the view. */
let shownKey: string | undefined;
/** The colour of a tone for the current theme (VS Code marks the page's body with it). */
const paint = (t: Tone | undefined) => (t ? (document.body.classList.contains('vscode-light') ? t.light : t.dark) : undefined);

/** Below this zoom, cards show only their names. */
const FAR = 0.55;
/** As far out as the map goes (a very big map may go further, to fit). */
const MIN_ZOOM = 0.08;
let minZoom = MIN_ZOOM;
let selected: string | undefined;
let marks: ShowMap['marks'] = {};
let colours: ShowMap['colours'] = { cards: {}, lines: {} };
let used: ShowMap['usedBy'] = {};
/** Cards with at least one line. */
let linked = new Set<string>();
/** Used by this many cards or more: the card stands out. */
const BUSY = 3;
/** Cards that exist as elements now (the ones on screen, zoomed in). */
const cardEls = new Map<string, HTMLElement>();
/** Every placed card, by id; the lines touching each card; which folder each is in; and a grid to find cards by place. */
let placedById = new Map<string, PlacedCard>();
let linksOf = new Map<string, Layout['links']>();
let sectionOf = new Map<string, number>();
const CELL = 600;
let grid = new Map<string, PlacedCard[]>();
/** Above this many lines, a zoomed-out map joins the lines between two folders into one. */
const MAX_FAR_LINES = 3000;
/** Never more card elements than this at once (zoomed in on a huge screen). */
const MAX_CARD_ELEMENTS = 1500;

function applyView() {
  world.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.k})`;
  world.classList.toggle('far', view.k < FAR);
  for (const t of tags) {
    // A folder's name shows once its box is big enough on screen to belong to it.
    t.el.hidden = t.w * view.k < 70;
    if (!t.el.hidden) Object.assign(t.el.style, { left: `${view.x + t.x * view.k + 8}px`, top: `${view.y + t.y * view.k}px`, maxWidth: `${Math.max(60, t.w * view.k - 16)}px` });
  }
  zoomText.textContent = `${Math.round(view.k * 100)}%`;
  requestRender();
}

let renderQueued = false;
/** Paints once per frame, however many moves came in. */
function requestRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    render();
  });
}

/** The part of the map on screen, in map units, with a margin. */
function inView(margin = 0) {
  const k = view.k;
  return { x0: -view.x / k - margin / k, y0: -view.y / k - margin / k, x1: (stage.clientWidth - view.x) / k + margin / k, y1: (stage.clientHeight - view.y) / k + margin / k };
}
const meets = (c: { x: number; y: number; w: number; h: number }, r: ReturnType<typeof inView>) => c.x < r.x1 && c.x + c.w > r.x0 && c.y < r.y1 && c.y + c.h > r.y0;

/** Cards in (or near) a part of the map, from the grid. */
function cardsIn(r: ReturnType<typeof inView>): PlacedCard[] {
  const out = new Set<PlacedCard>();
  for (let gx = Math.floor(r.x0 / CELL); gx <= Math.floor(r.x1 / CELL); gx++) {
    for (let gy = Math.floor(r.y0 / CELL); gy <= Math.floor(r.y1 / CELL); gy++) {
      for (const c of grid.get(`${gx},${gy}`) ?? []) if (meets(c, r)) out.add(c);
    }
  }
  return [...out];
}

function render() {
  const near = view.k >= FAR;
  syncCards(near ? cardsIn(inView(300)).slice(0, MAX_CARD_ELEMENTS) : []);
  paintSky(near);
}

/** Card elements for the cards on screen: the ones that left are removed, the ones that came are made. */
function syncCards(wanted: PlacedCard[]) {
  const keep = new Set(wanted.map((c) => c.item.id));
  for (const [id, card] of cardEls) {
    if (!keep.has(id)) {
      card.remove();
      cardEls.delete(id);
    }
  }
  const nearIds = nearSet();
  for (const c of wanted) {
    if (cardEls.has(c.item.id)) continue;
    const card = drawCard(c);
    if (c.item.id === selected) card.classList.add('selected');
    if (nearIds.has(c.item.id)) card.classList.add('near');
    cardEls.set(c.item.id, card);
    world.append(card);
  }
}

/** The chosen card and the cards it has a line to. */
function nearSet(): Set<string> {
  if (!selected) return new Set();
  return new Set([selected, ...(linksOf.get(selected) ?? []).flatMap((l) => [l.from, l.to])]);
}

/** Theme colours the canvas needs (read from the page, so they follow VS Code's theme). */
let ink = { fg: '#ccc', widget: '#2a2a2a', border: '#8884', bg: '#1e1e1e', text: '#ddd' };
function readInk() {
  const css = getComputedStyle(document.body);
  const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  ink = { fg: v('--vscode-foreground', '#ccc'), widget: v('--vscode-editorWidget-background', '#2a2a2a'), border: v('--vscode-editorWidget-border', '#8884'), bg: v('--vscode-editor-background', '#1e1e1e'), text: v('--vscode-editor-foreground', '#ddd') };
}

/** Folder boxes, lines and (zoomed out) the cards, painted for what's on screen. */
/**
 * Zoomed out, the whole view is painted once into a picture a bit bigger than the screen; moving around slides that
 * picture (the GPU's job), and it's painted again only when the view leaves it, the zoom settles at a new level, or
 * something on it changes. Zoomed in, there's little to paint, so it's painted each frame.
 */
let snapshot: { canvas: HTMLCanvasElement; k: number; x0: number; y0: number; x1: number; y1: number; version: number } | undefined;
/** Bumped whenever what's painted changes (a new map, a card chosen). */
let paintVersion = 0;
let lastZoomAt = 0;
let settleTimer: ReturnType<typeof setTimeout> | undefined;

function paintSky(near: boolean) {
  const dpr = window.devicePixelRatio || 1;
  const w = stage.clientWidth;
  const h = stage.clientHeight;
  if (sky.width !== Math.round(w * dpr) || sky.height !== Math.round(h * dpr)) {
    sky.width = Math.round(w * dpr);
    sky.height = Math.round(h * dpr);
    snapshot = undefined;
  }
  const ctx = sky.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, sky.width, sky.height);
  const k = view.k;
  if (near) {
    snapshot = undefined;
    ctx.setTransform(dpr * k, 0, 0, dpr * k, dpr * view.x, dpr * view.y);
    paintContent(ctx, k, inView(40), true);
    return;
  }
  const r = inView(0);
  const fresh = snapshot && snapshot.version === paintVersion && snapshot.k === k && r.x0 >= snapshot.x0 && r.y0 >= snapshot.y0 && r.x1 <= snapshot.x1 && r.y1 <= snapshot.y1;
  const zooming = performance.now() - lastZoomAt < 150;
  if (!fresh && !(zooming && snapshot && snapshot.version === paintVersion)) {
    // Half a screen of margin on every side, so panning slides the same picture for a while.
    const rect = inView(Math.max(w, h) / 2);
    const scale = Math.min(dpr, 1.5) * k;
    const canvas = snapshot?.canvas ?? document.createElement('canvas');
    canvas.width = Math.max(1, Math.ceil((rect.x1 - rect.x0) * scale));
    canvas.height = Math.max(1, Math.ceil((rect.y1 - rect.y0) * scale));
    const sctx = canvas.getContext('2d');
    if (!sctx) return;
    sctx.setTransform(scale, 0, 0, scale, -rect.x0 * scale, -rect.y0 * scale);
    paintContent(sctx, k, rect, false);
    snapshot = { canvas, k, ...rect, version: paintVersion };
  } else if (!fresh) {
    // Still zooming: the last picture, stretched; painted sharp once the zoom settles.
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = setTimeout(requestRender, 160);
  }
  const s = snapshot!;
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(s.canvas, (s.x0 * k + view.x) * dpr, (s.y0 * k + view.y) * dpr, (s.x1 - s.x0) * k * dpr, (s.y1 - s.y0) * k * dpr);
}

/** Paints the map's boxes, lines and (zoomed out) cards for a part of it, into a canvas already set to map units. */
function paintContent(ctx: CanvasRenderingContext2D, k: number, r: ReturnType<typeof inView>, near: boolean) {
  const picked = !!selected;
  const nearIds = nearSet();

  // Folder boxes (and the titles of sections without a box).
  for (const s of layout.sections) {
    if (!meets(s, r)) continue;
    if (s.box) {
      const tint = paint(s.tint);
      ctx.globalAlpha = tint ? 0.09 : 0.04;
      ctx.fillStyle = tint ?? ink.fg;
      roundRect(ctx, s.x, s.y, s.w, s.h, 14);
      ctx.fill();
      ctx.globalAlpha = tint ? 0.35 : 0.09;
      ctx.strokeStyle = tint ?? ink.fg;
      ctx.lineWidth = Math.max(1, 1 / k);
      ctx.stroke();
    } else {
      ctx.globalAlpha = 0.65;
      ctx.fillStyle = ink.fg;
      ctx.font = `600 ${near ? 12 : Math.min(30, 18 / k)}px system-ui, sans-serif`;
      ctx.fillText(s.map.title.toUpperCase(), s.x, s.y + 24);
    }
  }

  // Lines: zoomed in, those touching cards on screen; zoomed out, all of them, or one per pair of folders when
  // there are too many to read.
  const lw = Math.max(1.6, 0.6 / k);
  const drawLine = (x1: number, y1: number, x2: number, y2: number, colour: string, alpha: number, width: number, dashed?: boolean) => {
    const bend = Math.max(40, Math.abs(x2 - x1) / 2);
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = colour;
    ctx.lineWidth = width;
    ctx.setLineDash(dashed ? [6, 4] : []);
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.bezierCurveTo(x1 + bend, y1, x2 - bend, y2, x2, y2);
    ctx.stroke();
  };
  const ends = (l: Layout['links'][number]) => {
    const a = placedById.get(l.from);
    const b = placedById.get(l.to);
    return a && b ? { x1: a.x + a.w, y1: a.y + Math.min(a.h / 2, 28), x2: b.x, y2: b.y + Math.min(b.h / 2, 28) } : undefined;
  };
  const visibleLinks = near || layout.links.length <= MAX_FAR_LINES;
  if (visibleLinks) {
    const list = near ? [...new Set(cardsIn(r).flatMap((c) => linksOf.get(c.item.id) ?? []))] : layout.links;
    for (const l of list) {
      const e = ends(l);
      if (!e) continue;
      const on = picked && (l.from === selected || l.to === selected);
      const colour = paint(colours.lines[l.kind]) ?? '#7c8580';
      drawLine(e.x1, e.y1, e.x2, e.y2, colour, on ? 1 : picked ? 0.15 : near ? 0.8 : 0.3, on ? Math.max(3.5, 1.4 / k) : lw, colours.lines[l.kind]?.dashed);
      if (on) {
        // Its arrow head, and its name in the middle.
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
        ctx.fillStyle = colour;
        const s = Math.max(6, 6 / k);
        ctx.beginPath();
        ctx.moveTo(e.x2, e.y2);
        ctx.lineTo(e.x2 - s * 1.4, e.y2 - s * 0.7);
        ctx.lineTo(e.x2 - s * 1.4, e.y2 + s * 0.7);
        ctx.fill();
        const label = l.label ?? l.kind;
        if (label) {
          ctx.font = `600 ${Math.max(11, 11 / k)}px system-ui, sans-serif`;
          ctx.textAlign = 'center';
          ctx.fillText(label, (e.x1 + e.x2) / 2, (e.y1 + e.y2) / 2 - 6 / Math.min(1, k));
          ctx.textAlign = 'start';
        }
      }
    }
  } else {
    // One line per pair of folders, as thick as the lines it stands for.
    const pairs = new Map<string, { a: number; b: number; n: number; on: boolean }>();
    for (const l of layout.links) {
      const a = sectionOf.get(l.from);
      const b = sectionOf.get(l.to);
      if (a === undefined || b === undefined || a === b) continue;
      const key = `${a}|${b}`;
      const p = pairs.get(key) ?? { a, b, n: 0, on: false };
      p.n++;
      if (picked && (l.from === selected || l.to === selected)) p.on = true;
      pairs.set(key, p);
    }
    for (const p of pairs.values()) {
      const A = layout.sections[p.a];
      const B = layout.sections[p.b];
      drawLine(A.x + A.w, A.y + A.h / 2, B.x, B.y + B.h / 2, ink.fg, p.on ? 0.9 : picked ? 0.08 : 0.25, Math.max(lw, (1 + Math.log2(p.n)) / k), false);
    }
  }
  ctx.setLineDash([]);

  // Zoomed out: the cards themselves, as patches of their kind's colour, named when there's room.
  if (!near) {
    const cards = cardsIn(r);
    for (const c of cards) {
      const colour = paint(colours.cards[c.item.kind]) ?? '#8a94a6';
      ctx.globalAlpha = picked && !nearIds.has(c.item.id) ? 0.25 : 1;
      ctx.fillStyle = ink.widget;
      roundRect(ctx, c.x, c.y, c.w, c.h, 8);
      ctx.fill();
      const a = ctx.globalAlpha;
      ctx.globalAlpha = a * 0.32;
      ctx.fillStyle = colour;
      ctx.fill();
      ctx.globalAlpha = a;
      const mark = marks[c.item.id];
      const isSel = c.item.id === selected;
      ctx.strokeStyle = isSel ? ink.fg : mark === 'proposed' ? '#d9a400' : mark === 'changed' ? '#2f6fdb' : ink.border;
      ctx.lineWidth = isSel || mark ? Math.max(2, 2 / k) : Math.max(1, 0.5 / k);
      ctx.stroke();
      ctx.fillStyle = colour;
      ctx.fillRect(c.x, c.y, 5, c.h);
      // A name only when the card is big enough on screen to read it.
      if (c.w * k >= 40) {
        const size = Math.min(13 / k, 34);
        ctx.font = `600 ${size}px system-ui, sans-serif`;
        ctx.fillStyle = ink.text;
        fitText(ctx, c.item.label, c.x + 14, c.y + 10 + size, c.w - 22);
      }
    }
  }
  ctx.globalAlpha = 1;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
  else ctx.rect(x, y, w, h);
}

/** Text cut to a width, with an ellipsis. */
function fitText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, max: number) {
  if (ctx.measureText(text).width <= max) return ctx.fillText(text, x, y);
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (ctx.measureText(text.slice(0, mid) + '…').width <= max) lo = mid;
    else hi = mid - 1;
  }
  ctx.fillText(text.slice(0, lo) + '…', x, y);
}

/** The card at a point on screen (zoomed out, where cards are painted, not elements). */
function cardAt(clientX: number, clientY: number): PlacedCard | undefined {
  const b = stage.getBoundingClientRect();
  const x = (clientX - b.left - view.x) / view.k;
  const y = (clientY - b.top - view.y) / view.k;
  return cardsIn({ x0: x, y0: y, x1: x, y1: y }).find((c) => x >= c.x && x <= c.x + c.w && y >= c.y && y <= c.y + c.h);
}

function fit() {
  const w = stage.clientWidth;
  const h = stage.clientHeight;
  if (!layout.width || !w || !h) {
    view = { x: 40, y: 40, k: 1 };
  } else {
    // A very big map may zoom further out than usual, so it always fits.
    const fits = Math.min((w - 80) / layout.width, (h - 80) / layout.height);
    minZoom = Math.min(MIN_ZOOM, Math.max(0.005, fits));
    const k = Math.min(1, Math.max(minZoom, fits));
    view = { k, x: Math.max(40, (w - layout.width * k) / 2), y: Math.max(40, (h - layout.height * k) / 2) };
  }
  applyView();
}

/** Chooses a card (or none): highlights it and its lines, and asks for its notes and history. */
function select(id: string | undefined, tell = true) {
  if (selected) cardEls.get(selected)?.classList.remove('selected');
  const changed = selected !== id;
  selected = id;
  if (id) cardEls.get(id)?.classList.add('selected');
  // The chosen card and the cards it has a line to stay bright; the rest step back (lines are repainted).
  const near = nearSet();
  for (const [cid, card] of cardEls) card.classList.toggle('near', near.has(cid));
  world.classList.toggle('picked', !!id);
  paintVersion++;
  requestRender();
  if (!id) drawer.hidden = true;
  if (tell && changed) vscode.postMessage({ type: 'card', id });
}

const OUTCOME_WORDS = { applied: 'applied', 'sent-back': 'sent back', rejected: 'rejected', undone: 'undone' } as const;

/** The drawer: the chosen card, what's noted about it, and the changes it went through. */
function showCard(m: CardMemory) {
  if (m.id !== selected) return;
  const item = layout.sections.flatMap((s) => s.cards).find((c) => c.item.id === m.id)?.item;
  if (!item) return;
  drawer.replaceChildren();
  const close = el('button', 'close', '×');
  close.title = 'Close';
  close.addEventListener('click', () => select(undefined));
  drawer.append(close, el('h2', undefined, item.label), el('div', 'sub', [item.kind, item.sub].filter(Boolean).join(' · ')));
  const buttons = el('div', 'buttons');
  if (item.source) {
    const open = el('button', undefined, 'Open code');
    open.addEventListener('click', () => vscode.postMessage({ type: 'open', path: item.source!.path, line: item.source!.line }));
    buttons.append(open);
  }
  if (m.canPreview) {
    const preview = el('button', 'primary', 'Preview');
    preview.title = 'See how it looks';
    preview.addEventListener('click', () => vscode.postMessage({ type: 'preview', id: item.id }));
    if (m.versions) {
      const versions = el('button', undefined, `Versions (${m.versions})`);
      versions.title = 'Its other versions, side by side with it; choose one to make it the real one';
      versions.addEventListener('click', () => vscode.postMessage({ type: 'preview', id: item.id, versions: true }));
      buttons.prepend(versions);
    }
    buttons.prepend(preview);
  }
  const note = el('button', undefined, 'Add a note');
  note.title = 'Something to remember about this card (kept in the project, read by assistants)';
  note.addEventListener('click', () => vscode.postMessage({ type: 'addNote', id: item.id }));
  buttons.append(note);
  drawer.append(buttons);

  const notes = m.entries.filter((e) => e.kind !== 'change');
  const changes = m.entries.filter((e) => e.kind === 'change');
  drawer.append(el('h3', undefined, 'Notes'));
  if (notes.length) for (const e of notes) drawer.append(entry(e));
  else drawer.append(el('div', 'none', 'No notes yet.'));
  drawer.append(el('h3', undefined, 'History'));
  if (changes.length) for (const e of changes) drawer.append(entry(e));
  else drawer.append(el('div', 'none', 'No reviewed changes yet. Approved, sent back and rejected changes appear here.'));
  drawer.hidden = false;
}

function entry(e: MemoryEntry): HTMLElement {
  const box = el('div', 'entry');
  box.append(el('div', 't', e.text));
  if (e.detail) box.append(el('div', 'd', e.detail));
  if (e.note) box.append(el('div', 'd', `Note: “${e.note}”`));
  const what = e.kind === 'change' ? OUTCOME_WORDS[e.outcome ?? 'applied'] : e.kind;
  box.append(el('div', 'm', `${what} · ${e.by.name} · ${ago(e.at)}`));
  if (e.proposal) {
    box.classList.add('link');
    box.title = 'Open in Review';
    box.addEventListener('click', () => vscode.postMessage({ type: 'openReview', proposal: e.proposal }));
  }
  return box;
}

function drawCard(c: PlacedCard): HTMLElement {
  const { item } = c;
  const card = el('div', 'card');
  Object.assign(card.style, { left: `${c.x}px`, top: `${c.y}px`, width: `${c.w}px`, height: `${c.h}px` });
  const tone = colours.cards[item.kind];
  const colour = paint(tone);
  const strip = el('div', 'strip');
  if (colour) {
    strip.style.background = tone?.dashed ? `repeating-linear-gradient(180deg, ${colour} 0 6px, transparent 6px 10px)` : colour;
    card.style.setProperty('--kind', colour);
  }
  card.append(strip);
  const n = used[item.id] ?? 0;
  if (n >= BUSY) card.classList.add('busy');
  if (!linked.has(item.id)) card.classList.add('lonely');
  const head = el('div', 'head');
  const top = el('div', 'top');
  top.append(el('span', 'label', item.label));
  const mark = marks[item.id];
  if (mark) {
    card.classList.add(mark);
    top.append(el('span', 'mark', mark === 'proposed' ? 'proposed' : 'changed'));
  } else {
    const kind = el('span', 'kind', item.kind);
    if (colour) kind.style.color = colour;
    hint(kind, { name: item.kind, text: cardMeaning(item.kind), colour });
    top.append(kind);
  }
  if (n >= BUSY) top.append(Object.assign(el('span', 'used', `used in ${n}`), { title: `${n} other cards point at it` }));
  head.append(top);
  if (item.sub) head.append(el('div', 'sub', item.sub));
  card.append(head);
  if (item.fields?.length) {
    const fields = el('div', 'fields');
    for (const f of item.fields.slice(0, MAX_FIELDS)) {
      const row = el('div', 'field');
      row.append(el('span', 'n', f.name));
      if (f.tag) row.append(el('span', 't', f.tag));
      if (f.value) row.append(el('span', 'v', f.value));
      fields.append(row);
    }
    if (item.fields.length > MAX_FIELDS) fields.append(el('div', 'field more', `+ ${item.fields.length - MAX_FIELDS} more`));
    card.append(fields);
  }
  card.title = [item.label, n ? `Used by ${n} card${n === 1 ? '' : 's'}` : linked.has(item.id) ? '' : 'No lines to other cards', item.source ? 'Double-click to open its code' : ''].filter(Boolean).join('\n');
  card.addEventListener('pointerdown', (e) => e.stopPropagation());
  card.addEventListener('click', () => select(item.id));
  if (item.source) card.addEventListener('dblclick', () => vscode.postMessage({ type: 'open', path: item.source!.path, line: item.source!.line }));
  return card;
}

function draw() {
  world.replaceChildren();
  labels.replaceChildren();
  tags = [];
  cardEls.clear();
  readInk();
  // What the painter and the card elements need: each card by id and by place, its lines, and its folder.
  placedById = new Map();
  linksOf = new Map();
  sectionOf = new Map();
  grid = new Map();
  layout.sections.forEach((s, i) => {
    if (s.box) {
      const tag = el('div', 'tag', `${s.map.title}  ·  ${s.cards.length}`);
      const tint = paint(s.tint);
      if (tint) tag.style.color = tint;
      if (s.map.description) tag.title = s.map.description;
      labels.append(tag);
      tags.push({ el: tag, x: s.x, y: s.y, w: s.w });
    }
    for (const c of s.cards) {
      placedById.set(c.item.id, c);
      sectionOf.set(c.item.id, i);
      for (let gx = Math.floor(c.x / CELL); gx <= Math.floor((c.x + c.w) / CELL); gx++) {
        for (let gy = Math.floor(c.y / CELL); gy <= Math.floor((c.y + c.h) / CELL); gy++) {
          const key = `${gx},${gy}`;
          const cell = grid.get(key);
          if (cell) cell.push(c);
          else grid.set(key, [c]);
        }
      }
    }
  });
  for (const l of layout.links) {
    if (!placedById.has(l.from) || !placedById.has(l.to)) continue;
    for (const id of [l.from, l.to]) {
      const list = linksOf.get(id);
      if (list) list.push(l);
      else linksOf.set(id, [l]);
    }
  }
  paintVersion++;
  if (selected && placedById.has(selected)) select(selected, false);
  else if (selected) select(undefined);
  // Pin the new folder names where their boxes are now, and paint what's on screen.
  applyView();
}

/** Chooses a card and moves the view so it's in the middle. */
function focusCard(id: string) {
  const c = layout.sections.flatMap((s) => s.cards).find((card) => card.item.id === id);
  if (!c) return;
  select(id);
  // Close enough to read it.
  view.k = Math.max(view.k, 0.9);
  view.x = (stage.clientWidth - 300) / 2 - (c.x + c.w / 2) * view.k;
  view.y = stage.clientHeight / 2 - (c.y + c.h / 2) * view.k;
  applyView();
}

/** What the colours mean: each kind of card (with how many) and each kind of line. */
function drawLegend(m: ShowMap) {
  legend.replaceChildren();
  const counts = new Map<string, number>();
  for (const s of m.layout.sections) for (const c of s.cards) counts.set(c.item.kind, (counts.get(c.item.kind) ?? 0) + 1);
  for (const [kind, tone] of Object.entries(m.colours.cards)) {
    const k = el('span', 'k');
    const dot = el('span', 'dot');
    dot.style.background = paint(tone)!;
    const n = counts.get(kind) ?? 0;
    k.append(dot, el('span', undefined, kind), el('span', 'n', String(n)));
    hint(k, { name: kind, text: cardMeaning(kind), colour: paint(tone), count: `${n} card${n === 1 ? '' : 's'} on this map` });
    legend.append(k);
  }
  for (const [kind, tone] of Object.entries(m.colours.lines)) {
    const k = el('span', 'k');
    const ln = el('span', 'ln');
    ln.style.background = paint(tone)!;
    k.append(ln, el('span', undefined, kind));
    const n = m.layout.links.filter((l) => l.kind === kind).length;
    hint(k, { name: kind, text: lineMeaning(kind), colour: paint(tone), line: true, count: `${n} line${n === 1 ? '' : 's'} on this map` });
    legend.append(k);
  }
  legend.hidden = !!m.empty || !legend.childElementCount;
}

let lastDrawMs = 0;

/** Frame times while something moves the view each frame (for the performance test). */
async function frames(n: number, step: (i: number) => void) {
  const times: number[] = [];
  let prev = performance.now();
  for (let i = 0; i < n; i++) {
    step(i);
    applyView();
    await new Promise((r) => requestAnimationFrame(r));
    const now = performance.now();
    times.push(now - prev);
    prev = now;
  }
  times.sort((a, b) => a - b);
  const round = (x: number) => Math.round(x * 10) / 10;
  return { avg: round(times.reduce((a, b) => a + b, 0) / n), p95: round(times[Math.floor(n * 0.95)]), max: round(times[n - 1]) };
}

async function measure() {
  const start = { ...view };
  // Painting alone (no waiting for the screen), for each step of a pan and a zoom.
  const paintTimes = (n: number, step: (i: number) => void) => {
    const times: number[] = [];
    for (let i = 0; i < n; i++) {
      step(i);
      applyView();
      const t = performance.now();
      render();
      times.push(performance.now() - t);
    }
    times.sort((a, b) => a - b);
    const round = (x: number) => Math.round(x * 10) / 10;
    return { avg: round(times.reduce((a, b) => a + b, 0) / n), p95: round(times[Math.floor(n * 0.95)]), max: round(times[n - 1]) };
  };
  const paintPan = paintTimes(60, () => {
    view.x -= 12;
    view.y -= 4;
  });
  view = { ...start };
  const paintZoom = paintTimes(60, (i) => {
    lastZoomAt = performance.now();
    view.k = Math.min(2, Math.max(minZoom, view.k * (i < 30 ? 1.08 : 1 / 1.08)));
  });
  view = { ...start };
  vscode.postMessage({ type: 'measured', partial: true, drawMs: Math.round(lastDrawMs), pan: paintPan, zoom: paintZoom, paintPan, paintZoom, cards: cardEls.size, lines: layout.links.length, elements: document.querySelectorAll('*').length });
  const pan = await frames(60, () => {
    view.x -= 12;
    view.y -= 4;
  });
  view = { ...start };
  const zoom = await frames(60, (i) => {
    lastZoomAt = performance.now();
    view.k = Math.min(2, Math.max(minZoom, view.k * (i < 30 ? 1.05 : 1 / 1.05)));
  });
  // Zoomed in (cards as elements, made and removed while moving), in the middle of the map.
  view = { k: 0.9, x: stage.clientWidth / 2 - (layout.width / 2) * 0.9, y: stage.clientHeight / 2 - (layout.height / 2) * 0.9 };
  applyView();
  await new Promise((r) => requestAnimationFrame(r));
  const nearPan = await frames(60, () => {
    view.x -= 25;
    view.y -= 8;
  });
  const nearCards = cardEls.size;
  view = start;
  applyView();
  vscode.postMessage({ type: 'measured', drawMs: Math.round(lastDrawMs), pan, zoom, paintPan, paintZoom, nearPan, nearCards, cards: cardEls.size, lines: layout.links.length, elements: document.querySelectorAll('*').length });
}

function show(m: ShowMap) {
  const started = performance.now();
  picker.replaceChildren(
    ...m.projects.map((p) => {
      const o = el('option', undefined, `${p.group && p.group !== p.name ? `${p.group} › ` : ''}${p.name}${p.cards ? ` (${p.cards})` : ''}`);
      o.value = p.root;
      o.selected = p.root === m.current;
      return o;
    }),
  );
  // One project: no choice to make, just its name.
  picker.hidden = m.projects.length < 2;
  projectName.hidden = m.projects.length >= 2;
  projectName.textContent = m.projects.find((p) => p.root === m.current)?.name ?? '';
  chips.replaceChildren(...m.plugins.map((name) => el('span', 'chip', name)));
  tabs.replaceChildren(
    ...m.maps.map((t) => {
      const b = el('button', t.id === m.map ? 'on' : undefined, t.title);
      b.append(el('span', 'n', String(t.cards)));
      if (t.description) b.title = t.description;
      b.addEventListener('click', () => vscode.postMessage({ type: 'chooseMap', id: t.id }));
      return b;
    }),
  );
  tabs.hidden = m.maps.length < 2;
  empty.hidden = !m.empty;
  stage.hidden = !!m.empty;
  fitButton.hidden = !!m.empty;
  zoomText.hidden = !!m.empty;
  emptyTitle.textContent = m.empty?.title ?? '';
  emptyDetail.textContent = m.empty?.detail ?? '';
  layout = m.layout;
  marks = m.marks;
  colours = m.colours;
  meanings = m.meanings;
  tip.hidden = true;
  used = m.usedBy;
  linked = new Set(m.layout.links.flatMap((l) => [l.from, l.to]));
  for (const b of arrangeGroup.querySelectorAll('button')) b.classList.toggle('on', b.dataset.mode === m.arrange);
  windowButton.textContent = m.floating ? '⤡' : '⤢';
  windowButton.title = m.floating ? 'Back into the main window' : 'Open the map in its own window: make it full screen there, or move it to another screen';
  drawLegend(m);
  proposedBadge.textContent = `${m.proposed} proposed`;
  proposedBadge.hidden = !m.proposed;
  changedBadge.textContent = `${m.changed} file${m.changed === 1 ? '' : 's'} changed outside review`;
  changedBadge.hidden = !m.changed;
  draw();
  // A new project starts fitted; updates to the same one keep where you were looking.
  if (`${m.current}|${m.map}` !== shownKey) {
    shownKey = `${m.current}|${m.map}`;
    fit();
  }
  lastDrawMs = performance.now() - started;
}

// Moving around: drag the background, scroll to move, pinch or Ctrl+scroll to zoom.
let drag: { x: number; y: number; vx: number; vy: number } | undefined;
stage.addEventListener('pointerdown', (e) => {
  drag = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
  stage.setPointerCapture(e.pointerId);
  stage.classList.add('dragging');
});
stage.addEventListener('pointermove', (e) => {
  if (!drag) return;
  view.x = drag.vx + e.clientX - drag.x;
  view.y = drag.vy + e.clientY - drag.y;
  applyView();
});
const endDrag = (e: PointerEvent) => {
  // A click (not a drag) on the background: zoomed out, it may be on a painted card.
  if (drag && Math.abs(e.clientX - drag.x) + Math.abs(e.clientY - drag.y) < 3) select(view.k < FAR ? cardAt(e.clientX, e.clientY)?.item.id : undefined);
  drag = undefined;
  stage.classList.remove('dragging');
};
stage.addEventListener('pointerup', endDrag);
stage.addEventListener('pointercancel', endDrag);
stage.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      const r = stage.getBoundingClientRect();
      const px = e.clientX - r.left;
      const py = e.clientY - r.top;
      const k = Math.min(2, Math.max(minZoom, view.k * Math.exp(-e.deltaY * 0.01)));
      lastZoomAt = performance.now();
      view = { k, x: px - ((px - view.x) * k) / view.k, y: py - ((py - view.y) * k) / view.k };
    } else {
      view.x -= e.deltaX;
      view.y -= e.deltaY;
    }
    applyView();
  },
  { passive: false },
);
stage.addEventListener('dblclick', (e) => {
  const c = view.k < FAR ? cardAt(e.clientX, e.clientY) : undefined;
  if (c?.item.source) vscode.postMessage({ type: 'open', path: c.item.source.path, line: c.item.source.line });
});
new ResizeObserver(() => requestRender()).observe(stage);
fitButton.addEventListener('click', fit);

// Find a card by name: each Enter goes to the next match.
let found: Item[] = [];
let foundAt = 0;
find.addEventListener('input', () => {
  const q = find.value.trim().toLowerCase();
  found = q ? layout.sections.flatMap((s) => s.cards.map((c) => c.item)).filter((i) => i.label.toLowerCase().includes(q)) : [];
  foundAt = 0;
  find.style.outline = q && !found.length ? '1px solid var(--vscode-inputValidation-errorBorder, #e55)' : '';
  if (found[0]) focusCard(found[0].id);
});
find.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && found.length) {
    foundAt = (foundAt + 1) % found.length;
    focusCard(found[foundAt].id);
  } else if (e.key === 'Escape') {
    find.value = '';
    found = [];
    select(undefined);
  }
});
proposedBadge.addEventListener('click', () => vscode.postMessage({ type: 'openReview' }));
changedBadge.addEventListener('click', () => vscode.postMessage({ type: 'clearChanged' }));
picker.addEventListener('change', () => vscode.postMessage({ type: 'choose', root: picker.value }));

window.addEventListener('message', (e: MessageEvent<ToMap>) => {
  if (e.data?.type === 'show') show(e.data);
  else if (e.data?.type === 'card') showCard(e.data);
  else if (e.data?.type === 'focus') focusCard(e.data.id);
  else if (e.data?.type === 'measure') void measure();
});
applyView();
vscode.postMessage({ type: 'ready' });
