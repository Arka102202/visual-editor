// Preview: one variant of a component on its own, in one fixed-data state, drawn like a page of the app (the plugin's
// page with ?variant=…&state=…). Screen sizes like the Webview's (the page is that wide, so the component's own phone
// and tablet rules apply), zoom to fit, and Details: the variants and states to switch between, and the state's fixed
// data. Nothing reaches the network; saving a variant shows at once. Plain DOM; it shares the Playground's styles.

import type { Item } from '@visual-editor/contract';
import type { FromMap } from '../mapMessages';
import { el } from '../ui/dom';
import { iconButton, tray, type Icon } from '../ui/buttons';
import { Frame, type LayoutStore } from '../ui/frame';
import { makeToast, pageNote } from './playground';

export const PREVIEW_CSS = `
  .vq-stage.fill .vp-device { margin: 0; }
  .vq-stage:not(.fill) .vp-device { margin: auto; border-radius: 4px; box-shadow: 0 0 0 1px color-mix(in srgb, var(--vscode-foreground) 25%, transparent), 0 10px 30px #0006; }
`;

/** Screen sizes to try (width × height, upright). */
const DEVICES: { id: string; icon: Icon; name: string; width: number; height: number }[] = [
  { id: 'phone', icon: 'phone', name: 'Phone', width: 390, height: 844 },
  { id: 'tablet', icon: 'tablet', name: 'Tablet', width: 820, height: 1180 },
  { id: 'laptop', icon: 'laptop', name: 'Laptop', width: 1366, height: 768 },
  { id: 'desktop', icon: 'desktop', name: 'Desktop', width: 1920, height: 1080 },
];

interface Deps {
  post(m: FromMap): void;
  store: LayoutStore;
  /** "Use this design": proposes making this variant the one in use. */
  useVariant(item: Item, variant: string): void;
  /** "Update the helper": proposes what Preview needs from the card's plugin. */
  updateHelper(item: Item): void;
}

export class PreviewWindow {
  readonly frame: Frame;
  private readonly notes = el('div', 'vp-notes');
  private readonly stage = el('div', 'vp-stage vq-stage');
  private readonly device = el('div', 'vp-device');
  private readonly wait = el('div', 'vp-wait');
  private readonly zoomText = el('span', 'zoom');
  private readonly sizeButtons = new Map<string, HTMLButtonElement>();
  private readonly fitButton = iconButton('fitMap', 'Zoom to fit: the whole screen size in view (off: real size, scroll to see it all)', { cls: 'on' });
  private readonly details = el('div', 'vp-details');
  private readonly useButton = iconButton('choose', '');
  private iframe: HTMLIFrameElement | undefined;
  private item: Item | undefined;
  private variant = '';
  private state = '';
  private app: string | undefined;
  private readonly said = new Set<string>();
  private toast: (text: string) => void = () => {};
  private data: { file: string; states: Record<string, unknown> } | undefined;
  private size: { fill: true } | { fill: false; width: number; height: number; device?: string } = { fill: true };
  private fit = true;
  /** Called when it opens or closes (a button that opens it shows whether it's open). */
  onToggle: (() => void) | undefined;

