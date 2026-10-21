// The App panel's page script: runs inside the app's page (added by Visual Editor's proxy, before the app's own code),
// so React finds it when it starts. It keeps React's roots, and answers the App panel: the component tree, a
// component's props, hooks, state and the contexts it reads (and changes a useState value), the stores (Zustand and
// Redux; TanStack Query's cache), the route and its params, and browser storage (localStorage, sessionStorage,
// cookies, IndexedDB). It only reads React's own fields: nothing in the app changes unless the developer asks.

/* eslint-disable @typescript-eslint/no-explicit-any */
type Fiber = any;
interface PageApi {
  on(channel: string, handler: (data: any) => void): void;
  send(channel: string, data: unknown): void;
  copy(value: unknown, options?: { depth?: number; replace?: (value: unknown) => unknown }): unknown;
  highlight(elements: Element[] | null, label?: string): void;
  onPicked(handler: (element: Element) => void): void;
  drawAlone?(handler: { show(r: { file: string; name: string; props: Record<string, unknown>; fill?: boolean }): Promise<{ error?: string }>; leave(): void; target(): Element | null; propsOnPage?(r: { file: string; name: string }): Promise<Record<string, unknown> | null> }): void;
}

(() => {
  const ve = (window as any).visualEditor as PageApi | undefined;
  if (!ve || (window as any).__veReactApp) return;
  (window as any).__veReactApp = true;
  const CHANNEL = 'react/app';
  const say = (data: unknown) => ve.send(CHANNEL, data);

  // ---- React's roots, through the hook React looks for when it starts ----

  const roots = new Set<any>();
  let changed: (() => void) | undefined;
  const w = window as any;
  let hook = w.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  if (!hook) {
    let next = 1;
    hook = w.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
      renderers: new Map(),
      supportsFiber: true,
      inject(renderer: unknown) {
        const id = next++;
        this.renderers.set(id, renderer);
        return id;
      },
      onScheduleFiberRoot() {},
      onCommitFiberRoot() {},
      onCommitFiberUnmount() {},
      onPostCommitFiberRoot() {},
      checkDCE() {},
    };
  }
  const commit = hook.onCommitFiberRoot;
  hook.onCommitFiberRoot = function (id: number, root: any, ...rest: unknown[]) {
    roots.add(root);
    changed?.();
    return commit?.call(this, id, root, ...rest);
  };

  /** Roots made before this ran (or by a renderer it missed): found from the page's elements. */
  function findRoots() {
    if (roots.size) return;
    for (const el of Array.from(document.querySelectorAll('body, body > *, #root, #app, [data-reactroot]'))) {
      for (const k of Object.keys(el)) {
        if (k.startsWith('__reactContainer$')) roots.add((el as any)[k].stateNode);
        if (k === '_reactRootContainer') roots.add((el as any)[k]._internalRoot ?? (el as any)[k]);
      }
    }
  }

  // ---- Fibers: ids, names, kinds ----

  const ids = new WeakMap<Fiber, number>();
  const byId = new Map<number, WeakRef<Fiber>>();
  let nextId = 1;
  function idOf(f: Fiber): number {
    let id = ids.get(f) ?? (f.alternate ? ids.get(f.alternate) : undefined);
    if (!id) id = nextId++;
    ids.set(f, id);
    if (f.alternate) ids.set(f.alternate, id);
    byId.set(id, new WeakRef(f));
    return id;
  }
  /** The fiber for an id, as it is now (React keeps two copies; the one on screen). */
  function fiberOf(id: number): Fiber | undefined {
    const f = byId.get(id)?.deref();
    if (!f) return undefined;
    return current(f);
  }
  function current(f: Fiber): Fiber {
    // The copy whose root's current tree contains it.
    if (!f.alternate) return f;
    let top = f;
    while (top.return) top = top.return;
    const rootFiber = top.stateNode?.current;
    if (rootFiber === top) return f;
    return f.alternate;
  }

  const FUNCTION = 0, CLASS = 1, ROOT = 3, CONTEXT = 10, FORWARD = 11, SUSPENSE = 13, MEMO = 14, SIMPLE_MEMO = 15;
  function nameOfType(t: any): string {
    if (!t) return 'Anonymous';
    if (typeof t === 'string') return t;
    return t.displayName || t.name || (t.render ? t.render.displayName || t.render.name : '') || (t.type ? nameOfType(t.type) : '') || 'Anonymous';
  }
  /** A component's name and kind, or undefined for React's own parts (fragments, elements, text…). */
  function describe(f: Fiber): { name: string; kind: string } | undefined {
    switch (f.tag) {
      case FUNCTION:
        return { name: nameOfType(f.type), kind: 'function' };
      case CLASS:
        return { name: nameOfType(f.type), kind: 'class' };
      case FORWARD:
        return { name: nameOfType(f.type), kind: 'forwardRef' };
      case SIMPLE_MEMO:
        return { name: nameOfType(f.type), kind: 'memo' };
      case MEMO:
        return { name: nameOfType(f.elementType ?? f.type), kind: 'memo' };
      case CONTEXT: {
        const ctx = f.type?._context ?? f.type;
        return { name: `${ctx?.displayName || 'Context'}.Provider`, kind: 'provider' };
      }
      case SUSPENSE:
        return { name: 'Suspense', kind: 'suspense' };
      case ROOT:
        return { name: 'Root', kind: 'root' };
      default:
        return undefined;
    }
  }

  interface Node {
    id: number;
    name: string;
    kind: string;
    key?: string;
    children: Node[];
  }
  /** The component tree: React's own parts left out (their children go to the component above). */
  function tree(): Node[] {
    findRoots();
    const out: Node[] = [];
    for (const root of roots) {
      const top = root.current;
      if (!top?.child) continue;
      const node: Node = { id: idOf(top), name: 'Root', kind: 'root', children: [] };
      walk(top.child, node.children, 0);
      out.push(node);
    }
    return out;
  }
  function walk(first: Fiber, into: Node[], depth: number) {
    // Siblings in a loop, children by recursion (deep trees are deep: kept within the stack's limits).
    for (let f = first; f; f = f.sibling) {
      const d = describe(f);
      // A memo wrapper whose child is the component itself: one node.
      if (d && !(f.tag === MEMO && f.child && f.child.type === f.type?.type)) {
        const node: Node = { id: idOf(f), name: d.name, kind: f.tag === MEMO ? 'memo' : d.kind, ...(f.key != null ? { key: String(f.key) } : {}), children: [] };
        into.push(node);
        if (f.child && depth < 400) walk(f.child, node.children, depth + 1);
      } else if (f.tag === MEMO && f.child) {
        // The inner component, marked as memo.
        const inner = f.child;
        const di = describe(inner);
        const node: Node = { id: idOf(inner), name: di?.name ?? nameOfType(f.type), kind: 'memo', ...(f.key != null ? { key: String(f.key) } : {}), children: [] };
        into.push(node);
        if (inner.child && depth < 400) walk(inner.child, node.children, depth + 1);
      } else if (f.child && depth < 400) walk(f.child, into, depth + 1);
    }
  }

  /** The page's elements a component draws (its top-level ones). */
  function elementsOf(f: Fiber): Element[] {
    const out: Element[] = [];
    const visit = (x: Fiber) => {
      for (let c = x; c; c = c.sibling) {
        if ((c.tag === 5 || c.tag === 26 || c.tag === 27) && c.stateNode instanceof Element) out.push(c.stateNode);
        else if (c.child) visit(c.child);
        if (out.length > 50) return;
      }
    };
    if ((f.tag === 5 || f.tag === 26 || f.tag === 27) && f.stateNode instanceof Element) return [f.stateNode];
    if (f.child) visit(f.child);
    return out;
  }

  /** The component an element belongs to (the nearest one above it), and the ids up to the root. */
  function componentOf(el: Element): { id: number; path: number[] } | undefined {
    let f: Fiber | undefined;
    for (let e: Element | null = el; e && !f; e = e.parentElement) {
      const k = Object.keys(e).find((x) => x.startsWith('__reactFiber$'));
      if (k) f = (e as any)[k];
    }
    if (!f) return undefined;
    f = current(f);
    let comp: Fiber | undefined;
    const path: number[] = [];
    for (let x = f; x; x = x.return) {
      const d = describe(x);
      if (d && x.tag !== MEMO) {
        if (!comp && d.kind !== 'provider' && d.kind !== 'root') comp = x;
        path.unshift(idOf(x));
      }
    }
    return comp ? { id: idOf(comp), path } : undefined;
  }

  // ---- One component: props, hooks, state, contexts ----

  /** Values made safe to send: React elements and fibers in a few words. */
  const replace = (v: unknown): unknown => {
    const x = v as any;
    if (x && typeof x === 'object' && typeof x.$$typeof === 'symbol') {
      const t = String(x.$$typeof);
      if (/element/.test(t)) return { $t: 'element', text: `<${nameOfType(x.type)}${x.key != null ? ` key="${x.key}"` : ''} />` };
      if (/context/.test(t)) return { $t: 'object', name: 'Context', fields: { displayName: x.displayName ?? '' } };
      return { $t: 'more', text: t.replace(/^Symbol\(|\)$/g, '') };
    }
    if (x && typeof x === 'object' && 'stateNode' in x && 'memoizedProps' in x && 'return' in x) return { $t: 'more', text: `(React's own record of ${nameOfType(x.type)})` };
    if (typeof Node !== 'undefined' && x instanceof Node && !(x instanceof Element)) return { $t: 'more', text: x.nodeName };
    return undefined;
  };
  const copy = (v: unknown, depth = 3) => ve.copy(v, { depth, replace });

  /** How many of React's hook records each hook kind takes (useContext and use take none). */
  const SLOTS: Record<string, number> = { useContext: 0, use: 0, useDebugValue: 0, useFormStatus: 0, useTransition: 2, useActionState: 3, useFormState: 3, useSyncExternalStore: 2 };

  function hooksOf(f: Fiber) {
    if (f.tag === CLASS || f.tag === CONTEXT || f.tag === ROOT) return [];
    const types: string[] | null = f._debugHookTypes ?? null;
    const list: { i: number; name: string; value: unknown; deps?: unknown; editable?: boolean }[] = [];
    let h = f.memoizedState;
    if (!types) {
      for (let i = 0; h && i < 100; i++, h = h.next) list.push({ i, name: 'hook', value: copy(h.memoizedState) });
      return list;
    }
    types.forEach((name, i) => {
      const slots = SLOTS[name] ?? 1;
      // useContext and the like keep nothing here (what they read is under Contexts).
      if (!slots) return;
      const at = h;
      for (let s = 0; s < slots && h; s++) h = h.next;
      if (!at) return;
      const m = at.memoizedState;
      if (name === 'useState' || name === 'useReducer') list.push({ i, name, value: copy(m), editable: name === 'useState' && !!at.queue?.dispatch });
      else if (/Effect$/.test(name) || name === 'useImperativeHandle') list.push({ i, name, value: { $t: 'function', text: 'runs after drawing' }, deps: copy(m?.deps ?? null, 2) });
      else if (name === 'useRef') list.push({ i, name, value: copy(m?.current) });
      else if (name === 'useMemo' || name === 'useCallback') list.push({ i, name, value: copy(Array.isArray(m) ? m[0] : m), deps: copy(Array.isArray(m) ? m[1] : null, 2) });
      else if (name === 'useTransition') list.push({ i, name, value: { $t: 'more', text: at.memoizedState ? 'pending' : 'idle' } });
      else list.push({ i, name, value: copy(m) });
    });
    return list;
  }

  function contextsOf(f: Fiber) {
    const out: { name: string; value: unknown }[] = [];
    const seen = new Set<unknown>();
    for (let c = f.dependencies?.firstContext; c && out.length < 30; c = c.next) {
      if (seen.has(c.context)) continue;
      seen.add(c.context);
      out.push({ name: c.context?.displayName || 'Context', value: copy(c.memoizedValue, 2) });
    }
    return out;
  }

  /** Where the component was drawn from (the line with <Name …/> in its parent's code), when React kept it. */
  function placeOf(f: Fiber): { url?: string; line?: number; column?: number; file?: string } | undefined {
    if (f._debugSource) return { file: f._debugSource.fileName, line: f._debugSource.lineNumber, column: f._debugSource.columnNumber };
    const stack = String(f._debugStack?.stack ?? '');
    for (const line of stack.split('\n').slice(1)) {
      const m = /\(?((?:https?):[^\s)]+):(\d+):(\d+)\)?\s*$/.exec(line);
      if (m && !/node_modules|react-stack-top-frame|\/__ve\/|react_jsx|jsx-dev-runtime|chunk-/.test(line)) return { url: m[1], line: Number(m[2]), column: Number(m[3]) };
    }
    return undefined;
  }

  function inspect(id: number) {
    const f = fiberOf(id);
    if (!f) return { id, gone: true };
    const d = describe(f) ?? { name: nameOfType(f.type), kind: 'component' };
    const props = { ...(f.memoizedProps ?? {}) };
    const owners: { id: number; name: string }[] = [];
    for (let o = f._debugOwner; o && owners.length < 20; o = o._debugOwner) {
      const od = describe(o);
      if (od) owners.push({ id: idOf(current(o)), name: od.name });
    }
    return {
      id,
      name: d.name,
      kind: f.tag === MEMO ? 'memo' : d.kind,
      key: f.key ?? undefined,
      props: copy(props),
      state: f.tag === CLASS ? copy(f.memoizedState) : undefined,
      hooks: hooksOf(f),
      contexts: contextsOf(f),
      owners,
      place: placeOf(f),
      elements: elementsOf(f).length,
    };
  }

  /** Changes a useState value (as if the component had called its setter). */
  function setHook(id: number, index: number, value: unknown) {
    const f = fiberOf(id);
    const types: string[] = f?._debugHookTypes ?? [];
    let h = f?.memoizedState;
    for (let i = 0; i < index && h; i++) for (let s = 0; s < (SLOTS[types[i]] ?? 1); s++) h = h?.next;
    h?.queue?.dispatch?.(value);
  }

  // ---- Stores ----

  interface Store {
    name: string;
    kind: string;
    file?: string;
    get(): unknown;
    subscribe?(fn: () => void): () => void;
  }
  let stores: Store[] = [];
  const unsubscribe: (() => void)[] = [];

  /** Zustand and Redux stores exported by the project's files (imported as the app imports them: the same ones). */
  async function loadStores(files: string[]) {
    for (const u of unsubscribe.splice(0)) u();
    const found: Store[] = [];
    for (const file of files) {
      try {
        const mod = await import(/* @vite-ignore */ `/${file}`);
        for (const [name, v] of Object.entries<any>(mod)) {
          if (v && typeof v.getState === 'function' && typeof v.subscribe === 'function') {
            found.push({ name, kind: typeof v.dispatch === 'function' ? 'Redux' : 'Zustand', file, get: () => v.getState(), subscribe: (fn) => v.subscribe(fn) });
          }
        }
      } catch (e) {
        found.push({ name: file, kind: 'error', file, get: () => `Couldn't load it: ${e instanceof Error ? e.message : String(e)} (stores are read through Vite's dev server)` });
      }
    }
    // Stores and query caches handed to providers (Redux's <Provider store>, <QueryClientProvider client>).
    findRoots();
    const seen = new Set<unknown>(found.map((s) => s.get));
    const visit = (f: Fiber, depth: number) => {
      for (let x = f; x; x = x.sibling) {
        const p = x.memoizedProps;
        if (p?.store && typeof p.store.getState === 'function' && !seen.has(p.store)) {
          seen.add(p.store);
          const s = p.store;
          if (!found.some((y) => y.kind === 'Redux')) found.push({ name: 'store', kind: 'Redux', get: () => s.getState(), subscribe: (fn) => s.subscribe(fn) });
        }
        if (p?.client && typeof p.client.getQueryCache === 'function' && !seen.has(p.client)) {
          seen.add(p.client);
          const c = p.client;
          found.push({
            name: 'queries',
            kind: 'TanStack Query',
            get: () => Object.fromEntries(c.getQueryCache().getAll().map((q: any) => [JSON.stringify(q.queryKey), { status: q.state.status, fetching: q.state.fetchStatus, updated: q.state.dataUpdatedAt ? new Date(q.state.dataUpdatedAt).toLocaleTimeString() : '', data: q.state.data, error: q.state.error ?? undefined }])),
            subscribe: (fn) => c.getQueryCache().subscribe(fn),
          });
        }
        if (x.child && depth < 60) visit(x.child, depth + 1);
      }
    };
    for (const r of roots) if (r.current) visit(r.current, 0);
    stores = found;
    for (const s of stores) if (s.subscribe) unsubscribe.push(s.subscribe(() => soon('stores', sendStores)));
    sendStores();
  }
  function sendStores() {
    say({ type: 'stores', list: stores.map((s) => ({ name: s.name, kind: s.kind, file: s.file, value: copy(s.get(), 5) })) });
  }

  // ---- Route ----

  function route() {
    findRoots();
    let deepest: any;
    const visit = (f: Fiber, depth: number) => {
      for (let x = f; x; x = x.sibling) {
        const p = x.memoizedProps;
        if (p?.match && p?.routeContext?.matches) deepest = p.routeContext.matches;
        if (x.child && depth < 300) visit(x.child, depth + 1);
      }
    };
    for (const r of roots) if (r.current) visit(r.current, 0);
    return {
      type: 'route',
      location: { path: location.pathname, search: Object.fromEntries(new URLSearchParams(location.search)), hash: location.hash },
      matches: (deepest ?? []).map((m: any) => ({ pattern: m.route?.path ?? (m.route?.index ? '(index)' : ''), id: m.route?.id, url: m.pathnameBase ?? m.pathname, params: { ...(m.params ?? {}) } })),
    };
  }

  // ---- Browser storage ----

  function parse(text: string): unknown {
    try {
      return copy(JSON.parse(text), 4);
    } catch {
      return text;
    }
  }
  async function storage() {
    const area = (s: Storage) => Array.from({ length: s.length }, (_v, i) => s.key(i)!).sort().map((key) => ({ key, value: parse(s.getItem(key) ?? ''), raw: s.getItem(key) ?? '' }));
    const cookies = document.cookie
      .split(';')
      .map((c) => c.trim())
      .filter(Boolean)
      .map((c) => ({ key: decodeURIComponent(c.split('=')[0]), value: decodeURIComponent(c.slice(c.indexOf('=') + 1)), raw: decodeURIComponent(c.slice(c.indexOf('=') + 1)) }));
    const dbs: { name: string; version: number; stores: { name: string; count: number }[] }[] = [];
    try {
      for (const info of (await indexedDB.databases?.()) ?? []) {
        if (!info.name) continue;
        const db = await openDb(info.name);
        if (!db) continue;
        const names = Array.from(db.objectStoreNames);
        const stores = await Promise.all(names.map((n) => req(db.transaction(n).objectStore(n).count()).then((count) => ({ name: n, count: Number(count) }))));
        dbs.push({ name: info.name, version: db.version, stores });
        db.close();
      }
    } catch {
      // No IndexedDB here.
    }
    say({ type: 'storage', local: area(localStorage), session: area(sessionStorage), cookies, dbs });
  }
  function req<T>(r: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }
  /** Opens a database that exists (never makes or upgrades one). */
  function openDb(name: string): Promise<IDBDatabase | undefined> {
    return new Promise((resolve) => {
      const r = indexedDB.open(name);
      r.onupgradeneeded = () => {
        r.transaction?.abort();
        resolve(undefined);
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => resolve(undefined);
    });
  }
  async function records(dbName: string, store: string) {
    const db = await openDb(dbName);
    if (!db) return say({ type: 'records', db: dbName, store, records: [], count: 0 });
    const s = db.transaction(store).objectStore(store);
    const [keys, values, count] = await Promise.all([req(s.getAllKeys(undefined, 100)), req(s.getAll(undefined, 100)), req(s.count())]);
    db.close();
    // As JSON too, to change it (a record JSON can't hold, like a Blob or a Date, isn't changed here).
    const json = (v: unknown) => {
      try {
        return JSON.stringify(v, (_k, x) => (x instanceof Blob || x instanceof ArrayBuffer || x instanceof Date || x instanceof Map || x instanceof Set ? (() => { throw new Error('not JSON'); })() : x));
      } catch {
        return undefined;
      }
    };
    say({ type: 'records', db: dbName, store, count, keyPath: s.keyPath, autoIncrement: s.autoIncrement, records: keys.map((k, i) => ({ key: copy(k, 2), value: copy(values[i], 4), raw: json(values[i]) })) });
  }
  /** Adds or changes a record (its key: in the value when the table has a key path, else given). */
  async function putRecord(dbName: string, store: string, value: unknown, key?: IDBValidKey) {
    const db = await openDb(dbName);
    if (!db) return;
    try {
      const s = db.transaction(store, 'readwrite').objectStore(store);
      await req(s.keyPath !== null || key === undefined ? s.put(value) : s.put(value, key));
    } catch (e) {
      say({ type: 'storageError', text: e instanceof Error ? e.message : String(e) });
    }
    db.close();
    await records(dbName, store);
    await storage();
  }
  async function deleteRecord(dbName: string, store: string, key: IDBValidKey) {
    const db = await openDb(dbName);
    if (!db) return;
    await req(db.transaction(store, 'readwrite').objectStore(store).delete(key));
    db.close();
    await records(dbName, store);
  }

  // ---- One component alone (component mode) ----
  // Drawn by the app's own React (the same modules it loaded), inside the providers above it (router, query client,
  // theme…) with their real values, while the rest of the page is hidden (the app stays as it was underneath).

  interface Alone {
    name: string;
    type: any;
    /** Its props as given (functions and elements kept), and the providers around it. */
    base: Record<string, unknown>;
    providers: { type: any; value: unknown }[];
    /** The elements it sits in on the page (a library's wrappers, e.g. React Flow's node), rebuilt around it. */
    frame: HTMLElement[];
    props: Record<string, unknown>;
    root: any;
    stage: HTMLElement;
    /** Pop-ups the component opens (added to the page later), lifted above the stage. */
    watch: MutationObserver;
    fill: boolean;
  }
  let alone: Alone | undefined;
  /** The last reason a component couldn't be drawn alone (for the Playground's tiles). */
  let lastError = '';
  let reactModules: { React: any; createRoot: any } | undefined;

  /** React and react-dom/client as the app loaded them (Vite's dev server serves each once: the same instance). */
  async function react() {
    if (reactModules) return reactModules;
    const urls = performance.getEntriesByType('resource').map((e) => e.name);
    const domUrl = urls.find((u) => /\/react-dom_client\.js(\?|$)|\/react-dom\/client(\.m?js)?(\?|$)/.test(u));
    const reactUrl = urls.find((u) => /\/deps\/react\.js(\?|$)|\/node_modules\/react\/index\.js(\?|$)/.test(u));
    if (!domUrl || !reactUrl) throw new Error('React’s modules weren’t found in this page (showing a component alone needs Vite’s dev server).');
    const [R, D] = await Promise.all([import(/* @vite-ignore */ reactUrl), import(/* @vite-ignore */ domUrl)]);
    const React = R.default?.createElement ? R.default : R;
    const createRoot = D.createRoot ?? D.default?.createRoot;
    if (!React?.createElement || !createRoot) throw new Error('React’s modules don’t look as expected.');
    reactModules = { React, createRoot };
    return reactModules;
  }

  /** The type to draw a component with (memo and forwardRef wrappers kept). */
  function typeOf(f: Fiber): any {
    return f.tag === MEMO || f.tag === SIMPLE_MEMO ? f.elementType ?? f.type : f.type;
  }

  /** The providers above a component, outermost first, with their values now. */
  function providersOf(f: Fiber): { type: any; value: unknown }[] {
    const out: { type: any; value: unknown }[] = [];
    for (let x = f.return; x; x = x.return) if (x.tag === CONTEXT) out.unshift({ type: x.type, value: x.memoizedProps?.value });
    return out;
  }

  /** Every provider mounted in the app now (one per context: the deepest, most specific), outermost first: for a
   *  component opened on its own that isn't on the page (it may need one only some screens give, like React Flow's). */
  function allProviders(): { type: any; value: unknown }[] {
    findRoots();
    const byContext = new Map<unknown, { type: any; value: unknown; depth: number }>();
    const visit = (f: Fiber, depth: number) => {
      for (let x = f; x; x = x.sibling) {
        if (x.tag === CONTEXT) {
          const ctx = x.type?._context ?? x.type;
          const had = byContext.get(ctx);
          if (!had || depth >= had.depth) byContext.set(ctx, { type: x.type, value: x.memoizedProps?.value, depth });
        }
        if (x.child && depth < 400) visit(x.child, depth + 1);
      }
    };
    for (const r of roots) if (r.current && !r.current.stateNode?.containerInfo?.closest?.('#__ve_alone')) visit(r.current, 0);
    return [...byContext.values()].sort((a, b) => a.depth - b.depth).map(({ type, value }) => ({ type, value }));
  }

  /** The page's elements a component sits in (outermost first, up to its React root): their classes and data-
   *  attributes, so a library's styles still apply around it (React Flow's handles are placed in its node). */
  function frameOf(f: Fiber): { className: string; attrs: [string, string][]; vars: [string, string][]; size?: { w: number; h: number } }[] {
    const top = elementsOf(f)[0];
    let root: Fiber = f;
    while (root.return) root = root.return;
    const container: Element | undefined = root.stateNode?.containerInfo;
    const out: { className: string; attrs: [string, string][]; vars: [string, string][]; size?: { w: number; h: number } }[] = [];
    for (let e = top?.parentElement; e && e !== container && e !== document.body && e !== document.documentElement && out.length < 12; e = e.parentElement) {
      const attrs = Array.from(e.attributes).filter((a) => a.name.startsWith('data-') || a.name === 'role').map((a) => [a.name, a.value] as [string, string]);
      const vars: [string, string][] = [];
      for (let i = 0; i < e.style.length; i++) if (e.style[i].startsWith('--')) vars.push([e.style[i], e.style.getPropertyValue(e.style[i])]);
      out.unshift({ className: e.getAttribute('class') ?? '', attrs, vars });
    }
    // The element right around it keeps its size (a component that fills its parent, like a sidebar, needs it).
    const parent = top?.parentElement;
    const r = parent?.getBoundingClientRect();
    if (out.length && r) out[out.length - 1].size = { w: Math.round(r.width), h: Math.round(r.height) };
    return out;
  }

  /** A copy of a component on the page (for the frame it sits in). */
  function onPage(type: any): Fiber | undefined {
    findRoots();
    let hit: Fiber | undefined;
    const visit = (f: Fiber, depth: number) => {
      for (let x = f; x && !hit; x = x.sibling) {
        if (x.type === type || x.elementType === type) hit = x;
        else if (x.child && depth < 400) visit(x.child, depth + 1);
      }
    };
    for (const r of roots) if (!hit && r.current && !r.current.stateNode?.containerInfo?.closest?.('#__ve_alone')) visit(r.current, 0);
    return hit;
  }

  /** The frame rebuilt: the same classes, but laid out simply (no absolute places, transforms or clipping). */
  /** The width a component gets when its place on the page is collapsed (0 wide). */
  const COLLAPSED_WIDTH = 320;
  /** Sizes the frame keeps (by element), from frameOf. */
  const kept = new WeakMap<HTMLElement, { w: number; h: number }>();

  function buildFrame(stage: HTMLElement, frame: ReturnType<typeof frameOf>): HTMLElement[] {
    const made: HTMLElement[] = [];
    let at = stage;
    for (const f of frame) {
      const d = document.createElement('div');
      if (f.className) d.className = f.className;
      for (const [k, v] of f.attrs) d.setAttribute(k, v);
      for (const [k, v] of f.vars) d.style.setProperty(k, v);
      if (f.size) kept.set(d, f.size);
      at.append(d);
      made.push(d);
      at = d;
    }
    return made;
  }

  /** Props as JSON the developer can change: functions and elements left out (they're kept as they are). */
  function jsonable(props: Record<string, unknown>) {
    const json: Record<string, unknown> = {};
    const kept: string[] = [];
    for (const [k, v] of Object.entries(props)) {
      if (typeof v === 'function' || (v && typeof v === 'object' && typeof (v as any).$$typeof === 'symbol')) {
        kept.push(k);
        continue;
      }
      try {
        const seen = new WeakSet();
        json[k] = JSON.parse(JSON.stringify(v, (_k, x) => {
          if (x && typeof x === 'object') {
            if (seen.has(x) || typeof x.$$typeof === 'symbol' || x instanceof Node) throw new Error('not JSON');
            seen.add(x);
          }
          return typeof x === 'function' ? undefined : x;
        }) ?? 'null');
      } catch {
        kept.push(k);
      }
    }
    return { json, kept };
  }

  /** Props from JSON: {"$action": "name"} is a function that says when it's called. */
  function fromJson(v: unknown, name = ''): unknown {
    if (Array.isArray(v)) return v.map((x) => fromJson(x, name));
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      if (typeof o.$action === 'string') return action(o.$action);
      return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, fromJson(x, k)]));
    }
    return v;
  }
  function action(name: string) {
    return (...args: unknown[]) => {
      console.log(`${name}(…) was called`, ...args);
      say({ type: 'action', name, args: copy(args, 2) });
    };
  }

  function draw() {
    const a = alone!;
    const { React } = reactModules!;
    class Boundary extends React.Component {
      state = { error: null as unknown };
      static getDerivedStateFromError(error: unknown) {
        return { error };
      }
      componentDidCatch(error: unknown) {
        say({ type: 'aloneError', text: error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error) });
      }
      render() {
        const e = (this as any).state.error;
        // A calm note here; why it stopped, and what to do, are in the App panel.
        return e ? React.createElement('div', { style: { font: '13px/1.5 system-ui, sans-serif', color: '#777', padding: '16px', maxWidth: '420px', textAlign: 'center' } }, `${a.name} can’t be shown on its own here. The App panel says why, and what to do.`) : (this as any).props.children;
      }
    }
    let el = React.createElement(a.type, a.props);
    for (let i = a.providers.length - 1; i >= 0; i--) el = React.createElement(a.providers[i].type, { value: a.providers[i].value }, el);
    // Over the page (which stays as it is underneath: laid out, its state kept), in the page's own background.
    const bg = [document.body, document.documentElement].map((e) => getComputedStyle(e).backgroundColor).find((c) => c && !/rgba\(0, 0, 0, 0\)|transparent/.test(c)) ?? '#fff';
    // Centred by the stage itself (safe: never pushed off an edge), so it keeps its own size (not stretched).
    a.stage.style.cssText = `position:fixed;inset:0;z-index:2147483000;overflow:auto;background:${bg};` + (a.fill ? '' : 'display:flex;align-items:safe center;justify-content:safe center;padding:32px;box-sizing:border-box;');
    // In the middle, but never pushed off the edge when it's wider than the page (it scrolls instead).
    const first = a.stage.firstElementChild as HTMLElement | null;
    if (first) first.style.setProperty('margin', a.fill ? '0' : 'auto', 'important');
    // The frame's own layout (absolute places, transforms, clipping, sizes) undone: it only carries styles.
    for (const d of a.frame) {
      const set = (k: string, v: string) => d.style.setProperty(k, v, 'important');
      set('position', 'relative');
      for (const k of ['inset', 'left', 'top', 'right', 'bottom', 'z-index']) set(k, 'auto');
      set('transform', 'none');
      // Collapsed on the page (0 wide, like a closed sidebar): a usable width instead.
      const size = kept.get(d);
      set('width', a.fill ? '100%' : size ? `${size.w || COLLAPSED_WIDTH}px` : 'auto');
      set('height', size?.h ? `${size.h}px` : 'auto');
      if (size) set('flex', 'none');
      set('min-height', '0');
      set('margin', '0');
      set('overflow', 'visible');
      set('pointer-events', 'auto');
      set('visibility', 'visible');
    }
    a.root.render(React.createElement(Boundary, { key: Math.random() }, el));
    // Drawn, but nothing to see (0 wide or high): it's closed or empty right now, and says so.
    setTimeout(() => {
      if (alone !== a) return;
      const host = (a.frame[a.frame.length - 1] ?? a.stage).firstElementChild;
      const r = host?.getBoundingClientRect();
      const empty = !host || !r || r.width < 2 || r.height < 2;
      say({ type: 'aloneSize', empty, ...(r ? { size: `${Math.round(r.width)} × ${Math.round(r.height)}` } : {}) });
    }, 400);
  }

  /** Shows a component alone: its type, props and the providers around it. */
  /** `asJson`: the props as written (actions as {"$action"}), when they came from JSON. */
  async function showAlone(name: string, type: any, props: Record<string, unknown>, providers: { type: any; value: unknown }[], frameFrom: Fiber | undefined, asJson?: Record<string, unknown>) {
    try {
      const { createRoot } = await react();
      leaveAlone(false);
      ve!.highlight(null);
      const stage = document.createElement('div');
      stage.id = '__ve_alone';
      document.body.append(stage);
      // Pop-ups it opens (portals added to the page) go above the stage.
      const watch = new MutationObserver((changes) => {
        for (const c of changes)
          for (const n of Array.from(c.addedNodes)) {
            if (!(n instanceof HTMLElement) || n === stage || /^(SCRIPT|STYLE|LINK)$/.test(n.tagName) || n.closest('[id^="__ve"]')) continue;
            if (getComputedStyle(n).position === 'static') n.style.position = 'relative';
            n.style.zIndex = '2147483001';
          }
      });
      watch.observe(document.body, { childList: true });
      const frame = buildFrame(stage, frameFrom ? frameOf(frameFrom) : []);
      // Its errors go to the App panel (in words), not to the Console.
      const quiet = (error: unknown) => {
        lastError = error instanceof Error ? error.message : String(error);
        say({ type: 'aloneError', text: error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error) });
      };
      const root = createRoot(frame[frame.length - 1] ?? stage, { onCaughtError: quiet, onUncaughtError: quiet, onRecoverableError: () => {} });
      alone = { name, type, base: props, providers, frame, props, root, stage, watch, fill: false };
      draw();
      const { json, kept: keptProps } = asJson ? { json: asJson, kept: [] as string[] } : jsonable(props);
      const inner = frame[frame.length - 1];
      const collapsed = !!inner && kept.get(inner)?.w === 0;
      say({ type: 'alone', name, json, kept: keptProps, fill: false, ...(collapsed ? { note: `Its place on the page is closed (0 wide), so it’s drawn ${COLLAPSED_WIDTH} px wide. The Fill button (next to its name) gives it the page’s width.` } : {}) });
    } catch (e) {
      say({ type: 'aloneError', text: e instanceof Error ? e.message : String(e) });
    }
  }

  function leaveAlone(tell = true) {
    if (!alone) return;
    try {
      alone.root.unmount();
    } catch {
      // Already gone.
    }
    alone.stage.remove();
    alone.watch.disconnect();
    ve!.highlight(null);
    alone = undefined;
    if (tell) say({ type: 'alone', name: null });
  }

  /** A component of the project, by its file and name (imported as the app imports it), with these props. */
  async function openAlone(file: string, name: string, props: Record<string, unknown>) {
    try {
      const mod = await import(/* @vite-ignore */ `/${file}`);
      const type = mod[name] ?? (mod.default && nameOfType(mod.default) === name ? mod.default : undefined);
      if (!type) throw new Error(`${name} isn’t exported from ${file}, so it can’t be opened on its own. Show it from the page instead: pick it, then “Show it alone”.`);
      // Inside what a copy of it on the page sits in (its providers and frame), when there is one; else everything
      // the app provides now.
      const copy = onPage(type);
      await showAlone(name, type, fromJson(props) as Record<string, unknown>, copy ? providersOf(copy) : allProviders(), copy, props);
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      say({ type: 'aloneError', text: lastError });
    }
  }

  // The Playground's tiles: a component drawn alone on request (the shell takes its picture).
  ve.drawAlone?.({
    show: async (r) => {
      lastError = '';
      await openAlone(r.file, r.name, r.props);
      if (alone && !!r.fill !== alone.fill) {
        alone.fill = !!r.fill;
        draw();
      }
      // Errors come once React has tried to draw it.
      await new Promise((done) => setTimeout(done, 150));
      return lastError ? { error: lastError } : {};
    },
    leave: () => leaveAlone(),
    target: () => (alone ? ((alone.frame[alone.frame.length - 1] ?? alone.stage).firstElementChild as Element | null) : null),
    // The props a copy of it has on this page (real data), as JSON: functions as {"$action"}, elements left out.
    propsOnPage: async (r) => {
      try {
        const mod = await import(/* @vite-ignore */ `/${r.file}`);
        const type = mod[r.name] ?? (mod.default && nameOfType(mod.default) === r.name ? mod.default : undefined);
        const copy = type ? onPage(type) : undefined;
        if (!copy) return null;
        const props = (copy.memoizedProps ?? {}) as Record<string, unknown>;
        const { json, kept: left } = jsonable(props);
        for (const k of left) if (typeof props[k] === 'function') json[k] = { $action: k };
        return json;
      } catch {
        return null;
      }
    },
  });

  // ---- Talking to the panel ----

  let watching = false;
  let selected: number | undefined;
  const timers: Record<string, ReturnType<typeof setTimeout> | undefined> = {};
  function soon(what: string, run: () => void, ms = 250) {
    if (timers[what]) return;
    timers[what] = setTimeout(() => {
      timers[what] = undefined;
      run();
    }, ms);
  }
  changed = () => {
    if (!watching) return;
    soon('tree', () => {
      say({ type: 'tree', roots: tree() });
      if (selected !== undefined) say({ type: 'inspected', data: inspect(selected) });
    });
    soon('route', () => say(route()), 400);
  };

  ve.on(CHANNEL, (m: any) => {
    if (!m || typeof m !== 'object') return;
    if (m.type === 'ping') say({ type: 'ready' });
    else if (m.type === 'watch') {
      watching = true;
      say({ type: 'tree', roots: tree() });
      say(route());
    } else if (m.type === 'unwatch') watching = false;
    else if (m.type === 'inspect') {
      selected = m.id;
      say({ type: 'inspected', data: inspect(m.id) });
    } else if (m.type === 'highlight') {
      const f = m.id ? fiberOf(m.id) : undefined;
      ve.highlight(f ? elementsOf(f) : null, f ? describe(f)?.name : undefined);
    } else if (m.type === 'scroll') {
      const f = fiberOf(m.id);
      const el = f ? elementsOf(f)[0] : undefined;
      el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    } else if (m.type === 'alone') {
      const f = fiberOf(m.id);
      if (f) void showAlone(describe(f)?.name ?? nameOfType(f.type), typeOf(f), { ...(f.memoizedProps ?? {}) }, providersOf(f), f);
    } else if (m.type === 'openAlone') void openAlone(m.file, m.name, m.props ?? {});
    else if (m.type === 'aloneProps' && alone) {
      // The changed JSON over the props it had (functions and elements stay).
      alone.props = { ...alone.base, ...(fromJson(m.props) as Record<string, unknown>) };
      draw();
    } else if (m.type === 'aloneFill' && alone) {
      alone.fill = !!m.fill;
      draw();
    } else if (m.type === 'leaveAlone') leaveAlone();
    else if (m.type === 'log') {
      const f = fiberOf(m.id);
      if (!f) return;
      const name = describe(f)?.name ?? 'Component';
      w.$r = f.stateNode && f.tag === CLASS ? f.stateNode : { props: f.memoizedProps, hooks: hooksOf(f), elements: elementsOf(f) };
      console.log(`${name} (also in $r):`, w.$r);
    } else if (m.type === 'setHook') setHook(m.id, m.index, m.value);
    else if (m.type === 'stores') void loadStores(Array.isArray(m.files) ? m.files : []);
    else if (m.type === 'route') say(route());
    else if (m.type === 'storage') void storage();
    else if (m.type === 'records') void records(m.db, m.store);
    else if (m.type === 'deleteRecord') void deleteRecord(m.db, m.store, m.key);
    else if (m.type === 'putRecord') void putRecord(m.db, m.store, m.value, m.key);
    else if (m.type === 'setKey') {
      try {
        if (m.area === 'local') localStorage.setItem(m.key, m.value);
        else if (m.area === 'session') sessionStorage.setItem(m.key, m.value);
        else if (m.area === 'cookies') document.cookie = `${encodeURIComponent(m.key)}=${encodeURIComponent(m.value)}; path=/`;
      } catch (e) {
        say({ type: 'storageError', text: e instanceof Error ? e.message : String(e) });
      }
      void storage();
    } else if (m.type === 'deleteKey') {
      if (m.area === 'local') localStorage.removeItem(m.key);
      else if (m.area === 'session') sessionStorage.removeItem(m.key);
      else if (m.area === 'cookies') document.cookie = `${encodeURIComponent(m.key)}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
      void storage();
    }
  });
  // Preview's picker: the picked element's component.
  ve.onPicked((el) => {
    const c = componentOf(el);
    if (!c) return;
    selected = c.id;
    say({ type: 'picked', ...c });
    say({ type: 'inspected', data: inspect(c.id) });
  });

  // Here: the panel may be waiting for this page.
  say({ type: 'ready' });
})();
