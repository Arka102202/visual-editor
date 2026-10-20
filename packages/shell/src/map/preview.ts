// The Preview window: one card drawn on its own, in a window over everything (never beside anything). Its plugin
// works out, from the files alone, every piece of data the card needs (props, route params, API replies, context…)
// with example values; the side panel lists them all, and the developer fills in what couldn't be worked out. The
// card is drawn only when every required one has a value. The side panel's other tab shows the CSS of the part of
// the card that's picked.

import type { Need } from '@visual-editor/contract';
import type { CardNeeds, FromMap } from '../mapMessages';
import { el } from '../ui/dom';
import { iconButton, tray, type Icon } from '../ui/buttons';
import { typeText } from '../ui/typeText';
import { windowControls } from '../ui/windows';

export const PREVIEW_CSS = `
  .pv-back { position: fixed; inset: 0; z-index: 30; background: color-mix(in srgb, #000 60%, transparent); display: flex; align-items: center; justify-content: center; }
  .pv { position: relative; width: min(1320px, 96vw); height: min(860px, 92vh); display: flex; flex-direction: column; border-radius: 12px; background: var(--vscode-editor-background); border: 1px solid var(--vscode-panel-border, #8885); box-shadow: 0 24px 70px #0009; overflow: hidden; }
  .pv-head { display: flex; align-items: center; gap: 10px; padding: 12px 16px; border-bottom: 1px solid var(--vscode-panel-border, #8883); flex: none; }
  .pv-head h2 { margin: 0; font-size: 15px; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .pv-head .state { font-size: 11px; white-space: nowrap; padding: 2px 8px; border-radius: 10px; background: color-mix(in srgb, var(--state, #888) 18%, transparent); color: var(--state, inherit); }
  .pv-head .grow { flex: 1; }
  .pv-body { flex: 1; min-height: 0; display: flex; }
  .pv-stage { position: relative; flex: 1; min-width: 0; display: flex; align-items: center; justify-content: center; overflow: auto; background: color-mix(in srgb, var(--vscode-foreground) 3%, var(--vscode-editor-background)); }
  .pv-wait { max-width: 460px; padding: 24px; text-align: center; }
  .pv-wait h3 { margin: 0 0 6px; font-size: 15px; }
  .pv-wait p { margin: 0 0 12px; opacity: .75; }
  .pv-wait .gaps { display: flex; flex-wrap: wrap; gap: 6px; justify-content: center; }
  .pv-wait .gap { cursor: pointer; font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; padding: 2px 8px; border-radius: 6px; color: var(--miss); background: color-mix(in srgb, var(--miss) 14%, transparent); }
  .pv-side { width: 400px; flex: none; display: flex; flex-direction: column; border-left: 1px solid var(--vscode-panel-border, #8883); background: var(--vscode-sideBar-background, var(--vscode-editor-background)); }
  .pv-tabs { padding: 8px 10px; gap: 4px; border-bottom: 1px solid var(--vscode-panel-border, #8883); flex: none; }
  .pv-tabs button { background: transparent; color: var(--vscode-foreground); opacity: .75; }
  .pv-tabs button.icon.on { opacity: 1; background: var(--vscode-toolbar-activeBackground, #8883); }
  .pv-progress { padding: 10px 12px 4px; font-size: 12px; flex: none; }
  .pv-progress .meter { height: 4px; border-radius: 2px; margin-top: 6px; background: color-mix(in srgb, var(--vscode-foreground) 12%, transparent); overflow: hidden; }
  .pv-progress .meter > div { height: 100%; background: var(--ok); transition: width .2s; }
  .pv-list { flex: 1; min-height: 0; overflow-y: auto; padding: 4px 10px 12px; }
  .pv-list h3 { font-size: 11px; font-weight: 700; letter-spacing: .05em; text-transform: uppercase; opacity: .65; margin: 12px 2px 6px; }
  .pv-need { position: relative; border-radius: 6px; margin-bottom: 5px; background: var(--vscode-editorWidget-background, #8881); overflow: hidden; }
  .pv-need .strip { position: absolute; left: 0; top: 0; bottom: 0; width: 4px; background: var(--ok); }
  .pv-need.missing .strip { background: var(--miss); }
  .pv-need.optional .strip { background: color-mix(in srgb, var(--vscode-foreground) 25%, transparent); }
  .pv-need .top { display: flex; align-items: center; gap: 8px; padding: 7px 8px 2px 13px; cursor: pointer; }
  .pv-need .l { font-weight: 600; font-size: 13px; color: var(--tok-property, inherit); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
  .pv-need .chip { font-size: 10px; padding: 0 6px; border-radius: 6px; white-space: nowrap; flex: none; }
  .pv-need .chip.miss { color: var(--miss); background: color-mix(in srgb, var(--miss) 16%, transparent); }
  .pv-need .chip.yours { color: var(--tok-function, var(--vscode-textLink-foreground)); background: color-mix(in srgb, var(--tok-function, var(--vscode-textLink-foreground)) 16%, transparent); }
  .pv-need .chip.opt { opacity: .6; background: #8882; }
  .pv-need .grow { flex: 1; }
  .pv-need .chev { flex: none; width: 6px; height: 6px; border-right: 1.5px solid currentColor; border-bottom: 1.5px solid currentColor; transform: rotate(-45deg); opacity: .6; margin: 0 4px; transition: transform .15s; }
  .pv-need.open .chev { transform: rotate(45deg); }
  .pv-need .ty { padding: 0 8px 0 13px; font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .pv-need .from { padding: 2px 8px 7px 13px; font-size: 11px; opacity: .6; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .pv-need .edit { display: none; padding: 0 8px 8px 13px; }
  .pv-need.open .edit { display: block; }
  .pv-need .edit .full-type { font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; white-space: pre-wrap; word-break: break-word; padding: 6px 8px; border-radius: 4px; margin-bottom: 6px; background: color-mix(in srgb, var(--vscode-foreground) 6%, transparent); }
  .pv-need .edit .holes { font-size: 11px; color: var(--miss); margin-bottom: 6px; }
  .pv-need textarea { width: 100%; box-sizing: border-box; min-height: 90px; resize: vertical; font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; line-height: 1.45; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, #8884); border-radius: 4px; padding: 6px 8px; }
  .pv-need textarea:focus { outline: 1px solid var(--vscode-focusBorder, #39f); }
  .pv-need .err { color: var(--vscode-errorForeground, #f48771); font-size: 11px; margin-top: 4px; }
  .pv-need .acts { margin-top: 6px; }
  .pv-need .calls { font-size: 12px; opacity: .75; }
  .pv-group { display: flex; align-items: center; gap: 8px; margin: 10px 0 5px; padding: 4px 4px; border-radius: 5px; cursor: pointer; font-size: 11px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; }
  .pv-group:hover { background: #8881; }
  .pv-group .g { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; opacity: .8; }
  .pv-group .n { font-weight: 500; opacity: .6; text-transform: none; letter-spacing: 0; }
  .pv-group .n.miss { opacity: 1; color: var(--miss); }
  .pv-group .chev { flex: none; width: 5px; height: 5px; border-right: 1.5px solid currentColor; border-bottom: 1.5px solid currentColor; transform: rotate(-45deg); opacity: .6; transition: transform .15s; }
  .pv-group.open .chev { transform: rotate(45deg); }
  .pv-need .check { padding: 0 8px 7px 13px; font-size: 11px; color: var(--vscode-editorWarning-foreground, #cca700); }
  .pv-side .none { font-size: 12px; opacity: .65; padding: 12px 4px; }
  /* The drawing: all the space, or the size chosen in the title bar, in the middle (scrolling when it's bigger). */
  .pv-frame { position: absolute; inset: 0; display: flex; overflow: auto; }
  .pv-frame iframe { flex: none; margin: auto; width: 100%; height: 100%; border: 0; display: block; background: transparent; }
  .pv-frame.sized iframe { outline: 1px dashed color-mix(in srgb, var(--vscode-foreground) 35%, transparent); outline-offset: 0; }
  .pv-size { display: flex; align-items: center; gap: 4px; flex: none; font-size: 11px; }
  .pv-size input { width: 64px; box-sizing: border-box; font: inherit; font-size: 12px; padding: 3px 6px; border-radius: 4px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, #8884); }
  .pv-size input:focus { outline: 1px solid var(--vscode-focusBorder, #39f); }
  .pv-size input::-webkit-inner-spin-button { display: none; }
  .pv-size .x { opacity: .6; }
  .pv-loading { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; text-align: center; padding: 24px; background: color-mix(in srgb, var(--vscode-foreground) 3%, var(--vscode-editor-background)); }
  .pv-loading p { margin: 6px 0 0; opacity: .7; font-size: 12px; }
  .pv-problem { position: absolute; left: 12px; right: 12px; top: 12px; z-index: 2; padding: 10px 12px; border-radius: 8px; font-size: 12px; white-space: pre-wrap; color: var(--vscode-errorForeground, #f48771); background: color-mix(in srgb, var(--vscode-editor-background) 90%, var(--vscode-errorForeground, #f48771)); border: 1px solid color-mix(in srgb, var(--vscode-errorForeground, #f48771) 50%, transparent); }
  .pv-act { display: flex; gap: 8px; align-items: baseline; padding: 6px 8px; border-radius: 6px; margin-bottom: 4px; font-size: 12px; background: var(--vscode-editorWidget-background, #8881); }
  .pv-act .k { flex: none; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; color: var(--c, inherit); min-width: 64px; }
  .pv-act .t { min-width: 0; word-break: break-word; font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; }
  .pv-root { --ok: var(--tok-string, var(--vscode-charts-green, #89d185)); --miss: var(--vscode-errorForeground, #f48771); }
`;

