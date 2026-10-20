// The Console panel: everything the page in Preview logs (console.log/info/warn/error/debug, uncaught errors, failed
// promises), as the inspector tells it. Messages are filled in as the browser would (React's "%s" messages), objects
// open like a tree, repeats are counted, and each message says where it came from: a click opens that place in the
// developer's own file. Filter by level, search, clear. Plain DOM.

import { el } from '../ui/dom';
import { iconButton, tray, type Icon } from '../ui/buttons';

/** One message, as the inspector sends it. */
export interface ConsoleEntry {
  level: 'log' | 'info' | 'warn' | 'error' | 'debug';
  args: unknown[];
  at?: { url: string; line: number; column: number };
  time: number;
  uncaught?: boolean;
  promise?: boolean;
}

export const CONSOLE_CSS = `
  .cs { display: flex; flex-direction: column; height: 100%; }
  .cs-bar { display: flex; align-items: center; gap: 4px; padding: 5px 8px; border-bottom: 1px solid var(--vscode-panel-border, #8883); flex: none; }
  .cs-bar input { flex: 1; min-width: 80px; font: inherit; font-size: 12px; padding: 3px 7px; border-radius: 4px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, #8884); }
  .cs-bar .levels button { background: transparent; opacity: .45; }
  .cs-bar .levels button.on { opacity: 1; }
  .cs-list { flex: 1; min-height: 0; overflow: auto; font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; }
  .cs-row { display: flex; gap: 8px; align-items: flex-start; padding: 3px 10px; border-bottom: 1px solid color-mix(in srgb, var(--vscode-panel-border, #8883) 60%, transparent); }
  .cs-row .ic { flex: none; width: 14px; height: 14px; margin-top: 1px; color: var(--c, inherit); }
  .cs-row .ic svg { width: 14px; height: 14px; }
  .cs-row .msg { flex: 1; min-width: 0; white-space: pre-wrap; word-break: break-word; }
  .cs-row .where { flex: none; opacity: .6; cursor: pointer; text-decoration: underline dotted; white-space: nowrap; }
  .cs-row .where:hover { opacity: 1; color: var(--vscode-textLink-foreground, #3794ff); }
  .cs-row .times { flex: none; font-size: 10px; padding: 0 5px; border-radius: 8px; background: #8883; }
  .cs-row.error { --c: var(--vscode-errorForeground, #f48771); background: color-mix(in srgb, var(--vscode-errorForeground, #f48771) 9%, transparent); }
  .cs-row.warn { --c: var(--vscode-editorWarning-foreground, #cca700); background: color-mix(in srgb, var(--vscode-editorWarning-foreground, #cca700) 8%, transparent); }
  .cs-row.info { --c: var(--vscode-charts-blue, #3794ff); }
  .cs-row.debug { --c: var(--vscode-descriptionForeground, #999); opacity: .8; }
  .cs-row.error .msg { color: var(--vscode-errorForeground, #f48771); }
  .cs-page { padding: 3px 10px; font-size: 11px; opacity: .6; border-bottom: 1px dashed var(--vscode-panel-border, #8885); font-family: var(--vscode-font-family, system-ui); }
  .cs-empty { padding: 12px; opacity: .6; font-family: var(--vscode-font-family, system-ui); }
  .cs-v.str { color: var(--tok-string, #ce9178); }
  .cs-v.num { color: var(--tok-number, #b5cea8); }
  .cs-v.kw { color: var(--tok-literal, #569cd6); }
  .cs-v.fn { color: var(--tok-function, #dcdcaa); font-style: italic; }
  .cs-v.dim { opacity: .65; }
  .cs-key { color: var(--tok-property, #9cdcfe); }
  .cs-tree { display: inline; }
  .cs-tree > summary { display: inline; cursor: pointer; list-style: none; }
  .cs-tree > summary::before { content: '▸ '; opacity: .6; }
  .cs-tree[open] > summary::before { content: '▾ '; }
  .cs-tree > .kids { display: block; padding-left: 16px; }
`;

const LEVELS: { level: ConsoleEntry['level']; icon: Icon; name: string }[] = [
  { level: 'error', icon: 'levelError', name: 'Errors' },
  { level: 'warn', icon: 'levelWarn', name: 'Warnings' },
  { level: 'info', icon: 'levelInfo', name: 'Info' },
  { level: 'log', icon: 'levelLog', name: 'Logs' },
  { level: 'debug', icon: 'levelDebug', name: 'Debug' },
];
const ICON_OF: Record<ConsoleEntry['level'], Icon> = { error: 'levelError', warn: 'levelWarn', info: 'levelInfo', log: 'levelLog', debug: 'levelDebug' };
/** The most messages kept (the oldest go first). */
const MAX = 2000;

