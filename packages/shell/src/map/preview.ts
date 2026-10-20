// Preview: the running app in a window over the map, through Visual Editor's proxy (so its calls are seen, and later
// faked). A bar with back, forward, reload, the address, and responsive mode (fill, phone, tablet, laptop, desktop,
// any width × height, rotate, zoom to fit); side panels the developer arranges, starting with the Console. The page
// talks to it through the inspector the proxy adds. Plain DOM.

import type { FromMap } from '../mapMessages';
import { el } from '../ui/dom';
import { iconButton, tray, type Icon } from '../ui/buttons';
import { Frame, type LayoutStore } from '../ui/frame';
import { ConsolePanel, type ConsoleEntry } from './consolePanel';
import { CssPanel, type Picked } from './cssPanel';
import { NetworkPanel } from './networkPanel';
import type { CardNetwork } from './previewTypes';

export const PREVIEW_CSS = `
  .pv-main { position: absolute; inset: 0; display: flex; flex-direction: column; }
  .pv-bar { display: flex; align-items: center; gap: 6px; padding: 6px 10px; border-bottom: 1px solid var(--vscode-panel-border, #8883); flex: none; }
  .pv-bar input { font: inherit; font-size: 12px; padding: 4px 8px; border-radius: 5px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, #8884); }
  .pv-bar input:focus { outline: 1px solid var(--vscode-focusBorder, #39f); }
  .pv-bar .address { flex: 1; min-width: 140px; font-family: var(--vscode-editor-font-family, monospace); }
  .pv-bar .size input { width: 58px; text-align: center; }
  .pv-bar .size input::-webkit-inner-spin-button { display: none; }
  .pv-bar .x { opacity: .55; font-size: 11px; }
  .pv-bar .zoom { font-size: 11px; opacity: .7; min-width: 38px; text-align: right; }
  .pv-bar .devices button.on, .pv-bar button.icon.on { background: var(--vscode-toolbar-activeBackground, #8883); }
  .pv-stage { position: relative; flex: 1; min-height: 0; overflow: auto; display: flex; background: color-mix(in srgb, var(--vscode-foreground) 4%, var(--vscode-editor-background)); }
  .pv-device { flex: none; margin: auto; position: relative; }
  .pv-stage.fill .pv-device { margin: 0; width: 100% !important; height: 100% !important; }
  .pv-device iframe { position: absolute; left: 0; top: 0; border: 0; background: #fff; transform-origin: 0 0; }
  .pv-stage:not(.fill) .pv-device iframe { box-shadow: 0 0 0 1px color-mix(in srgb, var(--vscode-foreground) 25%, transparent), 0 10px 30px #0006; border-radius: 4px; }
  .pv-stage.fill .pv-device iframe { width: 100% !important; height: 100% !important; transform: none !important; }
  .pv-wait { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; text-align: center; padding: 24px; }
  .pv-wait h3 { margin: 0 0 6px; font-size: 15px; }
  .pv-wait p { margin: 0; opacity: .7; font-size: 12px; white-space: pre-wrap; max-width: 560px; }
  .pv-wait.error h3 { color: var(--vscode-errorForeground, #f48771); }
`;

/** Screen sizes to try (width × height, upright). */
const DEVICES: { id: string; icon: Icon; name: string; width: number; height: number }[] = [
  { id: 'phone', icon: 'phone', name: 'Phone', width: 390, height: 844 },
  { id: 'tablet', icon: 'tablet', name: 'Tablet', width: 820, height: 1180 },
  { id: 'laptop', icon: 'laptop', name: 'Laptop', width: 1366, height: 768 },
  { id: 'desktop', icon: 'desktop', name: 'Desktop', width: 1920, height: 1080 },
];

interface Deps {
  post(message: FromMap): void;
  store: LayoutStore;
}