const CALLBACK = '__visualEditorCallback';

interface Deps {
  post(message: FromMap): void;
  openCode(path: string, line?: number): void;
}

export class PreviewWindow {
  private readonly back = el('div', 'pv-back pv-root');
  private readonly title = el('h2');
  private readonly state = el('span', 'state');
  private readonly stage = el('div', 'pv-stage');
  private readonly side = el('div', 'pv-side');
  private readonly tabs = tray(el('div', 'pv-tabs'));
  private readonly progress = el('div', 'pv-progress');
  private readonly list = el('div', 'pv-list');
  private readonly sideButton = iconButton('sidePanel', 'Data and CSS: hide or show the side panel', { cls: 'on' });
  private id: string | undefined;
  private needs: Need[] = [];
  private values: Record<string, unknown> = {};
  private error: string | undefined;
  private tab: 'data' | 'css' | 'activity' = 'data';
  /** The drawing: one frame per card, kept while values change (they're posted into it, no reload). */
  private readonly frameBox = el('div', 'pv-frame');
  private frame: HTMLIFrameElement | undefined;
  private frameReady = false;
  /** The drawing's size boxes, and the size kept for each card (this session). */
  private readonly widthBox = el('input');
  private readonly heightBox = el('input');
  private readonly sizes = new Map<string, { width: string; height: string }>();
  private lastSize = { width: '', height: '' };
  /** The values last posted into the page. */
  private sent: string | undefined;
  private asked = false;
  private readonly loading = el('div', 'pv-loading');
  private readonly problem = el('div', 'pv-problem');
  /** What the drawn component did: requests answered or blocked, functions called, errors. */
  private activity: { kind: 'answered' | 'saved' | 'blocked' | 'called' | 'error' | 'moved'; text: string }[] = [];
  /** Groups (components) opened or folded by the developer. */
  private readonly groupsOpen = new Set<string>();
  private readonly groupsShut = new Set<string>();
  /** Needs whose editor is open (kept while values change). */
  private readonly open = new Set<string>();

