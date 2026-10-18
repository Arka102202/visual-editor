// The map page inside the editor tab: draws the cards and lines the shell laid out. Drag the background to move
// around, pinch or Ctrl+scroll to zoom, double-click a card to open its code. Plain DOM, no framework.

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
  .bar { position: absolute; inset: 0 0 auto 0; height: 40px; display: flex; align-items: center; gap: 8px; padding: 0 12px; border-bottom: 1px solid var(--vscode-panel-border, #8883); background: var(--vscode-editor-background); z-index: 2; }
  .bar select, .bar button { font: inherit; color: var(--vscode-dropdown-foreground); background: var(--vscode-dropdown-background); border: 1px solid var(--vscode-dropdown-border, #8884); border-radius: 4px; padding: 3px 8px; }
  .bar button { cursor: pointer; color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); border-color: transparent; }
  .bar .name { font-weight: 600; }
  .bar .chips { display: flex; gap: 4px; overflow: hidden; }
  .tabs { display: flex; gap: 2px; flex: 1; overflow: hidden; margin-left: 8px; }
  .tabs button { background: transparent; color: var(--vscode-foreground); opacity: .7; padding: 3px 10px; border-radius: 4px; white-space: nowrap; }
  .tabs button.on { opacity: 1; background: var(--vscode-toolbar-activeBackground, #8883); font-weight: 600; }
  .tabs button .n { opacity: .6; font-weight: normal; margin-left: 4px; }
  .bar input.find { width: 150px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, #8884); border-radius: 4px; padding: 3px 8px; font: inherit; }
  /* Zoomed out: only names, bigger, so the map reads like an outline. */
  .world.far .card .fields, .world.far .card .sub, .world.far .card .kind, .world.far svg.lines text { display: none; }
  .world.far .card .head { border-bottom: 0; height: auto; }
  .world.far .card .label { font-size: var(--far-label, 26px); white-space: normal; line-height: 1.1; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; word-break: break-word; }
  .world.far .section-title { font-size: 30px; }
  /* A card chosen: the cards it has no line to step back. */
  .world.picked .card { opacity: .25; }
  .world.picked .card.near { opacity: 1; }
  .world.picked svg.lines path { opacity: .15; }
  .world.picked svg.lines path.on { opacity: 1; }
  .zoom { font-size: 11px; opacity: .7; min-width: 36px; text-align: right; }
  .stage { position: absolute; inset: 40px 0 0 0; overflow: hidden; cursor: grab; touch-action: none; }
  .stage.dragging { cursor: grabbing; }
  .world { position: absolute; left: 0; top: 0; transform-origin: 0 0; }
  svg.lines { position: absolute; left: 0; top: 0; overflow: visible; pointer-events: none; }
  svg.lines path { fill: none; stroke-width: 1.6; opacity: .8; }
  svg.lines path.on { stroke-width: 3.5; opacity: 1; }
  /* Line names only on the chosen card's lines, so the map stays calm. */
  svg.lines text { display: none; font-weight: 600; }
  svg.lines text.on { display: block; }
  .area { position: absolute; border-radius: 14px; background: color-mix(in srgb, var(--vscode-foreground) 4%, transparent); border: 1px solid color-mix(in srgb, var(--vscode-foreground) 9%, transparent); }
  .area-title { position: absolute; font-size: 13px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  /* Folder names float above the map at reading size, pinned to their box (they don't scale with it). */
  .labels { position: absolute; inset: 0; pointer-events: none; overflow: hidden; }
  .labels .tag { position: absolute; font-size: 12px; font-weight: 700; padding: 2px 8px; border-radius: 6px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; background: color-mix(in srgb, var(--vscode-editor-background) 85%, transparent); transform: translateY(-50%); }
  /* Zoomed out, a card's whole face takes its kind's colour, so kinds read as patches. */
  .world.far .card { background: color-mix(in srgb, var(--kind, #8a94a6) 32%, var(--vscode-editorWidget-background, #2a2a2a)); }
  .world.far svg.lines path { opacity: .3; }
  .world.far.picked svg.lines path.on { opacity: 1; }
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
  svg.lines text { font-size: 11px; fill: var(--vscode-descriptionForeground, #888); }
  .section-title { position: absolute; font-size: 12px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; opacity: .65; }
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

const SVG = 'http://www.w3.org/2000/svg';

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
bar.append(picker, projectName, chips, tabs, find, arrangeGroup, proposedBadge, changedBadge, zoomText, fitButton);
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
const world = el('div', 'world');
const labels = el('div', 'labels');
stage.append(world, labels);
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
/** As far out as the map goes: enough for a medium project to fit. */
const MIN_ZOOM = 0.08;
let selected: string | undefined;
let marks: ShowMap['marks'] = {};
let colours: ShowMap['colours'] = { cards: {}, lines: {} };
let used: ShowMap['usedBy'] = {};
/** Cards with at least one line. */
let linked = new Set<string>();
/** Used by this many cards or more: the card stands out. */
const BUSY = 3;
const cardEls = new Map<string, HTMLElement>();
let lineEls: { from: string; to: string; path: SVGPathElement; text?: SVGTextElement }[] = [];

function applyView() {
  world.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.k})`;
  world.classList.toggle('far', view.k < FAR);
  for (const t of tags) {
    Object.assign(t.el.style, { left: `${view.x + t.x * view.k + 8}px`, top: `${view.y + t.y * view.k}px`, maxWidth: `${Math.max(60, t.w * view.k - 16)}px` });
  }
  // Names grow as the map shrinks, so they stay readable on screen.
  world.style.setProperty('--far-label', `${Math.min(13 / view.k, 34)}px`);
  world.style.setProperty('--far-title', `${Math.min(18 / view.k, 110)}px`);
  zoomText.textContent = `${Math.round(view.k * 100)}%`;
}

function fit() {
  const w = stage.clientWidth;
  const h = stage.clientHeight;
  if (!layout.width || !w || !h) {
    view = { x: 40, y: 40, k: 1 };
  } else {
    const k = Math.min(1, Math.max(MIN_ZOOM, Math.min((w - 80) / layout.width, (h - 80) / layout.height)));
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
  for (const l of lineEls) {
    const on = !!id && (l.from === id || l.to === id);
    l.path.classList.toggle('on', on);
    l.text?.classList.toggle('on', on);
  }
  // The chosen card and the cards it has a line to stay bright; the rest step back.
  const near = new Set(id ? [id, ...lineEls.filter((l) => l.from === id || l.to === id).flatMap((l) => [l.from, l.to])] : []);
  for (const [cid, card] of cardEls) card.classList.toggle('near', near.has(cid));
  world.classList.toggle('picked', !!id);
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
  lineEls = [];
  const svg = document.createElementNS(SVG, 'svg');
  svg.classList.add('lines');
  svg.setAttribute('width', String(layout.width));
  svg.setAttribute('height', String(layout.height));
  // One arrow head per line colour.
  const heads = Object.entries(colours.lines);
  svg.innerHTML = `<defs>${heads.map(([, t], i) => [paint(t), i] as const).map(([c, i]) => `<marker id="arrow${i}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" style="fill: ${c}; stroke: none"/></marker>`).join('')}</defs>`;
  const headOf = new Map(heads.map(([k], i) => [k, `url(#arrow${i})`]));
  world.append(svg);
  const placed = new Map<string, PlacedCard>();
  for (const s of layout.sections) {
    if (s.box) {
      const area = el('div', 'area');
      Object.assign(area.style, { left: `${s.x}px`, top: `${s.y}px`, width: `${s.w}px`, height: `${s.h}px` });
      const tint = paint(s.tint);
      if (tint) Object.assign(area.style, { background: `color-mix(in srgb, ${tint} 9%, transparent)`, borderColor: `color-mix(in srgb, ${tint} 35%, transparent)` });
      world.insertBefore(area, svg);
    }
    if (s.box) {
      const tag = el('div', 'tag', `${s.map.title}  ·  ${s.cards.length}`);
      const tint = paint(s.tint);
      if (tint) tag.style.color = tint;
      if (s.map.description) tag.title = s.map.description;
      labels.append(tag);
      tags.push({ el: tag, x: s.x, y: s.y, w: s.w });
    } else {
      const title = el('div', 'section-title', s.map.title);
      Object.assign(title.style, { left: `${s.x}px`, top: `${s.y + 12}px` });
      if (s.map.description) title.title = s.map.description;
      world.append(title);
    }
    for (const c of s.cards) {
      placed.set(c.item.id, c);
      const card = drawCard(c);
      cardEls.set(c.item.id, card);
      world.append(card);
    }
  }
  for (const l of layout.links) {
    const a = placed.get(l.from);
    const b = placed.get(l.to);
    if (!a || !b) continue;
    const x1 = a.x + a.w;
    const y1 = a.y + Math.min(a.h / 2, 28);
    const x2 = b.x;
    const y2 = b.y + Math.min(b.h / 2, 28);
    const bend = Math.max(40, Math.abs(x2 - x1) / 2);
    const path = document.createElementNS(SVG, 'path');
    path.setAttribute('d', `M${x1},${y1} C${x1 + bend},${y1} ${x2 - bend},${y2} ${x2},${y2}`);
    path.setAttribute('stroke', paint(colours.lines[l.kind]) ?? '#7c8580');
    if (colours.lines[l.kind]?.dashed) path.setAttribute('stroke-dasharray', '6 4');
    path.setAttribute('marker-end', headOf.get(l.kind) ?? '');
    svg.append(path);
    const label = l.label ?? l.kind;
    let text: SVGTextElement | undefined;
    if (label) {
      text = document.createElementNS(SVG, 'text');
      text.setAttribute('x', String((x1 + x2) / 2));
      text.setAttribute('y', String((y1 + y2) / 2 - 6));
      text.setAttribute('text-anchor', 'middle');
      text.setAttribute('fill', paint(colours.lines[l.kind]) ?? '#7c8580');
      text.textContent = label;
      svg.append(text);
    }
    lineEls.push({ from: l.from, to: l.to, path, text });
  }
  if (selected && cardEls.has(selected)) select(selected, false);
  else if (selected) select(undefined);
  // Pin the new folder names where their boxes are now.
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

function show(m: ShowMap) {
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
  if (drag && Math.abs(e.clientX - drag.x) + Math.abs(e.clientY - drag.y) < 3) select(undefined);
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
      const k = Math.min(2, Math.max(MIN_ZOOM, view.k * Math.exp(-e.deltaY * 0.01)));
      view = { k, x: px - ((px - view.x) * k) / view.k, y: py - ((py - view.y) * k) / view.k };
    } else {
      view.x -= e.deltaX;
      view.y -= e.deltaY;
    }
    applyView();
  },
  { passive: false },
);
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
});
applyView();
vscode.postMessage({ type: 'ready' });