export class PreviewWindow {
  readonly frame: Frame;
  private readonly address = el('input', 'address');
  private readonly widthBox = el('input');
  private readonly heightBox = el('input');
  private readonly zoomText = el('span', 'zoom');
  private readonly stage = el('div', 'pv-stage');
  private readonly device = el('div', 'pv-device');
  private readonly wait = el('div', 'pv-wait');
  private readonly deviceButtons = new Map<string, HTMLButtonElement>();
  private readonly fitButton = iconButton('fitMap', 'Zoom to fit: the whole screen size in view (off: real size, scroll to see it all)', { cls: 'on' });
  private readonly console: ConsolePanel;
  private readonly css: CssPanel;
  private readonly network: NetworkPanel;
  private readonly pickButton = iconButton('pick', 'Pick an element: hover the page to see it, click to see its CSS (Esc stops)');
  private picking = false;
  private iframe: HTMLIFrameElement | undefined;
  /** The app's address through the proxy, once it's running. */
  private app: string | undefined;
  /** Where to go once the app is running. */
  private pending = '/';
  /** Fill the space, or a screen size (upright or turned). */
  private size: { fill: true } | { fill: false; width: number; height: number; device?: string } = { fill: true };
  private fit = true;

  constructor(private readonly deps: Deps) {
    this.frame = new Frame('preview', deps.store, { bottom: { panels: ['console', 'network'], size: 240 }, right: { panels: ['css'], size: 380 } }, { size: { width: 'min(1400px, 96vw)', height: 'min(900px, 92vh)' } });
    this.frame.title.textContent = 'Preview';
    this.console = new ConsolePanel((url, line, column) => deps.post({ type: 'openSource', url, line, column }));
    this.console.onCounts = (all, errors) => this.frame.updatePanel('console', { count: errors || all, name: errors ? `Console: ${errors} error${errors === 1 ? '' : 's'}, ${all} message${all === 1 ? '' : 's'} in all` : `Console: everything the page logs (${all})`, tint: errors ? 'var(--vscode-errorForeground, #f48771)' : undefined });
    this.css = new CssPanel(
      (m) => this.toPage(m),
      () => this.setPicking(true),
      (source, selector) => deps.post({ type: 'openRule', source, selector }),
    );
    this.network = new NetworkPanel((m) => deps.post(m));
    this.network.onCounts = (calls, faked) => this.frame.updatePanel('network', { count: calls, name: `Network: ${calls} call${calls === 1 ? '' : 's'}${faked ? `, ${faked} answered by fakes` : ''}` });
    this.frame.setPanels([
      { id: 'console', icon: 'console', name: 'Console: everything the page logs', body: this.console.body },
      { id: 'network', icon: 'api', name: 'Network: every call the app makes, and the fakes that answer instead of the backend', body: this.network.body },
      { id: 'css', icon: 'css', name: 'CSS: the picked element’s rules, box model and final values', body: this.css.body },
    ]);
    this.pickButton.addEventListener('click', () => this.setPicking(!this.picking));

    // The bar: back, forward, reload, the address; responsive mode; open in the browser.
    const bar = el('div', 'pv-bar');
    const nav = tray(el('div'));
    const back = iconButton('goBack', 'Back');
    const forward = iconButton('goForward', 'Forward');
    const reload = iconButton('reload', 'Reload the page');
    nav.append(back, forward, reload);
    back.addEventListener('click', () => this.toPage({ type: 'go', steps: -1 }));
    forward.addEventListener('click', () => this.toPage({ type: 'go', steps: 1 }));
    reload.addEventListener('click', () => this.reload());
    this.address.placeholder = '/ (an address of the app)';
    this.address.spellcheck = false;
    this.address.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.go(this.address.value);
      if (e.key === 'Escape') {
        e.stopPropagation();
        this.address.blur();
      }
    });
    const devices = tray(el('div', 'devices'));
    const fill = iconButton('fill', 'Fill: the page takes all the space (it follows the window)', { cls: 'on' });
    this.deviceButtons.set('fill', fill);
    fill.addEventListener('click', () => this.setSize({ fill: true }));
    devices.append(fill);
    for (const d of DEVICES) {
      const b = iconButton(d.icon, `${d.name}: ${d.width} × ${d.height}`);
      this.deviceButtons.set(d.id, b);
      b.addEventListener('click', () => this.setSize({ fill: false, width: d.width, height: d.height, device: d.id }));
      devices.append(b);
    }
    const size = el('div', 'size');
    for (const [box, name] of [[this.widthBox, 'Width'], [this.heightBox, 'Height']] as const) {
      box.type = 'number';
      box.min = '100';
      box.max = '7680';
      box.placeholder = name;
      box.dataset.tip = `${name} of the screen, in pixels`;
      box.addEventListener('change', () => this.typedSize());
      box.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') this.typedSize();
        if (e.key === 'Escape') {
          e.stopPropagation();
          box.blur();
        }
      });
    }
    size.append(this.widthBox, el('span', 'x', '×'), this.heightBox);
    const rotate = iconButton('rotate', 'Turn the screen (swap width and height)');
    rotate.addEventListener('click', () => {
      if (!this.size.fill) this.setSize({ ...this.size, width: this.size.height, height: this.size.width });
    });
    this.fitButton.addEventListener('click', () => {
      this.fit = !this.fit;
      this.fitButton.classList.toggle('on', this.fit);
      this.layout();
    });
    const open = iconButton('popOut', 'Open in your browser (through Visual Editor, so its calls are seen there too)');
    open.addEventListener('click', () => this.app && deps.post({ type: 'openExternal', url: this.currentUrl() }));
    bar.append(nav, this.pickButton, this.address, devices, size, rotate, this.fitButton, this.zoomText, tray(el('div')));
    bar.lastElementChild!.append(open);

    this.stage.append(this.device);
    const main = el('div', 'pv-main');
    main.append(bar, this.stage);
    this.frame.main.append(main, this.wait);
    new ResizeObserver(() => this.layout()).observe(this.stage);
    this.setSize({ fill: true });
  }

  get isOpen(): boolean {
    return this.frame.isOpen;
  }

  /** Opens Preview at an address of the app (the proxy and dev server start when needed). */
  open(path?: string) {
    if (path) this.pending = path;
    this.frame.open();
    if (this.app) {
      if (path || !this.iframe) this.go(this.pending);
      return;
    }
    this.showWait('Starting the app…', 'Visual Editor runs it through its proxy (on this computer only), with your dev server behind it.');
    this.deps.post({ type: 'app' });
    this.deps.post({ type: 'network' });
  }

  /** The app's address, how starting it goes, or why it can't start. */
  receiveApp(m: { url?: string; progress?: string; error?: string }) {
    if (m.error) return this.showWait('Couldn’t start the app', m.error, true);
    if (m.progress) return this.showWait('Starting the app…', m.progress);
    if (!m.url) return;
    this.app = m.url.replace(/\/$/, '');
    this.frame.hint.textContent = this.app.replace(/^https?:\/\//, '');
    this.go(this.pending);
  }

  /** Calls the app made, and the project's fakes (from the extension). */
  receiveNetwork(m: CardNetwork) {
    if (m.type === 'calls') this.network.addCalls(m.calls, m.all);
    else this.network.setFakes(m.endpoints, m.scenarios, m.headers);
  }

  /** What the page says (through the inspector). */
  fromPage(data: Record<string, unknown>, source: MessageEventSource | null) {
    if (!this.iframe || source !== this.iframe.contentWindow) return;
    if (data.type === 'hello') {
      this.wait.hidden = true;
      this.css.empty();
      // A new page: picking goes on where it was.
      if (this.picking) this.toPage({ type: 'pick', on: true });
      this.console.page(this.pathOf(String(data.url)));
      this.address.value = this.pathOf(String(data.url));
    } else if (data.type === 'location') {
      this.address.value = this.pathOf(String(data.url));
    } else if (data.type === 'console') {
      this.console.add(data.entries as ConsoleEntry[]);
    } else if (data.type === 'picked') {
      this.css.show(data.element as Picked);
      this.frame.showPanel('css');
    } else if (data.type === 'picking') {
      this.picking = !!data.on;
      this.pickButton.classList.toggle('on', this.picking);
    }
  }

  private pathOf(url: string): string {
    try {
      const u = new URL(url);
      return u.pathname + u.search + u.hash;
    } catch {
      return url;
    }
  }

  private currentUrl(): string {
    return `${this.app}${this.address.value.startsWith('/') ? this.address.value : `/${this.address.value}`}`;
  }

  /** Goes to an address of the app (a path like /orders/7, or a whole address on the app). */
  private go(path: string) {
    let p = path.trim() || '/';
    if (/^https?:\/\//.test(p)) p = this.pathOf(p);
    if (!p.startsWith('/')) p = `/${p}`;
    this.pending = p;
    this.address.value = p;
    if (!this.app) return;
    if (!this.iframe) {
      this.iframe = el('iframe');
      this.iframe.title = 'The app';
      this.device.append(this.iframe);
      this.layout();
    }
    this.iframe.src = `${this.app}${p}`;
  }

  /** Picking an element in the page: on or off. */
  private setPicking(on: boolean) {
    this.picking = on;
    this.pickButton.classList.toggle('on', on);
    this.toPage({ type: 'pick', on });
  }

  private reload() {
    if (!this.toPage({ type: 'reload' }) && this.iframe) this.iframe.src = this.iframe.src;
  }

  /** A message to the page's inspector (false when there's no page). */
  private toPage(m: Record<string, unknown>): boolean {
    if (!this.iframe?.contentWindow) return false;
    this.iframe.contentWindow.postMessage({ source: 've-preview', ...m }, '*');
    return true;
  }

  private showWait(title: string, detail?: string, error = false) {
    this.wait.className = `pv-wait${error ? ' error' : ''}`;
    const box = el('div');
    box.append(el('h3', undefined, title));
    if (detail) box.append(el('p', undefined, detail));
    this.wait.replaceChildren(box);
    this.wait.hidden = false;
  }

  private typedSize() {
    const w = Math.round(Number(this.widthBox.value));
    const h = Math.round(Number(this.heightBox.value));
    if (w >= 100 && h >= 100) this.setSize({ fill: false, width: Math.min(w, 7680), height: Math.min(h, 7680) });
  }

  private setSize(size: PreviewWindow['size']) {
    this.size = size;
    const on = size.fill ? 'fill' : (size.device ?? '');
    for (const [id, b] of this.deviceButtons) b.classList.toggle('on', id === on);
    this.widthBox.value = size.fill ? '' : String(size.width);
    this.heightBox.value = size.fill ? '' : String(size.height);
    this.layout();
  }

  /** Sizes the screen: all the space, or the size chosen, scaled down to fit when asked. */
  private layout() {
    this.stage.classList.toggle('fill', this.size.fill);
    if (this.size.fill) {
      this.zoomText.textContent = '';
      this.device.style.width = this.device.style.height = '';
      return;
    }
    const { width, height } = this.size;
    const pad = 32;
    const scale = this.fit ? Math.min(1, (this.stage.clientWidth - pad) / width, (this.stage.clientHeight - pad) / height) : 1;
    const s = Math.max(0.05, scale);
    Object.assign(this.device.style, { width: `${Math.round(width * s)}px`, height: `${Math.round(height * s)}px` });
    if (this.iframe) Object.assign(this.iframe.style, { width: `${width}px`, height: `${height}px`, transform: s === 1 ? '' : `scale(${s})` });
    this.zoomText.textContent = `${Math.round(s * 100)}%`;
  }
}