  constructor(private readonly deps: Deps) {
    this.frame = new Frame('single', deps.store, { right: { panels: ['details'], size: 300 } }, { size: { width: 'min(1300px, 96vw)', height: 'min(900px, 92vh)' } });
    this.frame.title.textContent = 'Preview';
    this.frame.onClose = () => this.onToggle?.();
    const reload = iconButton('reload', 'Draw it again');
    reload.addEventListener('click', () => this.load());
    this.frame.addTools(reload);

    const bar = el('div', 'vp-bar');
    const sizes = tray(el('div'));
    const fill = iconButton('fill', 'Fill: the page takes all the space (it follows the window)', { cls: 'on' });
    this.sizeButtons.set('fill', fill);
    fill.addEventListener('click', () => this.setSize({ fill: true }));
    sizes.append(fill);
    for (const d of DEVICES) {
      const b = iconButton(d.icon, `${d.name}: ${d.width} × ${d.height}`);
      this.sizeButtons.set(d.id, b);
      b.addEventListener('click', () => this.setSize({ fill: false, width: d.width, height: d.height, device: d.id }));
      sizes.append(b);
    }
    const rotate = iconButton('rotate', 'Turn the screen (swap width and height)');
    rotate.addEventListener('click', () => {
      if (!this.size.fill) this.setSize({ ...this.size, width: this.size.height, height: this.size.width });
    });
    this.fitButton.addEventListener('click', () => {
      this.fit = !this.fit;
      this.fitButton.classList.toggle('on', this.fit);
      this.layout();
    });
    this.useButton.addEventListener('click', () => {
      const v = this.item?.preview?.variants.find((x) => x.id === this.variant);
      if (this.item && v && !v.inUse) deps.useVariant(this.item, v.id);
    });
    const reset = iconButton('undo', 'Reset: back to the starting data (what you clicked or typed is undone)');
    reset.addEventListener('click', () => this.iframe?.contentWindow?.postMessage({ source: 've-preview', type: 'reset' }, '*'));
    bar.append(sizes, rotate, el('span', 'sep'), this.fitButton, this.zoomText, el('span', 'sep'), reset, el('span', 'sep'), this.useButton);

    const main = el('div', 'vp-main');
    this.stage.append(this.device, this.wait);
    main.append(bar, this.notes, this.stage);
    this.toast = makeToast(main);
    this.frame.main.append(main);
    this.frame.setPanels([{ id: 'details', icon: 'props', name: 'Details: the variant and state shown (switch them here), and the state’s fixed data', body: this.details }]);
    new ResizeObserver(() => this.layout()).observe(this.stage);
    this.setSize({ fill: true });
  }

