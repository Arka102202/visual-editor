// The Playground: one component on a board, a tile for each of its data cases (the ones kept in Name.variants.json,
// and ones added from suggestions made from its props' types). Tiles are pictures, drawn one after another by a
// hidden copy of the app; the tile you click is live (the real app, to use), up to a set number at once. A Data
// panel changes the chosen tile's props, keeps it in the file, or removes it. The whole board takes one screen size;
// two tiles can be compared (side by side, or one over the other). Designs as columns come later. Plain DOM.

import type { Item } from '@visual-editor/contract';
import type { FromMap } from '../mapMessages';
import { suggestCases, type DataCase } from '../cases';
import { el } from '../ui/dom';
import { iconButton, tray, type Icon } from '../ui/buttons';
import { Frame, type LayoutStore } from '../ui/frame';

export const PLAYGROUND_CSS = `
  .pg-main { position: absolute; inset: 0; display: flex; flex-direction: column; }
  .pg-bar { display: flex; align-items: center; gap: 6px; padding: 6px 10px; border-bottom: 1px solid var(--vscode-panel-border, #8883); flex: none; flex-wrap: nowrap; overflow-x: auto; overflow-y: hidden; }
  .pg-bar > * { flex: none; }
  .pg-bar button.icon.on { background: var(--vscode-toolbar-activeBackground, #8883); }
  .pg-bar select { font: inherit; font-size: 12px; padding: 2px 4px; border-radius: 4px; color: var(--vscode-dropdown-foreground); background: var(--vscode-dropdown-background); border: 1px solid var(--vscode-dropdown-border, #8884); }
  .pg-bar .status { font-size: 11px; opacity: .7; white-space: nowrap; }
  .pg-view { position: relative; flex: 1; min-height: 0; overflow: hidden; cursor: grab; background: color-mix(in srgb, var(--vscode-foreground) 4%, var(--vscode-editor-background)); }
  .pg-view.dragging { cursor: grabbing; }
  .pg-content { position: absolute; left: 0; top: 0; transform-origin: 0 0; }
  .pg-tile { position: absolute; border-radius: 8px; background: var(--vscode-editorWidget-background, #2a2c31); box-shadow: 0 0 0 1px color-mix(in srgb, var(--vscode-foreground) 18%, transparent); cursor: pointer; }
  .pg-tile.on { box-shadow: 0 0 0 2px var(--vscode-focusBorder, #39f); }
  .pg-tile.second { box-shadow: 0 0 0 2px var(--vscode-charts-purple, #b180d7); }
  .pg-tile .head { display: flex; align-items: center; gap: 6px; height: 28px; padding: 0 10px; font-size: 12px; white-space: nowrap; overflow: hidden; }
  .pg-tile .head .n { font-weight: 600; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
  .pg-tile .head .tag { font-size: 10px; padding: 0 6px; border-radius: 8px; opacity: .75; background: #8882; }
  .pg-tile .head .tag.draft { color: var(--vscode-editorWarning-foreground, #cca700); }
  .pg-tile .area { position: absolute; left: 0; right: 0; top: 28px; bottom: 0; overflow: hidden; border-radius: 0 0 8px 8px; display: flex; align-items: center; justify-content: center; }
  .pg-tile .area img { display: block; max-width: 100%; max-height: 100%; }
  .pg-tile .area .note { padding: 16px; font-size: 12px; opacity: .7; text-align: center; line-height: 1.5; }
  .pg-live { position: absolute; border: 0; background: #fff; border-radius: 0 0 8px 8px; }
  .pg-painter { position: absolute; left: 0; top: 0; border: 0; opacity: .01; pointer-events: none; z-index: -1; }
  .pg-empty { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; text-align: center; padding: 24px; opacity: .7; }
  .pg-compare { position: absolute; inset: 0; z-index: 5; display: flex; flex-direction: column; background: var(--vscode-editor-background); }
  .pg-compare .row { display: flex; align-items: center; gap: 8px; padding: 6px 10px; border-bottom: 1px solid var(--vscode-panel-border, #8883); font-size: 12px; }
  .pg-compare .row input[type=range] { width: 160px; }
  .pg-compare .sides { flex: 1; min-height: 0; overflow: auto; display: flex; gap: 16px; padding: 16px; align-items: flex-start; justify-content: center; }
  .pg-compare figure { margin: 0; text-align: center; font-size: 12px; }
  .pg-compare figure img { display: block; max-width: 100%; margin-top: 6px; box-shadow: 0 0 0 1px #8884; }
  .pg-compare .over { position: relative; margin: auto; }
  .pg-compare .over img { position: absolute; left: 0; top: 0; }
  .pg-data { height: 100%; overflow: auto; padding: 10px; font-size: 12px; display: flex; flex-direction: column; gap: 8px; }
  .pg-data h4 { margin: 8px 0 0; font-size: 11px; letter-spacing: .05em; text-transform: uppercase; opacity: .65; }
  .pg-data input[type=text] { font: inherit; font-size: 12px; padding: 3px 7px; border-radius: 4px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, #8884); min-width: 0; }
  .pg-data textarea { width: 100%; box-sizing: border-box; min-height: 180px; resize: vertical; font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, #8884); border-radius: 4px; padding: 6px 8px; }
  .pg-data .hint { opacity: .65; line-height: 1.5; }
  .pg-data .err { color: var(--vscode-errorForeground, #f48771); }
  .pg-data .why { padding: 8px 10px; border-radius: 6px; line-height: 1.5; background: color-mix(in srgb, var(--vscode-editorWarning-foreground, #cca700) 13%, transparent); }
  .pg-data .sug { display: flex; align-items: center; gap: 6px; padding: 2px 0; }
  .pg-data .sug span { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .pg-data .name { display: flex; gap: 6px; align-items: center; }
  .pg-data .name input { flex: 1; }
`;

