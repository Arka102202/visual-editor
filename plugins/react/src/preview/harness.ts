// The preview page, written into the project (`.visual-editor/preview/`) and served by its own dev server, so
// components are drawn by the app's real build: its styles, its packages, its aliases. One page shows any component:
// which one, in which situation and theme, comes in the address. Example props are made up from each prop's name and
// type. Pure text in, text out (plus reading the app's setup), so it can be tested.
// Adapted from No-Code Map's Playground.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import type { FeComponent, PropInfo } from '../read/model';

export const PREVIEW_DIR = '.visual-editor/preview';
export const GENERATED = '// Written by Visual Editor (React plugin) for previews. Replaced when needed: do not edit.';

/** A grey picture with a soft shape, as a data address: works offline and in any <img>. */
export const PLACEHOLDER_IMAGE =
  "data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='800' height='450' viewBox='0 0 800 450'%3E%3Crect width='800' height='450' fill='%23cbd5e1'/%3E%3Ccircle cx='290' cy='170' r='60' fill='%2394a3b8'/%3E%3Cpath d='M0 450 L260 260 L420 380 L560 240 L800 450 Z' fill='%2364748b'/%3E%3C/svg%3E";

/** Marks a callback prop in the example props (JSON): the page turns it into a function that reports its calls. */
export const CALLBACK = '__visualEditorCallback';

export interface AppSetup {
  /** The app's index.html, when it has one (its <head>: fonts, meta). */
  index?: string;
  /** Global stylesheets the app's entry imports, as import paths from the preview folder (or package names). */
  css: string[];
  /** Wrappers the app's components expect. */
  providers: { reactQuery: boolean; router?: 'react-router-dom' | 'react-router'; reactFlow?: '@xyflow/react' | 'reactflow' };
}

const read = (p: string) => {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return undefined;
  }
};
const posix = (p: string) => p.split('\\').join('/');

/** How the app is set up: its index.html, the stylesheets its entry imports, and the providers its packages need. */
export function appSetup(root: string): AppSetup {
  const index = read(join(root, 'index.html'));
  const entrySrc = index?.match(/<script[^>]*type="module"[^>]*src="\/?([^"]+)"/)?.[1];
  const entry = entrySrc ? join(root, entrySrc) : undefined;
  const entryText = entry && read(entry);
  const from = join(root, PREVIEW_DIR);
  const css: string[] = [];
  for (const m of entryText?.matchAll(/^\s*import\s+['"]([^'"]+\.css)['"]/gm) ?? []) {
    const spec = m[1];
    if (spec.startsWith('.')) {
      const file = resolve(dirname(entry!), spec);
      if (existsSync(file)) css.push(posix(relative(from, file)));
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
      reactQuery: !!deps['@tanstack/react-query'],
      router: deps['react-router-dom'] ? 'react-router-dom' : deps['react-router'] ? 'react-router' : undefined,
      reactFlow: deps['@xyflow/react'] ? '@xyflow/react' : deps.reactflow ? 'reactflow' : undefined,
    },
  };
}

/** The app's index.html (its <html> attributes, fonts and head), with the body replaced by the preview. */
export function previewHtml(appIndex: string | undefined): string {
  const body = '<body>\n    <div id="root"></div>\n    <script type="module" src="./preview.tsx"></script>\n  </body>';
  if (!appIndex || !/<body[\s>]/i.test(appIndex)) {
    return `<!doctype html>\n<html lang="en">\n  <head>\n    <meta charset="UTF-8" />\n    <meta name="viewport" content="width=device-width, initial-scale=1.0" />\n    <title>Preview</title>\n  </head>\n  ${body}\n</html>\n`;
  }
  return appIndex.replace(/<title>[\s\S]*?<\/title>/i, '<title>Preview</title>').replace(/<body[\s\S]*<\/body>/i, body);
}

/**
 * The preview script. It reads which component to show from the address (`?c=<card>&s=<situation>&theme=<theme>`),
 * loads that card's description (`cards/<card>.json`: file, export, example props, route), puts the situation's fake
 * replies in front of fetch, axios and React Query, wraps the component in the app's providers and draws it.
 */