  /** Opens Preview: one variant (the one in use unless said) in one state (the first unless said). */
  open(item: Item, variant?: string, state?: string) {
    const p = item.preview;
    if (!p) return;
    if (this.item?.id !== item.id) this.data = undefined;
    this.item = item;
    this.variant = variant ?? p.variants.find((v) => v.inUse)?.id ?? p.variants[0]?.id ?? '';
    this.state = state ?? (p.states.includes('default') ? 'default' : (p.states[0] ?? 'default'));
    this.frame.title.textContent = `Preview: ${item.label}`;
    this.frame.open();
    this.onToggle?.();
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
    this.showDetails();
    this.showHint();
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

  /** What the page says: what it drew, a call it blocked, something missing, its fixed data. */
  fromPage(data: Record<string, unknown>, source: MessageEventSource | null) {
    if (!this.iframe || source !== this.iframe.contentWindow) return;
    const note = pageNote(data, this.item?.label ?? 'It');
    if (note) this.say(note);
    this.fromPageExtra(data);
    if (data.type === 'drawn' && data.found === false) this.say(`There’s no variant “${this.variant}” any more: choose another in Details.`);
    if (data.type === 'data') {
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
    iframe.title = `Preview of ${this.item.label}`;
    iframe.src = `${this.app}/__ve/preview?item=${encodeURIComponent(this.item.id)}&variant=${encodeURIComponent(this.variant)}&state=${encodeURIComponent(this.state)}`;
    this.iframe = iframe;
    this.wait.hidden = true;
    this.device.append(iframe);
    this.layout();
    this.showHint();
  }

  /** The title bar's hint, and Use this design (for a variant that isn't in use). */
  private showHint() {
    const v = this.item?.preview?.variants.find((x) => x.id === this.variant);
    this.frame.hint.textContent = `${v?.name ?? this.variant}${v?.inUse ? ' (in use)' : ''} · ${this.state} · fixed data, no network`;
    const tip = !v ? 'Use this design' : v.inUse ? `Use this design: ${v.name} is already the one in use` : `Use this design: make ${v.name} the one ${this.item?.label ?? 'it'} uses (a proposal you review first, with before and after)`;
    this.useButton.classList.toggle('dim', !v || v.inUse);
    this.useButton.dataset.tip = tip;
    this.useButton.setAttribute('aria-label', tip);
  }

  private setSize(size: PreviewWindow['size']) {
    this.size = size;
    const on = size.fill ? 'fill' : (size.device ?? '');
    for (const [id, b] of this.sizeButtons) b.classList.toggle('on', id === on);
    this.layout();
  }

  /** Sizes the screen: all the space, or the size chosen, scaled down to fit when asked. */
  private layout() {
    this.stage.classList.toggle('fill', this.size.fill);
    if (this.size.fill) {
      this.zoomText.textContent = '';
      Object.assign(this.device.style, { width: `${this.stage.clientWidth}px`, height: `${this.stage.clientHeight}px` });
      if (this.iframe) Object.assign(this.iframe.style, { width: '100%', height: '100%', transform: '' });
      return;
    }
    const { width, height } = this.size;
    const pad = 32;
    const s = Math.max(0.05, this.fit ? Math.min(1, (this.stage.clientWidth - pad) / width, (this.stage.clientHeight - pad) / height) : 1);
    Object.assign(this.device.style, { width: `${Math.round(width * s)}px`, height: `${Math.round(height * s)}px` });
    if (this.iframe) Object.assign(this.iframe.style, { width: `${width}px`, height: `${height}px`, transform: s === 1 ? '' : `scale(${s})` });
    this.zoomText.textContent = `${Math.round(s * 100)}%`;
  }

  /** Details: the variants and states (click to switch), and the shown state's fixed data (read-only for now). */
  private showDetails() {
    const p = this.item?.preview;
    if (!p) return this.details.replaceChildren();
    const row = (text: string, note: string | undefined, on: boolean, click: () => void, cls?: string) => {
      const r = el('div', `row${on ? ' on' : ''}`);
      r.append(el('span', cls, text));
      if (note) r.append(el('span', 'note', note));
      r.addEventListener('click', click);
      return r;
    };
    const open = (path: string) => () => this.deps.post({ type: 'open', path });
    const file = (path: string) => path.split('/').pop() ?? path;
    const out: HTMLElement[] = [el('h4', undefined, 'Variants')];
    for (const v of p.variants) out.push(row(v.name, v.inUse ? 'in use' : undefined, v.id === this.variant, () => this.switchTo(v.id, this.state)));
    const shown = p.variants.find((v) => v.id === this.variant);
    if (shown) out.push(row(file(shown.path), 'open', false, open(shown.path), 'file'));
    out.push(el('h4', undefined, 'States'));
    for (const s of p.states) out.push(row(s, undefined, s === this.state, () => this.switchTo(this.variant, s)));
    out.push(el('h4', undefined, `Fixed data · ${this.state}`));
    if (this.data) {
      out.push(row(file(this.data.file), 'open', false, open(this.data.file), 'file'));
      const state = this.data.states[this.state];
      out.push(el('pre', undefined, state === undefined ? `There’s no “${this.state}” in ${file(this.data.file)}.` : JSON.stringify(state, null, 2)));
    } else out.push(el('div', 'empty', 'The fixed data shows here once the page has loaded it.'));
    this.details.replaceChildren(...out);
  }

  private switchTo(variant: string, state: string) {
    if (variant === this.variant && state === this.state) return;
    this.variant = variant;
    this.state = state;
    this.showDetails();
    this.load();
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
      this.say(`This project’s helper (src/visual-editor.tsx) is version ${String(data.version ?? 1)}. Version 2 gives each tile its own prototype, Reset, and links that stay on the page.`, update);
    }
  }

  private showWait(text: string) {
    this.wait.textContent = text;
    this.wait.hidden = false;
  }
}
