// The CSS panel: the element picked in Preview's page. Its path (click a part to pick that parent), its box model,
// every rule that applies (strongest first, with @media, what's overridden struck through, and where each comes from:
// a click opens that file at that rule), what each of its classes does (Tailwind's too), and its final values (the
// usual ones by group; all of them, searchable). Plain DOM.

import { el } from '../ui/dom';
import { iconButton, tray } from '../ui/buttons';

export interface PickedRule {
  selector: string;
  matched: string;
  media: string[];
  /** Where it comes from: a stylesheet's file (or address), "inline", or "<style> in the page". */
  source: string;
  /** `vars`: what each var(--x) in the value stands for on this element. */
  declarations: { name: string; value: string; important: boolean; overridden?: boolean; vars?: Record<string, string> }[];
}

export interface Picked {
  label: string;
  tag: string;
  classes: string[];
  path: string[];
  size: { width: number; height: number };
  box: { margin: number[]; border: number[]; padding: number[]; content: { width: number; height: number } };
  rules: PickedRule[];
  computed: Record<string, string>;
  all: Record<string, string>;
  text: string;
}

export const CSS_PANEL_CSS = `
  .css { padding: 8px 10px 14px; font-size: 12px; }
  .css .bar { display: flex; align-items: center; gap: 6px; margin-bottom: 8px; }
  .css .bar .who { flex: 1; min-width: 0; font-family: var(--vscode-editor-font-family, monospace); font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--tok-type, inherit); }
  .css .bar .dim { opacity: .6; white-space: nowrap; }
  .css .crumbs { display: flex; flex-wrap: wrap; gap: 2px 4px; margin-bottom: 10px; font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; }
  .css .crumbs span.part { cursor: pointer; opacity: .7; padding: 0 3px; border-radius: 3px; }
  .css .crumbs span.part:hover { opacity: 1; background: #8882; }
  .css .crumbs span.part.here { opacity: 1; font-weight: 700; }
  .css .crumbs .sep { opacity: .35; }
  .css h4 { margin: 14px 0 6px; font-size: 11px; letter-spacing: .05em; text-transform: uppercase; opacity: .65; }
  .css .boxm { font-family: var(--vscode-editor-font-family, monospace); font-size: 10px; text-align: center; }
  .css .boxm .lay { position: relative; padding: 16px 22px; border: 1px dashed #8886; border-radius: 3px; }
  .css .boxm .lay > .name { position: absolute; left: 4px; top: 1px; opacity: .6; }
  .css .boxm .lay > .t, .css .boxm .lay > .b { position: absolute; left: 0; right: 0; }
  .css .boxm .lay > .t { top: 1px; }
  .css .boxm .lay > .b { bottom: 1px; }
  .css .boxm .lay > .l, .css .boxm .lay > .r { position: absolute; top: 50%; transform: translateY(-50%); }
  .css .boxm .lay > .l { left: 4px; }
  .css .boxm .lay > .r { right: 4px; }
  .css .boxm .m { background: rgba(246,178,107,.18); }
  .css .boxm .bo { background: rgba(255,229,153,.18); border-style: solid; }
  .css .boxm .p { background: rgba(147,196,125,.2); }
  .css .boxm .c { background: rgba(111,168,220,.25); padding: 6px; border: 1px solid #8886; }
  .css .rule { margin-bottom: 8px; border-radius: 6px; background: var(--vscode-editorWidget-background, #8881); padding: 6px 8px; font-family: var(--vscode-editor-font-family, monospace); }
  .css .rule .head { display: flex; gap: 8px; align-items: baseline; }
  .css .rule .sel { flex: 1; min-width: 0; color: var(--tok-type, inherit); word-break: break-all; }
  .css .rule .sel .hit { font-weight: 700; }
  .css .rule .src { flex: none; opacity: .65; cursor: pointer; text-decoration: underline dotted; white-space: nowrap; font-family: var(--vscode-font-family, system-ui); font-size: 11px; }
  .css .rule .src:hover { opacity: 1; color: var(--vscode-textLink-foreground, #3794ff); }
  .css .rule .media { font-size: 10px; opacity: .6; }
  .css .decl { padding-left: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .css .decl .n { color: var(--tok-property, #9cdcfe); }
  .css .decl .v { color: var(--tok-string, inherit); }
  .css .decl.over { text-decoration: line-through; opacity: .45; }
  .css .decl .arrow { opacity: .45; }
  .css .decl .var { color: var(--tok-number, inherit); }
  .css .decl .imp { font-size: 10px; margin-left: 4px; color: var(--tok-keyword, #c586c0); }
  .css .sw { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 4px; vertical-align: -1px; border: 1px solid #8886; }
  .css .cls { margin-bottom: 6px; }
  .css .cls .name { font-family: var(--vscode-editor-font-family, monospace); color: var(--tok-function, inherit); font-weight: 600; }
  .css .cls .what { padding-left: 12px; font-family: var(--vscode-editor-font-family, monospace); opacity: .9; }
  .css .cls .none { padding-left: 12px; opacity: .55; }
  .css table { width: 100%; border-collapse: collapse; font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; }
  .css td { padding: 2px 4px; border-bottom: 1px solid color-mix(in srgb, var(--vscode-panel-border, #8883) 60%, transparent); vertical-align: top; }
  .css td.k { color: var(--tok-property, #9cdcfe); width: 42%; white-space: nowrap; }
  .css td.v { word-break: break-all; }
  .css .group { margin: 8px 0 2px; font-size: 10px; opacity: .55; text-transform: uppercase; letter-spacing: .05em; }
  .css input.find { width: 100%; box-sizing: border-box; font: inherit; font-size: 12px; padding: 3px 7px; margin: 4px 0 6px; border-radius: 4px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, #8884); }
  .css .empty { opacity: .7; line-height: 1.5; padding: 6px 2px; }
`;