export function previewTsx(s: AppSetup): string {
  const p = s.providers;
  return [
    GENERATED,
    `import { Component, type ReactNode } from 'react'`,
    `import { createRoot } from 'react-dom/client'`,
    ...s.css.map((c) => `import '${c}'`),
    ...(p.reactQuery ? [`import { QueryClient, QueryClientProvider } from '@tanstack/react-query'`] : []),
    ...(p.router ? [`import { MemoryRouter, Routes, Route } from '${p.router}'`] : []),
    ...(p.reactFlow ? [`import { ReactFlowProvider } from '${p.reactFlow}'`] : []),
    `import { installSituations } from './situations.js'`,
    ``,
    `const params = new URLSearchParams(location.search)`,
    `const card = params.get('c') ?? ''`,
    `const situation = params.get('s') ?? 'normal'`,
    `const theme = params.get('theme') === 'light' ? 'light' : 'dark'`,
    `// Light or dark the common ways apps read it: a data attribute, Tailwind's "dark" class, and the colour scheme.`,
    `document.documentElement.setAttribute('data-theme', theme)`,
    `document.documentElement.classList.toggle('dark', theme === 'dark')`,
    `document.documentElement.style.colorScheme = theme`,
    `const say = (m: Record<string, unknown>) => window.parent.postMessage({ source: 'visual-editor-preview', card, situation, ...m }, '*')`,
    `window.addEventListener('error', (e) => say({ type: 'error', message: String(e.message) }))`,
    `const show = (v: unknown) => { try { return (JSON.stringify(v, (_k, x) => (typeof x === 'function' ? 'ƒ' : x)) ?? String(v)).slice(0, 200) } catch { return String(v) } }`,
    `// A callback prop reports that it was called, e.g. "onOpen called with 1042".`,
    `const log = (name: string) => (...args: unknown[]) => say({ type: 'callback', name, args: args.map(show).join(', ') })`,
    `const revive = (v: unknown): unknown => {`,
    `  if (Array.isArray(v)) return v.map(revive)`,
    `  if (v && typeof v === 'object') {`,
    `    const o = v as Record<string, unknown>`,
    `    if (typeof o.${CALLBACK} === 'string') return log(o.${CALLBACK})`,
    `    return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, revive(x)]))`,
    `  }`,
    `  return v`,
    `}`,
    ``,
    `function Problem({ text }: { text: string }) {`,
    `  return <pre style={{ color: '#ff5a5f', background: '#1e1f22', padding: 14, margin: 0, whiteSpace: 'pre-wrap', font: '12px/1.5 ui-monospace, monospace', minHeight: '100vh', boxSizing: 'border-box' }}>{text}</pre>`,
    `}`,
    `// A crash in plain words: what failed, in which situation, and in which component and file (not a stack dump).`,
    `const SITUATION_WORDS: Record<string, string> = { normal: 'with normal data', loading: 'while loading', empty: 'when there is no data', error: 'when the server fails', long: 'with long text', live: 'with your live backend' }`,
    `function explain(error: Error) {`,
    `  const at = /at (\\w+) \\([^)]*?\\/(src\\/[^?:)]+)/.exec(String(error.stack ?? ''))`,
    `  const where = at ? '\\n\\nWhere: ' + at[1] + ' (' + at[2] + ')' : ''`,
    `  const advice = situation === 'normal' ? '' : '\\n\\nThe real app would do the same ' + (SITUATION_WORDS[situation] ?? 'in this situation') + ': this is worth fixing (check for missing data before using it).'`,
    `  return 'This component crashes ' + (SITUATION_WORDS[situation] ?? '') + '.\\n\\n' + String(error.message ?? error) + where + advice`,
    `}`,
    `class Boundary extends Component<{ children: ReactNode }, { error: Error | null }> {`,
    `  state = { error: null as Error | null }`,
    `  static getDerivedStateFromError(error: Error) { return { error } }`,
    `  componentDidCatch(error: Error) { say({ type: 'error', message: String(error?.message ?? error) }) }`,
    `  render() { return this.state.error ? <Problem text={explain(this.state.error)} /> : this.props.children }`,
    `}`,
    ...(p.reactQuery ? [`const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })`] : []),
    `const Wrap = ({ children, route }: { children: ReactNode; route?: string }) => {`,
    `  let out = <>{children}</>`,
    ...(p.reactFlow ? [`  out = <ReactFlowProvider>{out}</ReactFlowProvider>`] : []),
    ...(p.router
      ? [
          `  // A page is shown at its own address (with example values), so useParams and links work.`,
          `  const at = route && route.startsWith('/') ? route : '/'`,
          `  const address = at.replace(/:(\\w+)/g, 'example').replace(/\\*\\w*$/, '')`,
          `  out = <MemoryRouter initialEntries={[address]}><Routes><Route path={route && route.startsWith('/') ? route : '*'} element={out} /></Routes></MemoryRouter>`,
        ]
      : []),
    ...(p.reactQuery ? [`  out = <QueryClientProvider client={client}>{out}</QueryClientProvider>`] : []),
    `  return out`,
    `}`,
    ``,
    `/** Requests that stay on this computer: the only ones a dev token is ever added to. */`,
    `const local = (address: string) => { try { const u = new URL(address, location.href); return u.origin === location.origin || ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname) || u.hostname.endsWith('.localhost') } catch { return false } }`,
    `/**`,
    ` * Live backend: adds the developer's dev token (from the address's #fragment, never written anywhere) to requests`,
    ` * that stay on this computer, records successful data replies (data only) for "normal" to use later, and offers to`,
    ` * log in when the backend asks for it.`,
    ` */`,
    `function goLive(loginPath?: string) {`,
    `  const token = new URLSearchParams(location.hash.slice(1)).get('token')`,
    `  const realFetch = window.fetch.bind(window)`,
    `  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {`,
    `    const address = typeof input === 'string' ? input : input instanceof URL ? String(input) : input.url`,
    `    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))`,
    `    if (token && local(address) && !headers.has('Authorization')) headers.set('Authorization', 'Bearer ' + token)`,
    `    const res = await realFetch(input, { ...init, headers })`,
    `    heardBack(address, (init?.method ?? 'GET').toUpperCase(), res.status, res.headers.get('content-type'), () => res.clone().json())`,
    `    return res`,
    `  }`,
    `  const open = XMLHttpRequest.prototype.open`,
    `  const send = XMLHttpRequest.prototype.send`,
    `  XMLHttpRequest.prototype.open = function (this: XMLHttpRequest & { _ve?: [string, string] }, method: string, address: string | URL, ...rest: unknown[]) {`,
    `    this._ve = [String(method).toUpperCase(), String(address)]`,
    `    return (open as (...a: unknown[]) => void).call(this, method, address, ...rest)`,
    `  }`,
    `  XMLHttpRequest.prototype.send = function (this: XMLHttpRequest & { _ve?: [string, string] }, body?: Document | XMLHttpRequestBodyInit | null) {`,
    `    const [method, address] = this._ve ?? ['GET', '']`,
    `    if (token && local(address)) { try { this.setRequestHeader('Authorization', 'Bearer ' + token) } catch { /* already set */ } }`,
    `    this.addEventListener('load', () => heardBack(address, method, this.status, this.getResponseHeader('content-type'), async () => JSON.parse(this.responseText)))`,
    `    return send.call(this, body)`,
    `  }`,
    `  let asked = false`,
    `  function heardBack(address: string, method: string, status: number, type: string | null, json: () => Promise<unknown>) {`,
    `    if ((status === 401 || status === 403) && !asked) { asked = true; askLogin(loginPath) }`,
    `    if (method !== 'GET' || status < 200 || status >= 300 || !(type ?? '').includes('json') || !local(address)) return`,
    `    json().then((reply) => say({ type: 'recorded', address, reply })).catch(() => {})`,
    `  }`,
    `}`,
    `/** The backend asked for a login: offer to log in here, with the app's own login page, inside the preview. */`,
    `function askLogin(loginPath?: string) {`,
    `  say({ type: 'needs-login' })`,
    `  const bar = document.createElement('div')`,
    `  Object.assign(bar.style, { position: 'fixed', top: '0', left: '0', right: '0', zIndex: '2147483647', padding: '10px 14px', background: '#ff9e8a', color: '#1e1f22', font: '13px/1.4 system-ui, sans-serif', display: 'flex', gap: '10px', alignItems: 'center' })`,
    `  bar.textContent = 'Your dev backend asked for a login, so real data is not shown yet. '`,
    `  const go = document.createElement('button')`,
    `  go.textContent = 'Log in here'`,
    `  Object.assign(go.style, { font: 'inherit', fontWeight: '600', padding: '4px 10px', borderRadius: '6px', border: '0', cursor: 'pointer' })`,
    `  go.onclick = () => { location.href = loginPath && loginPath.startsWith('/') ? loginPath : '/' }`,
    `  const after = document.createElement('span')`,
    `  after.textContent = 'Then click Reload at the top. (Your login stays in this preview only.)'`,
    `  bar.append(go, after)`,
    `  document.body.append(bar)`,
    `}`,
    ``,
    `const rootEl = document.getElementById('root')!`,
    `async function main() {`,
    `  const res = await fetch('./cards/' + encodeURIComponent(card) + '.json?t=' + Date.now())`,
    `  if (!res.ok) throw new Error('This preview is out of date. Reload it.')`,
    `  const c = (await res.json()) as { path: string; export: string; props: unknown; route?: string; seed?: { module: string; export: string; tables: Record<string, unknown[]> }; requests?: { match: string; reply: unknown }[]; login?: string }`,
    `  // Stand-in data: the app's own browser database (Dexie) gets example rows first ("empty": none).`,
    `  // Only ever at the preview's own address (an IP), never at localhost where the app itself keeps its real data.`,
    `  if (c.seed && location.hostname !== 'localhost') {`,
    `    const seed = c.seed`,
    `    const fill = async () => {`,
    `      // eslint-disable-next-line @typescript-eslint/no-explicit-any`,
    `      const m = (await import(/* @vite-ignore */ '/' + seed.module)) as Record<string, any>`,
    `      const db = m[seed.export] ?? m.default`,
    `      if (!db?.open || !db?.table) return 'skipped'`,
    `      await db.open()`,
    `      for (const [name, rows] of Object.entries(seed.tables)) {`,
    `        const table = db.table(name)`,
    `        await table.clear()`,
    `        if (situation !== 'empty' && rows.length) await table.bulkPut(rows).catch((e: unknown) => console.warn('Visual Editor: example rows for ' + name + ' were not accepted', e))`,
    `      }`,
    `      return 'filled'`,
    `    }`,
    `    // Never a blank page: if the database doesn't answer in time, draw without example data and say so.`,
    `    const outcome = await Promise.race([fill().catch((e) => 'failed: ' + String(e?.message ?? e)), new Promise<string>((r) => setTimeout(() => r('timed out'), 4000))])`,
    `    say({ type: 'seed', outcome })`,
    `    if (outcome !== 'filled') console.warn('Visual Editor: example data could not be prepared (' + outcome + ')')`,
    `  }`,
    `  // "Normal" answers the requests the code makes with example replies (recorded real ones first, else worked out`,
    `  // from how the code uses them). "Live": nothing is made up; requests go to the developer's own dev backend.`,
    `  const props = situation === 'live'`,
    `    ? (goLive(c.login), revive(c.props) as Record<string, unknown>)`,
    `    : installSituations({ id: situation, fixtures: { props: () => revive(c.props), situations: { normal: { requests: c.requests ?? [] } } }, log, win: window${p.reactQuery ? ', QueryClient' : ''} }).props`,
    `  // eslint-disable-next-line @typescript-eslint/no-explicit-any`,
    `  const mod = (await import(/* @vite-ignore */ '/' + c.path)) as Record<string, any>`,
    `  const View = mod[c.export] ?? mod.default`,
    `  if (typeof View !== 'function' && typeof View !== 'object') throw new Error(c.export + ' is not exported from ' + c.path + ', so it cannot be shown on its own.')`,
    `  // A page fills the frame; a single component gets some room around it.`,
    `  if (!c.route) rootEl.style.padding = '24px'`,
    `  createRoot(rootEl).render(<Boundary><Wrap route={c.route}><View {...(props as object)} /></Wrap></Boundary>)`,
    `  say({ type: 'ready' })`,
    `  // What's on screen once data has arrived (for checks and for assistants): its visible text.`,
    `  setTimeout(() => say({ type: 'text', text: (rootEl.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 400) }), 1500)`,
    `}`,
    `main().catch((e) => {`,
    `  say({ type: 'error', message: String(e?.message ?? e) })`,
    `  createRoot(rootEl).render(<Problem text={String(e?.message ?? e)} />)`,
    `})`,
    ``,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Example props, made up from each prop's name and type
// ---------------------------------------------------------------------------

/** The fields of a TypeScript type by name, found in the project's files. */
export type TypeFields = (typeName: string) => { name: string; type: string; optional: boolean }[] | undefined;

/** Reads `interface X { a: string; b?: number }` / `type X = { … }` from source text (simple, flat types). */
export function fieldsOfType(text: string, typeName: string): { name: string; type: string; optional: boolean }[] | undefined {
  const m = new RegExp(`(?:interface\\s+${typeName}\\b[^{]*|type\\s+${typeName}\\s*=\\s*)\\{`).exec(text);
  if (!m) return undefined;
  let depth = 1;
  let i = m.index + m[0].length;
  const start = i;
  for (; i < text.length && depth; i++) depth += text[i] === '{' ? 1 : text[i] === '}' ? -1 : 0;
  const body = text.slice(start, i - 1);
  const out: { name: string; type: string; optional: boolean }[] = [];
  let level = 0;
  let line = '';
  const take = () => {
    const f = /^\s*(?:readonly\s+)?([A-Za-z_$][\w$]*)(\?)?\s*:\s*(.+?)\s*$/.exec(line);
    if (f) out.push({ name: f[1], optional: !!f[2], type: f[3] });
    line = '';
  };
  for (const ch of body) {
    if (ch === '{') level++;
    if (ch === '}') level--;
    if ((ch === '\n' || ch === ';' || ch === ',') && level === 0) take();
    else line += ch;
  }
  take();
  return out.length ? out : undefined;
}

/** Example props for a component: a realistic value for each prop; callbacks report when they're called. */
export function exampleProps(c: FeComponent, types: TypeFields = () => undefined): Record<string, unknown> {
  return Object.fromEntries(c.props.filter((p) => p.name !== '...').map((p: PropInfo) => [p.name, p.isCallback ? { [CALLBACK]: p.name } : sample(p.name, p.type, 0, types)]));
}

/** A realistic value for a prop or field, from its type and name. */
export function sample(name: string, type: string | undefined, depth: number, types: TypeFields = () => undefined): unknown {
  const n = name.toLowerCase();
  const t = (type ?? '').replace(/\s+/g, '');
  const bare = t.replace(/\|null|\|undefined|\?/g, '');
  if (/=>/.test(t)) return { [CALLBACK]: name };
  if (/\[\]$|^Array</.test(t) || n.endsWith('list') || (n.endsWith('s') && /items|children|rows|list/.test(n))) {
    const inner = t.replace(/\[\]$/, '').replace(/^Array<(.*)>$/, '$1');
    const one = inner && inner !== t ? sample(name.replace(/s$/, ''), inner, depth + 1, types) : undefined;
    return one !== undefined && depth < 2 && !(one && typeof one === 'object' && !Object.keys(one).length) ? [one, one] : [];
  }
  if (/ReactNode|ReactElement|JSX\.Element/.test(t) || n === 'children') return 'Example content';
  // An inline shape: { x: number; y: number }.
  if (t.startsWith('{') && t.endsWith('}') && depth < 3) {
    const fields = fieldsOfType(`type Inline = ${type}`, 'Inline');
    if (fields) return Object.fromEntries(fields.map((f) => [f.name, sample(f.name, f.type, depth + 1, types)]));
  }
  const shape = depth < 2 && /^[A-Z]\w*$/.test(bare) ? types(bare) : undefined;
  if (shape) return Object.fromEntries(shape.map((f) => [f.name, sample(f.name, f.type, depth + 1, types)]));
  if (/^(number|bigint)/.test(t)) return numberFor(n);
  if (/^boolean/.test(t)) return /^(is|has|show|can)?(open|visible|enabled|active)$/.test(n);
  if (/^'([^']*)'/.test(t)) return t.match(/^'([^']*)'/)![1];
  if (/^Date/.test(t)) return new Date().toISOString();
  if (!t || /^string/.test(t)) return stringFor(n);
  return {};
}

function numberFor(n: string): number {
  if (/(at|date|time|timestamp)$/.test(n)) return Date.now() - 3_600_000;
  if (/price|amount|total|cost|revenue|sales|income|spend|budget|balance|subtotal/.test(n)) return 1299;
  if (/^(number|num|no)$/.test(n)) return 1042;
  if (/count|qty|quantity|size|length/.test(n)) return 12;
  if (/age/.test(n)) return 34;
  if (/id$/.test(n)) return 1042;
  return 42;
}

function stringFor(n: string): string {
  // Text fields that usually hold JSON (data, config, payload…): valid JSON, so the app can read them back.
  if (/^(data|json|payload|config|settings|meta|metadata|snapshot|value|state)$/.test(n)) return '{}';
  if (n === 'id' || n.endsWith('id')) return 'id-1042';
  if (/email/.test(n)) return 'ada@example.com';
  if (/(^|_)(name|title|label|heading)$/.test(n) || n === 'name' || n === 'title') return 'Order dashboard';
  if (/desc|summary|subtitle|bio|text|content|message|body/.test(n)) return 'A short description, long enough to wrap onto a second line in narrow cards.';
  if (/colou?r|accent/.test(n)) return '#6366f1';
  if (/avatar|image|img|src|photo|picture|cover|thumbnail|logo/.test(n)) return PLACEHOLDER_IMAGE;
  if (/url|link|href/.test(n)) return '/';
  if (/status|state/.test(n)) return 'active';
  if (/(at|date|time)$/.test(n)) return new Date().toISOString();
  if (/phone/.test(n)) return '+1 555 0100';
  return `Example ${n}`;
}
