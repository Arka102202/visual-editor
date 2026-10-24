// The App panel (React), in the Webview: what the running app is made of right now.
//   Components: the tree (your own components; library parts hidden unless asked), pick one in the page or the tree,
//               and see its props, hooks and state (a useState value can be changed), the contexts it reads, and what
//               drew it. Hovering outlines it in the page.
//   Stores:     Zustand and Redux stores, and TanStack Query's cache, live.
//   Route:      the address, its params and query, and the routes that matched.
//   Storage:    localStorage, sessionStorage, cookies and IndexedDB.
// It talks to its page script (appPage) through Visual Editor; it draws with the shell's look (ui).

/* eslint-disable @typescript-eslint/no-explicit-any */
import type { PreviewPanelApi } from '@visual-editor/contract';

interface Node {
  id: number;
  name: string;
  kind: string;
  key?: string;
  children: Node[];
}
interface Facts {
  components?: string[];
  stores?: string[];
  /** Design components (by function name): of which card, which design, in use or not. */
  designs?: Record<string, { card: string; design: string; id: string; inUse: boolean; inUseFor?: string[] }>;
  /** Cards that can be previewed (by name). */
  previewable?: string[];
}

const ICONS = {
  store: '<ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v6c0 1.7 3.1 3 7 3s7-1.3 7-3V6M5 12v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6"/>',
  storage: '<rect x="3" y="4" width="18" height="6" rx="1.5"/><rect x="3" y="14" width="18" height="6" rx="1.5"/><path d="M7 7h.01M7 17h.01"/>',
  mine: '<circle cx="12" cy="8" r="4"/><path d="M4 21c1-4 4.5-6 8-6s7 2 8 6"/>',
  log: '<path d="M4 17l6-6-6-6M12 19h8"/>',
  scroll: '<path d="M12 3v14M6 11l6 6 6-6M5 21h14"/>',
  where: '<path d="M12 21s-7-6.1-7-11a7 7 0 0 1 14 0c0 4.9-7 11-7 11z"/><circle cx="12" cy="10" r="2.5"/>',
};

