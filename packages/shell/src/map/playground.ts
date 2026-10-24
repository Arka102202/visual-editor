// Playground: a component made previewable, drawn with every variant in every fixed-data state (the plugin's page, served
// at the app's address so the project's own styles and code load). Nothing reaches the network: a call a variant
// tries is blocked, and said here in words (with what to do). Saving a variant shows at once (the dev server's live
// reload). The board: zoom (Fit by default), Compare (the chosen variant next to the one in use), Details for the
// chosen tile (its variant, its state and that state's fixed data; read-only), and Preview for the chosen tile on its
// own (at a screen size). Plain DOM.

import type { Item } from '@visual-editor/contract';
import type { FromMap } from '../mapMessages';
import { el } from '../ui/dom';
import { iconButton } from '../ui/buttons';
import { Frame, type LayoutStore } from '../ui/frame';

export const PLAYGROUND_CSS = `
  .vp-main { position: absolute; inset: 0; display: flex; flex-direction: column; }
  .vp-bar { flex: none; display: flex; align-items: center; gap: 6px; padding: 4px 8px; border-bottom: 1px solid var(--vscode-panel-border, #8883); flex-wrap: nowrap; overflow-x: auto; overflow-y: hidden; }
  .vp-bar > * { flex: none; }
  .vp-bar button.icon.on { color: inherit; background: var(--vscode-toolbar-activeBackground, #8883); }
  .vp-bar button.icon.dim { opacity: .4; }
  .vp-bar .zoom { font-size: 11px; opacity: .7; min-width: 38px; text-align: center; }
  .vp-bar .sep { width: 1px; align-self: stretch; margin: 2px 4px; background: var(--vscode-panel-border, #8884); }
  .vp-notes { flex: none; display: flex; flex-direction: column; gap: 6px; padding: 8px 12px; border-bottom: 1px solid var(--vscode-panel-border, #8883); max-height: 30%; overflow: auto; }
  .vp-notes:empty { display: none; }
  .vp-note button.icon { float: right; margin: -3px -4px 0 8px; }
  .vp-toast { position: absolute; left: 50%; bottom: 16px; transform: translateX(-50%); max-width: 80%; padding: 7px 12px; border-radius: 6px; background: var(--vscode-editorWidget-background, #252526); color: var(--vscode-editorWidget-foreground, inherit); border: 1px solid var(--vscode-widget-border, #8884); box-shadow: 0 4px 16px #0005; font-size: 12px; z-index: 2; pointer-events: none; }
  .vp-note { white-space: pre-line; padding: 7px 10px; border-radius: 6px; font-size: 12px; line-height: 1.5; background: color-mix(in srgb, var(--vscode-editorWarning-foreground, #cca700) 13%, transparent); }
  .vp-stage { position: relative; flex: 1; min-height: 0; overflow: auto; display: flex; background: color-mix(in srgb, var(--vscode-foreground) 4%, var(--vscode-editor-background)); }
  .vp-device { flex: none; position: relative; margin: 0 auto; overflow: hidden; }
  .vp-device iframe { position: absolute; left: 0; top: 0; border: 0; background: #fff; transform-origin: 0 0; }
  .vp-details { padding: 10px 12px; font-size: 12px; line-height: 1.5; }
  .vp-details h4 { margin: 12px 0 4px; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; opacity: .6; }
  .vp-details h4:first-child { margin-top: 0; }
  .vp-details .empty { opacity: .65; }
  .vp-details .row { display: flex; gap: 6px; align-items: baseline; padding: 2px 6px; margin: 0 -6px; border-radius: 4px; cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .vp-details .row:hover { background: var(--vscode-list-hoverBackground, #8882); }
  .vp-details .row.on { background: var(--vscode-list-activeSelectionBackground, #8884); color: var(--vscode-list-activeSelectionForeground, inherit); }
  .vp-details .row .note { opacity: .6; font-size: 11px; }
  .vp-details .grp { display: flex; align-items: center; gap: 8px; margin: 10px 0 2px; font-size: 11px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; opacity: .85; }
  .vp-details .grp .name { flex: 1; }
  .vp-details .grp .tag { text-transform: none; letter-spacing: 0; font-weight: 500; font-size: 11px; padding: 1px 8px; border-radius: 10px; background: color-mix(in srgb, var(--vscode-foreground) 12%, transparent); }
  .vp-details .grp .tag.none { color: var(--vscode-editorWarning-foreground, #cca700); }
  .vp-details .row.sub { padding-left: 16px; }
  .vp-details .row.empty { opacity: .5; cursor: default; }
  .vp-details .file { font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; opacity: .8; }
  .vp-details pre { margin: 4px 0 0; padding: 8px; border-radius: 4px; background: color-mix(in srgb, var(--vscode-foreground) 6%, transparent); font: 11px/1.5 var(--vscode-editor-font-family, monospace); white-space: pre-wrap; word-break: break-word; }
  .vp-wait { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; text-align: center; padding: 24px; color: #555; font-size: 13px; }
`;