/** Screen sizes for the whole board. */
const SCREENS: { id: string; icon: Icon; name: string; width: number; height: number }[] = [
  { id: 'phone', icon: 'phone', name: 'Phone', width: 390, height: 844 },
  { id: 'tablet', icon: 'tablet', name: 'Tablet', width: 820, height: 1180 },
  { id: 'laptop', icon: 'laptop', name: 'Laptop', width: 1366, height: 768 },
  { id: 'desktop', icon: 'desktop', name: 'Desktop', width: 1920, height: 1080 },
];

const GAP = 28;
const HEAD = 28;

interface Picture {
  src?: string;
  w: number;
  h: number;
  empty?: boolean;
}

interface Tile {
  id: number;
  name: string;
  props: Record<string, unknown>;
  /** Kept in the file (else a draft: from a suggestion, or added here, until kept). */
  kept: boolean;
  picture?: Picture;
  error?: string;
  painting?: boolean;
  /** Where it sits on the board. */
  x: number;
  y: number;
  h: number;
}

interface Deps {
  post(m: FromMap): void;
  store: LayoutStore;
}

export class Playground {
  readonly frame: Frame;
  private readonly view = el('div', 'pg-view');
  private readonly content = el('div', 'pg-content');
  private readonly data = el('div', 'pg-data');
  private readonly status = el('span', 'status');
  private readonly liveCount = el('select');
  private readonly compareButton = iconButton('compare', 'Compare the two chosen tiles (shift-click a second one)');
  /** Tiles are drawn again often; live tiles' apps sit in a layer of their own (moving an iframe reloads it). */
  private readonly tilesLayer = el('div');
  private readonly liveLayer = el('div');
  private readonly screenButtons = new Map<string, HTMLButtonElement>();
  private item: Item | undefined;
  private file: string | undefined;
  private pages: string[] = [];
  private suggestions: DataCase[] = [];
  private example: Record<string, unknown> = {};
  private tiles: Tile[] = [];
  private nextId = 1;
  private chosen: number[] = [];
  private screen = SCREENS[0];
  private app: string | undefined;
  /** Pan and zoom of the board. */
  private at = { x: 40, y: 30, k: 0.6 };
  /** The hidden copy of the app that draws pictures, one tile at a time. */
  private painter: HTMLIFrameElement | undefined;
  private painterReady = false;
  private painting: Tile | undefined;
  private paintTimer: ReturnType<typeof setTimeout> | undefined;
  /** Live tiles: the real app, for tiles clicked (the oldest goes back to a picture when there are too many). */
  private readonly live = new Map<number, { iframe: HTMLIFrameElement; ready: boolean }>();
  private asked = 0;
  private readonly waiting = new Map<number, (m: Record<string, unknown>) => void>();
  private compare: HTMLElement | undefined;

