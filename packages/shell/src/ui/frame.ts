// A window over a page (Focus, Preview, Playground): a title bar with its tools (moved by dragging, full screen with a
// button or a double-click), Esc to close (the window on top first: they stack), and side panels the developer
// arranges. Panels sit in docks (left, right, bottom), as tabs; a dock sits beside the content or floats over it, and
// is resized by dragging its inner edge. A panel moves to another dock by dragging its tab there (or to an empty side),
// or from the Panels menu in the title bar, which also shows and hides panels. The arrangement is kept per window.
// Plain DOM.

import { el } from './dom';
import { iconButton, tray, type Icon } from './buttons';
import { windowControls } from './windows';

export type Dock = 'left' | 'right' | 'bottom';
const DOCKS: Dock[] = ['left', 'right', 'bottom'];

/** One panel: its tab (icon, name, count, colour) and its content (kept while the panel is hidden or moved). */
export interface PanelSpec {
  id: string;
  icon: Icon;
  name: string;
  count?: number;
  /** A colour for its tab (and the content's headings, as --tint). */
  tint?: string;
  body: HTMLElement;
  /** Called each time it's shown (to measure what only shows on screen). */
  onShow?(): void;
}

/** Where every panel is, how each dock sits, and which panels are hidden. */
export interface Layout {
  docks: Record<Dock, { panels: string[]; active?: string; size: number; float: boolean; open: boolean }>;
  hidden: string[];
}

/** Where layouts are kept (the extension keeps them, so they last). */
export interface LayoutStore {
  get(key: string): Layout | undefined;
  set(key: string, layout: Layout): void;
}