const CSS = `
  .ra { display: flex; flex-direction: column; height: 100%; font-size: 12px; }
  .ra-bar { display: flex; align-items: center; gap: 6px; padding: 5px 8px; border-bottom: 1px solid var(--vscode-panel-border, #8883); flex: none; min-width: 0; }
  .ra-bar input { flex: 1; min-width: 60px; font: inherit; font-size: 12px; padding: 3px 7px; border-radius: 4px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, #8884); }
  .ra-bar button.icon.on { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .ra-body { flex: 1; min-height: 0; display: flex; flex-direction: column; }
  .ra-tree { flex: 1; min-height: 60px; overflow: auto; padding: 4px 0; font-family: var(--vscode-editor-font-family, monospace); }
  .ra-tree.ra-half { flex: 0 0 45%; border-bottom: 1px solid var(--vscode-panel-border, #8883); }
  .ra-row { display: flex; align-items: center; gap: 4px; padding: 1px 8px; white-space: nowrap; cursor: pointer; min-width: max-content; }
  .ra-row:hover { background: #8881; }
  .ra-row.on { background: var(--vscode-list-activeSelectionBackground, #04395e); color: var(--vscode-list-activeSelectionForeground, inherit); }
  .ra-row .ra-caret { width: 12px; flex: none; opacity: .6; text-align: center; }
  .ra-row .ra-n { color: var(--tok-type, #4ec9b0); }
  .ra-row.ra-lib .ra-n, .ra-row.ra-provider .ra-n, .ra-row.ra-root .ra-n { color: inherit; opacity: .55; }
  .ra-row .ra-k { opacity: .6; }
  .ra-row .ra-b { font-family: var(--vscode-font-family, system-ui); font-size: 10px; padding: 0 5px; border-radius: 7px; opacity: .75; background: #8882; }
  .ra-row .ra-hit { background: color-mix(in srgb, var(--vscode-editor-findMatchHighlightBackground, #ea5c0055) 100%, transparent); border-radius: 2px; }
  .ra-detail, .ra-page { flex: 1; min-height: 0; overflow: auto; padding: 8px 10px 14px; }
  .ra h4 { margin: 12px 0 4px; font-size: 11px; letter-spacing: .05em; text-transform: uppercase; opacity: .65; }
  .ra .ra-title { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .ra .ra-design { display: flex; align-items: center; gap: 8px; margin: 6px 0 2px; padding: 6px 8px; border-radius: 6px; font-size: 12px; background: color-mix(in srgb, var(--vscode-charts-yellow, #cca700) 12%, transparent); }
  .ra .ra-design .grow { flex: 1; min-width: 0; }
  .ra .ra-title b { font-family: var(--vscode-editor-font-family, monospace); font-size: 13px; color: var(--tok-type, #4ec9b0); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
  .ra .ra-title .tray { margin-left: auto; flex: none; }
  .ra .ra-line { display: flex; gap: 6px; align-items: flex-start; padding: 1px 0; font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; min-width: 0; }
  .ra .ra-line > .ra-name { color: var(--tok-property, #9cdcfe); white-space: nowrap; flex: none; }
  .ra .ra-line > .ra-val { min-width: 0; flex: 1; word-break: break-word; }
  .ra .ra-line > .tray { flex: none; }
  .ra .ra-line input { flex: 1; min-width: 0; font: inherit; font-size: 11px; padding: 1px 5px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-focusBorder, #39f); border-radius: 3px; }
  .ra .ra-owners { display: flex; flex-wrap: wrap; gap: 4px; }
  .ra .ra-owners .ra-chip { font: inherit; font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; padding: 1px 7px; border-radius: 10px; border: 0; cursor: pointer; color: inherit; background: #8882; white-space: nowrap; }
  .ra .ra-card { border-radius: 6px; background: var(--vscode-editorWidget-background, #8881); padding: 6px 8px; margin-bottom: 8px; }
  .ra .ra-card .ra-head { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .ra .ra-card .ra-head .ra-t { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
  .ra .ra-card .ra-head .ra-tag { font-size: 10px; padding: 0 6px; border-radius: 8px; opacity: .8; background: #8882; white-space: nowrap; }
  .ra .ra-card .ra-head .tray { margin-left: auto; flex: none; }
  .ra .ra-hint, .ra .ra-empty { opacity: .65; line-height: 1.5; }
  .ra .ra-warn { display: flex; gap: 8px; align-items: center; padding: 8px 10px; margin: 6px 8px 0; border-radius: 6px; line-height: 1.45; background: color-mix(in srgb, var(--vscode-editorWarning-foreground, #cca700) 14%, transparent); }
  .ra .ra-warn > span { flex: 1; min-width: 0; }
  .ra .ra-add { display: flex; gap: 6px; align-items: center; margin: 4px 0 2px; min-width: 0; }
  .ra .ra-add input, .ra .ra-edit input { min-width: 0; font: inherit; font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; padding: 2px 6px; border-radius: 4px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, #8884); }
  .ra .ra-add input.k { flex: 0 1 30%; }
  .ra .ra-add input.v, .ra .ra-edit input { flex: 1; }
  .ra .ra-edit { display: flex; gap: 6px; align-items: center; padding: 1px 0; min-width: 0; }
  .ra .ra-edit > .ra-name { color: var(--tok-property, #9cdcfe); font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; white-space: nowrap; }
  .ra .ra-empty { padding: 12px; }
  .ra .ra-err { color: var(--vscode-errorForeground, #f48771); }
  .ra .ra-row2 { display: flex; align-items: center; gap: 6px; padding: 2px 0; cursor: pointer; }
  .ra .ra-row2:hover { background: #8881; }
  .ra .ra-row2 .ra-c { margin-left: auto; opacity: .6; }
`;