  constructor(private readonly deps: Deps) {
    this.frame = new Frame('playground', deps.store, { right: { panels: ['data'], size: 340 } }, { size: { width: 'min(1400px, 96vw)', height: 'min(900px, 92vh)' } });
    this.frame.title.textContent = 'Playground';
    this.frame.setPanels([{ id: 'data', icon: 'props', name: 'Data: the chosen tile’s props, kept in Name.variants.json; suggested cases', body: this.data }]);
    this.frame.onClose = () => this.stopAll();

    const bar = tray(el('div', 'pg-bar'));
    const screens = tray(el('div'));
    for (const s of SCREENS) {
      const b = iconButton(s.icon, `${s.name}: every tile ${s.width} wide`);
      b.addEventListener('click', () => this.setScreen(s));
      this.screenButtons.set(s.id, b);
      screens.append(b);
    }
    const zoom = tray(el('div'));
    const out = iconButton('zoomOut', 'Zoom out');
    out.addEventListener('click', () => this.zoomBy(1 / 1.25));
    const inn = iconButton('zoomIn', 'Zoom in');
    inn.addEventListener('click', () => this.zoomBy(1.25));
    const fit = iconButton('fitMap', 'Fit every tile in view');
    fit.addEventListener('click', () => this.fit());
    zoom.append(out, inn, fit);
    const tools = tray(el('div'));
    const add = iconButton('add', 'Add a case (a copy of the chosen tile’s props, to change)');
    add.addEventListener('click', () => this.addCase());
    const redraw = iconButton('reload', 'Draw every tile again');
    redraw.addEventListener('click', () => this.repaintAll());
    this.compareButton.addEventListener('click', () => this.openCompare());
    tools.append(add, redraw, this.compareButton);
    for (const n of [1, 2, 3]) this.liveCount.append(Object.assign(el('option', undefined, `${n} live`), { value: String(n) }));
    this.liveCount.dataset.tip = 'How many tiles are live at once (the real app); the others are pictures';
    this.liveCount.addEventListener('change', () => this.trimLive());
    bar.append(screens, zoom, tools, this.liveCount, this.status);

    const main = el('div', 'pg-main');
    this.content.append(this.tilesLayer, this.liveLayer);
    this.view.append(this.content);
    main.append(bar, this.view);
    this.frame.main.append(main);
    this.panAndZoom();
  }

  // ---- Opening ----

  /** Opens it for a component card (VS Code answers with its cases). */
  open(item: Item) {
    this.stopAll();
    this.item = item;
    this.frame.title.textContent = `Playground: ${item.label}`;
    this.tiles = [];
    this.chosen = [];
    this.tilesLayer.replaceChildren(el('div', 'pg-empty', 'Reading its cases…'));
    this.frame.open();
    this.deps.post({ type: 'playground', id: item.id });
    // The app, through the proxy (started if needed): the same address Preview uses.
    this.deps.post({ type: 'app' });
  }

  get isOpen(): boolean {
    return this.frame.isOpen;
  }

  /** Its cases, from VS Code. */
  receive(m: { item: Item; file?: string; cases: DataCase[]; example: Record<string, unknown>; suggestions: DataCase[]; pages: string[] }) {
    if (!this.item || m.item.id !== this.item.id) return;
    this.item = m.item;
    this.file = m.file;
    this.pages = m.pages;
    this.example = m.example;
    this.suggestions = m.suggestions;
    const cases = m.cases.length ? m.cases.map((c) => ({ ...c, kept: true })) : [{ name: 'made from its types', props: m.example, kept: false }];
    this.tiles = cases.map((c) => ({ id: this.nextId++, name: c.name, props: c.props, kept: c.kept, x: 0, y: 0, h: 200 }));
    this.chosen = this.tiles.length ? [this.tiles[0].id] : [];
    this.setScreen(this.screen, true);
    this.startPainter();
    this.renderData();
  }

  /** The app's address (when it's running). */
  receiveApp(m: { url?: string; error?: string }) {
    if (m.error && this.isOpen) this.status.textContent = `The app couldn’t start: ${m.error}`;
    if (!m.url) return;
    const url = m.url.replace(/\/$/, '');
    if (url === this.app) return;
    this.app = url;
    if (this.isOpen && this.item) this.startPainter();
  }