export const FRAME_CSS = `
  .fw-back { position: fixed; inset: 0; background: color-mix(in srgb, #000 55%, transparent); display: flex; align-items: center; justify-content: center; }
  .fw { position: relative; display: flex; flex-direction: column; border-radius: 12px; background: var(--vscode-editor-background); border: 1px solid var(--vscode-panel-border, #8885); box-shadow: 0 20px 60px #0008; overflow: hidden; }
  .fw-head { display: flex; align-items: center; gap: 10px; padding: 10px 14px; border-bottom: 1px solid var(--vscode-panel-border, #8883); flex: none; }
  .fw-head h2 { margin: 0; font-size: 15px; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .fw-head .hint { font-size: 11px; opacity: .6; white-space: nowrap; }
  .fw-head .grow { flex: 1; }
  .fw-body { position: relative; flex: 1; min-height: 0; display: flex; }
  .fw-mid { position: relative; flex: 1; min-width: 0; display: flex; flex-direction: column; }
  .fw-main { position: relative; flex: 1; min-height: 0; }
  .fw-dock { position: relative; display: flex; flex-direction: column; min-width: 0; min-height: 0; background: var(--vscode-sideBar-background, var(--vscode-editor-background)); }
  .fw-dock[data-dock=left] { border-right: 1px solid var(--vscode-panel-border, #8883); }
  .fw-dock[data-dock=right] { border-left: 1px solid var(--vscode-panel-border, #8883); }
  .fw-dock[data-dock=bottom] { border-top: 1px solid var(--vscode-panel-border, #8883); }
  /* Floating over the content instead of beside it. */
  .fw-dock.float { position: absolute; z-index: 3; border: 1px solid var(--vscode-panel-border, #8885); border-radius: 10px; overflow: hidden; background: color-mix(in srgb, var(--vscode-sideBar-background, var(--vscode-editor-background)) 94%, transparent); box-shadow: 0 8px 28px #0007; }
  .fw-dock.float[data-dock=left] { left: 10px; top: 10px; bottom: 10px; }
  .fw-dock.float[data-dock=right] { right: 10px; top: 10px; bottom: 10px; }
  .fw-dock.float[data-dock=bottom] { left: 10px; right: 10px; bottom: 10px; }
  .fw-dock-head { display: flex; align-items: center; gap: 4px; padding: 6px 8px; border-bottom: 1px solid var(--vscode-panel-border, #8883); flex: none; min-width: 0; }
  .fw-dock-head .tabs { flex: 1; gap: 4px; }
  .fw-dock-head .tabs button { background: transparent; color: var(--tint, var(--vscode-foreground)); opacity: .75; }
  .fw-dock-head .tabs button:hover { opacity: 1; }
  .fw-dock-head .tabs button.icon.on { opacity: 1; color: var(--tint, var(--vscode-foreground)); background: color-mix(in srgb, var(--tint, #888) 22%, transparent); box-shadow: inset 0 -2px 0 var(--tint, transparent); }
  .fw-dock-head .tabs button.dragging { opacity: .35; }
  .fw-dock-head .own { flex: none; gap: 2px; }
  .fw-dock-head .own button { background: transparent; opacity: .6; }
  .fw-dock-head .own button:hover { opacity: 1; }
  .fw-dock-body { position: relative; flex: 1; min-height: 0; }
  .fw-dock-body > * { position: absolute; inset: 0; overflow: auto; }
  /* Its inner edge: drag to resize. */
  .fw-grip { position: absolute; z-index: 4; }
  .fw-dock[data-dock=left] > .fw-grip { top: 0; bottom: 0; right: -3px; width: 6px; cursor: col-resize; }
  .fw-dock[data-dock=right] > .fw-grip { top: 0; bottom: 0; left: -3px; width: 6px; cursor: col-resize; }
  .fw-dock[data-dock=bottom] > .fw-grip { left: 0; right: 0; top: -3px; height: 6px; cursor: row-resize; }
  .fw-grip:hover, .fw-grip.on { background: var(--vscode-focusBorder, #39f); }
  /* Where a dragged tab can go: each side of the window. */
  .fw-drop { position: absolute; z-index: 10; display: none; border: 2px dashed var(--vscode-focusBorder, #39f); background: color-mix(in srgb, var(--vscode-focusBorder, #39f) 14%, transparent); border-radius: 8px; }
  .fw.dragging .fw-drop { display: block; }
  .fw-drop.over { background: color-mix(in srgb, var(--vscode-focusBorder, #39f) 30%, transparent); }
  .fw-drop[data-dock=left] { left: 6px; top: 6px; bottom: 6px; width: 22%; }
  .fw-drop[data-dock=right] { right: 6px; top: 6px; bottom: 6px; width: 22%; }
  .fw-drop[data-dock=bottom] { left: 25%; right: 25%; bottom: 6px; height: 28%; }
  /* The Panels menu: every panel, shown or hidden, and the side it's on. */
  .fw-menu { position: absolute; z-index: 20; min-width: 260px; padding: 6px; border-radius: 8px; background: var(--vscode-menu-background, var(--vscode-editorWidget-background, #252526)); border: 1px solid var(--vscode-menu-border, var(--vscode-editorWidget-border, #8885)); box-shadow: 0 8px 24px #0008; }
  .fw-menu .row { display: flex; align-items: center; gap: 6px; padding: 3px 4px; border-radius: 5px; font-size: 12px; }
  .fw-menu .row:hover { background: #8881; }
  .fw-menu .row .name { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .fw-menu .row.off .name { opacity: .45; }
  .fw-menu .row button { background: transparent; opacity: .55; }
  .fw-menu .row button.on { opacity: 1; background: var(--vscode-toolbar-activeBackground, #8883); }
`;

const stack: Frame[] = [];
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || !stack.length) return;
  // The window on top closes first (a menu open in it closes before that).
  stack[stack.length - 1].escape();
});

export class Frame {
  readonly back = el('div', 'fw-back');
  readonly box = el('div', 'fw');
  readonly head = el('div', 'fw-head');
  readonly title = el('h2');
  readonly hint = el('span', 'hint');
  /** The window's own buttons (before the Panels menu, full screen and close). */
  readonly tools = tray(el('div'));
  /** The content, between the docks. */
  readonly main = el('div', 'fw-main');
  private readonly mid = el('div', 'fw-mid');
  private readonly body = el('div', 'fw-body');
  private readonly docks = new Map<Dock, { el: HTMLElement; tabs: HTMLElement; body: HTMLElement; floatButton: HTMLButtonElement }>();
  private readonly drops = new Map<Dock, HTMLElement>();
  private readonly panels = new Map<string, PanelSpec>();
  private readonly tabButtons = new Map<string, HTMLButtonElement>();
  private readonly panelsButton = iconButton('panels', 'Panels: show, hide and arrange the side panels');
  private menu: HTMLElement | undefined;
  private layout: Layout;
  private readonly controls: ReturnType<typeof windowControls>;
  /** Called when the window closes. */
  onClose: (() => void) | undefined;