const ZOOMS = [0.1, 0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.25, 1.5, 2, 3];

interface Deps {
  post(m: FromMap): void;
  store: LayoutStore;
  /** Opens Preview: one variant on its own, in one state. */
  preview(item: Item, variant: string, state: string): void;
  /** "Use this design": proposes making this variant the one in use (for a situation, when there are situations). */
  useVariant(item: Item, variant: string, situation?: string): void;
  /** "Update the helper": proposes what Preview needs from the card's plugin. */
  updateHelper(item: Item): void;
}

type Design = NonNullable<Item['preview']>['variants'][number];

/** The situation a state shows (Button: "danger"), when the card has situations. */
export function situationOf(item: Item | undefined, state: string | undefined): string | undefined {
  const s = item?.preview?.situations;
  return s && state ? s.ofState[state] : undefined;
}

/** Whether a design is the one in use (for this situation, when there are situations). */
export function inUseFor(d: Design, situation: string | undefined): boolean {
  return situation ? !!d.inUseFor?.includes(situation) : d.inUse;
}

/** Use this design's hover name, and whether there's something to do (a design, not in use, made for the situation). */
export function useTip(item: Item | undefined, d: Design | undefined, situation: string | undefined): { tip: string; can: boolean } {
  if (!d) return { tip: 'Use this design: choose a variant that isn’t in use (click its name on the board)', can: false };
  if (situation && d.for && !d.for.includes(situation)) return { tip: `Use this design: ${d.name} isn’t made for “${situation}”`, can: false };
  if (inUseFor(d, situation)) return { tip: `Use this design: ${d.name} is already the one in use${situation ? ` for “${situation}”` : ''}`, can: false };
  return { tip: `Use this design: make ${d.name} the ${situation ? `design for “${situation}”` : `one ${item?.label ?? 'it'} uses`} (a proposal you review first, with before and after)`, can: true };
}

/** The title bar's summary: "3 variants · 3 situations · 4 states". */
export function summary(p: NonNullable<Item['preview']>): string {
  const n = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;
  return [n(p.variants.length, 'variant'), p.situations ? n(p.situations.names.length, 'situation') : '', n(p.states.length, 'state')].filter(Boolean).join(' · ');
}

/**
 * Details' states, in one list: with situations, each situation is a small heading with its design in use (as a tag)
 * and its states under it; without, the states. Only the state shown is marked; picking a state shows it.
 */
export function stateList(p: NonNullable<Item['preview']>, state: string | undefined, pick: (state: string) => void): HTMLElement[] {
  const item = (name: string, sub: boolean) => {
    const r = el('div', `row${sub ? ' sub' : ''}${name === state ? ' on' : ''}`);
    r.append(el('span', undefined, name));
    r.addEventListener('click', () => pick(name));
    return r;
  };
  const s = p.situations;
  if (!s) return [el('h4', undefined, 'States'), ...p.states.map((x) => item(x, false))];
  const out: HTMLElement[] = [el('h4', undefined, 'Situations and states')];
  const groups = [...s.names.map((name) => ({ name, states: p.states.filter((x) => s.ofState[x] === name) })), { name: '', states: p.states.filter((x) => !s.names.includes(s.ofState[x])) }];
  for (const g of groups) {
    if (!g.states.length && !g.name) continue;
    if (g.name) {
      const head = el('div', 'grp');
      const design = p.variants.find((v) => v.inUseFor?.includes(g.name));
      head.append(el('span', 'name', g.name), el('span', `tag${design ? '' : ' none'}`, design ? design.name : 'no design in use'));
      head.title = design ? `${design.name} is the design in use for “${g.name}”` : `No design is in use for “${g.name}”`;
      out.push(head);
    }
    out.push(...g.states.map((x) => item(x, !!g.name)));
    if (g.name && !g.states.length) out.push(el('div', 'row sub empty', 'no state shows it yet'));
  }
  return out;
}