  casesSaved(m: { id: string; file: string }) {
    if (m.id !== this.item?.id) return;
    this.file = m.file;
    this.status.textContent = `Kept in ${m.file}`;
  }

  // ---- The board ----

  private setScreen(s: (typeof SCREENS)[number], keepPictures = false) {
    const changed = s.id !== this.screen.id;
    this.screen = s;
    for (const [id, b] of this.screenButtons) b.classList.toggle('on', id === s.id);
    if (changed && !keepPictures) {
      for (const t of this.tiles) t.picture = undefined;
      this.stopLive();
      if (this.painter) this.sizePainter();
    }
    this.layout();
    this.fit();
    this.paintNext();
  }

  /** Tiles in one column (a column per design comes later), each as tall as its picture. */
  private layout() {
    let y = 0;
    for (const t of this.tiles) {
      t.x = 0;
      t.y = y;
      t.h = HEAD + Math.min(this.screen.height, Math.max(160, (t.picture && !t.picture.empty ? t.picture.h : 120) + 64));
      y += t.h + GAP;
    }
    this.draw();
  }

  private draw() {
    if (!this.tiles.length) {
      this.tilesLayer.replaceChildren(el('div', 'pg-empty', 'No cases yet.'));
      return;
    }
    const nodes: HTMLElement[] = [];
    for (const t of this.tiles) {
      const box = el('div', `pg-tile${this.chosen[this.chosen.length - 1] === t.id ? ' on' : this.chosen.includes(t.id) ? ' second' : ''}`);
      box.style.left = `${t.x}px`;
      box.style.top = `${t.y}px`;
      box.style.width = `${this.screen.width}px`;
      box.style.height = `${t.h}px`;
      const head = el('div', 'head');
      head.append(el('span', 'n', t.name));
      if (!t.kept) head.append(el('span', 'tag draft', 'not kept yet'));
      if (this.live.has(t.id)) head.append(el('span', 'tag', 'live'));
      head.dataset.tip = `${t.name}${t.kept ? '' : ' (not kept yet: keep it from the Data panel)'}`;
      const area = el('div', 'area');
      const live = this.live.get(t.id);
      if (live) {
        // Its app sits over the area, in the live layer (never moved, so never reloaded).
        Object.assign(live.iframe.style, { left: `${t.x}px`, top: `${t.y + HEAD}px`, width: `${this.screen.width}px`, height: `${t.h - HEAD}px` });
      } else if (t.picture?.src) {
        // At its real size (the picture has more pixels, for sharpness).
        const img = Object.assign(el('img'), { src: t.picture.src, alt: t.name, draggable: false });
        img.style.width = `${t.picture.w}px`;
        area.append(img);
      }
      else area.append(el('div', 'note', t.error ? 'Can’t be shown on its own here: the Data panel says why.' : t.painting ? 'Drawing…' : t.picture?.empty ? 'It drew itself with no size (closed or empty with these props).' : 'Waiting to be drawn…'));
      box.append(head, area);
      box.addEventListener('click', (e) => this.choose(t, e.shiftKey));
      nodes.push(box);
    }
    this.tilesLayer.replaceChildren(...nodes);
    this.compareButton.disabled = this.chosen.length < 2;
    this.place();
  }

  private place() {
    this.content.style.transform = `translate(${this.at.x}px, ${this.at.y}px) scale(${this.at.k})`;
  }

  private zoomBy(f: number, cx?: number, cy?: number) {
    const r = this.view.getBoundingClientRect();
    const x = cx ?? r.width / 2;
    const y = cy ?? r.height / 2;
    const k = Math.min(2, Math.max(0.1, this.at.k * f));
    this.at.x = x - ((x - this.at.x) * k) / this.at.k;
    this.at.y = y - ((y - this.at.y) * k) / this.at.k;
    this.at.k = k;
    this.place();
  }

  private fit() {
    const r = this.view.getBoundingClientRect();
    const last = this.tiles[this.tiles.length - 1];
    if (!last || !r.width) return;
    const w = this.screen.width;
    const h = last.y + last.h;
    this.at.k = Math.min(1, Math.max(0.1, Math.min((r.width - 60) / w, (r.height - 60) / h)));
    this.at.x = (r.width - w * this.at.k) / 2;
    this.at.y = 30;
    this.place();
  }

