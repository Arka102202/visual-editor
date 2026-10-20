// The preview page, written into the project (.visual-editor/preview/) and served by its own dev server, so a
// component is drawn by the app's real build: its styles, its packages, its aliases. Its files:
//   index.html   the app's own index.html head (fonts, meta), with the preview as its body
//   guard.ts     loaded first: nothing leaves the page (requests, sockets, service workers…). Every value comes from
//                the data list, so nothing should try; whatever does is refused and reported.
//   preview.tsx  waits for the values (posted by the Preview window), then draws the root's static copy with them
//   static/…     the static copies of the tree's files (reader.ts)
// Pure text in, text out (plus reading the app's setup), so it can be tested.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { PREVIEW_DIR, type DrawSpec } from './reader';

export { PREVIEW_DIR };
const GENERATED = '// Written by Visual Editor (React plugin) for previews. Replaced when needed: do not edit.';

export interface AppSetup {
  /** The app's index.html, when it has one. */
  index?: string;
  /** Global stylesheets the app's entry imports, as addresses from the project's root (or package names). */
  css: string[];
  /** Wrappers library components need (a router for <Link>, React Flow's store for its parts). */
  providers: { router?: 'react-router-dom' | 'react-router'; reactFlow?: '@xyflow/react' | 'reactflow' };
}

const read = (p: string) => {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return undefined;
  }
};
const posix = (p: string) => p.split('\\').join('/');

/** How the app is set up: its index.html, the stylesheets its entry imports, and the wrappers its libraries need. */
export function appSetup(root: string): AppSetup {
  const index = read(join(root, 'index.html'));
  const entrySrc = index?.match(/<script[^>]*type="module"[^>]*src="\/?([^"]+)"/)?.[1];
  const entry = entrySrc ? join(root, entrySrc) : undefined;
  const entryText = entry && read(entry);
  const css: string[] = [];
  for (const m of entryText?.matchAll(/^\s*import\s+['"]([^'"]+\.css)['"]/gm) ?? []) {
    const spec = m[1];
    if (spec.startsWith('.')) {
      const file = resolve(dirname(entry!), spec);
      if (existsSync(file)) css.push(`/${posix(relative(root, file))}`);
    } else css.push(spec);
  }
  let deps: Record<string, string> = {};
  try {
    const pkg = JSON.parse(read(join(root, 'package.json')) ?? '{}') as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    deps = { ...pkg.dependencies, ...pkg.devDependencies };
  } catch {
    // no package.json
  }
  return {
    ...(index ? { index } : {}),
    css,
    providers: {
      router: deps['react-router-dom'] ? 'react-router-dom' : deps['react-router'] ? 'react-router' : undefined,
      reactFlow: deps['@xyflow/react'] ? '@xyflow/react' : deps.reactflow ? 'reactflow' : undefined,
    },
  };
}

/** The app's index.html (its <html> attributes, fonts and head, without its scripts), with the preview as its body. */
export function previewHtml(appIndex: string | undefined): string {
  const body = '<body>\n    <div id="root"></div>\n    <script type="module" src="./preview.tsx"></script>\n  </body>';
  if (!appIndex || !/<body[\s>]/i.test(appIndex)) {
    return `<!doctype html>\n<html lang="en">\n  <head>\n    <meta charset="UTF-8" />\n    <meta name="viewport" content="width=device-width, initial-scale=1.0" />\n    <title>Preview</title>\n  </head>\n  ${body}\n</html>\n`;
  }
  return appIndex
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<title>[\s\S]*?<\/title>/i, '<title>Preview</title>')
    .replace(/<body[\s\S]*<\/body>/i, body);
}

