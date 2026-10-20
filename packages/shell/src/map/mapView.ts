// A map you can move around in: drag the background, scroll to move, pinch or Ctrl/Cmd+scroll to zoom. Used by the
// map page and by the Focus view, so both stay smooth with tens of thousands of cards:
// - zoomed in, only the cards on screen exist as elements (made and removed while moving), found through a grid;
// - folder boxes, lines and (zoomed out) the cards themselves are painted on one canvas the size of the view, which
//   the GPU draws; zoomed out, the view is painted once into a picture a bit bigger than the screen and slid while
//   panning, painted again only when the view leaves it, the zoom settles, or something on it changes;
// - with very many lines, a zoomed-out map joins the lines between two folders into one.

import type { Layout, PlacedCard } from '../layout';
import type { Item } from '@visual-editor/contract';
import type { ShowMap } from '../mapMessages';
import type { Tone } from '../styles';
import { el } from '../ui/dom';

/** What a view needs from its page: colours, marks, and how a card element looks. */
export interface Look {
  paint(t: Tone | undefined): string | undefined;
  colours(): ShowMap['colours'];
  marks(): ShowMap['marks'];
  /** A card's element (its face), placed at its position; the view adds the clicks. */
  drawCard(c: PlacedCard): HTMLElement;
}

export interface Hooks {
  /** A card was clicked (or the background: undefined). */
  pick(id: string | undefined): void;
  /** A card was double-clicked. */
  open(item: Item): void;
  /** The view moved or zoomed. */
  moved?(view: { x: number; y: number; k: number }): void;
}

type Rect = { x0: number; y0: number; x1: number; y1: number };

/** Below this zoom, cards are painted (names only), not elements. */
export const FAR = 0.55;
/** As far out as a map goes (a very big map may go further, to fit). */
const MIN_ZOOM = 0.08;
const CELL = 600;
/** Above this many lines, a zoomed-out map joins the lines between two folders into one. */
const MAX_FAR_LINES = 3000;
/** A chosen card's lines show their names only when it has at most this many (more would pile up). */
const MAX_NAMED_LINES = 8;
/** Never more card elements than this at once (zoomed in on a huge screen). */
const MAX_CARD_ELEMENTS = 1500;

export class MapView {
  view = { x: 40, y: 40, k: 1 };
  layout: Layout = { sections: [], links: [], width: 0, height: 0 };
  selected: string | undefined;
  minZoom = MIN_ZOOM;
  /** When the last zoom step happened (a zoom in progress shows the last picture, stretched). */
  lastZoomAt = 0;
  /** Cards that exist as elements now (the ones on screen, zoomed in). */
  readonly cardEls = new Map<string, HTMLElement>();
  placedById = new Map<string, PlacedCard>();
  linksOf = new Map<string, Layout['links']>();
  private sectionOf = new Map<string, number>();
  private grid = new Map<string, PlacedCard[]>();
  private readonly sky = el('canvas', 'sky');
  readonly world = el('div', 'world');
  private readonly labels = el('div', 'labels');
  /** Folder names, with the box each is pinned to. */
  private tags: { el: HTMLElement; x: number; y: number; w: number }[] = [];
  private ink = { fg: '#ccc', widget: '#2a2a2a', border: '#8884', bg: '#1e1e1e', text: '#ddd' };
  private snapshot: { canvas: HTMLCanvasElement; k: number; x0: number; y0: number; x1: number; y1: number; version: number } | undefined;
  /** Bumped whenever what's painted changes (a new layout, a card chosen). */
  private paintVersion = 0;
  private settleTimer: ReturnType<typeof setTimeout> | undefined;
  private renderQueued = false;
  private drag: { x: number; y: number; vx: number; vy: number } | undefined;