type Described = { $t: string; text?: string; stack?: string; name?: string; fields?: Record<string, unknown>; entries?: [unknown, unknown][]; items?: unknown[]; size?: number };

export class ConsolePanel {
  readonly body = el('div', 'cs');
  private readonly list = el('div', 'cs-list');
  private readonly search = el('input');
  private readonly shown = new Set<ConsoleEntry['level']>(['error', 'warn', 'info', 'log', 'debug']);
  private readonly rows: { entry: ConsoleEntry; el: HTMLElement; key: string; times: number }[] = [];
  /** Called when the counts change (for the panel's tab). */
  onCounts: ((all: number, errors: number) => void) | undefined;

  constructor(private readonly openSource: (url: string, line: number, column: number) => void) {
    const bar = el('div', 'cs-bar');
    const levels = tray(el('div', 'levels'));
    for (const l of LEVELS) {
      const b = iconButton(l.icon, `${l.name}: show or hide`, { cls: 'on' });
      b.addEventListener('click', () => {
        if (this.shown.has(l.level)) this.shown.delete(l.level);
        else this.shown.add(l.level);
        b.classList.toggle('on', this.shown.has(l.level));
        this.filter();
      });
      levels.append(b);
    }
    this.search.placeholder = 'Find in messages';
    this.search.addEventListener('input', () => this.filter());
    this.search.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        this.search.value = '';
        this.filter();
      }
    });
    const clear = iconButton('clear', 'Clear the messages');
    clear.addEventListener('click', () => this.clear());
    bar.append(levels, this.search, clear);
    this.body.append(bar, this.list);
    this.list.append(el('div', 'cs-empty', 'Nothing logged yet. What the page logs shows here.'));
  }

  /** A new page loaded: a line between its messages and the earlier ones. */
  page(url: string) {
    this.list.querySelector('.cs-empty')?.remove();
    const line = el('div', 'cs-page', `Page loaded: ${url}`);
    this.list.append(line);
    this.rows.length && this.trim();
  }

  add(entries: ConsoleEntry[]) {
    this.list.querySelector('.cs-empty')?.remove();
    const atEnd = this.list.scrollHeight - this.list.scrollTop - this.list.clientHeight < 30;
    for (const entry of entries) {
      const key = `${entry.level}|${JSON.stringify(entry.args)}|${entry.at?.url}:${entry.at?.line}`;
      const last = this.rows[this.rows.length - 1];
      // The same message again: counted, not repeated.
      if (last && last.key === key && last.el === this.list.lastElementChild) {
        last.times++;
        let t = last.el.querySelector('.times');
        if (!t) {
          t = el('span', 'times');
          last.el.insertBefore(t, last.el.querySelector('.where'));
        }
        t.textContent = `×${last.times}`;
        continue;
      }
      const row = this.row(entry);
      this.rows.push({ entry, el: row, key, times: 1 });
      this.list.append(row);
      row.hidden = !this.matches(entry, row);
    }
    this.trim();
    if (atEnd) this.list.scrollTop = this.list.scrollHeight;
    this.count();
  }

  clear() {
    this.rows.length = 0;
    this.list.replaceChildren(el('div', 'cs-empty', 'Cleared. New messages show here.'));
    this.count();
  }

  private trim() {
    while (this.rows.length > MAX) this.rows.shift()!.el.remove();
  }

  private count() {
    this.onCounts?.(this.rows.length, this.rows.filter((r) => r.entry.level === 'error').length);
  }

  private matches(entry: ConsoleEntry, row: HTMLElement): boolean {
    const q = this.search.value.trim().toLowerCase();
    return this.shown.has(entry.level) && (!q || (row.textContent ?? '').toLowerCase().includes(q));
  }

  private filter() {
    for (const r of this.rows) r.el.hidden = !this.matches(r.entry, r.el);
  }

  private row(entry: ConsoleEntry): HTMLElement {
    const row = el('div', `cs-row ${entry.level}`);
    const ic = el('span', 'ic');
    const tmp = iconButton(ICON_OF[entry.level], '');
    ic.innerHTML = tmp.innerHTML;
    const msg = el('div', 'msg');
    if (entry.uncaught) msg.append(el('span', 'cs-v dim', entry.promise ? 'Uncaught (in promise) ' : 'Uncaught '));
    msg.append(...format(entry.args));
    row.append(ic, msg);
    if (entry.at) {
      const file = entry.at.url.replace(/^https?:\/\/[^/]+/, '').replace(/\?.*$/, '');
      const where = el('span', 'where', `${file.split('/').pop()}:${entry.at.line}`);
      where.dataset.tip = `${file}, line ${entry.at.line}: open it in your file`;
      const at = entry.at;
      where.addEventListener('click', () => this.openSource(at.url, at.line, at.column));
      row.append(where);
    }
    return row;
  }
}