(window as any).VisualEditor.definePanel('react/app', (api: PreviewPanelApi) => {
  const { el, button, tray, value } = api.ui;
  if (!document.getElementById('ra-css')) {
    const style = el('style');
    style.id = 'ra-css';
    style.textContent = CSS;
    document.head.append(style);
  }
  const send = (m: unknown) => api.send(m);
  let facts: Facts = (api.facts as Facts) ?? {};
  let mineNames = new Set(facts.components ?? []);
  api.onFacts((f) => {
    facts = (f as Facts) ?? {};
    mineNames = new Set(facts.components ?? []);
    render();
  });

  type View = 'components' | 'stores' | 'route' | 'storage';
  let view: View = 'components';
  let shown = false;
  let roots: Node[] = [];
  let selected: number | undefined;
  let detail: any;
  let onlyMine = true;
  const collapsed = new Set<number>();
  let stores: any[] | undefined;
  let routeInfo: any;
  let storageInfo: any;
  let records: any;
  let editing: { index: number } | undefined;
  /** The storage key or record being changed ("local:theme", "rec:archflow/projects:\"id\""). */
  let storageEditing: string | undefined;
  let storageError = '';

  // ---- The bar ----
  const root = el('div', 'ra');
  const bar = el('div', 'ra-bar');
  // When the page doesn't answer: it was loaded without this panel's page script.
  const warn = el('div', 'ra-warn');
  warn.hidden = true;
  const warnText = el('span', undefined, 'This page doesn’t answer the App panel: it was loaded before the panel was there (or React isn’t on it). Reload the page.');
  const warnTray = tray(el('div'));
  const reloadPage = button('reload', 'Reload the page');
  reloadPage.addEventListener('click', () => {
    warn.hidden = true;
    api.reloadPage();
  });
  warnTray.append(reloadPage);
  warn.append(warnText, warnTray);
  let alive = false;
  let waiting: ReturnType<typeof setTimeout> | undefined;
  /** Checks the page script is there (it answers "ready"); says so when it isn't. */
  function check() {
    if (alive || waiting) return;
    send({ type: 'ping' });
    waiting = setTimeout(() => {
      waiting = undefined;
      if (!alive) warn.hidden = false;
    }, 3000);
  }
  const body = el('div', 'ra-body');
  const views = tray(el('div'));
  const viewButtons: [View, HTMLButtonElement][] = [
    ['components', button('components', 'Components: the tree, and the props, hooks and state of the one you pick')],
    ['stores', button(ICONS.store, 'Stores: Zustand and Redux stores, and TanStack Query’s cache, live')],
    ['route', button('pages', 'Route: the address, its params and query, and the routes that matched')],
    ['storage', button(ICONS.storage, 'Storage: localStorage, sessionStorage, cookies and IndexedDB')],
  ];
  for (const [v, b] of viewButtons) {
    b.addEventListener('click', () => {
      view = v;
      load();
      render();
    });
    views.append(b);
  }
  const search = el('input');
  search.placeholder = 'Find a component';
  search.addEventListener('input', () => render());
  search.addEventListener('keydown', (e) => e.key === 'Escape' && (e.stopPropagation(), (search.value = ''), render()));
  const tools = tray(el('div'));
  const mine = button(ICONS.mine, 'Only your components (library parts hidden; their children still show)', { cls: 'on' });
  mine.addEventListener('click', () => {
    onlyMine = !onlyMine;
    mine.classList.toggle('on', onlyMine);
    render();
  });
  const refresh = button('reload', 'Read it again');
  refresh.addEventListener('click', () => load(true));
  tools.append(mine, refresh);
  bar.append(views, search, tools);
  root.append(bar, warn, body);
  api.body.append(root);

  /** Asks the page for what the view shows. */
  function load(again = false) {
    if (!shown) return;
    if (view === 'components' || again) send({ type: 'watch' });
    if (view === 'stores' && (again || !stores)) send({ type: 'stores', files: facts.stores ?? [] });
    if (view === 'route') send({ type: 'route' });
    if (view === 'storage') send({ type: 'storage' });
  }
  api.onShow(() => {
    shown = true;
    check();
    load();
  });
  api.onPage(() => {
    alive = false;
    if (shown) setTimeout(check, 400);
    roots = [];
    detail = undefined;
    stores = undefined;
    // The page script runs anew with the page: ask again (it has to have started React first).
    setTimeout(() => load(), 400);
    render();
  });

  api.on((m: any) => {
    alive = true;
    warn.hidden = true;
    if (m.type === 'ready') return;
    if (m.type === 'tree') {
      roots = m.roots;
      if (view === 'components') renderTree();
    } else if (m.type === 'inspected') {
      if (m.data.id === selected) {
        detail = m.data;
        if (view === 'components' && !editing) renderDetail();
      }
    } else if (m.type === 'picked') {
      // Picked with Preview's picker: its component.
      if (m.id) {
        selected = m.id;
        for (const id of m.path ?? []) collapsed.delete(id);
        view = 'components';
        render();
        requestAnimationFrame(() => body.querySelector('.ra-row.on')?.scrollIntoView({ block: 'center' }));
      }
    } else if (m.type === 'stores') {
      stores = m.list;
      if (view === 'stores') render();
    } else if (m.type === 'route') {
      routeInfo = m;
      if (view === 'route') render();
    } else if (m.type === 'storageError') {
      storageError = m.text;
      if (view === 'storage') render();
    } else if (m.type === 'storage') {
      storageInfo = m;
      if (view === 'storage') render();
    } else if (m.type === 'records') {
      records = m;
      if (view === 'storage') render();
    }
  });

  // ---- Drawing ----

  /** The component outlined in the page while its row is hovered (cleared whenever the panel is drawn again). */
  let outlined: number | undefined;
  function outline(id: number | undefined) {
    if (id === outlined) return;
    outlined = id;
    send({ type: 'highlight', id: id ?? null });
  }

  function render() {
    outline(undefined);
    for (const [v, b] of viewButtons) b.classList.toggle('on', v === view);
    search.hidden = view !== 'components';
    mine.hidden = view !== 'components';
    if (view === 'components') {
      body.replaceChildren(el('div', 'ra-tree'), ...(selected !== undefined ? [el('div', 'ra-detail')] : []));
      renderTree();
      if (selected !== undefined) renderDetail();
    } else {
      const page = el('div', 'ra-page');
      body.replaceChildren(page);
      if (view === 'stores') drawStores(page);
      else if (view === 'route') drawRoute(page);
      else drawStorage(page);
    }
  }

  /** The tree as shown: library parts left out (their children lifted) when only yours are wanted. */
  function visible(nodes: Node[]): Node[] {
    if (!onlyMine || !mineNames.size) return nodes;
    const out: Node[] = [];
    for (const n of nodes) {
      const kids = visible(n.children);
      if (n.kind === 'root' || mineNames.has(n.name)) out.push({ ...n, children: kids });
      else out.push(...kids);
    }
    return out;
  }

  function renderTree() {
    outline(undefined);
    const box = body.querySelector<HTMLElement>('.ra-tree');
    if (!box) return;
    box.classList.toggle('ra-half', selected !== undefined);
    const keep = box.scrollTop;
    box.replaceChildren();
    if (!roots.length) {
      box.append(el('div', 'ra-empty', 'Waiting for React… (the app has to be open in the Webview; the panel reads it as it draws)'));
      return;
    }
    const q = search.value.trim().toLowerCase();
    const tree = visible(roots);
    // With a search: the matching components and the ones above them.
    const keepIds = new Set<number>();
    if (q) {
      const mark = (n: Node): boolean => {
        let hit = n.name.toLowerCase().includes(q);
        for (const c of n.children) if (mark(c)) hit = true;
        if (hit) keepIds.add(n.id);
        return hit;
      };
      tree.forEach(mark);
    }
    let rows = 0;
    const draw = (n: Node, depth: number) => {
      if (q && !keepIds.has(n.id)) return;
      if (rows++ > 4000) return;
      const lib = !mineNames.has(n.name) && n.kind !== 'root';
      const row = el('div', `ra-row ra-${n.kind}${lib ? ' ra-lib' : ''}${n.id === selected ? ' on' : ''}`);
      row.style.paddingLeft = `${8 + depth * 12}px`;
      const open = !collapsed.has(n.id) || !!q;
      const caret = el('span', 'ra-caret', n.children.length ? (open ? '▾' : '▸') : '');
      caret.addEventListener('click', (e) => {
        e.stopPropagation();
        if (collapsed.has(n.id)) collapsed.delete(n.id);
        else collapsed.add(n.id);
        renderTree();
      });
      const name = el('span', 'ra-n');
      const at = q ? n.name.toLowerCase().indexOf(q) : -1;
      if (at >= 0) name.append(n.name.slice(0, at), el('span', 'ra-hit', n.name.slice(at, at + q.length)), n.name.slice(at + q.length));
      else name.textContent = n.name;
      row.append(caret, name);
      if (n.key !== undefined) row.append(el('span', 'ra-k', `key="${n.key}"`));
      if (n.kind === 'memo' || n.kind === 'forwardRef' || n.kind === 'class') row.append(el('span', 'ra-b', n.kind === 'forwardRef' ? 'ref' : n.kind));
      row.addEventListener('mouseenter', () => outline(n.id));
      row.addEventListener('mouseleave', () => outline(undefined));
      row.addEventListener('click', () => {
        selected = n.id;
        editing = undefined;
        detail = undefined;
        send({ type: 'inspect', id: n.id });
        render();
      });
      box.append(row);
      if (open) for (const c of n.children) draw(c, depth + 1);
    };
    for (const n of tree) draw(n, 0);
    if (rows > 4000) box.append(el('div', 'ra-hint', `… and more: ${rows - 4000} not shown. Search, or close some.`));
    box.scrollTop = keep;
  }

  function renderDetail() {
    const box = body.querySelector<HTMLElement>('.ra-detail');
    if (!box) return;
    const keep = box.scrollTop;
    box.replaceChildren();
    if (!detail) return void box.append(el('div', 'ra-hint', 'Reading it…'));
    const d = detail;
    if (d.gone) return void box.append(el('div', 'ra-hint', 'It’s no longer on the screen.'));
    const title = el('div', 'ra-title');
    title.append(el('b', undefined, d.name));
    if (d.key != null) title.append(el('span', 'ra-hint', `key="${d.key}"`));
    const acts = tray(el('div'));
    if (mineNames.has(d.name)) {
      const code = button('code', `Open ${d.name}’s code`);
      code.addEventListener('click', () => api.openItem(d.name, 'components'));
      acts.append(code);
    }
    if (d.place) {
      const where = button(ICONS.where, `Where it’s drawn: the <${d.name} …/> line in ${d.owners?.[0]?.name ?? 'its parent'}`);
      where.addEventListener('click', () => (d.place.file ? api.openFile(d.place.file, d.place.line) : api.openSource(d.place.url, d.place.line, d.place.column)));
      acts.append(where);
    }
    if (d.elements) {
      const scroll = button(ICONS.scroll, 'Scroll the page to it');
      scroll.addEventListener('click', () => send({ type: 'scroll', id: d.id }));
      acts.append(scroll);
    }
    const log = button(ICONS.log, 'Log it in the Console (and as $r in the page)');
    log.addEventListener('click', () => send({ type: 'log', id: d.id }));
    acts.append(log);
    title.append(acts);
    box.append(title);

    // A design (or a previewable card): which one, and its Preview and Playground. Looked for in this component and
    // the ones above it (an element in a card's design belongs to that card).
    const chain = [d.name, ...(d.owners ?? []).map((o: { name: string }) => o.name)];
    const found = chain.find((n) => facts.designs?.[n] || facts.previewable?.includes(n));
    if (found) {
      const design = facts.designs?.[found];
      const card = design ? design.card : found;
      const row = el('div', 'ra-design');
      const use = design?.inUseFor?.length ? `in use for ${design.inUseFor.join(', ')}` : design?.inUse ? 'the one in use' : '';
      row.append(el('span', 'grow', design ? `${found === d.name ? '' : 'Part of '}${design.design} design of ${card}${use ? ` (${use})` : ''}` : `${found === d.name ? '' : 'Part of '}${card}, which can be previewed`));
      const one = button('single', `Preview: ${card}${design ? ` (${design.design})` : ''} on its own, with fixed data`);
      one.addEventListener('click', () => api.preview(card, design?.id));
      const all = button('board', `Playground: every design of ${card} in every state`);
      all.addEventListener('click', () => api.playground(card));
      row.append(one, all);
      box.append(row);
    }

    box.append(el('h4', undefined, 'Props'));
    const props = Object.entries(d.props ?? {});
    if (!props.length) box.append(el('div', 'ra-hint', 'None.'));
    for (const [k, v] of props) box.append(line(k, v));

    if (d.state !== undefined) {
      box.append(el('h4', undefined, 'State'));
      box.append(line('state', d.state));
    }
    if (d.hooks?.length) {
      box.append(el('h4', undefined, 'Hooks'));
      for (const h of d.hooks) {
        if (editing?.index === h.i) {
          const row = el('div', 'ra-line');
          const input = el('input');
          input.value = JSON.stringify(plain(h.value));
          input.addEventListener('keydown', (e) => {
            e.stopPropagation();
            if (e.key === 'Escape') {
              editing = undefined;
              renderDetail();
            }
            if (e.key !== 'Enter') return;
            let v: unknown;
            try {
              v = JSON.parse(input.value);
            } catch {
              v = input.value;
            }
            send({ type: 'setHook', id: d.id, index: h.i, value: v });
            editing = undefined;
          });
          row.append(el('span', 'ra-name', `${h.name}:`), input);
          box.append(row);
          requestAnimationFrame(() => input.focus());
          continue;
        }
        const row = line(h.name, h.value, h.deps !== undefined && h.deps !== null ? h.deps : undefined);
        if (h.editable) {
          const edit = button('changed', 'Change this value (JSON; Enter keeps it, Esc cancels)');
          edit.addEventListener('click', () => {
            editing = { index: h.i };
            renderDetail();
          });
          const t = tray(el('div'));
          t.append(edit);
          row.append(t);
        }
        box.append(row);
      }
    }
    if (d.contexts?.length) {
      box.append(el('h4', undefined, 'Contexts it reads'));
      for (const c of d.contexts) box.append(line(c.name, c.value));
    }
    if (d.owners?.length) {
      box.append(el('h4', undefined, 'Drawn by'));
      const owners = el('div', 'ra-owners');
      for (const o of d.owners) {
        // Names to click, like the tree's rows (not buttons: buttons are icons).
        const chip = el('span', 'ra-chip', o.name);
        chip.dataset.tip = `Show ${o.name}`;
        chip.addEventListener('mouseenter', () => outline(o.id));
        chip.addEventListener('mouseleave', () => outline(undefined));
        chip.addEventListener('click', () => {
          selected = o.id;
          detail = undefined;
          send({ type: 'inspect', id: o.id });
          render();
        });
        owners.append(chip);
      }
      box.append(owners);
    }
    box.scrollTop = keep;
  }

  /** A name and a value (opens like a tree), and what it depends on. */
  function line(name: string, v: unknown, deps?: unknown): HTMLElement {
    const row = el('div', 'ra-line');
    const val = el('div', 'ra-val');
    val.append(value(v));
    if (deps !== undefined) {
      const dep = el('div', 'ra-hint');
      dep.append('depends on ', value(deps));
      val.append(dep);
    }
    row.append(el('span', 'ra-name', `${name}:`), val);
    return row;
  }

  function drawStores(page: HTMLElement) {
    if (!stores) return void page.append(el('div', 'ra-empty', 'Reading the stores…'));
    if (!stores.length) {
      page.append(el('div', 'ra-empty', `No stores found. Zustand and Redux stores exported from the project's files show here (found: ${(facts.stores ?? []).length} file${(facts.stores ?? []).length === 1 ? '' : 's'}), and TanStack Query's cache when the app has a QueryClientProvider.`));
      return;
    }
    for (const s of stores) {
      const card = el('div', 'ra-card');
      const head = el('div', 'ra-head');
      head.append(el('span', 'ra-t', s.name), el('span', 'ra-tag', s.kind));
      if (s.file) {
        const t = tray(el('div'));
        const open = button('code', `Open ${s.file}`);
        open.addEventListener('click', () => api.openFile(s.file));
        t.append(open);
        head.append(t);
      }
      card.append(head);
      if (s.kind === 'error') card.append(el('div', 'ra-err', String(s.value)));
      else if (s.value && typeof s.value === 'object' && !Array.isArray(s.value) && !('$t' in s.value)) {
        // Its data first; its actions (functions) in one line.
        const fields = Object.entries<any>(s.value);
        const isAction = (v: any) => v && typeof v === 'object' && v.$t === 'function';
        const data = fields.filter(([, v]) => !isAction(v));
        const actions = fields.filter(([, v]) => isAction(v)).map(([k]) => k);
        if (!data.length) card.append(el('div', 'ra-hint', 'No data.'));
        for (const [k, v] of data) card.append(line(k, v));
        if (actions.length) card.append(el('div', 'ra-hint', `Actions: ${actions.join(', ')}`));
      } else card.append(line('value', s.value));
      page.append(card);
    }
  }

  function drawRoute(page: HTMLElement) {
    const r = routeInfo;
    if (!r) return void page.append(el('div', 'ra-empty', 'Reading the route…'));
    page.append(el('h4', undefined, 'Address'));
    page.append(line('path', r.location.path));
    const search = Object.entries(r.location.search ?? {});
    if (search.length) for (const [k, v] of search) page.append(line(`?${k}`, v));
    if (r.location.hash) page.append(line('hash', r.location.hash));
    page.append(el('h4', undefined, 'Routes that matched'));
    if (!r.matches.length) page.append(el('div', 'ra-hint', 'No React Router routes found (the app may use another router, or none).'));
    for (const m of r.matches) {
      const card = el('div', 'ra-card');
      const head = el('div', 'ra-head');
      head.append(el('span', 'ra-t', m.pattern || '/'), el('span', 'ra-tag', m.url));
      card.append(head);
      for (const [k, v] of Object.entries(m.params ?? {})) card.append(line(`:${k}`, v));
      page.append(card);
    }
  }

  function drawStorage(page: HTMLElement) {
    const s = storageInfo;
    if (!s) return void page.append(el('div', 'ra-empty', 'Reading storage…'));
    if (storageError) page.append(el('div', 'ra-err', storageError));
    const area = (title: string, key: string, list: { key: string; value: unknown; raw: string }[]) => {
      page.append(el('h4', undefined, `${title} (${list.length})`));
      if (!list.length) page.append(el('div', 'ra-hint', 'Empty.'));
      for (const item of list) {
        const id = `${key}:${item.key}`;
        if (storageEditing === id) {
          page.append(
            editor(item.key, item.raw, (v) => {
              storageEditing = undefined;
              send({ type: 'setKey', area: key, key: item.key, value: v });
            }),
          );
          continue;
        }
        const row = line(item.key, item.value);
        const t = tray(el('div'));
        const change = button('changed', `Change ${item.key}`);
        change.addEventListener('click', () => {
          storageEditing = id;
          storageError = '';
          render();
        });
        const del = button('trash', `Remove ${item.key}`);
        del.addEventListener('click', () => send({ type: 'deleteKey', area: key, key: item.key }));
        t.append(change, del);
        row.append(t);
        page.append(row);
      }
      // A new key and its value (text, or JSON: kept as written).
      const add = el('div', 'ra-add');
      const k = el('input', 'k');
      k.placeholder = 'key';
      const v = el('input', 'v');
      v.placeholder = 'value (text or JSON)';
      const go = () => {
        if (!k.value.trim()) return k.focus();
        storageError = '';
        send({ type: 'setKey', area: key, key: k.value.trim(), value: v.value });
      };
      for (const i of [k, v]) {
        i.spellcheck = false;
        i.addEventListener('keydown', (e) => {
          e.stopPropagation();
          if (e.key === 'Enter') go();
        });
      }
      const t = tray(el('div'));
      const addB = button('add', `Add to ${title.toLowerCase()}`);
      addB.addEventListener('click', go);
      t.append(addB);
      add.append(k, v, t);
      page.append(add);
    };
    area('Local storage', 'local', s.local);
    area('Session storage', 'session', s.session);
    area('Cookies', 'cookies', s.cookies);
    page.append(el('h4', undefined, `IndexedDB (${s.dbs.length})`));
    if (!s.dbs.length) page.append(el('div', 'ra-hint', 'No databases.'));
    for (const db of s.dbs) {
      const card = el('div', 'ra-card');
      const head = el('div', 'ra-head');
      head.append(el('span', 'ra-t', db.name), el('span', 'ra-tag', `version ${db.version}`));
      card.append(head);
      for (const st of db.stores) {
        const row = el('div', 'ra-row2');
        row.append(el('span', undefined, st.name), el('span', 'ra-c', `${st.count} record${st.count === 1 ? '' : 's'}`));
        row.dataset.tip = `Show the records in ${st.name}`;
        row.addEventListener('click', () => {
          if (records?.db === db.name && records?.store === st.name) records = undefined;
          else {
            records = { db: db.name, store: st.name, loading: true };
            send({ type: 'records', db: db.name, store: st.name });
          }
          render();
        });
        card.append(row);
        if (records?.db === db.name && records?.store === st.name) {
          if (records.loading) card.append(el('div', 'ra-hint', 'Reading…'));
          else {
            if (records.count > records.records.length) card.append(el('div', 'ra-hint', `The first ${records.records.length} of ${records.count}.`));
            for (const r of records.records) {
              const label = typeof r.key === 'object' ? JSON.stringify(r.key) : String(r.key);
              const id = `rec:${db.name}/${st.name}:${label}`;
              if (storageEditing === id) {
                card.append(
                  editor(label, r.raw, (text) => {
                    const value = parseJson(text);
                    if (value === undefined) return;
                    storageEditing = undefined;
                    send({ type: 'putRecord', db: db.name, store: st.name, value, ...(records.keyPath === null ? { key: r.key } : {}) });
                  }),
                );
                continue;
              }
              const rr = line(label, r.value);
              const t = tray(el('div'));
              if (r.raw !== undefined) {
                const change = button('changed', 'Change this record (JSON)');
                change.addEventListener('click', () => {
                  storageEditing = id;
                  storageError = '';
                  render();
                });
                t.append(change);
              }
              const del = button('trash', 'Remove this record');
              del.addEventListener('click', () => send({ type: 'deleteRecord', db: db.name, store: st.name, key: r.key }));
              t.append(del);
              rr.append(t);
              card.append(rr);
            }
            // A new record: its value as JSON (its key in it, when the table names one; else given here).
            const add = el('div', 'ra-add');
            const ownKey = records.keyPath === null && !records.autoIncrement;
            const k = el('input', 'k');
            k.placeholder = 'key';
            const v = el('input', 'v');
            v.placeholder = records.keyPath ? `JSON, with its ${Array.isArray(records.keyPath) ? records.keyPath.join(' and ') : records.keyPath}` : 'JSON';
            const go = () => {
              const value = parseJson(v.value);
              if (value === undefined) return;
              if (ownKey && !k.value.trim()) return k.focus();
              storageError = '';
              send({ type: 'putRecord', db: db.name, store: st.name, value, ...(ownKey ? { key: parseJson(k.value, true) } : {}) });
            };
            for (const i of [k, v]) {
              i.spellcheck = false;
              i.addEventListener('keydown', (e) => {
                e.stopPropagation();
                if (e.key === 'Enter') go();
              });
            }
            const t = tray(el('div'));
            const addB = button('add', `Add a record to ${st.name}`);
            addB.addEventListener('click', go);
            t.append(addB);
            if (ownKey) add.append(k);
            add.append(v, t);
            card.append(add);
          }
        }
      }
      page.append(card);
    }
  }

  /** A value being changed: Enter keeps it, Esc leaves it. */
  function editor(name: string, raw: string, save: (text: string) => void): HTMLElement {
    const row = el('div', 'ra-edit');
    const input = el('input');
    input.value = raw;
    input.spellcheck = false;
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') save(input.value);
      if (e.key === 'Escape') {
        storageEditing = undefined;
        render();
      }
    });
    const t = tray(el('div'));
    const keep = button('choose', 'Keep it (Enter)');
    keep.addEventListener('click', () => save(input.value));
    const cancel = button('close', 'Never mind (Esc)');
    cancel.addEventListener('click', () => {
      storageEditing = undefined;
      render();
    });
    t.append(keep, cancel);
    row.append(el('span', 'ra-name', `${name}:`), input, t);
    requestAnimationFrame(() => input.focus());
    return row;
  }

  /** JSON written by the developer (a key may be plain text); undefined (and says why) when it isn't. */
  function parseJson(text: string, plainOk = false): unknown {
    try {
      return JSON.parse(text);
    } catch {
      if (plainOk) return text.trim();
      storageError = 'That isn’t JSON. Records are JSON, like {"id": "a1", "name": "Ada"}.';
      render();
      return undefined;
    }
  }

  render();
});

/** A value made by the page's copy, back to plain JSON (for editing). */
function plain(v: any): unknown {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(plain);
  if (typeof v.$t === 'string') return v.$t === 'undefined' ? null : v.$t === 'object' ? plain(v.fields) : (v.text ?? null);
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)]));
}