/** Reset's look: dimmed until something was clicked or typed in the board (then there's something to undo). */
export function showReset(b: HTMLButtonElement, touched: boolean, what: string) {
  const tip = touched ? `Reset: ${what} back to the starting data (what you clicked or typed is undone)` : 'Reset: nothing to undo yet (click or type inside a tile first: delete a card, open a menu, type in a field)';
  b.classList.toggle('dim', !touched);
  b.dataset.tip = tip;
  b.setAttribute('aria-label', tip);
}

/** How a design's use reads in Details: "in use", "in use for primary, secondary", "not in use". */
export function useWords(d: Design, situations: boolean): string {
  const made = d.for?.length ? ` · made for ${d.for.join(', ')}` : '';
  if (situations) return (d.inUseFor?.length ? `in use for ${d.inUseFor.join(', ')}` : 'not in use') + made;
  return (d.inUse ? 'in use' : 'not in use') + made;
}

/** A short message at the bottom of a window that goes away by itself. */
export function makeToast(host: HTMLElement): (text: string) => void {
  const box = el('div', 'vp-toast');
  box.hidden = true;
  host.append(box);
  let timer: ReturnType<typeof setTimeout> | undefined;
  return (text) => {
    box.textContent = text;
    box.hidden = false;
    clearTimeout(timer);
    timer = setTimeout(() => (box.hidden = true), 3500);
  };
}

/** What a variants page says, in words (a call it blocked, something missing, a variant that stopped). */
export function pageNote(data: Record<string, unknown>, name: string): string | undefined {
  if (data.type === 'blocked') return `A variant tried to call ${String(data.method)} ${String(data.url)}. Visual Editor blocked it: variants show looks only, with fixed data. Move the call to ${name}.data.tsx and pass what it gives in ${name}View.`;
  if (data.type === 'missing') return data.what === 'helper' ? 'The project doesn’t have Visual Editor’s helper (src/visual-editor.tsx) yet, so nothing can be drawn.' : 'The project’s helper (src/visual-editor.tsx) is from before the Playground: it needs updating (it has no mountPreview).';
  if (data.type === 'error') return `Something stopped while drawing: ${String(data.text)}`;
  if (data.type === 'drawn') {
    const broken = (data.broken as { id: string; text: string }[] | undefined) ?? [];
    return broken.length ? broken.map((b) => `The variant “${b.id}” stopped while drawing: ${b.text}`).join('\n') : undefined;
  }
  return undefined;
}

export class Playground {
  readonly frame: Frame;
  private readonly notes = el('div', 'vp-notes');
  private readonly stage = el('div', 'vp-stage');
  private readonly device = el('div', 'vp-device');
  private readonly zoomText = el('span', 'zoom');
  private readonly fitButton = iconButton('fitMap', 'Fit: the whole board in view (it keeps fitting until you zoom in or out)', { cls: 'on' });
  private readonly compareButton = iconButton('compare', '');
  private readonly previewButton = iconButton('single', '');
  private readonly useButton = iconButton('choose', '');
  private readonly resetButton = iconButton('restart', 'Reset');
  /** Something was clicked or typed in the board since it was drawn (Reset has something to undo). */
  private touched = false;
  private readonly details = el('div', 'vp-details');
  private zoom = 1;
  private fit = true;
  /** The board's own size (the page says), and the one before (a board that flips between two sizes isn't followed). */
  private content: { w: number; h: number } | undefined;
  private contentBefore: { w: number; h: number } | undefined;
  private chosen: { variant: string; state: string } | undefined;
  private comparing = false;
  private data: { file: string; states: Record<string, unknown> } | undefined;
  private readonly wait = el('div', 'vp-wait');
  private iframe: HTMLIFrameElement | undefined;
  private item: Item | undefined;
  private app: string | undefined;
  private readonly said = new Set<string>();
  private toast: (text: string) => void = () => {};
  /** Called when it opens or closes (a button that opens it shows whether it's open). */
  onToggle: (() => void) | undefined;