const GROUPS: [string, RegExp][] = [
  ['Layout', /^(display|position|top|right|bottom|left|z-index|box-sizing|width|height|min-|max-|overflow)/],
  ['Spacing', /^(margin|padding|border-(top|right|bottom|left)-width|border-style|border-color|border-radius)/],
  ['Flex and grid', /^(flex|justify|align|gap|grid)/],
  ['Text', /^(font|line-height|letter-spacing|text-|white-space)/],
  ['Colour and effects', /^(color|background|opacity|box-shadow|cursor|transform|transition)/],
];

export class CssPanel {
  readonly body = el('div', 'css');
  private element: Picked | undefined;
  private showAll = false;
  private filterText = '';

  constructor(
    private readonly toPage: (m: Record<string, unknown>) => void,
    private readonly openRule: (source: string, selector: string) => void,
  ) {
    this.empty();
  }

  /** Nothing picked (a new page, or not yet). */
  empty(text = 'Pick an element to see its CSS: the picker in Preview’s bar (the arrow), then click anything in the page.') {
    this.element = undefined;
    const bar = el('div', 'bar');
    bar.append(el('span', 'empty', text));
    this.body.replaceChildren(bar);
  }

  show(p: Picked) {
    this.element = p;
    this.render();
  }

  private render() {
    const p = this.element;
    if (!p) return this.empty();
    const scroll = this.body.parentElement?.scrollTop ?? 0;
    const out: Node[] = [];

    // Who: the element, its size, and refresh / its parent (another one: Preview's picker).
    const bar = el('div', 'bar');
    const who = el('span', 'who', p.label);
    who.dataset.tip = p.text ? `${p.label}\n“${p.text}”` : p.label;
    const tools = tray(el('div'));
    const up = iconButton('goBack', 'Its parent');
    up.addEventListener('click', () => this.toPage({ type: 'selectUp', steps: 1 }));
    const refresh = iconButton('reload', 'Read it again (after the page changed)');
    refresh.addEventListener('click', () => this.toPage({ type: 'refresh' }));
    tools.append(up, refresh);
    bar.append(who, el('span', 'dim', `${round(p.size.width)} × ${round(p.size.height)}`), tools);
    out.push(bar);

    // Its path: a click picks that parent.
    const crumbs = el('div', 'crumbs');
    p.path.forEach((part, i) => {
      if (i) crumbs.append(el('span', 'sep', '›'));
      const c = el('span', `part${i === p.path.length - 1 ? ' here' : ''}`, part.length > 40 ? `${part.slice(0, 38)}…` : part);
      c.dataset.tip = part;
      const steps = p.path.length - 1 - i;
      if (steps) c.addEventListener('click', () => this.toPage({ type: 'selectUp', steps }));
      crumbs.append(c);
    });
    out.push(crumbs);

    out.push(el('h4', undefined, 'Box model'), boxModel(p));

    // Rules, strongest first.
    out.push(el('h4', undefined, `Rules (${p.rules.length})`));
    if (!p.rules.length) out.push(el('div', 'empty', 'No CSS rules apply: only what the browser does by default (and what it inherits).'));
    for (const r of p.rules) out.push(this.rule(r));

    // What each class does.
    if (p.classes.length) {
      out.push(el('h4', undefined, `Classes (${p.classes.length})`));
      for (const c of p.classes) {
        const box = el('div', 'cls');
        box.append(el('div', 'name', c));
        const esc = `.${cssEscape(c)}`;
        const own = p.rules.filter((r) => r.matched.includes(esc));
        if (!own.length) box.append(el('div', 'none', 'No rule for it (a name used by scripts, or styles not loaded).'));
        for (const r of own) {
          const what = el('div', 'what');
          // Only real conditions (screen size…); @layer is just how the CSS is grouped.
          const conditions = r.media.filter((m) => !m.startsWith('@layer'));
          const media = conditions.length ? ` (${conditions.map((m) => m.replace(/^@media\s*/, '')).join(', ')})` : '';
          what.textContent = `${r.declarations.map((d) => `${d.name}: ${d.value}${d.important ? ' !important' : ''}`).join('; ')}${media}`;
          box.append(what);
        }
        out.push(box);
      }
    }

    // Its final values.
    out.push(el('h4', undefined, 'Final values'));
    const toggle = iconButton(this.showAll ? 'levelLog' : 'panels', this.showAll ? 'Show the usual ones, by group' : 'Show all of them');
    toggle.addEventListener('click', () => {
      this.showAll = !this.showAll;
      this.render();
    });
    out.push(toggle);
    if (this.showAll) {
      const find = el('input', 'find');
      find.placeholder = 'Find a property';
      find.value = this.filterText;
      find.addEventListener('input', () => {
        this.filterText = find.value;
        table.replaceChildren(...rows(Object.entries(p.all).filter(([k]) => k.includes(this.filterText.trim()))));
      });
      find.addEventListener('keydown', (e) => e.key === 'Escape' && e.stopPropagation());
      const table = el('table');
      table.append(...rows(Object.entries(p.all).filter(([k]) => k.includes(this.filterText.trim()))));
      out.push(find, table);
    } else {
      for (const [name, test] of GROUPS) {
        const list = Object.entries(p.computed).filter(([k, v]) => test.test(k) && v && v !== 'none' && v !== 'normal' && v !== 'auto' && v !== '0px');
        if (!list.length) continue;
        const table = el('table');
        table.append(...rows(list));
        out.push(el('div', 'group', name), table);
      }
    }
    this.body.replaceChildren(...out);
    if (this.body.parentElement) this.body.parentElement.scrollTop = scroll;
  }