  constructor(
    private readonly key: string,
    private readonly store: LayoutStore,
    /** Where panels first go, and how their docks first sit. */
    private readonly start: Partial<Record<Dock, { panels: string[]; float?: boolean; size?: number }>>,
    options: { size?: { width: string; height: string }; closeOnBackdrop?: boolean } = {},
  ) {
    this.layout = this.fresh();
    this.back.hidden = true;
    const size = options.size ?? { width: 'min(1100px, 94vw)', height: 'min(720px, 88vh)' };
    Object.assign(this.box.style, { width: size.width, height: size.height });
    const close = iconButton('close', 'Close (Esc)');
    close.addEventListener('click', () => this.close());
    this.controls = windowControls(this.box, this.head);
    this.head.append(this.title, this.hint, el('span', 'grow'), this.tools);
    this.tools.append(this.panelsButton, this.controls.fullButton, close);
    this.panelsButton.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this.menu) this.closeMenu();
      else this.openMenu();
    });
    this.mid.append(this.main);
    this.body.append(this.mid);
    for (const d of DOCKS) {
      this.docks.set(d, this.makeDock(d));
      const drop = el('div', 'fw-drop');
      drop.dataset.dock = d;
      this.drops.set(d, drop);
      this.body.append(drop);
      this.dropTarget(drop, d);
    }
    this.box.append(this.head, this.body);
    this.back.append(this.box);
    document.body.append(this.back);
    if (options.closeOnBackdrop !== false) {
      this.back.addEventListener('pointerdown', (e) => {
        if (e.target === this.back) this.close();
      });
    }
    document.addEventListener('pointerdown', (e) => {
      if (this.menu && !this.menu.contains(e.target as Node) && e.target !== this.panelsButton) this.closeMenu();
    });
  }

  get isOpen(): boolean {
    return !this.back.hidden;
  }

  /** Puts its own buttons in the title bar, before the Panels menu, full screen and close. */
  addTools(...buttons: HTMLElement[]) {
    for (const b of buttons) this.tools.insertBefore(b, this.panelsButton);
  }

  open() {
    if (!this.isOpen) {
      stack.push(this);
      this.back.style.zIndex = String(20 + stack.length * 2);
      this.back.hidden = false;
    }
    this.layout = this.store.get(this.key) ?? this.layout;
    this.arrange();
  }

  close() {
    if (!this.isOpen) return;
    this.closeMenu();
    this.back.hidden = true;
    const at = stack.indexOf(this);
    if (at >= 0) stack.splice(at, 1);
    this.onClose?.();
  }

  escape() {
    if (this.menu) this.closeMenu();
    else this.close();
  }

  /**
   * The panels it has now (a card's panels change with the card). Each keeps its place from the layout; a new one
   * goes where the window starts it, or to the right.
   */
  setPanels(list: PanelSpec[]) {
    this.panels.clear();
    for (const p of list) this.panels.set(p.id, p);
    const placed = new Set(DOCKS.flatMap((d) => this.layout.docks[d].panels));
    for (const p of list) {
      if (placed.has(p.id)) continue;
      const home = DOCKS.find((d) => this.start[d]?.panels.some((x) => x === p.id || (x.endsWith('*') && p.id.startsWith(x.slice(0, -1))))) ?? 'right';
      this.layout.docks[home].panels.push(p.id);
    }
    this.arrange();
  }

  /** Changes a panel's tab (its count, name, colour) without touching its content. */
  updatePanel(id: string, change: Partial<Pick<PanelSpec, 'count' | 'name' | 'tint' | 'icon'>>) {
    const p = this.panels.get(id);
    if (!p) return;
    Object.assign(p, change);
    const b = this.tabButtons.get(id);
    if (!b?.isConnected) return;
    const fresh = this.tab(id, this.dockOf(id)!, b.classList.contains('on'));
    b.replaceWith(fresh);
  }

  /** Whether a panel is on screen now (its dock open, and its tab the chosen one). */
  isShown(id: string): boolean {
    const d = this.dockOf(id);
    if (!d || this.layout.hidden.includes(id)) return false;
    const dock = this.layout.docks[d];
    return dock.open && dock.active === id && !this.docks.get(d)!.el.hidden;
  }

  /** Shows a panel (opening its dock and choosing its tab). */
  showPanel(id: string) {
    const d = this.dockOf(id);
    if (!d) return;
    this.layout.hidden = this.layout.hidden.filter((x) => x !== id);
    this.layout.docks[d].active = id;
    this.layout.docks[d].open = true;
    this.save();
  }

  // ---- Arranging ----

  private fresh(): Layout {
    const docks = Object.fromEntries(
      DOCKS.map((d) => [d, { panels: [...(this.start[d]?.panels.filter((p) => !p.endsWith('*')) ?? [])], size: this.start[d]?.size ?? (d === 'bottom' ? 220 : 340), float: this.start[d]?.float ?? false, open: true }]),
    ) as Layout['docks'];
    return { docks, hidden: [] };
  }

  private dockOf(id: string): Dock | undefined {
    return DOCKS.find((d) => this.layout.docks[d].panels.includes(id));
  }

  private save() {
    this.store.set(this.key, this.layout);
    this.arrange();
  }

  /** Puts every dock and panel where the layout says. */
  private arrange() {
    for (const d of DOCKS) {
      const dock = this.docks.get(d)!;
      const spec = this.layout.docks[d];
      const shown = spec.panels.filter((id) => this.panels.has(id) && !this.layout.hidden.includes(id));
      if (!shown.includes(spec.active ?? '')) spec.active = shown[0];
      const visible = shown.length > 0 && spec.open;
      dock.el.hidden = !visible;
      dock.el.classList.toggle('float', spec.float);
      dock.el.style.width = d === 'bottom' ? '' : `${spec.size}px`;
      dock.el.style.height = d === 'bottom' ? `${spec.size}px` : '';
      dock.floatButton.classList.toggle('on', spec.float);
      // Beside the content (in the flow), or floating over it.
      const home = spec.float ? this.main : d === 'bottom' ? this.mid : this.body;
      if (dock.el.parentElement !== home) {
        if (spec.float) this.main.append(dock.el);
        else if (d === 'bottom') this.mid.append(dock.el);
        else if (d === 'left') this.body.prepend(dock.el);
        else this.body.insertBefore(dock.el, this.drops.get('left')!);
      }
      dock.tabs.replaceChildren(...shown.map((id) => this.tab(id, d, id === spec.active)));
      const active = spec.active ? this.panels.get(spec.active) : undefined;
      if (active && dock.body.firstElementChild !== active.body) {
        dock.body.replaceChildren(active.body);
        if (active.tint) active.body.style.setProperty('--tint', active.tint);
        if (visible) requestAnimationFrame(() => active.onShow?.());
      } else if (!active) dock.body.replaceChildren();
    }
  }

  private tab(id: string, dock: Dock, on: boolean): HTMLButtonElement {
    const p = this.panels.get(id)!;
    const b = iconButton(p.icon, p.count !== undefined ? `${p.name} (${p.count})` : p.name, p.count !== undefined ? { count: p.count } : {});
    b.classList.toggle('on', on);
    if (p.tint) b.style.setProperty('--tint', p.tint);
    b.draggable = true;
    b.addEventListener('click', () => {
      this.layout.docks[dock].active = id;
      this.save();
    });
    b.addEventListener('dragstart', (e) => {
      e.dataTransfer?.setData('text/x-ve-panel', id);
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
      b.classList.add('dragging');
      this.box.classList.add('dragging');
    });
    b.addEventListener('dragend', () => {
      b.classList.remove('dragging');
      this.box.classList.remove('dragging');
      for (const drop of this.drops.values()) drop.classList.remove('over');
    });
    this.tabButtons.set(id, b);
    return b;
  }

  private makeDock(d: Dock) {
    const dock = el('div', 'fw-dock');
    dock.dataset.dock = d;
    const head = el('div', 'fw-dock-head');
    const tabs = tray(el('div', 'tabs'));
    const own = tray(el('div', 'own'));
    const floatButton = iconButton('float', 'Float over the content, or sit beside it');
    const hide = iconButton('hide', 'Hide these panels (the Panels menu brings them back)');
    own.append(floatButton, hide);
    head.append(tabs, own);
    const body = el('div', 'fw-dock-body');
    const grip = el('div', 'fw-grip');
    dock.append(head, body, grip);
    floatButton.addEventListener('click', () => {
      this.layout.docks[d].float = !this.layout.docks[d].float;
      this.save();
    });
    hide.addEventListener('click', () => {
      this.layout.docks[d].open = false;
      this.save();
    });
    // A tab dropped on a dock's tabs joins it.
    this.dropTarget(head, d);
    // Drag the inner edge to resize.
    let drag: { at: number; size: number } | undefined;
    grip.addEventListener('pointerdown', (e) => {
      drag = { at: d === 'bottom' ? e.clientY : e.clientX, size: this.layout.docks[d].size };
      grip.setPointerCapture(e.pointerId);
      grip.classList.add('on');
      e.stopPropagation();
    });
    grip.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const delta = d === 'bottom' ? drag.at - e.clientY : d === 'left' ? e.clientX - drag.at : drag.at - e.clientX;
      const room = d === 'bottom' ? this.body.clientHeight : this.body.clientWidth;
      this.layout.docks[d].size = Math.round(Math.max(d === 'bottom' ? 120 : 220, Math.min(room * 0.75, drag.size + delta)));
      this.arrange();
    });
    const end = () => {
      if (!drag) return;
      drag = undefined;
      grip.classList.remove('on');
      this.save();
    };
    grip.addEventListener('pointerup', end);
    grip.addEventListener('pointercancel', end);
    return { el: dock, tabs, body, floatButton };
  }

  private dropTarget(target: HTMLElement, d: Dock) {
    target.addEventListener('dragover', (e) => {
      if (!e.dataTransfer?.types.includes('text/x-ve-panel')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      this.drops.get(d)?.classList.add('over');
    });
    target.addEventListener('dragleave', () => this.drops.get(d)?.classList.remove('over'));
    target.addEventListener('drop', (e) => {
      const id = e.dataTransfer?.getData('text/x-ve-panel');
      if (!id) return;
      e.preventDefault();
      this.box.classList.remove('dragging');
      this.moveTo(id, d);
    });
  }

  /** Moves a panel to a dock (opening it, with the panel chosen). */
  private moveTo(id: string, d: Dock) {
    for (const x of DOCKS) this.layout.docks[x].panels = this.layout.docks[x].panels.filter((p) => p !== id);
    this.layout.docks[d].panels.push(id);
    this.layout.docks[d].active = id;
    this.layout.docks[d].open = true;
    this.layout.hidden = this.layout.hidden.filter((x) => x !== id);
    this.save();
  }

  // ---- The Panels menu ----

  private openMenu() {
    const menu = el('div', 'fw-menu');
    for (const [id, p] of this.panels) {
      const d = this.dockOf(id);
      const hidden = this.layout.hidden.includes(id) || (d !== undefined && !this.layout.docks[d].open);
      const row = el('div', `row${hidden ? ' off' : ''}`);
      // Its own icon when shown, crossed out when hidden: click to switch.
      const show = iconButton(hidden ? 'hide' : p.icon, hidden ? `Show ${p.name.split(':')[0]}` : `Hide ${p.name.split(':')[0]}`, { cls: hidden ? undefined : 'on' });
      show.addEventListener('click', () => {
        if (hidden) {
          this.layout.hidden = this.layout.hidden.filter((x) => x !== id);
          if (d) {
            this.layout.docks[d].open = true;
            this.layout.docks[d].active = id;
          }
        } else this.layout.hidden.push(id);
        this.save();
        this.closeMenu();
        this.openMenu();
      });
      row.append(show, el('span', 'name', p.name.split(':')[0]));
      for (const [side, icon, words] of [['left', 'dockLeft', 'left'], ['bottom', 'dockBottom', 'at the bottom'], ['right', 'dockRight', 'right']] as const) {
        const b = iconButton(icon, `${p.name.split(':')[0]}: put it on the ${words === 'at the bottom' ? 'bottom' : words}`);
        b.classList.toggle('on', d === side);
        b.addEventListener('click', () => {
          this.moveTo(id, side);
          this.closeMenu();
          this.openMenu();
        });
        row.append(b);
      }
      menu.append(row);
    }
    if (!this.panels.size) menu.append(el('div', 'row', 'No panels here.'));
    const r = this.panelsButton.getBoundingClientRect();
    const box = this.box.getBoundingClientRect();
    menu.style.top = `${r.bottom - box.top + 6}px`;
    menu.style.right = `${box.right - r.right}px`;
    this.box.append(menu);
    this.menu = menu;
  }

  private closeMenu() {
    this.menu?.remove();
    this.menu = undefined;
  }
}