  constructor(private readonly deps: Deps) {
    this.frame = new Frame('variants', deps.store, { right: { panels: ['details'], size: 320 } }, { size: { width: 'min(1400px, 96vw)', height: 'min(900px, 92vh)' } });
    this.frame.title.textContent = 'Playground';
    this.frame.onClose = () => this.onToggle?.();
    const reload = iconButton('reload', 'Draw it again');
    reload.addEventListener('click', () => this.load());
    this.frame.addTools(reload);

    const bar = el('div', 'vp-bar');
    const zoomOut = iconButton('zoomOut', 'Zoom out');
    zoomOut.addEventListener('click', () => this.stepZoom(-1));
    const zoomIn = iconButton('zoomIn', 'Zoom in');
    zoomIn.addEventListener('click', () => this.stepZoom(1));
    // Fit is an action (like the map's): it always fits the board; zooming in or out stops following it.
    this.fitButton.addEventListener('click', () => {
      this.fit = true;
      this.layout();
    });
    this.compareButton.addEventListener('click', () => {
      if (!this.compared()) return;
      this.comparing = !this.comparing;
      this.sendCompare();
      this.showCompare();
    });
    this.previewButton.addEventListener('click', () => {
      if (this.item && this.chosen) deps.preview(this.item, this.chosen.variant, this.chosen.state);
    });
    this.useButton.addEventListener('click', () => {
      const v = this.chosen && this.item?.preview?.variants.find((x) => x.id === this.chosen!.variant);
      const situation = situationOf(this.item, this.chosen?.state);
      if (this.item && useTip(this.item, v, situation).can) deps.useVariant(this.item, v!.id, situation);
    });
    const reset = this.resetButton;
    reset.addEventListener('click', () => {
      if (!this.touched) return;
      this.touched = false;
      showReset(reset, false, 'every tile');
      this.toPage({ type: 'reset' });
    });
    showReset(reset, false, 'every tile');
    bar.append(zoomOut, this.zoomText, zoomIn, this.fitButton, el('span', 'sep'), reset, el('span', 'sep'), this.compareButton, this.previewButton, this.useButton);

    const main = el('div', 'vp-main');
    this.stage.append(this.device, this.wait);
    main.append(bar, this.notes, this.stage);
    this.toast = makeToast(main);
    this.frame.main.append(main);
    this.frame.setPanels([{ id: 'details', icon: 'props', name: 'Details: the chosen tile’s variant, its state and its fixed data (read-only)', body: this.details }]);
    new ResizeObserver(() => this.layout()).observe(this.stage);
    this.showCompare();
    this.showDetails();
  }

  /** Opens the Playground for a card that has variants. */
  open(item: Item) {
    if (this.item?.id !== item.id) {
      this.chosen = undefined;
      this.comparing = false;
      this.data = undefined;
      this.content = this.contentBefore = undefined;
    }
    this.item = item;
    this.frame.title.textContent = `Playground: ${item.label}`;
    const p = item.preview;
    this.frame.hint.textContent = p ? `${summary(p)} · fixed data, no network` : '';
    this.frame.open();
    this.onToggle?.();
    this.showCompare();
    this.showDetails();
    if (this.app) this.load();
    else {
      this.showWait('Starting the app’s dev server…');
      this.deps.post({ type: 'app' });
    }
  }

  /** The card it shows (open or not). */
  get itemId(): string | undefined {
    return this.item?.id;
  }

  /** The card was read again (e.g. another variant is now in use): what's shown follows. */
  refresh(item: Item) {
    if (this.item?.id !== item.id) return;
    this.item = item;
    const p = item.preview;
    if (p) this.frame.hint.textContent = `${summary(p)} · fixed data, no network`;
    this.showCompare();
    this.showDetails();
  }

  /** Whether it's open, showing this card. */
  shows(id: string): boolean {
    return this.frame.isOpen && this.item?.id === id;
  }

  /** The app's address (its dev server, through the proxy). */
  receiveApp(m: { url?: string; progress?: string; error?: string }) {
    if (!this.frame.isOpen) {
      if (m.url) this.app = m.url.replace(/\/$/, '');
      return;
    }
    if (m.error) return this.showWait(`The app’s dev server couldn’t start: ${m.error}`);
    if (m.progress) return this.showWait(`Starting the app’s dev server… ${m.progress}`);
    if (!m.url) return;
    this.app = m.url.replace(/\/$/, '');
    this.load();
  }

