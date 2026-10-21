// Preview: a component made previewable, drawn with every variant in every fixed-data state (the plugin's page, served
// at the app's address so the project's own styles and code load). Nothing reaches the network: a call a variant
// tries is blocked, and said here in words (with what to do). Saving a variant shows at once (the dev server's live
// reload). Plain DOM.

import type { Item } from '@visual-editor/contract';
import type { FromMap } from '../mapMessages';
import { el } from '../ui/dom';
import { iconButton } from '../ui/buttons';
import { Frame, type LayoutStore } from '../ui/frame';

export const PREVIEW_CSS = `
  .vp-main { position: absolute; inset: 0; display: flex; flex-direction: column; }
  .vp-notes { flex: none; display: flex; flex-direction: column; gap: 6px; padding: 8px 12px; border-bottom: 1px solid var(--vscode-panel-border, #8883); max-height: 30%; overflow: auto; }
  .vp-notes:empty { display: none; }
  .vp-note { padding: 7px 10px; border-radius: 6px; font-size: 12px; line-height: 1.5; background: color-mix(in srgb, var(--vscode-editorWarning-foreground, #cca700) 13%, transparent); }
  .vp-stage { position: relative; flex: 1; min-height: 0; background: #fff; }
  .vp-stage iframe { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; }
  .vp-wait { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; text-align: center; padding: 24px; color: #555; font-size: 13px; }
`;

interface Deps {
  post(m: FromMap): void;
  store: LayoutStore;
}

export class PreviewWindow {
  readonly frame: Frame;
  private readonly notes = el('div', 'vp-notes');
  private readonly stage = el('div', 'vp-stage');
  private readonly wait = el('div', 'vp-wait');
  private iframe: HTMLIFrameElement | undefined;
  private item: Item | undefined;
  private app: string | undefined;
  private readonly said = new Set<string>();
  /** Called when it opens or closes (a button that opens it shows whether it's open). */
  onToggle: (() => void) | undefined;

  constructor(private readonly deps: Deps) {
    this.frame = new Frame('variants', deps.store, {}, { size: { width: 'min(1400px, 96vw)', height: 'min(900px, 92vh)' } });
    this.frame.title.textContent = 'Preview';
    this.frame.onClose = () => this.onToggle?.();
    const reload = iconButton('reload', 'Draw it again');
    reload.addEventListener('click', () => this.load());
    this.frame.addTools(reload);
    const main = el('div', 'vp-main');
    this.stage.append(this.wait);
    main.append(this.notes, this.stage);
    this.frame.main.append(main);
  }

  /** Opens Preview for a card that has variants. */
  open(item: Item) {
    this.item = item;
    this.frame.title.textContent = `Preview: ${item.label}`;
    const p = item.preview;
    this.frame.hint.textContent = p ? `${p.variants.length} variant${p.variants.length === 1 ? '' : 's'} · ${p.states.length} state${p.states.length === 1 ? '' : 's'} · fixed data, no network` : '';
    this.frame.open();
    this.onToggle?.();
    if (this.app) this.load();
    else {
      this.showWait('Starting the app’s dev server…');
      this.deps.post({ type: 'app' });
    }
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
    const name = this.item?.label ?? 'It';
    if (data.type === 'blocked') {
      this.say(`A variant tried to call ${String(data.method)} ${String(data.url)}. Preview blocked it: variants show looks only, with fixed data. Move the call to ${name}.data.tsx and pass what it gives in ${name}View.`);
    } else if (data.type === 'missing') {
      this.say(data.what === 'helper' ? 'The project doesn’t have Visual Editor’s helper (src/visual-editor.tsx) yet, so nothing can be drawn.' : 'The project’s helper (src/visual-editor.tsx) is from before Preview: it needs updating (it has no mountPreview).');
    } else if (data.type === 'drawn') {
      for (const b of (data.broken as { id: string; text: string }[]) ?? []) this.say(`The variant “${b.id}” stopped while drawing: ${b.text}`);
    } else if (data.type === 'error') {
      this.say(`Something stopped while drawing: ${String(data.text)}`);
    }
  }

  private load() {
    if (!this.app || !this.item) return;
    this.said.clear();
    this.notes.replaceChildren();
    this.iframe?.remove();
    const iframe = el('iframe');
    iframe.title = `Preview of ${this.item.label}`;
    iframe.src = `${this.app}/__ve/preview?item=${encodeURIComponent(this.item.id)}`;
    this.iframe = iframe;
    this.wait.hidden = true;
    this.stage.append(iframe);
  }

  private say(text: string) {
    if (this.said.has(text)) return;
    this.said.add(text);
    this.notes.append(el('div', 'vp-note', text));
  }

  private showWait(text: string) {
    this.wait.textContent = text;
    this.wait.hidden = false;
  }
}