  constructor(private readonly deps: Deps) {
    this.back.hidden = true;
    const box = el('div', 'pv');
    const head = el('div', 'pv-head');
    const reload = iconButton('reload', 'Read again: work out what it needs from the files once more');
    const close = iconButton('close', 'Close (Esc)');
    // The drawing's size: width and height in pixels (empty: all the space), remembered for each card.
    const size = el('div', 'pv-size');
    const fill = iconButton('fit', 'Fill: let it take all the space (clears the width and height)');
    size.append(this.widthBox, el('span', 'x', '×'), this.heightBox, fill);
    for (const [box, name] of [[this.widthBox, 'Width'], [this.heightBox, 'Height']] as const) {
      box.type = 'number';
      box.min = '40';
      box.max = '5000';
      box.placeholder = name;
      box.dataset.tip = `${name} of the drawing, in pixels (empty: all the space)`;
      box.addEventListener('input', () => this.applySize(true));
      box.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          box.blur();
        }
      });
    }
    fill.addEventListener('click', () => {
      this.widthBox.value = '';
      this.heightBox.value = '';
      this.applySize(true);
    });
    head.append(this.title, this.state, el('span', 'grow'), size, tray(el('div')));
    // Moved by its title bar; full screen with a button or a double-click on the title bar.
    const win = windowControls(box, head);
    head.lastElementChild!.append(this.sideButton, reload, win.fullButton, close);
    const body = el('div', 'pv-body');
    this.side.append(this.tabs, this.progress, this.list);
    body.append(this.stage, this.side);
    box.append(head, body);
    this.back.append(box);
    document.body.append(this.back);
    this.back.addEventListener('pointerdown', (e) => {
      if (e.target === this.back) this.close();
    });
    close.addEventListener('click', () => this.close());
    reload.addEventListener('click', () => {
      if (!this.id) return;
      this.resetFrame();
      this.ask(this.id);
    });
    this.problem.hidden = true;
    this.sideButton.addEventListener('click', () => {
      this.side.hidden = !this.side.hidden;
      this.sideButton.classList.toggle('on', !this.side.hidden);
    });
  }

  get isOpen(): boolean {
    return !this.back.hidden;
  }

  /** Opens the window for a card, and asks what it needs. */
  show(id: string, label: string) {
    this.id = id;
    this.title.textContent = label;
    this.needs = [];
    this.values = {};
    this.error = undefined;
    this.open.clear();
    this.groupsOpen.clear();
    this.groupsShut.clear();
    this.resetFrame();
    // Its size from last time (this session), or the size used last.
    const size = this.sizes.get(id) ?? this.lastSize;
    this.widthBox.value = size.width;
    this.heightBox.value = size.height;
    this.applySize(false);
    this.back.hidden = false;
    this.ask(id);
  }

  /** Sizes the drawing as the title bar says (empty: all the space); `remember` keeps it for this card. */
  private applySize(remember: boolean) {
    const read = (box: HTMLInputElement) => {
      const n = Math.round(Number(box.value));
      return box.value.trim() && n >= 40 ? `${Math.min(n, 5000)}px` : '';
    };
    const width = read(this.widthBox);
    const height = read(this.heightBox);
    this.frameBox.classList.toggle('sized', !!(width || height));
    if (this.frame) Object.assign(this.frame.style, { width: width || '100%', height: height || '100%' });
    if (remember && this.id) {
      const size = { width: this.widthBox.value, height: this.heightBox.value };
      this.sizes.set(this.id, size);
      this.lastSize = size;
    }
  }

  private resetFrame() {
    this.frame?.remove();
    this.frame = undefined;
    this.frameReady = false;
    this.asked = false;
    this.activity = [];
    this.problem.hidden = true;
  }

  close() {
    this.back.hidden = true;
    this.id = undefined;
  }

  private ask(id: string) {
    this.setState('Reading what it needs…', 'var(--vscode-foreground)');
    this.list.replaceChildren(el('div', 'none', 'Reading the files to work out what it needs…'));
    this.progress.replaceChildren();
    this.stage.replaceChildren();
    this.deps.post({ type: 'needs', id });
  }

  /** What the card needs arrived (from its plugin). */
  receive(m: CardNeeds) {
    if (m.id !== this.id) return;
    this.needs = m.needs;
    // The developer's own values: kept by the plugin (next to each file), or by the shell for plugins that don't.
    this.values = { ...m.values };
    for (const n of this.needs) if ('yours' in n) this.values[n.id] = n.yours;
    this.error = m.error;
    // What's missing starts open, ready to be filled in.
    for (const n of this.needs) if (this.isRequired(n) && !this.filled(n)) this.open.add(n.id);
    this.render();
  }

  private isRequired(n: Need) {
    return n.required;
  }

  /** The value used for a need: the developer's own, or the plugin's example. */
  private valueOf(n: Need): unknown {
    return n.id in this.values ? this.values[n.id] : n.value;
  }

  /** It has a value (the developer's own, or one made from the code; parts deep inside may be noted as unknown). */
  private filled(n: Need): boolean {
    if (n.id in this.values) return this.values[n.id] !== undefined;
    return n.value !== undefined && !n.missing?.includes('');
  }

  private setState(text: string, colour: string) {
    this.state.textContent = text;
    this.state.style.setProperty('--state', colour);
  }

  private render() {
    const required = this.needs.filter((n) => this.isRequired(n));
    const done = required.filter((n) => this.filled(n));
    const gaps = required.filter((n) => !this.filled(n));
    const ready = !gaps.length && !this.error;
    if (this.error) this.setState('Couldn’t work out what it needs', 'var(--miss)');
    else if (ready) this.setState(required.length ? `All ${required.length} required values ready` : 'Needs no data', 'var(--ok)');
    else this.setState(`${gaps.length} of ${required.length} required values missing`, 'var(--miss)');

    // Tabs: the data it needs, and the CSS of the part picked.
    const blocked = this.activity.filter((a) => a.kind === 'blocked' || a.kind === 'error').length;
    const tabs: [typeof this.tab, Icon, string, number | undefined][] = [
      ['data', 'props', `Data: everything it needs to be drawn (${this.needs.length})`, this.needs.length],
      ['css', 'code', 'CSS: click a part of the component to see its CSS', undefined],
      ['activity', 'api', `Activity: what it did: requests answered or blocked, functions called, errors (${this.activity.length})`, this.activity.length || undefined],
    ];
    this.tabs.replaceChildren(
      ...tabs.map(([key, icon, name, count]) => {
        const b = iconButton(icon, name, count !== undefined ? { count } : {});
        if (key === 'activity' && blocked) b.style.color = 'var(--miss)';
        b.classList.toggle('on', this.tab === key);
        b.addEventListener('click', () => {
          this.tab = key;
          this.render();
        });
        return b;
      }),
    );

    // The stage: what's still missing, or (once nothing is) the card itself.
    if (ready) this.drawn();
    else this.stage.replaceChildren(this.waiting(gaps));

    if (this.tab === 'activity') {
      this.progress.replaceChildren();
      const COLOUR = { answered: 'var(--ok)', saved: 'var(--tok-function, var(--ok))', called: 'var(--tok-function, var(--ok))', blocked: 'var(--miss)', error: 'var(--miss)', moved: 'var(--miss)' };
      const WORD = { answered: 'answered', saved: 'not sent', called: 'called', blocked: 'blocked', error: 'error', moved: 'moved' };
      const rows = this.activity.map((a) => {
        const row = el('div', 'pv-act');
        const k = el('span', 'k', WORD[a.kind]);
        k.style.setProperty('--c', COLOUR[a.kind]);
        row.append(k, el('span', 't', a.text));
        return row;
      });
      this.list.replaceChildren(...(rows.length ? rows.reverse() : [el('div', 'none', 'Nothing yet. Requests it makes (answered from the list, or blocked: nothing reaches a server), functions it calls and errors show here.')]));
      return;
    }
    if (this.tab === 'css') {
      this.progress.replaceChildren();
      this.list.replaceChildren(el('div', 'none', 'Click a part of the component to see its CSS here: the rules from your files, with where they are.'));
      return;
    }
    const pct = required.length ? Math.round((done.length / required.length) * 100) : 100;
    const bar = el('div', 'meter');
    const fill = el('div');
    fill.style.width = `${pct}%`;
    bar.append(fill);
    this.progress.replaceChildren(el('span', undefined, required.length ? `${done.length} of ${required.length} required values filled` : 'Nothing is required'), bar);

    if (this.error) {
      this.list.replaceChildren(el('div', 'none', this.error));
      return;
    }
    if (!this.needs.length) {
      this.list.replaceChildren(el('div', 'none', 'It needs no data: no props, and nothing it draws brings data in.'));
      return;
    }
    // One group per component of the tree (folded when all its values are there; open when something's missing).
    const rows: HTMLElement[] = [];
    const groups = [...new Set(this.needs.map((n) => n.group))];
    for (const g of groups) {
      const list = this.needs.filter((n) => n.group === g);
      const gaps = list.filter((n) => n.required && !this.filled(n)).length;
      const open = this.groupsOpen.has(g) || (!this.groupsShut.has(g) && (gaps > 0 || groups.length <= 3));
      const head = el('div', `pv-group${open ? ' open' : ''}`);
      head.append(el('span', 'chev'), el('span', 'g', g), el('span', gaps ? 'n miss' : 'n', gaps ? `${gaps} missing` : `${list.length}`));
      head.dataset.tip = gaps ? `${g}: ${gaps} of ${list.length} values missing` : `${g}: all ${list.length} values there`;
      head.addEventListener('click', () => {
        if (open) {
          this.groupsOpen.delete(g);
          this.groupsShut.add(g);
        } else {
          this.groupsShut.delete(g);
          this.groupsOpen.add(g);
        }
        this.render();
      });
      rows.push(head);
      if (open) for (const n of list) rows.push(this.row(n));
    }
    const scroll = this.list.scrollTop;
    this.list.replaceChildren(...rows);
    this.list.scrollTop = scroll;
  }

  private waiting(gaps: Need[]): HTMLElement {
    const box = el('div', 'pv-wait');
    if (this.error) {
      box.append(el('h3', undefined, 'Couldn’t work out what it needs'), el('p', undefined, this.error));
      return box;
    }
    box.append(
      el('h3', undefined, gaps.length === 1 ? 'One value is still missing' : `${gaps.length} values are still missing`),
      el('p', undefined, 'Nothing in the code says what these hold. Fill them in on the right, and the component is drawn as soon as every required value is there.'),
    );
    const list = el('div', 'gaps');
    for (const n of gaps) {
      const gap = el('span', 'gap', n.label);
      gap.title = `${n.group}: ${n.label}. Click to fill it in.`;
      gap.addEventListener('click', () => this.reveal(n.id));
      list.append(gap);
    }
    box.append(list);
    return box;
  }

  /** The card, drawn by its plugin's page with the values: asked for once, then the values are posted in. */
  private drawn() {
    if (!this.frameBox.isConnected) this.stage.replaceChildren(this.frameBox, this.problem);
    // Drawn already: the values go in when they change (sendValues), never just because the panel was redrawn.
    if (this.frame) {
      this.sendValues();
      return;
    }
    if (this.asked) return;
    this.asked = true;
    this.showLoading('Starting the project’s dev server…', 'The first time can take a few seconds. It’s drawn from the values in the list only: nothing is sent anywhere.');
    this.deps.post({ type: 'draw', id: this.id! });
  }

  private showLoading(title: string, detail?: string) {
    const box = el('div');
    box.append(el('h3', undefined, title));
    if (detail) box.append(el('p', undefined, detail));
    this.loading.replaceChildren(box);
    if (!this.loading.isConnected) this.frameBox.append(this.loading);
  }

  /** Where the drawing is (from the plugin), or why it can't be drawn. */
  receiveDrawing(m: { id: string; url?: string; html?: string; error?: string }) {
    if (m.id !== this.id) return;
    if (m.error !== undefined) {
      this.showLoading('Couldn’t draw it', m.error);
      return;
    }
    this.frame?.remove();
    const frame = el('iframe');
    frame.title = `${this.title.textContent}: preview`;
    if (m.url) frame.src = m.url;
    else frame.srcdoc = m.html ?? '';
    this.frame = frame;
    this.frameReady = false;
    this.frameBox.prepend(frame);
    this.applySize(false);
    this.showLoading('Drawing it…');
  }

  /** What the page said (it posts to the window around it). */
  fromFrame(data: Record<string, unknown>, source: MessageEventSource | null) {
    if (!this.frame || source !== this.frame.contentWindow) return;
    const add = (kind: (typeof this.activity)[number]['kind'], text: string) => {
      this.activity.push({ kind, text });
      if (this.activity.length > 200) this.activity.shift();
    };
    if (data.type === 'ready') {
      this.frameReady = true;
      this.sent = undefined;
      this.sendValues();
      return;
    }
    if (data.type === 'drawn') {
      this.loading.remove();
      return;
    }
    if (data.type === 'request') add(data.write ? 'saved' : 'answered', `${data.method} ${shortUrl(String(data.url), this.frame?.src)}`);
    else if (data.type === 'filled') add('answered', `${data.rows} example rows put in the ${data.table} table`);
    else if (data.type === 'blocked') add('blocked', `${data.method} ${shortUrl(String(data.url), this.frame?.src)}`);
    else if (data.type === 'callback') add('called', `${data.name}(${data.args ?? ''})`);
    else if (data.type === 'moved') add('moved', `It sent you to ${data.to}`);
    else if (data.type === 'error') {
      add('error', `${data.message}${data.where ? ` · ${data.where}` : ''}`);
      this.problem.textContent = `It crashed: ${data.message}${data.where ? `\nWhere: ${data.where}` : ''}`;
      this.problem.hidden = false;
      this.loading.remove();
    }
    if (this.tab === 'activity' || data.type === 'blocked' || data.type === 'error') this.render();
  }

  /** The values (the developer's own, or the examples) posted into the page, which draws with them. */
  private sendValues() {
    if (!this.frame?.contentWindow || !this.frameReady) return;
    const values: Record<string, unknown> = {};
    for (const n of this.needs) {
      const v = this.valueOf(n);
      if (v !== undefined) values[n.id] = v;
    }
    const theme = document.body.classList.contains('vscode-light') || document.body.classList.contains('vscode-high-contrast-light') ? 'light' : 'dark';
    // Only what changed is drawn again: the same values twice would redraw it for nothing (and run its effects again).
    const sent = JSON.stringify([values, theme]);
    if (sent === this.sent) return;
    this.sent = sent;
    this.problem.hidden = true;
    this.frame.contentWindow.postMessage({ source: 'visual-editor', type: 'draw', values, theme }, '*');
  }

  /** Opens a need's editor in the side panel and brings it into view. */
  private reveal(id: string) {
    this.tab = 'data';
    this.side.hidden = false;
    this.sideButton.classList.add('on');
    this.open.add(id);
    this.render();
    const row = this.list.querySelector<HTMLElement>(`[data-need="${CSS.escape(id)}"]`);
    row?.scrollIntoView({ block: 'center' });
    row?.querySelector('textarea')?.focus();
  }

  private row(n: Need): HTMLElement {
    const filled = this.filled(n);
    const yours = n.id in this.values;
    const row = el('div', `pv-need${!filled && n.required ? ' missing' : ''}${!n.required ? ' optional' : ''}${this.open.has(n.id) ? ' open' : ''}`);
    row.dataset.need = n.id;
    const top = el('div', 'top');
    const label = el('span', 'l', n.label);
    label.dataset.tip = `${n.group}: ${n.label}`;
    top.append(el('span', 'strip'), label);
    if (!filled && n.required) top.append(el('span', 'chip miss', 'missing'));
    else if (yours) top.append(el('span', 'chip yours', 'yours'));
    if (!n.required) top.append(el('span', 'chip opt', 'optional'));
    top.append(el('span', 'grow'), el('span', 'chev'));
    top.addEventListener('click', () => {
      if (this.open.has(n.id)) this.open.delete(n.id);
      else this.open.add(n.id);
      row.classList.toggle('open', this.open.has(n.id));
    });
    row.append(top);
    if (n.type) {
      const ty = el('div', 'ty');
      ty.append(typeText(n.type));
      row.append(ty);
    }
    row.append(el('div', 'from', yours ? 'your value' : (n.from ?? '')));
    if (n.check && yours) row.append(el('div', 'check', n.check));

    const edit = el('div', 'edit');
    if (n.type && n.type.length > 50) {
      const full = el('div', 'full-type');
      full.append(typeText(n.type));
      edit.append(full);
    }
    const value = this.valueOf(n);
    const acts = tray(el('div', 'acts'));
    if (isCallback(value)) {
      edit.append(el('div', 'calls', 'A function: in the preview it just reports when it’s called.'));
    } else {
      const holes = !yours ? (n.missing ?? []).filter((p) => p) : [];
      if (holes.length) edit.append(el('div', 'holes', `Nothing in the code says what these are, so they’re null: ${holes.join(', ')}`));
      const area = el('textarea');
      area.spellcheck = false;
      area.value = value === undefined ? '' : JSON.stringify(value, null, 2);
      area.placeholder = placeholderFor(n);
      const err = el('div', 'err');
      err.hidden = true;
      const save = () => {
        const parsed = parseValue(area.value, n);
        if ('error' in parsed) {
          err.textContent = parsed.error;
          err.hidden = false;
          return;
        }
        err.hidden = true;
        if (parsed.value === undefined) delete this.values[n.id];
        else this.values[n.id] = parsed.value;
        this.deps.post({ type: 'setValue', id: this.id!, need: n.id, value: parsed.value });
        if (this.filled(n)) this.open.delete(n.id);
        this.render();
      };
      area.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          save();
        }
        // Esc leaves the editor, not the window.
        if (e.key === 'Escape') {
          e.stopPropagation();
          area.blur();
        }
      });
      const ok = iconButton('choose', 'Use this value (Ctrl/Cmd+Enter)', { cls: 'primary' });
      ok.addEventListener('click', save);
      acts.append(ok);
      if (yours) {
        const reset = iconButton('undo', n.value !== undefined ? 'Back to the example worked out from the code' : 'Clear your value');
        reset.addEventListener('click', () => {
          delete this.values[n.id];
          this.deps.post({ type: 'setValue', id: this.id!, need: n.id });
          this.render();
        });
        acts.append(reset);
      }
      edit.append(area, err);
    }
    if (n.place) {
      const code = iconButton('code', `Open code: ${n.place.path}${n.place.line ? `:${n.place.line}` : ''}`);
      code.addEventListener('click', () => this.deps.openCode(n.place!.path, n.place!.line));
      acts.append(code);
    }
    edit.append(acts);
    row.append(edit);
    return row;
  }
}