  private rule(r: PickedRule): HTMLElement {
    const box = el('div', 'rule');
    for (const m of r.media) box.append(el('div', 'media', m));
    const head = el('div', 'head');
    const sel = el('span', 'sel');
    // The part of the selector that matched stands out.
    const at = r.selector.indexOf(r.matched);
    if (at >= 0 && r.selector !== r.matched) sel.append(r.selector.slice(0, at), el('span', 'hit', r.matched), r.selector.slice(at + r.matched.length));
    else sel.append(el('span', 'hit', r.selector));
    head.append(sel);
    if (r.source && r.source !== 'inline') {
      const name = r.source.replace(/^https?:\/\/[^/]+/, '').replace(/\?.*$/, '');
      const src = el('span', 'src', name.split('/').pop() || name);
      src.dataset.tip = `${name}: open it at this rule`;
      src.addEventListener('click', () => this.openRule(r.source, r.selector));
      head.append(src);
    }
    box.append(head);
    for (const d of r.declarations) {
      const line = el('div', `decl${d.overridden ? ' over' : ''}`);
      line.append(el('span', 'n', d.name), ': ');
      const v = el('span', 'v');
      if (isColour(d.value)) {
        const sw = el('span', 'sw');
        sw.style.background = d.value;
        v.append(sw);
      }
      v.append(d.value);
      line.append(v);
      // What its variables stand for here: var(--color-accent) → #3b5bdb.
      for (const [name, real] of Object.entries(d.vars ?? {})) {
        if (!real) continue;
        const is = el('span', 'var');
        if (isColour(real)) {
          const sw = el('span', 'sw');
          sw.style.background = real;
          is.append(sw);
        }
        is.append(real);
        is.dataset.tip = `${name} is ${real} here`;
        line.append(el('span', 'arrow', ' → '), is);
      }
      if (d.important) line.append(el('span', 'imp', '!important'));
      // The whole line on hover (long ones are cut short).
      line.dataset.tip = `${line.textContent ?? ''}${d.overridden ? '\n(overridden by a stronger rule)' : ''}`;
      box.append(line);
    }
    return box;
  }
}

function round(n: number): string {
  return String(Math.round(n * 10) / 10);
}

function isColour(v: string): boolean {
  return /^(#|rgb|hsl|oklch|oklab|lab\(|lch\(|color\()/i.test(v.trim()) || (/^[a-z]+$/i.test(v.trim()) && !/^(inherit|initial|unset|none|auto|currentcolor|transparent)$/i.test(v.trim()) && CSS.supports('color', v));
}

function cssEscape(s: string): string {
  return typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(s) : s.replace(/([^\w-])/g, '\\$1');
}

function rows(list: [string, string][]): HTMLElement[] {
  return list.map(([k, v]) => {
    const tr = el('tr');
    const td = el('td', 'v');
    if (isColour(v)) {
      const sw = el('span', 'sw');
      sw.style.background = v;
      td.append(sw);
    }
    td.append(v);
    tr.append(el('td', 'k', k), td);
    return tr;
  });
}

/** Margin, border, padding and content, nested, with their numbers. */
function boxModel(p: Picked): HTMLElement {
  const layer = (cls: string, name: string, sides: number[] | undefined, inner: HTMLElement) => {
    const box = el('div', `lay ${cls}`);
    box.append(el('span', 'name', name));
    if (sides) {
      const [t, r, b, l] = sides.map((n) => (n ? round(n) : '–'));
      box.append(el('span', 't', t), el('span', 'r', r), el('span', 'b', b), el('span', 'l', l));
    }
    box.append(inner);
    return box;
  };
  const content = el('div', 'c', `${round(p.box.content.width)} × ${round(p.box.content.height)}`);
  const wrap = el('div', 'boxm');
  wrap.append(layer('m', 'margin', p.box.margin, layer('bo', 'border', p.box.border, layer('p', 'padding', p.box.padding, content))));
  return wrap;
}