/** The arguments as the browser shows them: "%s"/"%d"/"%o" filled in from the first, styles ("%c") dropped. */
export function format(args: unknown[]): Node[] {
  const out: Node[] = [];
  let rest = args;
  if (typeof args[0] === 'string' && /%[sdifoOc]/.test(args[0])) {
    let i = 1;
    const text = args[0].replace(/%([sdifoOc%])/g, (_m, k: string) => {
      if (k === '%') return '%';
      const v = args[i++];
      if (k === 'c') return '';
      if (k === 'd' || k === 'i') return String(parseInt(String(v), 10));
      if (k === 'f') return String(parseFloat(String(v)));
      return typeof v === 'string' ? v : preview(v);
    });
    out.push(document.createTextNode(text));
    rest = args.slice(i);
  }
  for (const a of rest) {
    if (out.length) out.push(document.createTextNode(' '));
    out.push(typeof a === 'string' && out.length === 0 ? document.createTextNode(a) : value(a));
  }
  return out;
}

/** A short line for a value (shown where it's closed). */
function preview(v: unknown): string {
  if (v === null) return 'null';
  if (typeof v !== 'object') return typeof v === 'string' ? JSON.stringify(v) : String(v);
  const d = v as Described;
  if (typeof d.$t === 'string' && !Array.isArray(v)) {
    if (d.$t === 'object') return `${d.name} {…}`;
    if (d.$t === 'map') return `Map(${d.size})`;
    if (d.$t === 'set') return `Set(${d.size})`;
    return d.text ?? d.$t;
  }
  if (Array.isArray(v)) return `Array(${v.length})`;
  const keys = Object.keys(v);
  return `{${keys.slice(0, 4).join(', ')}${keys.length > 4 ? ', …' : ''}}`;
}

/** A value as the Console shows it (for plugin panels too). */
export function valueView(v: unknown, key?: string): Node {
  return value(v, key);
}

/** A value: plain ones coloured; objects, lists, maps and sets open like a tree; errors with their stack. */
function value(v: unknown, key?: string): Node {
  const span = (cls: string, text: string) => el('span', `cs-v ${cls}`, text);
  const wrap = (node: Node) => {
    if (key === undefined) return node;
    const line = el('div');
    line.append(el('span', 'cs-key', `${key}: `), node);
    return line;
  };
  if (v === null) return wrap(span('kw', 'null'));
  if (typeof v === 'string') return wrap(key === undefined ? document.createTextNode(v) : span('str', JSON.stringify(v)));
  if (typeof v === 'number') return wrap(span('num', String(v)));
  if (typeof v === 'boolean') return wrap(span('kw', String(v)));
  if (typeof v !== 'object') return wrap(span('dim', String(v)));
  const d = v as Described;
  if (!Array.isArray(v) && typeof d.$t === 'string') {
    if (d.$t === 'undefined') return wrap(span('kw', 'undefined'));
    if (d.$t === 'function') return wrap(span('fn', d.text ?? 'ƒ'));
    if (d.$t === 'error') {
      if (!d.stack) return wrap(span('', d.text ?? 'Error'));
      return wrap(tree(d.text ?? 'Error', () => [el('div', 'cs-v dim', d.stack!.split('\n').slice(1).join('\n'))]));
    }
    if (d.$t === 'object') return wrap(tree(`${d.name} {…}`, () => Object.entries(d.fields ?? {}).map(([k, x]) => value(x, k))));
    if (d.$t === 'map') return wrap(tree(`Map(${d.size})`, () => (d.entries ?? []).map(([k, x]) => value(x, preview(k)))));
    if (d.$t === 'set') return wrap(tree(`Set(${d.size})`, () => (d.items ?? []).map((x, i) => value(x, String(i)))));
    return wrap(span('dim', d.text ?? d.$t));
  }
  if (Array.isArray(v)) return wrap(tree(`Array(${v.length})`, () => v.map((x, i) => value(x, String(i)))));
  return wrap(tree(preview(v), () => Object.entries(v as Record<string, unknown>).map(([k, x]) => value(x, k))));
}

/** Something that opens to show what's in it (made only when opened). */
function tree(summary: string, kids: () => Node[]): HTMLElement {
  const box = el('details', 'cs-tree');
  const s = el('summary');
  s.append(el('span', 'cs-v dim', summary));
  const inner = el('div', 'kids');
  box.append(s, inner);
  box.addEventListener('toggle', () => {
    if (box.open && !inner.childElementCount) inner.append(...kids());
  });
  return box;
}