/** An address without the drawing's own server in front ('/api/orders' rather than 'http://…:5199/api/orders'). */
function shortUrl(url: string, page: string | undefined): string {
  try {
    const u = new URL(url);
    return page && u.origin === new URL(page).origin ? u.pathname + u.search : url;
  } catch {
    return url;
  }
}

function isCallback(v: unknown): boolean {
  return !!v && typeof v === 'object' && CALLBACK in (v as object);
}

function placeholderFor(n: Need): string {
  const t = n.type ?? '';
  if (/^string$|^'/.test(t)) return '"some text"';
  if (/^number$/.test(t)) return '42';
  if (/^boolean$/.test(t)) return 'true';
  if (/\[\]$/.test(t)) return '[ { … }, { … } ]';
  return 'A value as JSON, e.g. { "name": "Ada" } or [1, 2, 3] or "text"';
}

/** What was typed, as a value: JSON; or, for text, the text itself. Empty: back to the example. */
function parseValue(text: string, n: Need): { value: unknown } | { error: string } {
  const t = text.trim();
  if (!t) return { value: undefined };
  try {
    return { value: JSON.parse(t) };
  } catch {
    // Text needn't be quoted (but what starts like JSON must be JSON).
    if (!/^[[{"]/.test(t) && (!n.type || /^string$/.test(n.type) || n.group === 'Route')) return { value: t };
    return { error: 'That isn’t valid JSON. Text needs "quotes"; lists use [ ]; objects use { "key": value }.' };
  }
}
