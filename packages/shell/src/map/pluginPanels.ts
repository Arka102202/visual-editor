// Plugins' Preview panels (contract 8), in the map page: each panel's script is loaded (allowed by the page's own
// nonce), it calls VisualEditor.definePanel(key, factory), and gets the api it draws with. Messages between it and its
// page script (in the app) go through Preview, on the panel's channel ("<plugin>/<panel>").

import type { PreviewPanelApi } from '@visual-editor/contract';
import type { FromMap, PluginPanel } from '../mapMessages';
import { el } from '../ui/dom';
import { addIcon, iconButton, tray, type Icon } from '../ui/buttons';
import type { PanelSpec } from '../ui/frame';
import { valueView } from './consolePanel';

/** The nonce the page's own script was allowed by: plugin scripts get it too (nothing else may run). */
const NONCE = (document.currentScript as HTMLScriptElement | null)?.nonce || (document.querySelector('script[nonce]') as HTMLScriptElement | null)?.nonce || '';

export const PLUGIN_PANELS_CSS = `
  .pp { height: 100%; overflow: auto; font-size: 12px; }
  .pp-error { padding: 12px; color: var(--vscode-errorForeground, #f48771); white-space: pre-wrap; font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; }
`;

interface Instance {
  info: PluginPanel;
  body: HTMLElement;
  defined: boolean;
  onMessage: ((data: unknown) => void)[];
  onFacts: ((facts: unknown) => void)[];
  onPage: ((url: string) => void)[];
  onShow: (() => void)[];
}

interface Host {
  post(m: FromMap): void;
  /** A message to the app's page (false when there's none). */
  toPage(m: Record<string, unknown>): boolean;
  /** The panels changed: arrange them again. */
  changed(): void;
  /** Loads the app's page again. */
  reload(): void;
  setCount(id: string, count: number | undefined): void;
}

export class PluginPanels {
  private readonly all = new Map<string, Instance>();
  private asked = 0;
  private readonly waiting = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();

  constructor(private readonly host: Host) {
    const w = window as unknown as { VisualEditor?: { definePanel(key: string, factory: (api: PreviewPanelApi) => void): void } };
    w.VisualEditor = { definePanel: (key, factory) => this.define(key, factory) };
  }

  /** The shown project's plugin panels (from VS Code). */
  set(panels: PluginPanel[]) {
    const keys = new Set(panels.map((p) => p.key));
    let changed = false;
    for (const key of [...this.all.keys()]) {
      if (keys.has(key)) continue;
      this.all.delete(key);
      changed = true;
    }
    for (const info of panels) {
      const had = this.all.get(info.key);
      if (had && had.info.code === info.code) {
        if (JSON.stringify(had.info.facts) !== JSON.stringify(info.facts)) {
          had.info = info;
          for (const h of had.onFacts) this.safely(had, () => h(info.facts));
        }
        continue;
      }
      addIcon(this.iconName(info.key), info.icon);
      const inst: Instance = { info, body: el('div', 'pp'), defined: false, onMessage: [], onFacts: [], onPage: [], onShow: [] };
      this.all.set(info.key, inst);
      this.load(inst);
      changed = true;
    }
    if (changed) this.host.changed();
  }

  /** The panels, for Preview's frame. */
  specs(): PanelSpec[] {
    return [...this.all.values()].map((inst) => ({
      id: this.id(inst.info.key),
      icon: this.iconName(inst.info.key) as Icon,
      name: inst.info.name,
      body: inst.body,
      onShow: () => {
        for (const h of inst.onShow) this.safely(inst, h);
      },
    }));
  }

  /** What the page said: a plugin's message, or a new page. */
  fromPage(data: Record<string, unknown>) {
    if (data.type === 'plugin') {
      const inst = this.all.get(String(data.channel));
      if (inst) for (const h of inst.onMessage) this.safely(inst, () => h(data.data));
    } else if (data.type === 'hello') {
      for (const inst of this.all.values()) for (const h of inst.onPage) this.safely(inst, () => h(String(data.url)));
    }
  }

  /** A plugin's answer to a panel's question (from VS Code). */
  answer(m: { id: number; answer?: unknown; error?: string }) {
    const w = this.waiting.get(m.id);
    if (!w) return;
    this.waiting.delete(m.id);
    if (m.error) w.reject(new Error(m.error));
    else w.resolve(m.answer);
  }

  id(key: string): string {
    return `plugin:${key}`;
  }

  private iconName(key: string): string {
    return `plugin:${key}`;
  }

  /** Runs the panel's script (a blob with this page's nonce: the page's policy lets nothing else run). */
  private load(inst: Instance) {
    const url = URL.createObjectURL(new Blob([inst.info.code], { type: 'text/javascript' }));
    const script = document.createElement('script');
    script.nonce = NONCE;
    script.src = url;
    script.onload = () => {
      URL.revokeObjectURL(url);
      if (!inst.defined) this.fail(inst, `The panel's script ran but didn't call VisualEditor.definePanel('${inst.info.key}', …).`);
    };
    script.onerror = () => this.fail(inst, 'The panel’s script couldn’t be loaded.');
    document.head.append(script);
  }

  private define(key: string, factory: (api: PreviewPanelApi) => void) {
    const inst = this.all.get(key);
    if (!inst) return;
    inst.defined = true;
    const channel = key;
    const api: PreviewPanelApi = {
      body: inst.body,
      get facts() {
        return inst.info.facts;
      },
      onFacts: (h) => void inst.onFacts.push(h),
      send: (data) => void this.host.toPage({ type: 'plugin', channel, data }),
      on: (h) => void inst.onMessage.push(h),
      onPage: (h) => void inst.onPage.push(h),
      onShow: (h) => void inst.onShow.push(h),
      setCount: (count) => this.host.setCount(this.id(key), count),
      reloadPage: () => this.host.reload(),
      ask: (request) =>
        new Promise((resolve, reject) => {
          const id = ++this.asked;
          this.waiting.set(id, { resolve, reject });
          this.host.post({ type: 'panelAsk', key, id, request });
        }),
      openSource: (url, line, column) => this.host.post({ type: 'openSource', url, line, column }),
      openFile: (path, line) => this.host.post({ type: 'open', path, ...(line ? { line } : {}) }),
      openItem: (label, kind) => this.host.post({ type: 'openItem', label, ...(kind ? { kind } : {}) }),
      ui: {
        el,
        button: (icon, name, options) => {
          if (icon.includes('<')) {
            const named = `plugin:${key}:${name}`;
            addIcon(named, icon);
            return iconButton(named as Icon, name, options ?? {});
          }
          return iconButton(icon as Icon, name, options ?? {});
        },
        tray: (row) => tray(row),
        value: (v, k) => valueView(v, k),
      },
    };
    this.safely(inst, () => factory(api));
  }

  private safely(inst: Instance, run: () => void) {
    try {
      run();
    } catch (e) {
      this.fail(inst, e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e));
    }
  }

  private fail(inst: Instance, text: string) {
    inst.body.replaceChildren(el('div', 'pp-error', `The ${inst.info.name.split(':')[0]} panel stopped: ${text}`));
  }
}
