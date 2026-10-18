// The map page inside the editor tab: draws the cards and lines the shell laid out. Drag the background to move
// around, pinch or Ctrl+scroll to zoom, double-click a card to open its code. Plain DOM, no framework.

import type { Layout, PlacedCard } from '../layout';
import { MAX_FIELDS } from '../layout';
import type { CardMemory, FromMap, ShowMap, ToMap } from '../mapMessages';
import type { MemoryEntry } from '../memory';
import { addStyles, ago, el } from '../ui/dom';

declare function acquireVsCodeApi(): { postMessage(message: FromMap): void };
const vscode = acquireVsCodeApi();

addStyles(`
  .bar { position: absolute; inset: 0 0 auto 0; height: 40px; display: flex; align-items: center; gap: 8px; padding: 0 12px; border-bottom: 1px solid var(--vscode-panel-border, #8883); background: var(--vscode-editor-background); z-index: 2; }
  .bar select, .bar button { font: inherit; color: var(--vscode-dropdown-foreground); background: var(--vscode-dropdown-background); border: 1px solid var(--vscode-dropdown-border, #8884); border-radius: 4px; padding: 3px 8px; }
  .bar button { cursor: pointer; color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); border-color: transparent; }
  .bar .name { font-weight: 600; }
  .bar .chips { display: flex; gap: 4px; flex: 1; overflow: hidden; }
  .zoom { font-size: 11px; opacity: .7; min-width: 36px; text-align: right; }
  .stage { position: absolute; inset: 40px 0 0 0; overflow: hidden; cursor: grab; touch-action: none; }
  .stage.dragging { cursor: grabbing; }
  .world { position: absolute; left: 0; top: 0; transform-origin: 0 0; }
  svg.lines { position: absolute; left: 0; top: 0; overflow: visible; pointer-events: none; }
  svg.lines path { fill: none; stroke: var(--vscode-editorLineNumber-foreground, #888); stroke-width: 1.5; }
  svg.lines path.on { stroke: var(--vscode-focusBorder, #39f); stroke-width: 2.5; }
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
  .card.selected { border-color: var(--vscode-focusBorder, #39f); box-shadow: 0 0 0 2px var(--vscode-focusBorder, #39f); }
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
bar.append(picker, projectName, chips, proposedBadge, changedBadge, zoomText, fitButton);
const stage = el('div', 'stage');
const world = el('div', 'world');
stage.append(world);
const empty = el('div', 'empty');
const emptyTitle = el('h2');
const emptyDetail = el('p');
empty.append(emptyTitle, emptyDetail);
const drawer = el('div', 'drawer');
drawer.hidden = true;
document.body.append(bar, stage, empty, drawer);

// The view: moved by (x, y), zoomed by k.
let view = { x: 40, y: 40, k: 1 };
let layout: Layout = { sections: [], links: [], width: 0, height: 0 };
let shownRoot: string | undefined;
let selected: string | undefined;
let marks: ShowMap['marks'] = {};
const cardEls = new Map<string, HTMLElement>();
let lineEls: { from: string; to: string; path: SVGPathElement }[] = [];

function applyView() {
  world.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.k})`;
  zoomText.textContent = `${Math.round(view.k * 100)}%`;
}

function fit() {
  const w = stage.clientWidth;
  const h = stage.clientHeight;
  if (!layout.width || !w || !h) {
    view = { x: 40, y: 40, k: 1 };
  } else {
    const k = Math.min(1, Math.max(0.2, Math.min((w - 80) / layout.width, (h - 80) / layout.height)));
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
  for (const l of lineEls) l.path.classList.toggle('on', !!id && (l.from === id || l.to === id));
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
  const head = el('div', 'head');
  const top = el('div', 'top');
  top.append(el('span', 'label', item.label));
  const mark = marks[item.id];
  if (mark) {
    card.classList.add(mark);
    top.append(el('span', 'mark', mark === 'proposed' ? 'proposed' : 'changed'));
  } else top.append(el('span', 'kind', item.kind));
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
  card.title = item.source ? `${item.label}\nDouble-click to open its code` : item.label;
  card.addEventListener('pointerdown', (e) => e.stopPropagation());
  card.addEventListener('click', () => select(item.id));
  if (item.source) card.addEventListener('dblclick', () => vscode.postMessage({ type: 'open', path: item.source!.path, line: item.source!.line }));
  return card;
}

function draw() {
  world.replaceChildren();
  cardEls.clear();
  lineEls = [];
  const svg = document.createElementNS(SVG, 'svg');
  svg.classList.add('lines');
  svg.setAttribute('width', String(layout.width));
  svg.setAttribute('height', String(layout.height));
  svg.innerHTML = `<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" style="fill: var(--vscode-editorLineNumber-foreground, #888); stroke: none"/></marker></defs>`;
  world.append(svg);
  const placed = new Map<string, PlacedCard>();
  for (const s of layout.sections) {
    const title = el('div', 'section-title', s.map.title);
    Object.assign(title.style, { left: `${s.x}px`, top: `${s.y + 12}px` });
    if (s.map.description) title.title = s.map.description;
    world.append(title);
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
    path.setAttribute('marker-end', 'url(#arrow)');
    svg.append(path);
    const label = l.label ?? l.kind;
    if (label) {
      const text = document.createElementNS(SVG, 'text');
      text.setAttribute('x', String((x1 + x2) / 2));
      text.setAttribute('y', String((y1 + y2) / 2 - 6));
      text.setAttribute('text-anchor', 'middle');
      text.textContent = label;
      svg.append(text);
    }
    lineEls.push({ from: l.from, to: l.to, path });
  }
  if (selected && cardEls.has(selected)) select(selected, false);
  else if (selected) select(undefined);
}

/** Chooses a card and moves the view so it's in the middle. */
function focusCard(id: string) {
  const c = layout.sections.flatMap((s) => s.cards).find((card) => card.item.id === id);
  if (!c) return;
  select(id);
  view.x = (stage.clientWidth - 300) / 2 - (c.x + c.w / 2) * view.k;
  view.y = stage.clientHeight / 2 - (c.y + c.h / 2) * view.k;
  applyView();
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
  empty.hidden = !m.empty;
  stage.hidden = !!m.empty;
  fitButton.hidden = !!m.empty;
  zoomText.hidden = !!m.empty;
  emptyTitle.textContent = m.empty?.title ?? '';
  emptyDetail.textContent = m.empty?.detail ?? '';
  layout = m.layout;
  marks = m.marks;
  proposedBadge.textContent = `${m.proposed} proposed`;
  proposedBadge.hidden = !m.proposed;
  changedBadge.textContent = `${m.changed} file${m.changed === 1 ? '' : 's'} changed outside review`;
  changedBadge.hidden = !m.changed;
  draw();
  // A new project starts fitted; updates to the same one keep where you were looking.
  if (m.current !== shownRoot) {
    shownRoot = m.current;
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
      const k = Math.min(2, Math.max(0.2, view.k * Math.exp(-e.deltaY * 0.01)));
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