/** Loaded before anything else: nothing leaves the page. */
export const GUARD = `${GENERATED}
// Every value in the preview comes from the data list, so nothing needs the network. Whatever still tries (a
// request, a socket, a service worker, a beacon) is refused and reported to the Preview window.
const say = (m: Record<string, unknown>) => window.parent.postMessage({ source: 'visual-editor-preview', ...m }, '*')
/** The dev server's own files (modules, styles, pictures): always fine. */
const own = (u: URL) => u.origin === location.origin && (/^\\/(@|node_modules\\/|\\.visual-editor\\/)/.test(u.pathname) || /\\.[a-z0-9]{1,5}$/i.test(u.pathname))
const realFetch = window.fetch.bind(window)
window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = input instanceof Request ? input.url : String(input)
  const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
  const u = new URL(url, location.href)
  if (method === 'GET' && own(u)) return realFetch(input, init)
  say({ type: 'blocked', method, url: u.href })
  throw new TypeError('Blocked by the Visual Editor preview: ' + method + ' ' + u.href)
}
class PreviewXHR extends EventTarget {
  static UNSENT = 0; static OPENED = 1; static HEADERS_RECEIVED = 2; static LOADING = 3; static DONE = 4
  readyState = 0; status = 0; statusText = ''; response: unknown = null; responseText = ''; responseType = ''; responseURL = ''; timeout = 0; withCredentials = false
  upload = new EventTarget()
  private method = 'GET'; private url = ''
  open(method: string, url: string | URL) { this.method = method.toUpperCase(); this.url = String(url); this.readyState = 1 }
  setRequestHeader() {}
  overrideMimeType() {}
  abort() {}
  getResponseHeader() { return null }
  getAllResponseHeaders() { return '' }
  send() {
    say({ type: 'blocked', method: this.method, url: new URL(this.url, location.href).href })
    setTimeout(() => { this.readyState = 4; for (const t of ['readystatechange', 'error', 'loadend']) { const e = new Event(t); const on = (this as unknown as Record<string, unknown>)['on' + t]; if (typeof on === 'function') on.call(this, e); this.dispatchEvent(e) } })
  }
}
;(window as unknown as { XMLHttpRequest: unknown }).XMLHttpRequest = PreviewXHR
const RealSocket = window.WebSocket
const closed = (kind: string, url: string) => {
  say({ type: 'blocked', method: kind, url })
  const fake = Object.assign(new EventTarget(), { readyState: 3, url, send() {}, close() {} })
  setTimeout(() => { for (const t of ['error', 'close']) { const e = new Event(t); const on = (fake as unknown as Record<string, unknown>)['on' + t]; if (typeof on === 'function') on.call(fake, e); fake.dispatchEvent(e) } })
  return fake
}
// The dev server's own reload socket still connects.
function PreviewSocket(url: string | URL, protocols?: string | string[]) {
  if (String(protocols ?? '').includes('vite')) return new RealSocket(url, protocols)
  return closed('SOCKET', String(url))
}
Object.assign(PreviewSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 })
;(window as unknown as { WebSocket: unknown }).WebSocket = PreviewSocket
;(window as unknown as { EventSource: unknown }).EventSource = function (url: string) { return closed('EVENTS', String(url)) }
if (navigator.serviceWorker) {
  Object.defineProperty(navigator.serviceWorker, 'register', { value: (url: string | URL) => { say({ type: 'blocked', method: 'WORKER', url: String(url) }); return new Promise(() => {}) } })
}
if (navigator.sendBeacon) navigator.sendBeacon = (url: string | URL) => { say({ type: 'blocked', method: 'BEACON', url: String(url) }); return true }
export {}
`;