  /** What the page says: what it drew, a call it blocked, something missing. */
  fromPage(data: Record<string, unknown>, source: MessageEventSource | null) {
    if (!this.iframe || source !== this.iframe.contentWindow) return;
    const note = pageNote(data, this.item?.label ?? 'It');
    if (note) this.say(note);
    this.fromPageExtra(data);
    if (data.type === 'touched') {
      this.touched = true;
      showReset(this.resetButton, true, 'every tile');
    }
    if (data.type === 'drawn') {
      // Drawn again (a reload): the chosen tile and Compare go on.
      if (this.chosen) this.toPage({ type: 'choose', ...this.chosen });
      this.sendCompare();
    } else if (data.type === 'size') {
      const size = { w: Number(data.w) || 0, h: Number(data.h) || 0 };
      const same = (a?: { w: number; h: number }) => !!a && Math.abs(a.w - size.w) < 2 && Math.abs(a.h - size.h) < 2;
      if (same(this.content) || same(this.contentBefore)) return;
      this.contentBefore = this.content;
      this.content = size;
      this.layout();
    } else if (data.type === 'chosen') {
      this.chosen = { variant: String(data.variant), state: String(data.state) };
      if (this.comparing && !this.compared()) this.comparing = false;
      this.sendCompare();
      this.showCompare();
      this.showDetails();
    } else if (data.type === 'data') {
      this.data = { file: String(data.file), states: (data.states ?? {}) as Record<string, unknown> };
      this.showDetails();
    }
  }

  private load() {
    if (!this.app || !this.item) return;
    this.said.clear();
    this.notes.replaceChildren();
    this.iframe?.remove();
    const iframe = el('iframe');
    this.touched = false;
    showReset(this.resetButton, false, 'every tile');
    iframe.title = `Playground of ${this.item.label}`;
    iframe.src = `${this.app}/__ve/preview?item=${encodeURIComponent(this.item.id)}`;
    this.iframe = iframe;
    this.wait.hidden = true;
    this.device.append(iframe);
    this.layout();
  }

  private toPage(m: Record<string, unknown>) {
    this.iframe?.contentWindow?.postMessage({ source: 've-preview', ...m }, '*');
  }

  private stepZoom(dir: 1 | -1) {
    const now = this.shownZoom();
    this.zoom = dir > 0 ? (ZOOMS.find((z) => z > now + 0.001) ?? ZOOMS[ZOOMS.length - 1]) : ([...ZOOMS].reverse().find((z) => z < now - 0.001) ?? ZOOMS[0]);
    this.fit = false;
    this.layout();
  }

  /** The zoom shown: Fit's (the whole board in view, never bigger than real size), or the one chosen. */
  private shownZoom(): number {
    if (!this.fit) return this.zoom;
    const sw = this.stage.clientWidth;
    const sh = this.stage.clientHeight;
    if (!sw || !sh || !this.content) return 1;
    return Math.max(ZOOMS[0], Math.min(1, sw / this.content.w, sh / this.content.h));
  }

  /** Sizes the page: as wide as the window, scaled by the zoom; the board scrolls down. */
  private layout() {
    const z = this.shownZoom();
    const sw = this.stage.clientWidth;
    const sh = this.stage.clientHeight;
    const w = sw / z;
    Object.assign(this.device.style, { width: `${Math.round(w * z)}px`, height: `${sh}px` });
    if (this.iframe) Object.assign(this.iframe.style, { width: `${w}px`, height: `${sh / z}px`, transform: z === 1 ? '' : `scale(${z})` });
    this.zoomText.textContent = `${Math.round(z * 100)}%`;
    this.fitButton.classList.toggle('on', this.fit);
  }

  /** The variants Compare shows (the one in use, then the chosen one), when there are two (and others to hide). */
  private compared(): string[] | undefined {
    const variants = this.item?.preview?.variants ?? [];
    const situation = situationOf(this.item, this.chosen?.state);
    const inUse = variants.find((v) => inUseFor(v, situation))?.id;
    return variants.length > 2 && inUse && this.chosen && this.chosen.variant !== inUse ? [inUse, this.chosen.variant] : undefined;
  }

  private sendCompare() {
    this.toPage({ type: 'compare', variants: this.comparing ? (this.compared() ?? null) : null });
  }