  /** Drag to move the board; the wheel moves it too, and zooms with Ctrl (or a pinch). */
  private panAndZoom() {
    let drag: { x: number; y: number; ax: number; ay: number } | undefined;
    this.view.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || (e.target as Element).closest('.pg-tile, .pg-compare')) return;
      drag = { x: e.clientX, y: e.clientY, ax: this.at.x, ay: this.at.y };
      this.view.setPointerCapture(e.pointerId);
      this.view.classList.add('dragging');
    });
    this.view.addEventListener('pointermove', (e) => {
      if (!drag) return;
      this.at.x = drag.ax + e.clientX - drag.x;
      this.at.y = drag.ay + e.clientY - drag.y;
      this.place();
    });
    const end = () => {
      drag = undefined;
      this.view.classList.remove('dragging');
    };
    this.view.addEventListener('pointerup', end);
    this.view.addEventListener('pointercancel', end);
    this.view.addEventListener(
      'wheel',
      (e) => {
        if ((e.target as Element).closest('.pg-compare')) return;
        e.preventDefault();
        const r = this.view.getBoundingClientRect();
        if (e.ctrlKey || e.metaKey) this.zoomBy(Math.exp(-e.deltaY / 300), e.clientX - r.left, e.clientY - r.top);
        else {
          this.at.x -= e.deltaX;
          this.at.y -= e.deltaY;
          this.place();
        }
      },
      { passive: false },
    );
  }

  // ---- Choosing, live tiles ----

  /** A click chooses a tile (shift: a second one, to compare) and makes it live. */
  private choose(t: Tile, second: boolean) {
    if (second) {
      this.chosen = [...this.chosen.filter((id) => id !== t.id), t.id].slice(-2);
    } else {
      this.chosen = [t.id];
      this.makeLive(t);
    }
    this.draw();
    this.renderData();
  }

  private makeLive(t: Tile) {
    if (!this.app || this.live.has(t.id)) return;
    const iframe = el('iframe', 'pg-live');
    iframe.title = `${t.name}, live`;
    this.live.set(t.id, { iframe, ready: false });
    iframe.src = `${this.app}${this.page()}`;
    this.liveLayer.append(iframe);
    this.trimLive();
  }

  /** Too many live tiles: the oldest go back to pictures (taken from them, as they are now). */
  private trimLive() {
    const max = Number(this.liveCount.value) || 1;
    for (const id of [...this.live.keys()].slice(0, Math.max(0, this.live.size - max))) this.endLive(id);
    this.draw();
  }

  private endLive(id: number) {
    const l = this.live.get(id);
    if (!l) return;
    const t = this.tiles.find((x) => x.id === id);
    if (l.ready && t && l.iframe.contentWindow) {
      void this.ask(l.iframe, { type: 'snapshot' }).then((m) => {
        const pic = m.picture as Picture | null;
        if (pic?.src) t.picture = pic;
        l.iframe.remove();
        this.layout();
      });
    } else l.iframe.remove();
    this.live.delete(id);
  }

  private stopLive() {
    for (const [, l] of this.live) l.iframe.remove();
    this.live.clear();
  }

  // ---- Drawing pictures ----

  /** The page tiles are drawn on: one the component is on, so what it needs from around it is there. */
  private page(): string {
    return this.pages.find((p) => !/[:*]/.test(p)) ?? '/';
  }

  private startPainter() {
    if (!this.app || !this.item || !this.tiles.length) return;
    this.painter?.remove();
    this.painterReady = false;
    this.painting = undefined;
    const iframe = el('iframe', 'pg-painter');
    iframe.title = 'Drawing the tiles';
    this.painter = iframe;
    this.sizePainter();
    iframe.src = `${this.app}${this.page()}`;
    this.view.append(iframe);
    this.status.textContent = 'Starting the app to draw the tiles…';
  }

  private sizePainter() {
    if (!this.painter) return;
    this.painter.style.width = `${this.screen.width}px`;
    this.painter.style.height = `${this.screen.height}px`;
  }

  /** The next tile without a picture, drawn by the hidden copy of the app. */
  private paintNext() {
    if (!this.painter || !this.painterReady || this.painting || !this.item?.source) return;
    const t = this.tiles.find((x) => !x.picture && !x.error && !this.live.has(x.id));
    if (!t) {
      const n = this.tiles.filter((x) => x.picture?.src).length;
      this.status.textContent = `${n} of ${this.tiles.length} drawn`;
      return;
    }
    this.painting = t;
    t.painting = true;
    this.status.textContent = `Drawing “${t.name}”…`;
    this.draw();
    const done = (m: Record<string, unknown>) => {
      clearTimeout(this.paintTimer);
      t.painting = false;
      if (m.error) t.error = String(m.error);
      else t.picture = (m.picture as Picture | null) ?? { w: 0, h: 0, empty: true };
      this.painting = undefined;
      this.layout();
      if (this.chosen.includes(t.id)) this.renderData();
      this.paintNext();
    };
    const timeout = new Promise<Record<string, unknown>>((resolve) => (this.paintTimer = setTimeout(() => resolve({ error: 'It took too long to draw.' }), 12_000)));
    void Promise.race([this.ask(this.painter, { type: 'aloneShow', file: this.item.source.path, name: this.item.label, props: t.props }), timeout]).then(done);
  }

  /** A case with the real props a copy of it has on the page (once per opening), first on the board. */
  private async fromThePage() {
    if (!this.painter || !this.item?.source || this.tiles.some((t) => t.name === 'as on the page')) return;
    const m = await Promise.race([this.ask(this.painter, { type: 'aloneProps', file: this.item.source.path, name: this.item.label }), new Promise<Record<string, unknown>>((r) => setTimeout(() => r({}), 4000))]);
    const props = m.props as Record<string, unknown> | null | undefined;
    if (!props) return;
    const tile: Tile = { id: this.nextId++, name: 'as on the page', props, kept: false, x: 0, y: 0, h: 200 };
    // Real data beats made-up data: it replaces the case made from the types.
    this.tiles = [tile, ...this.tiles.filter((t) => !(t.name === 'made from its types' && !t.kept))];
    // Suggestions change the real data now.
    if (!this.tiles.some((t) => t.kept)) this.suggestions = suggestCases(this.item.fields ?? [], props);
    this.chosen = [tile.id];
    this.layout();
    this.renderData();
  }

  private repaintAll() {
    for (const t of this.tiles) {
      t.picture = undefined;
      t.error = undefined;
    }
    this.layout();
    this.paintNext();
  }

  private repaint(t: Tile) {
    t.picture = undefined;
    t.error = undefined;
    const l = this.live.get(t.id);
    if (l?.ready) void this.showIn(l.iframe, t).then(() => this.layout());
    this.layout();
    this.paintNext();
  }

  /** Asks a page (a tile's app) and waits for its answer. */
  private ask(iframe: HTMLIFrameElement, m: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = ++this.asked;
    return new Promise((resolve) => {
      this.waiting.set(id, resolve);
      iframe.contentWindow?.postMessage({ source: 've-preview', ...m, id }, '*');
    });
  }

  private showIn(iframe: HTMLIFrameElement, t: Tile) {
    return this.ask(iframe, { type: 'aloneShow', file: this.item!.source!.path, name: this.item!.label, props: t.props }).then((m) => {
      if (m.error) t.error = String(m.error);
      else if ((m.picture as Picture | null)?.src) t.picture = m.picture as Picture;
    });
  }

  /** What the pages say (through their inspectors). */
  fromPage(data: Record<string, unknown>, source: MessageEventSource | null) {
    if (!source) return;
    const fromPainter = this.painter && source === this.painter.contentWindow;
    const liveEntry = [...this.live.entries()].find(([, l]) => l.iframe.contentWindow === source);
    if (!fromPainter && !liveEntry) return;
    if (data.type === 'hello') {
      // The app has to draw itself first (what the component needs from around it comes from there).
      setTimeout(() => {
        if (fromPainter) {
          this.painterReady = true;
          void this.fromThePage().then(() => this.paintNext());
        } else if (liveEntry) {
          const [id, l] = liveEntry;
          l.ready = true;
          const t = this.tiles.find((x) => x.id === id);
          if (t) void this.showIn(l.iframe, t).then(() => this.layout());
        }
      }, 900);
      return;
    }
    if ((data.type === 'aloneShown' || data.type === 'snapshot' || data.type === 'aloneProps') && typeof data.id === 'number') {
      const w = this.waiting.get(data.id);
      this.waiting.delete(data.id);
      w?.(data);
    }
  }

  private stopAll() {
    clearTimeout(this.paintTimer);
    this.painter?.remove();
    this.painter = undefined;
    this.painterReady = false;
    this.painting = undefined;
    this.stopLive();
    this.closeCompare();
  }

  // ---- The Data panel ----

  private chosenTile(): Tile | undefined {
    const id = this.chosen[this.chosen.length - 1];
    return this.tiles.find((t) => t.id === id);
  }

  private renderData() {
    const d = this.data;
    d.replaceChildren();
    const t = this.chosenTile();
    if (!this.item) return;
    if (!t) {
      d.append(el('div', 'hint', 'Choose a tile to see and change its data.'));
      return;
    }
    const name = el('div', 'name');
    const nameBox = el('input');
    nameBox.type = 'text';
    nameBox.value = t.name;
    nameBox.addEventListener('keydown', (e) => e.stopPropagation());
    nameBox.addEventListener('change', () => {
      t.name = nameBox.value.trim() || t.name;
      this.draw();
      if (t.kept) this.save();
    });
    name.append(nameBox);
    d.append(name);
    d.append(el('div', 'hint', t.kept ? `Kept in ${this.file ?? 'its variants file'}.` : 'Not kept yet: keep it to save it next to the component.'));
    if (t.error) d.append(this.why(t.error));

    d.append(el('h4', undefined, 'Props'));
    d.append(el('div', 'hint', 'As JSON. A function: {"$action": "name"} (it says when it’s called).'));
    const box = el('textarea');
    box.spellcheck = false;
    box.value = JSON.stringify(t.props, null, 2);
    const err = el('div', 'err');
    const apply = (): boolean => {
      try {
        t.props = JSON.parse(box.value);
        err.textContent = '';
        this.repaint(t);
        return true;
      } catch {
        err.textContent = 'That isn’t JSON yet.';
        return false;
      }
    };
    box.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) apply();
    });
    d.append(box, err);
    const acts = tray(el('div'));
    const draw = iconButton('choose', 'Draw it with these props (⌘ Enter)');
    draw.addEventListener('click', () => apply());
    const keep = iconButton('add', t.kept ? 'Keep these props in the file' : 'Keep this case in the file (next to the component)', { cls: 'primary' });
    keep.addEventListener('click', () => {
      if (!apply()) return;
      t.kept = true;
      this.save();
      this.draw();
      this.renderData();
    });
    const copy = iconButton('example', 'A copy of this case, to change');
    copy.addEventListener('click', () => this.addCase());
    const remove = iconButton('trash', t.kept ? 'Remove this case (from the file too)' : 'Remove this case');
    remove.addEventListener('click', () => {
      const wasKept = t.kept;
      this.live.get(t.id)?.iframe.remove();
      this.live.delete(t.id);
      this.tiles = this.tiles.filter((x) => x.id !== t.id);
      this.chosen = this.tiles.length ? [this.tiles[0].id] : [];
      if (wasKept) this.save();
      this.layout();
      this.renderData();
    });
    acts.append(draw, keep, copy, remove);
    d.append(acts);

    // Suggestions not on the board yet.
    const shown = new Set(this.tiles.map((x) => x.name));
    const left = this.suggestions.filter((s) => !shown.has(s.name));
    if (left.length) {
      d.append(el('h4', undefined, 'Suggested cases'));
      d.append(el('div', 'hint', 'From its props’ types: each changes one thing. Add one to see it.'));
      for (const s of left) {
        const row = el('div', 'sug');
        row.append(el('span', undefined, s.name));
        const add = iconButton('add', `Add “${s.name}” to the board`);
        add.addEventListener('click', () => {
          const tile: Tile = { id: this.nextId++, name: s.name, props: s.props, kept: false, x: 0, y: 0, h: 200 };
          this.tiles.push(tile);
          this.chosen = [tile.id];
          this.layout();
          this.renderData();
          this.paintNext();
        });
        const t2 = tray(el('div'));
        t2.append(add);
        row.append(t2);
        d.append(row);
      }
    }
  }

  /** Why a case can't be drawn on its own, and what to do, in words (never the error). */
  private why(error: string): HTMLElement {
    const box = el('div', 'why');
    const pages = this.pages.join(', ');
    let text: string;
    if (/React Flow|zustand provider|provider|ancestor|must be (used|rendered) (within|inside)|<Router>|useNavigate|useLocation|QueryClient|context/i.test(error)) {
      text = `It uses something only the page around it sets up, and the page tiles are drawn on (${this.page()}) doesn’t have it.${pages ? ` It’s drawn on ${pages}.` : ''} Pick it on such a page in Preview and use “Show it alone” there.`;
    } else if (/isn’t exported/.test(error)) text = 'It isn’t exported from its file, so it can’t be loaded by itself. Pick it on a page in Preview and use “Show it alone”.';
    else if (/React’s modules|modules don’t look|No plugin here/.test(error)) text = 'Drawing a component on its own needs the app on Vite’s dev server, with a plugin that can draw it (React’s).';
    else if (/too long/.test(error)) text = 'It took too long to draw (the app may still be starting). Draw it again.';
    else if (/Cannot read propert|undefined is not|is not a function|is not iterable|of null|of undefined/i.test(error)) text = 'It needs data in its props that these props don’t have. Fill them in above.';
    else text = 'It stopped while drawing with these props. Change them above, or pick it on a page in Preview and use “Show it alone”.';
    box.textContent = text;
    return box;
  }

  private addCase() {
    const from = this.chosenTile();
    const tile: Tile = { id: this.nextId++, name: `case ${this.tiles.length + 1}`, props: structuredClone(from?.props ?? this.example), kept: false, x: 0, y: 0, h: 200 };
    this.tiles.push(tile);
    this.chosen = [tile.id];
    this.layout();
    this.renderData();
    this.paintNext();
  }

  /** The kept cases, in their order, to the file. */
  private save() {
    if (!this.item) return;
    this.deps.post({ type: 'saveCases', id: this.item.id, cases: this.tiles.filter((t) => t.kept).map((t) => ({ name: t.name, props: t.props })) });
  }

  // ---- Compare ----

  private openCompare() {
    const [a, b] = this.chosen.map((id) => this.tiles.find((t) => t.id === id)).filter((t): t is Tile => !!t);
    if (!a || !b) return;
    this.closeCompare();
    const box = el('div', 'pg-compare');
    const row = el('div', 'row');
    const mode = el('select');
    for (const [v, t] of [['side', 'Side by side'], ['over', 'One over the other']]) mode.append(Object.assign(el('option', undefined, t), { value: v }));
    const fade = el('input');
    fade.type = 'range';
    fade.min = '0';
    fade.max = '100';
    fade.value = '50';
    fade.dataset.tip = `How much of “${b.name}” shows over “${a.name}”`;
    const close = iconButton('close', 'Close the comparison');
    close.addEventListener('click', () => this.closeCompare());
    const t = tray(el('div'));
    t.append(close);
    row.append(el('b', undefined, `${a.name}  ·  ${b.name}`), mode, fade, t);
    const sides = el('div', 'sides');
    const img = (x: Tile) => {
      if (!x.picture?.src) return el('div', undefined, '(not drawn)');
      const i = Object.assign(el('img'), { src: x.picture.src, alt: x.name });
      i.style.width = `${x.picture.w}px`;
      return i;
    };
    const show = () => {
      fade.hidden = mode.value !== 'over';
      if (mode.value === 'side') {
        const fa = el('figure');
        fa.append(el('figcaption', undefined, a.name), img(a));
        const fb = el('figure');
        fb.append(el('figcaption', undefined, b.name), img(b));
        sides.replaceChildren(fa, fb);
      } else {
        const over = el('div', 'over');
        const ia = img(a);
        const ib = img(b);
        over.style.width = `${Math.max(a.picture?.w ?? 0, b.picture?.w ?? 0)}px`;
        over.style.height = `${Math.max(a.picture?.h ?? 0, b.picture?.h ?? 0)}px`;
        ib.style.opacity = String(Number(fade.value) / 100);
        over.append(ia, ib);
        sides.replaceChildren(over);
      }
    };
    mode.addEventListener('change', show);
    fade.addEventListener('input', show);
    box.append(row, sides);
    show();
    this.compare = box;
    this.view.append(box);
  }

  private closeCompare() {
    this.compare?.remove();
    this.compare = undefined;
  }
}