/** The page's runtime: waits for the values, then draws the root's static copy with them. */
export function previewTsx(s: AppSetup): string {
  const p = s.providers;
  return [
    GENERATED,
    `import './guard'`,
    `import { Component, type ReactNode } from 'react'`,
    `import { createRoot } from 'react-dom/client'`,
    ...s.css.map((c) => `import '${c}'`),
    ...(p.router ? [`import { MemoryRouter } from '${p.router}'`] : []),
    ...(p.reactFlow ? [p.reactFlow === '@xyflow/react' ? `import { ReactFlowProvider } from '@xyflow/react'` : `import { ReactFlowProvider } from 'reactflow'`] : []),
    ``,
    `const say = (m: Record<string, unknown>) => window.parent.postMessage({ source: 'visual-editor-preview', ...m }, '*')`,
    `const rootPath = new URLSearchParams(location.search).get('r') ?? ''`,
    `const rootExport = new URLSearchParams(location.search).get('e') ?? ''`,
    `// The full address, so the files load once (Vite treats a short dynamic address as another copy).`,
    `const load = (path: string) => import(/* @vite-ignore */ new URL('/' + path, location.origin).href) as Promise<Record<string, unknown>>`,
    `const show = (v: unknown) => { try { return (JSON.stringify(v, (_k, x) => (typeof x === 'function' ? 'ƒ' : x)) ?? String(v)).slice(0, 200) } catch { return String(v) } }`,
    `// A function in the data reports that it was called, e.g. "onOpen called with 1042".`,
    `const log = (name: string) => (...args: unknown[]) => say({ type: 'callback', name, args: args.map(show).join(', ') })`,
    `const revive = (v: unknown, name = ''): unknown => {`,
    `  if (Array.isArray(v)) return v.map((x) => revive(x, name))`,
    `  if (v && typeof v === 'object') {`,
    `    const o = v as Record<string, unknown>`,
    `    if (typeof o.__visualEditorCallback === 'string') return log(o.__visualEditorCallback)`,
    `    if (typeof o.__visualEditorDate === 'string') return new Date(o.__visualEditorDate)`,
    `    if (Array.isArray(o.__visualEditorSet)) return new Set(o.__visualEditorSet.map((x: unknown) => revive(x)))`,
    `    if (Array.isArray(o.__visualEditorMap)) return new Map(o.__visualEditorMap.map(([k, x]: [unknown, unknown]) => [revive(k), revive(x)]))`,
    `    return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, revive(x, k)]))`,
    `  }`,
    `  return v`,
    `}`,
    `// The values, made once per drawing (the same object every time a component asks, so nothing redraws for nothing).`,
    `let current = new Map<string, unknown>()`,
    `;(globalThis as unknown as { __veValue: (id: string) => unknown }).__veValue = (id: string) => current.get(id)`,
    `window.addEventListener('error', (e) => say({ type: 'error', message: String(e.message) }))`,
    `window.addEventListener('unhandledrejection', (e) => say({ type: 'error', message: String((e.reason as Error)?.message ?? e.reason) }))`,
    `function Problem({ text }: { text: string }) {`,
    `  return <pre style={{ color: '#ff5a5f', padding: 16, margin: 0, whiteSpace: 'pre-wrap', font: '12px/1.5 ui-monospace, monospace' }}>{text}</pre>`,
    `}`,
    `class Boundary extends Component<{ children: ReactNode }, { error: Error | null }> {`,
    `  state = { error: null as Error | null }`,
    `  static getDerivedStateFromError(error: Error) { return { error } }`,
    `  componentDidCatch(error: Error) {`,
    `    const at = /at (\\w+) \\([^)]*?\\/(src\\/[^?:)]+)/.exec(String(error?.stack ?? ''))`,
    `    say({ type: 'error', message: String(error?.message ?? error), ...(at ? { where: at[1] + ' (' + at[2] + ')' } : {}) })`,
    `  }`,
    `  render() { return this.state.error ? <Problem text={'It crashed while drawing: ' + String(this.state.error.message ?? this.state.error)} /> : this.props.children }`,
    `}`,
    `const root = createRoot(document.getElementById('root')!)`,
    `let Root: ((props: Record<string, unknown>) => ReactNode) | undefined`,
    `let round = 0`,
    `async function draw(values: Record<string, unknown>, theme: 'light' | 'dark') {`,
    `  // Light or dark the common ways apps read it: a data attribute, Tailwind's "dark" class, the colour scheme.`,
    `  document.documentElement.setAttribute('data-theme', theme)`,
    `  document.documentElement.classList.toggle('dark', theme === 'dark')`,
    `  document.documentElement.style.colorScheme = theme`,
    `  current = new Map(Object.entries(values).map(([k, v]) => [k, revive(v, k.slice(k.lastIndexOf('|') + 1))]))`,
    `  try {`,
    `    Root ??= (await load(rootPath))[rootExport] as typeof Root`,
    `  } catch (e) {`,
    `    const text = 'Couldn’t load the component: ' + String((e as Error)?.message ?? e)`,
    `    say({ type: 'error', message: text })`,
    `    root.render(<Problem text={text} />)`,
    `    return`,
    `  }`,
    `  const props: Record<string, unknown> = {}`,
    `  for (const [k, v] of current) if (k.startsWith('prop:')) props[k.slice(5)] = v`,
    `  const R = Root!`,
    `  // Drawn afresh for new values (their own state starts again too).`,
    `  round++`,
    `  let tree: ReactNode = <R key={round} {...props} />`,
    ...(p.router ? [`  tree = <MemoryRouter>{tree}</MemoryRouter>`] : []),
    ...(p.reactFlow ? [`  tree = <ReactFlowProvider>{tree}</ReactFlowProvider>`] : []),
    `  root.render(<Boundary key={round}>{tree}</Boundary>)`,
    `  requestAnimationFrame(() => say({ type: 'drawn' }))`,
    `}`,
    `window.addEventListener('message', (e: MessageEvent) => {`,
    `  const m = e.data as { source?: string; type?: string; values?: Record<string, unknown>; theme?: 'light' | 'dark' }`,
    `  if (m?.source !== 'visual-editor' || m.type !== 'draw') return`,
    `  void draw(m.values ?? {}, m.theme ?? 'dark')`,
    `})`,
    `say({ type: 'ready' })`,
    ``,
  ].join('\n');
}

/** Writes a file only when its text changed (an unchanged file mustn't make the dev server reload the page). */
export function writeIfChanged(path: string, text: string) {
  if (read(path) === text) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

/** Writes the page and a root's static copies into the project; returns the page's address (from the server's root). */
export function writePage(root: string, spec: DrawSpec): string {
  const dir = join(root, PREVIEW_DIR);
  const setup = appSetup(root);
  // Nothing in the preview folder belongs in the project's history.
  writeIfChanged(join(dir, '.gitignore'), '*\n');
  writeIfChanged(join(dir, 'index.html'), previewHtml(setup.index));
  writeIfChanged(join(dir, 'guard.ts'), GUARD);
  writeIfChanged(join(dir, 'preview.tsx'), previewTsx(setup));
  // A file only a server running the app's React setup turns into JavaScript (how a running server is checked).
  writeIfChanged(join(dir, 'check.tsx'), `${GENERATED}\nexport const check = <div />\n`);
  for (const f of spec.files) writeIfChanged(join(root, f.path), f.text);
  return `/${PREVIEW_DIR}/index.html?r=${encodeURIComponent(spec.root)}&e=${encodeURIComponent(spec.exportName)}`;
}