  private showCompare() {
    // Preview: the chosen tile on its own.
    const v = this.chosen && this.item?.preview?.variants.find((x) => x.id === this.chosen!.variant);
    const ptip = v && this.chosen ? `Preview: ${v.name} on its own, in the state “${this.chosen.state}”, at a screen size` : 'Preview: choose a tile (click its name on the board) to see it on its own, at a screen size';
    this.previewButton.classList.toggle('dim', !v);
    this.previewButton.dataset.tip = ptip;
    this.previewButton.setAttribute('aria-label', ptip);
    // Use this design: for a chosen variant that isn't the one in use.
    const use = useTip(this.item, v || undefined, situationOf(this.item, this.chosen?.state));
    this.useButton.classList.toggle('dim', !use.can);
    this.useButton.dataset.tip = use.tip;
    this.useButton.setAttribute('aria-label', use.tip);
    // Only when there's something to hide: with two variants, the board already shows just those two.
    this.compareButton.hidden = (this.item?.preview?.variants.length ?? 0) < 3;
    const two = this.compared();
    const name = (id: string) => this.item?.preview?.variants.find((v) => v.id === id)?.name ?? id;
    // Dimmed (not disabled, so its name still shows on hover) when there's nothing to compare.
    this.compareButton.classList.toggle('dim', !two);
    this.compareButton.classList.toggle('on', this.comparing);
    const tip = two
      ? this.comparing ? `Compare: on (${name(two[1])} next to ${name(two[0])}, the one in use). Click to show every variant again` : `Compare: ${name(two[1])} next to ${name(two[0])}, the one in use, in every state`
      : 'Compare: choose a variant that isn’t in use (click its name on the board) to see it next to the one in use';
    this.compareButton.dataset.tip = tip;
    this.compareButton.setAttribute('aria-label', tip);
  }

  /** Details: the chosen tile's variant, its state and that state's fixed data (read-only for now). */
  private showDetails() {
    const p = this.item?.preview;
    const c = this.chosen;
    const v = c && p?.variants.find((x) => x.id === c.variant);
    if (!p || !c || !v) {
      this.details.replaceChildren(el('div', 'empty', 'Click a variant’s name on the board (or an empty spot in its tile) to see its details here: its file, its states and the fixed data it’s drawn with. Then Preview shows it on its own.'));
      return;
    }
    const row = (text: string, note: string | undefined, on: boolean, click: () => void, cls?: string) => {
      const r = el('div', `row${on ? ' on' : ''}`);
      r.append(el('span', cls, text));
      if (note) r.append(el('span', 'note', note));
      r.addEventListener('click', click);
      return r;
    };
    const open = (path: string) => () => this.deps.post({ type: 'open', path });
    const file = (path: string) => path.split('/').pop() ?? path;
    const out: HTMLElement[] = [el('h4', undefined, 'Variant'), row(v.name, useWords(v, !!p.situations), false, open(v.path)), row(file(v.path), 'open', false, open(v.path), 'file')];
    out.push(...stateList(p, c.state, (s) => this.choose(c.variant, s)));
    out.push(el('h4', undefined, `Fixed data · ${c.state}`));
    if (this.data) {
      out.push(row(file(this.data.file), 'open', false, open(this.data.file), 'file'));
      const state = this.data.states[c.state];
      out.push(el('pre', undefined, state === undefined ? `There’s no “${c.state}” in ${file(this.data.file)}.` : JSON.stringify(state, null, 2)));
    } else out.push(el('div', 'empty', 'The fixed data shows here once the board has loaded it.'));
    this.details.replaceChildren(...out);
  }

  private choose(variant: string, state: string) {
    this.chosen = { variant, state };
    this.toPage({ type: 'choose', variant, state });
    this.showCompare();
    this.showDetails();
  }

  /** A note above the page (once each); with a button when there's something to do about it. */
  private say(text: string, action?: HTMLButtonElement) {
    if (this.said.has(text)) return;
    this.said.add(text);
    const note = el('div', 'vp-note', text);
    if (action) note.append(action);
    this.notes.append(note);
  }

  /** What the page says that this window acts on: where the prototype would go, an older helper. */
  private fromPageExtra(data: Record<string, unknown>) {
    if (data.type === 'goto') this.toast(`Would open ${String(data.path) || 'another page'}. A preview is one page, so it stays here.`);
    else if (data.type === 'old' && this.item) {
      const item = this.item;
      const update = iconButton('add', 'Update the helper: a proposal you review first');
      update.addEventListener('click', () => this.deps.updateHelper(item));
      this.say(`This project’s helper (src/visual-editor.tsx) is version ${String(data.version ?? 1)}; the newest is version ${String(data.latest ?? '')}. Update it to get every Preview and Playground feature (folders made for the newest need it).`, update);
    }
  }

  private showWait(text: string) {
    this.wait.textContent = text;
    this.wait.hidden = false;
  }
}
