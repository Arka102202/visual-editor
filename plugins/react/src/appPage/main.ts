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
    } else if (m.type === 'log') {
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