  constructor(
    readonly stage: HTMLElement,
    private readonly look: Look,
    private readonly hooks: Hooks,
  ) {
    stage.classList.add('mv');
    stage.append(this.sky, this.world, this.labels);
    stage.addEventListener('pointerdown', (e) => {
      this.drag = { x: e.clientX, y: e.clientY, vx: this.view.x, vy: this.view.y };
      stage.setPointerCapture(e.pointerId);
      stage.classList.add('dragging');
    });
    stage.addEventListener('pointermove', (e) => {
      if (!this.drag) return;
      this.view.x = this.drag.vx + e.clientX - this.drag.x;
      this.view.y = this.drag.vy + e.clientY - this.drag.y;
      this.applyView();
    });
    const endDrag = (e: PointerEvent) => {
      // A click (not a drag) on the background: zoomed out, it may be on a painted card.
      if (this.drag && Math.abs(e.clientX - this.drag.x) + Math.abs(e.clientY - this.drag.y) < 3) this.hooks.pick(this.view.k < FAR ? this.cardAt(e.clientX, e.clientY)?.item.id : undefined);
      this.drag = undefined;
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
          this.zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.01));
        } else {
          this.view.x -= e.deltaX;
          this.view.y -= e.deltaY;
          this.applyView();
        }
      },
      { passive: false },
    );
    stage.addEventListener('dblclick', (e) => {
      const c = this.view.k < FAR ? this.cardAt(e.clientX, e.clientY) : undefined;
      if (c) this.hooks.open(c.item);
    });
    new ResizeObserver(() => this.requestRender()).observe(stage);
  }

  /** Zooms by `factor` around a point of the view (the view's middle by default). */
  zoomAt(px = this.stage.clientWidth / 2, py = this.stage.clientHeight / 2, factor = 1.25) {
    const k = Math.min(2, Math.max(this.minZoom, this.view.k * factor));
    this.lastZoomAt = performance.now();
    this.view = { k, x: px - ((px - this.view.x) * k) / this.view.k, y: py - ((py - this.view.y) * k) / this.view.k };
    this.applyView();
  }

  /** A new layout to show; the view stays where it is (fit() to see all of it). */
  setLayout(layout: Layout) {
    this.layout = layout;
    this.world.replaceChildren();
    this.labels.replaceChildren();
    this.tags = [];
    this.cardEls.clear();
    this.readInk();
    this.placedById = new Map();
    this.linksOf = new Map();
    this.sectionOf = new Map();
    this.grid = new Map();
    layout.sections.forEach((s, i) => {
      if (s.box) {
        const tag = el('div', 'tag', `${s.map.title}  ·  ${s.cards.length}`);
        const tint = this.look.paint(s.tint);
        if (tint) tag.style.color = tint;
        if (s.map.description) tag.title = s.map.description;
        this.labels.append(tag);
        this.tags.push({ el: tag, x: s.x, y: s.y, w: s.w });
      }
      for (const c of s.cards) {
        this.placedById.set(c.item.id, c);
        this.sectionOf.set(c.item.id, i);
        for (let gx = Math.floor(c.x / CELL); gx <= Math.floor((c.x + c.w) / CELL); gx++) {
          for (let gy = Math.floor(c.y / CELL); gy <= Math.floor((c.y + c.h) / CELL); gy++) {
            const key = `${gx},${gy}`;
            const cell = this.grid.get(key);
            if (cell) cell.push(c);
            else this.grid.set(key, [c]);
          }
        }
      }
    });
    for (const l of layout.links) {
      if (!this.placedById.has(l.from) || !this.placedById.has(l.to)) continue;
      for (const id of [l.from, l.to]) {
        const list = this.linksOf.get(id);
        if (list) list.push(l);
        else this.linksOf.set(id, [l]);
      }
    }
    if (this.selected && !this.placedById.has(this.selected)) this.selected = undefined;
    this.select(this.selected);
  }

  /** Highlights a card (or none) and its lines; the cards it has no line to step back. */
  select(id: string | undefined) {
    if (this.selected) this.cardEls.get(this.selected)?.classList.remove('selected');
    this.selected = id;
    if (id) this.cardEls.get(id)?.classList.add('selected');
    const near = this.nearSet();
    for (const [cid, card] of this.cardEls) card.classList.toggle('near', near.has(cid));
    this.world.classList.toggle('picked', !!id);
    this.paintVersion++;
    this.applyView();
  }

  /** Shows all of it. */
  fit() {
    const w = this.stage.clientWidth;
    const h = this.stage.clientHeight;
    if (!this.layout.width || !w || !h) {
      this.view = { x: 40, y: 40, k: 1 };
    } else {
      const fits = Math.min((w - 80) / this.layout.width, (h - 80) / this.layout.height);
      this.minZoom = Math.min(MIN_ZOOM, Math.max(0.005, fits));
      const k = Math.min(1, Math.max(this.minZoom, fits));
      this.view = { k, x: Math.max(40, (w - this.layout.width * k) / 2), y: Math.max(40, (h - this.layout.height * k) / 2) };
    }
    this.applyView();
  }

  /** Moves the view so a card is in the middle, close enough to read; `offsetX` keeps it clear of a side panel. */
  centre(id: string, offsetX = 0) {
    const c = this.placedById.get(id);
    if (!c) return;
    this.view.k = Math.max(this.view.k, 0.9);
    this.view.x = (this.stage.clientWidth - offsetX) / 2 - (c.x + c.w / 2) * this.view.k;
    this.view.y = this.stage.clientHeight / 2 - (c.y + c.h / 2) * this.view.k;
    this.applyView();
  }

  applyView() {
    const { x, y, k } = this.view;
    this.world.style.transform = `translate(${x}px, ${y}px) scale(${k})`;
    for (const t of this.tags) {
      // A folder's name shows once its box is big enough on screen to belong to it.
      t.el.hidden = t.w * k < 70;
      if (!t.el.hidden) Object.assign(t.el.style, { left: `${x + t.x * k + 8}px`, top: `${y + t.y * k}px`, maxWidth: `${Math.max(60, t.w * k - 16)}px` });
    }
    this.hooks.moved?.(this.view);
    this.requestRender();
  }

  /** Paints once per frame, however many moves came in. */
  requestRender() {
    if (this.renderQueued) return;
    this.renderQueued = true;
    requestAnimationFrame(() => {
      this.renderQueued = false;
      this.render();
    });
  }

  render() {
    const near = this.view.k >= FAR;
    this.syncCards(near ? this.cardsIn(this.inView(300)).slice(0, MAX_CARD_ELEMENTS) : []);
    this.paintSky(near);
  }

  /** The card at a point on screen. */
  cardAt(clientX: number, clientY: number): PlacedCard | undefined {
    const b = this.stage.getBoundingClientRect();
    const x = (clientX - b.left - this.view.x) / this.view.k;
    const y = (clientY - b.top - this.view.y) / this.view.k;
    return this.cardsIn({ x0: x, y0: y, x1: x, y1: y }).find((c) => x >= c.x && x <= c.x + c.w && y >= c.y && y <= c.y + c.h);
  }

  /** The part of the map on screen, in map units, with a margin. */
  private inView(margin = 0): Rect {
    const { x, y, k } = this.view;
    return { x0: -x / k - margin / k, y0: -y / k - margin / k, x1: (this.stage.clientWidth - x) / k + margin / k, y1: (this.stage.clientHeight - y) / k + margin / k };
  }

  /** Cards in (or near) a part of the map, from the grid. */
  private cardsIn(r: Rect): PlacedCard[] {
    const out = new Set<PlacedCard>();
    for (let gx = Math.floor(r.x0 / CELL); gx <= Math.floor(r.x1 / CELL); gx++) {
      for (let gy = Math.floor(r.y0 / CELL); gy <= Math.floor(r.y1 / CELL); gy++) {
        for (const c of this.grid.get(`${gx},${gy}`) ?? []) if (meets(c, r)) out.add(c);
      }
    }
    return [...out];
  }

  /** The chosen card and the cards it has a line to. */
  private nearSet(): Set<string> {
    if (!this.selected) return new Set();
    return new Set([this.selected, ...(this.linksOf.get(this.selected) ?? []).flatMap((l) => [l.from, l.to])]);
  }

  /** Card elements for the cards on screen: the ones that left are removed, the ones that came are made. */
  private syncCards(wanted: PlacedCard[]) {
    const keep = new Set(wanted.map((c) => c.item.id));
    for (const [id, card] of this.cardEls) {
      if (!keep.has(id)) {
        card.remove();
        this.cardEls.delete(id);
      }
    }
    const nearIds = this.nearSet();
    for (const c of wanted) {
      if (this.cardEls.has(c.item.id)) continue;
      const card = this.look.drawCard(c);
      card.addEventListener('pointerdown', (e) => e.stopPropagation());
      card.addEventListener('click', () => this.hooks.pick(c.item.id));
      card.addEventListener('dblclick', () => this.hooks.open(c.item));
      if (c.item.id === this.selected) card.classList.add('selected');
      if (nearIds.has(c.item.id)) card.classList.add('near');
      this.cardEls.set(c.item.id, card);
      this.world.append(card);
    }
  }

  /** Theme colours the canvas needs (read from the page, so they follow VS Code's theme). */
  private readInk() {
    const css = getComputedStyle(document.body);
    const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
    this.ink = { fg: v('--vscode-foreground', '#ccc'), widget: v('--vscode-editorWidget-background', '#2a2a2a'), border: v('--vscode-editorWidget-border', '#8884'), bg: v('--vscode-editor-background', '#1e1e1e'), text: v('--vscode-editor-foreground', '#ddd') };
  }

  private paintSky(near: boolean) {
    const dpr = window.devicePixelRatio || 1;
    const w = this.stage.clientWidth;
    const h = this.stage.clientHeight;
    const sky = this.sky;
    if (sky.width !== Math.round(w * dpr) || sky.height !== Math.round(h * dpr)) {
      sky.width = Math.round(w * dpr);
      sky.height = Math.round(h * dpr);
      this.snapshot = undefined;
    }
    const ctx = sky.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, sky.width, sky.height);
    const { x, y, k } = this.view;
    if (near) {
      this.snapshot = undefined;
      ctx.setTransform(dpr * k, 0, 0, dpr * k, dpr * x, dpr * y);
      this.paintContent(ctx, k, this.inView(40), true);
      return;
    }
    const r = this.inView(0);
    const s0 = this.snapshot;
    const fresh = s0 && s0.version === this.paintVersion && s0.k === k && r.x0 >= s0.x0 && r.y0 >= s0.y0 && r.x1 <= s0.x1 && r.y1 <= s0.y1;
    const zooming = performance.now() - this.lastZoomAt < 150;
    if (!fresh && !(zooming && s0 && s0.version === this.paintVersion)) {
      // Half a screen of margin on every side, so panning slides the same picture for a while.
      const rect = this.inView(Math.max(w, h) / 2);
      const scale = Math.min(dpr, 1.5) * k;
      const canvas = s0?.canvas ?? document.createElement('canvas');
      canvas.width = Math.max(1, Math.ceil((rect.x1 - rect.x0) * scale));
      canvas.height = Math.max(1, Math.ceil((rect.y1 - rect.y0) * scale));
      const sctx = canvas.getContext('2d');
      if (!sctx) return;
      sctx.setTransform(scale, 0, 0, scale, -rect.x0 * scale, -rect.y0 * scale);
      this.paintContent(sctx, k, rect, false);
      this.snapshot = { canvas, k, ...rect, version: this.paintVersion };
    } else if (!fresh) {
      // Still zooming: the last picture, stretched; painted sharp once the zoom settles.
      if (this.settleTimer) clearTimeout(this.settleTimer);
      this.settleTimer = setTimeout(() => this.requestRender(), 160);
    }
    const s = this.snapshot!;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(s.canvas, (s.x0 * k + x) * dpr, (s.y0 * k + y) * dpr, (s.x1 - s.x0) * k * dpr, (s.y1 - s.y0) * k * dpr);
  }

  /** Paints the boxes, lines and (zoomed out) cards for a part of the map, into a canvas already set to map units. */
  private paintContent(ctx: CanvasRenderingContext2D, k: number, r: Rect, near: boolean) {
    const { paint } = this.look;
    const colours = this.look.colours();
    const marks = this.look.marks();
    const layout = this.layout;
    const ink = this.ink;
    const selected = this.selected;
    const picked = !!selected;
    const nearIds = this.nearSet();
    const nameLines = (selected ? (this.linksOf.get(selected)?.length ?? 0) : 0) <= MAX_NAMED_LINES;

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
      const a = this.placedById.get(l.from);
      const b = this.placedById.get(l.to);
      return a && b ? { x1: a.x + a.w, y1: a.y + Math.min(a.h / 2, 28), x2: b.x, y2: b.y + Math.min(b.h / 2, 28) } : undefined;
    };
    if (near || layout.links.length <= MAX_FAR_LINES) {
      const list = near ? [...new Set(this.cardsIn(r).flatMap((c) => this.linksOf.get(c.item.id) ?? []))] : layout.links;
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
          // Its name too, unless the chosen card has so many lines that the names would pile up.
          const label = nameLines ? (l.label ?? l.kind) : undefined;
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
        const a = this.sectionOf.get(l.from);
        const b = this.sectionOf.get(l.to);
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
      for (const c of this.cardsIn(r)) {
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
}

const meets = (c: { x: number; y: number; w: number; h: number }, r: Rect) => c.x < r.x1 && c.x + c.w > r.x0 && c.y < r.y1 && c.y + c.h > r.y0;

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
