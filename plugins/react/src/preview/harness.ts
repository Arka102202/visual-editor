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
  /** The app's entry file (relative to the project), from its index.html. */
  entry?: string;
  /** The app's index.html, when it has one (its <head>: fonts, meta). */
  index?: string;
  /** Global stylesheets the app's entry imports, as import paths from the preview folder (or package names). */
  css: string[];
  /** Wrappers the app's components expect. */
  providers: { reactQuery: boolean; router?: 'react-router-dom' | 'react-router'; reactFlow?: '@xyflow/react' | 'reactflow'; jotai?: boolean; localforage?: boolean; idbKeyval?: boolean };
  /** The app's entry puts its router among its own providers (the preview passes its router in there). */
  appHasRouter?: boolean;
  /** The app component (App.tsx) puts its router among its own providers (the preview passes its router in there). */
  shellHasRouter?: boolean;
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
    ...(entrySrc ? { entry: entrySrc } : {}),
    css,
    providers: {
      reactQuery: !!deps['@tanstack/react-query'],
      router: deps['react-router-dom'] ? 'react-router-dom' : deps['react-router'] ? 'react-router' : undefined,
      reactFlow: deps['@xyflow/react'] ? '@xyflow/react' : deps.reactflow ? 'reactflow' : undefined,
      jotai: !!deps.jotai,
      localforage: !!deps.localforage,
      idbKeyval: !!deps['idb-keyval'],
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
    `import { Component, useEffect, type ReactNode } from 'react'`,
    `import { createRoot } from 'react-dom/client'`,
    ...s.css.map((c) => `import '${c}'`),
    ...(p.reactQuery ? [`import { QueryClient, QueryClientProvider } from '@tanstack/react-query'`] : []),
    ...(p.router ? [`import { MemoryRouter, Routes, Route, useLocation } from '${p.router}'`] : []),
    ...(p.reactFlow ? [p.reactFlow === '@xyflow/react' ? `import { ReactFlowProvider, ReactFlow } from '@xyflow/react'` : `import ReactFlow, { ReactFlowProvider } from 'reactflow'`] : []),
    ...(p.jotai ? [`import { getDefaultStore } from 'jotai'`] : []),
    ...(p.localforage ? [`import localforage from 'localforage'`] : []),
    ...(p.idbKeyval ? [`import { set as keyvalSet, del as keyvalDel } from 'idb-keyval'`] : []),
    `import { installSituations } from './situations.js'`,
    `import { AppProviders } from './app-providers'`,
    `import { AppShell, HAS_SHELL } from './app-shell'`,
    ``,
    `// CAPTCHAs (Turnstile, reCAPTCHA, hCaptcha) look solved: their scripts can't load at the preview's address.`,
    `const solved = (name: string) => ({`,
    `  render: (el: HTMLElement | string, o?: { callback?: (t: string) => void }) => { const box = typeof el === 'string' ? document.querySelector(el) : el; if (box instanceof HTMLElement) box.innerHTML = '<div style="font:12px system-ui;padding:8px 10px;border:1px dashed #8888;border-radius:6px;display:inline-block">' + name + ' · solved in the preview</div>'; setTimeout(() => o?.callback?.('preview-captcha-token'), 50); return 'preview' },`,
    `  execute: () => Promise.resolve('preview-captcha-token'), ready: (fn: () => void) => fn(), reset: () => {}, getResponse: () => 'preview-captcha-token', remove: () => {},`,
    `})`,
    `for (const [key, name] of [['turnstile', 'CAPTCHA (Turnstile)'], ['grecaptcha', 'CAPTCHA (reCAPTCHA)'], ['hcaptcha', 'CAPTCHA (hCaptcha)']] as const) Object.defineProperty(window, key, { value: solved(name), writable: false })`,
    `const params = new URLSearchParams(location.search)`,
    `const card = params.get('c') ?? ''`,
    `// "role=admin", "plan=pro": normal data, with that field set to that value everywhere.`,
    `const asked = params.get('s') ?? 'normal'`,
    `const override = asked.includes('=') ? (asked.split('=') as [string, string]) : undefined`,
    `const situation = override ? 'normal' : asked`,
    `const APP_HAS_ROUTER = ${s.appHasRouter ? 'true' : 'false'}`,
    `const SHELL_HAS_ROUTER = ${s.shellHasRouter ? 'true' : 'false'}`,
    `const setEverywhere = (v: unknown): unknown => {`,
    `  if (!override) return v`,
    `  if (Array.isArray(v)) return v.map(setEverywhere)`,
    `  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, k === override[0] ? (typeof x === 'number' ? Number(override[1]) : override[1]) : setEverywhere(x)]))`,
    `  return v`,
    `}`,
    `/**`,
    ` * Loads one of the app's files by its full address. Vite adds "?import" to dynamic imports of short addresses,`,
    ` * which would load a second copy of the file (its own store, its own context) apart from the one the app uses.`,
    ` */`,
    `// eslint-disable-next-line @typescript-eslint/no-explicit-any`,
    `const load = (path: string) => import(/* @vite-ignore */ new URL('/' + path, location.origin).href) as Promise<Record<string, any>>`,
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
    `const SITUATION_WORDS: Record<string, string> = { normal: 'with normal data', loading: 'while loading', empty: 'when there is no data', error: 'when the server fails', long: 'with long text', live: 'with your live backend', loggedOut: 'when logged out', expired: 'when the session has expired' }`,
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
    `/** Shown when the page sends you somewhere else (a login page, home): where, in plain words. */`,
    `function Redirected() {`,
    ...(p.router ? [`  const to = useLocation().pathname`] : [`  const to = location.pathname`]),
    `  useEffect(() => say({ type: 'redirected', to }), [to])`,
    `  return <Problem text={'This page sent you to ' + to + (situation === 'loggedOut' || situation === 'expired' ? ' (not logged in).' : '.') + '\\n\\nIt usually means it needs a login, a role or some data it did not get. The other situations show it logged in.'} />`,
    `}`,
    ...(p.reactQuery ? [`const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })`] : []),
    `// The app's frame around the component: the entry's providers (main.tsx), then the app component's (App.tsx);`,
    `// the preview's router goes where the app had its own. The app itself ("app") is drawn whole.`,
    `const Wrap = ({ children, route, app }: { children: ReactNode; route?: string; app?: boolean }) => {`,
    ...(p.router
      ? [
          `  // A page is shown at its own address (with example values), so useParams and links work; any other address`,
          `  // it goes to (a redirect) says so.`,
          `  const path = route && route.startsWith('/') ? route : '/'`,
          `  const address = path.replace(/:(\\w+)/g, 'example').replace(/\\*\\w*$/, '')`,
          `  const Routed = ({ children: c }: { children: ReactNode }) => <MemoryRouter initialEntries={[address]}><Routes><Route path={path} element={c} /><Route path="*" element={<Redirected />} /></Routes></MemoryRouter>`,
        ]
      : [`  const Routed = ({ children: c }: { children: ReactNode }) => <>{c}</>`]),
    `  const shellRouter = SHELL_HAS_ROUTER ? Routed : undefined`,
    `  let out = app && HAS_SHELL ? <AppShell whole Router={shellRouter} /> : <>{children}</>`,
    ...(p.reactQuery ? [`  out = <QueryClientProvider client={client}>{out}</QueryClientProvider>`] : []),
    ...(p.reactFlow ? [`  out = <ReactFlowProvider>{out}</ReactFlowProvider>`] : []),
    `  if (HAS_SHELL && !app) out = <AppShell Router={shellRouter}>{out}</AppShell>`,
    `  if (APP_HAS_ROUTER) return <AppProviders Router={Routed}>{out}</AppProviders>`,
    `  return SHELL_HAS_ROUTER ? <AppProviders>{out}</AppProviders> : <AppProviders><Routed>{out}</Routed></AppProviders>`,
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
    `// The app's stores: the state the app starts with, its empty parts (no user, an empty cart) filled with example`,
    `// data from the store's type. Logged out: no user, not signed in. Empty: as the app starts it.`,
    `const AUTHY = /^(user|currentUser|me|session|token|accessToken|refreshToken|auth|profile|account|viewer)$/`,
    `const SIGNED_IN = /^(is)?(authenticated|loggedIn|signedIn|authed|authorized)$/i`,
    `/** Store switches that show a modal or dialog: on when the card is one (set from the card). */`,
    `const OPEN_SWITCH = /^(is)?(open|opened|visible|shown|show|active)$/i`,
    `let opensDialog = false`,
    `const loggedOut = situation === 'loggedOut' || situation === 'expired'`,
    `const isPlain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype`,
    `const emptyValue = (v: unknown) => v == null || v === '' || (Array.isArray(v) && !v.length)`,
    `/** The app's value with its empty parts filled from the example; new objects only where something changed. */`,
    `const filled = (cur: unknown, ex: unknown, depth = 0): unknown => {`,
    `  if (!isPlain(cur) || !isPlain(ex) || depth > 6) return emptyValue(cur) && ex !== undefined ? ex : cur`,
    `  let out = cur`,
    `  for (const [k, x] of Object.entries(ex)) {`,
    `    const v = cur[k]`,
    `    if (typeof v === 'function') continue`,
    `    const next = loggedOut && AUTHY.test(k) ? v : SIGNED_IN.test(k) && typeof v === 'boolean' ? !loggedOut : opensDialog && OPEN_SWITCH.test(k) && v === false ? true : filled(v, x, depth + 1)`,
    `    if (next !== v) { if (out === cur) out = { ...cur }; (out as Record<string, unknown>)[k] = next }`,
    `  }`,
    `  return out`,
    `}`,
    `const nounOf = (name: string) => { const b = name.replace(/^use(?=[A-Z])/, '').replace(/(Store|Atom|State|Slice)$/, ''); return b ? b[0].toLowerCase() + b.slice(1) : name }`,
    `/** "Empty": like the API replies, the same data with every list emptied (still logged in, nothing in it). */`,
    `const noLists = (v: unknown, depth = 0): unknown => Array.isArray(v) ? (v.length ? [] : v) : isPlain(v) && depth < 6 ? (() => { let out = v; for (const [k, x] of Object.entries(v)) { const n = noLists(x, depth + 1); if (n !== x) { if (out === v) out = { ...v }; (out as Record<string, unknown>)[k] = n } } return out })() : v`,
    `const fillStore = (cur: unknown, ex: unknown, name: string) => { const f = loggedOut && AUTHY.test(nounOf(name)) ? cur : filled(cur, ex); return situation === 'empty' ? noLists(f) : f }`,
    `type StoreSeed = { kind: 'zustand' | 'redux' | 'jotai' | 'valtio' | 'supabase' | 'firebaseAuth'; module: string; export: string; example: unknown }`,
    `/** Login clients (Supabase, Firebase): asked who is logged in, they answer with the example person, or nobody when logged out. */`,
    `// eslint-disable-next-line @typescript-eslint/no-explicit-any`,
    `function stubLogin(kind: 'supabase' | 'firebaseAuth', client: any, person: { id: string; name: string; email: string } & Record<string, unknown>) {`,
    `  const signedIn = !loggedOut`,
    `  const said = (name: string) => async () => { say({ type: 'callback', name, args: '' }); return { data: {}, error: null } }`,
    `  if (kind === 'supabase' && client?.auth) {`,
    `    const { id, name, email, ...rest } = person`,
    `    const user = { id, email, aud: 'authenticated', role: 'authenticated', app_metadata: { provider: 'email', ...rest }, user_metadata: { full_name: name, name, ...rest }, created_at: new Date().toISOString() }`,
    `    const session = signedIn ? { access_token: 'preview-token', token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'preview', user } : null`,
    `    Object.assign(client.auth, {`,
    `      getSession: async () => ({ data: { session }, error: null }),`,
    `      getUser: async () => ({ data: { user: signedIn ? user : null }, error: signedIn ? null : { message: 'Not logged in (made up by Visual Editor)' } }),`,
    `      onAuthStateChange: (cb: (event: string, s: unknown) => void) => { setTimeout(() => cb(signedIn ? 'SIGNED_IN' : 'SIGNED_OUT', session), 0); return { data: { subscription: { unsubscribe() {} } } } },`,
    `      signOut: said('signOut'), signInWithPassword: said('signInWithPassword'), signInWithOAuth: said('signInWithOAuth'), signInWithOtp: said('signInWithOtp'), signUp: said('signUp'),`,
    `    })`,
    `  } else if (kind === 'firebaseAuth' && client) {`,
    `    const user = signedIn ? { uid: person.id, email: person.email, displayName: person.name, photoURL: null, emailVerified: true, isAnonymous: false, providerData: [], metadata: {}, ...person, getIdToken: async () => 'preview-token', getIdTokenResult: async () => ({ token: 'preview-token', claims: { ...person } }), reload: async () => {}, toJSON: () => ({ uid: person.id, email: person.email }) } : null`,
    `    Object.defineProperty(client, 'currentUser', { get: () => user, configurable: true })`,
    `    const watch = (next: unknown) => { const fn = typeof next === 'function' ? next : (next as { next?: (u: unknown) => void })?.next; setTimeout(() => fn?.(user), 0); return () => {} }`,
    `    Object.assign(client, { onAuthStateChanged: watch, onIdTokenChanged: watch, beforeAuthStateChanged: () => () => {}, authStateReady: async () => {}, signOut: said('signOut') })`,
    `  }`,
    `}`,
    `async function fillStores(stores: StoreSeed[]) {`,
    `  if (situation === 'live') return`,
    `  const outcome: string[] = []`,
    `  for (const s of stores) {`,
    `    try {`,
    `      // eslint-disable-next-line @typescript-eslint/no-explicit-any`,
    `      const st = ((await load(s.module)) as Record<string, any>)[s.export]`,
    `      if (!st) { outcome.push(s.export + ': not found'); continue }`,
    `      if (s.kind === 'supabase' || s.kind === 'firebaseAuth') stubLogin(s.kind, st, (s.example as { user: { id: string; name: string; email: string } }).user)`,
    `      else if (s.kind === 'zustand' && st.getState && st.setState) st.setState(fillStore(st.getState(), s.example, s.export), true)`,
    `      else if (s.kind === 'redux' && st.getState) {`,
    `        // Read through: the app's reducers keep working; what they leave empty shows the example.`,
    `        const real = st.getState.bind(st)`,
    `        let seen: unknown, shown: unknown`,
    `        st.getState = () => { const r = real(); if (r !== seen) { seen = r; shown = fillStore(r, s.example, s.export) } return shown }`,
    `      } else if (s.kind === 'valtio') {`,
    `        const next = fillStore(st, s.example, s.export) as Record<string, unknown>`,
    `        if (next !== st) for (const k of Object.keys(next)) if (next[k] !== st[k]) st[k] = next[k]`,
    ...(p.jotai
      ? [
          `      } else if (s.kind === 'jotai') {`,
          `        const store = getDefaultStore()`,
          `        const cur = store.get(st)`,
          `        const next = fillStore(cur, s.example, s.export)`,
          `        if (next !== cur) store.set(st, next)`,
        ]
      : []),
    `      }`,
    `      outcome.push(s.export + ': filled')`,
    `    } catch (e) {`,
    `      outcome.push(s.export + ': ' + String((e as Error)?.message ?? e))`,
    `    }`,
    `  }`,
    `  if (stores.length) say({ type: 'stores', outcome: outcome.join(', ') })`,
    `}`,
    `// Data the app saves in the browser and reads back: example values first ("empty": none). Only ever at the`,
    `// preview's own address, never at localhost where the app itself keeps its real data.`,
    `type SavedSeed = { kind: 'local' | 'session' | 'localforage' | 'idb-keyval'; key: string; value: unknown }`,
    `async function fillSaved(seeds: SavedSeed[]) {`,
    `  if (situation === 'live' || location.hostname === 'localhost') return`,
    `  const none = situation === 'empty'`,
    `  for (const s of seeds) {`,
    `    try {`,
    `      if (s.kind === 'local' || s.kind === 'session') {`,
    `        const store = s.kind === 'local' ? localStorage : sessionStorage`,
    `        if (none) store.removeItem(s.key)`,
    `        else store.setItem(s.key, JSON.stringify(s.value))`,
    ...(p.localforage ? [`      } else if (s.kind === 'localforage') {`, `        await (none ? localforage.removeItem(s.key) : localforage.setItem(s.key, s.value))`] : []),
    ...(p.idbKeyval ? [`      } else if (s.kind === 'idb-keyval') {`, `        await (none ? keyvalDel(s.key) : keyvalSet(s.key, s.value))`] : []),
    `      }`,
    `    } catch (e) {`,
    `      console.warn('Visual Editor: example data for ' + s.key + ' could not be saved', e)`,
    `    }`,
    `  }`,
    `}`,
    ``,
    `const rootEl = document.getElementById('root')!`,
    `async function main() {`,
    `  const res = await fetch('./cards/' + encodeURIComponent(card) + '.json?t=' + Date.now())`,
    `  if (!res.ok) throw new Error('This preview is out of date. Reload it.')`,
    `  const raw = (await res.json()) as { path: string; export: string; props: unknown; route?: string; seed?: { module: string; export: string; tables: Record<string, unknown[]> }; requests?: { match: string; reply: unknown }[]; login?: string; authKeys?: string[]; element?: string; app?: boolean; opens?: boolean; edge?: boolean; stores?: StoreSeed[]; saved?: SavedSeed[] }`,
    `  const c = setEverywhere(raw) as typeof raw`,
    `  // Login tokens the app keeps in storage: there when logged in, gone when logged out, stale when expired.`,
    `  for (const key of c.authKeys ?? []) {`,
    `    for (const store of [localStorage, sessionStorage]) {`,
    `      if (situation === 'loggedOut') store.removeItem(key)`,
    `      else if (situation === 'expired') store.setItem(key, 'expired-preview-token')`,
    `      else if (store === localStorage && !store.getItem(key)) store.setItem(key, 'preview-token')`,
    `    }`,
    `  }`,
    `  // Stand-in data: the app's own browser database (Dexie) gets example rows first ("empty": none).`,
    `  // Only ever at the preview's own address (an IP), never at localhost where the app itself keeps its real data.`,
    `  if (c.seed && location.hostname !== 'localhost') {`,
    `    const seed = c.seed`,
    `    const fill = async () => {`,
    `      // eslint-disable-next-line @typescript-eslint/no-explicit-any`,
    `      const m = (await load(seed.module)) as Record<string, any>`,
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
    `  // The browser's database may not answer (as with Dexie): never a blank page, draw after 4 seconds at most.`,
    `  await Promise.race([fillSaved(c.saved ?? []), new Promise((r) => setTimeout(r, 4000))])`,
    `  opensDialog = !!c.opens`,
    `  await fillStores(c.stores ?? [])`,
    `  // A page whose route wraps it (a login guard): shown with that wrapper, like in the app.`,
    `  // eslint-disable-next-line @typescript-eslint/no-explicit-any`,
    `  const loaded = (await load(c.element ? '${PREVIEW_DIR}/' + c.element : c.path)) as Record<string, any>`,
    `  const mod = c.element ? { [c.export]: loaded.default } : loaded`,
    `  // Its own export, or the file's default export only when that really is this component (memo/forwardRef too).`,
    `  const def = mod.default`,
    `  const defName = def && (def.displayName ?? def.name ?? def.type?.name ?? def.render?.name)`,
    `  const View = mod[c.export] ?? (defName === c.export ? def : undefined)`,
    `  if (typeof View !== 'function' && typeof View !== 'object') throw new Error(c.export + ' is not exported from ' + c.path + ', so it cannot be shown on its own.')`,
    `  // A page fills the frame; a single component gets some room around it.`,
    `  if (!c.route) rootEl.style.padding = '24px'`,
    ...(p.reactFlow
      ? [
          `  // A React Flow edge draws only inside a diagram: between two example nodes, with its example data.`,
          `  const Edge = View`,
          `  const inFlow = () => <div style={{ height: 320 }}><ReactFlow nodes={[{ id: 'a', position: { x: 0, y: 80 }, data: { label: 'From' } }, { id: 'b', position: { x: 360, y: 80 }, data: { label: 'To' } }]} edges={[{ id: 'e', source: 'a', target: 'b', type: 'preview', data: (props as { data?: unknown }).data ?? {} }]} edgeTypes={{ preview: Edge }} fitView proOptions={{ hideAttribution: true }} /></div>`,
          `  const drawn = c.edge ? inFlow() : <View {...(props as object)} />`,
        ]
      : [`  const drawn = <View {...(props as object)} />`]),
    `  createRoot(rootEl).render(<Boundary><Wrap route={c.route} app={c.app}>{drawn}</Wrap></Boundary>)`,
    `  say({ type: 'ready' })`,
    `  // What's on screen once data has arrived (for checks and for assistants): its visible text, sent again when it`,
    `  // changes (slow data, a redirect), for the first 10 seconds.`,
    `  let last = ''`,
    `  let quiet: ReturnType<typeof setTimeout> | undefined`,
    `  // How many things on screen have a size (boxes, pictures, shapes): a component with no words still draws something.`,
    `  // The whole page, not only the root: modals and menus often draw through a portal straight into <body>.`,
    `  const drawnCount = () => [...document.body.querySelectorAll('*')].filter((e) => { if (e.tagName === 'SCRIPT' || e === note || note.contains(e)) return false; const r = e.getBoundingClientRect(); return r.width > 1 && r.height > 1 }).length`,
    `  const note = document.createElement('div')`,
    `  Object.assign(note.style, { position: 'fixed', left: '12px', bottom: '12px', maxWidth: '440px', padding: '8px 12px', borderRadius: '8px', font: '12px/1.45 system-ui, sans-serif', background: '#2a2c31', color: '#e8e8ea', border: '1px solid #8886', zIndex: '2147483646' })`,
    `  note.textContent = 'Nothing visible here: in this situation the component draws nothing. It may be closed, wait for something, or need to sit inside its parent.'`,
    `  const report = () => {`,
    `    const text = (document.body.innerText || '').replace(note.isConnected ? note.innerText : '\\u0000', '').replace(/\\s+/g, ' ').trim().slice(0, 400)`,
    `    const drawn = drawnCount()`,
    `    const now = text + '|' + (drawn ? 'drawn' : 'empty')`,
    `    if (now === last) return`,
    `    last = now`,
    `    say({ type: 'text', text, drawn })`,
    `    if (!drawn && !text) { if (!note.isConnected) document.body.append(note) } else if (note.isConnected) note.remove()`,
    `  }`,
    `  const watch = new MutationObserver(() => { clearTimeout(quiet); quiet = setTimeout(report, 300) })`,
    `  watch.observe(document.body, { childList: true, subtree: true, characterData: true })`,
    `  setTimeout(report, 1500)`,
    `  setTimeout(() => { watch.disconnect(); report() }, 10_000)`,
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
  if (/\[\]$|^Array</.test(t) || n.endsWith('list') || (!t && n.endsWith('s') && /items|children|rows|list/.test(n))) {
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
  // Yes for what is usually so (in stock, active, verified, a dialog open); no for trouble (deleted, failed, locked).
  if (/^boolean/.test(t)) return !/(disabled|hidden|deleted|archived|error|loading|locked|blocked|banned|failed|empty|expired|dirty|pending)/.test(n) && /^(is|has|can|in|show)[a-z]|^(open|expanded|visible|enabled|active|available|verified|published|online|instock|selected|checked|done|completed|paid|read)$/.test(n);
  if (/^'([^']*)'/.test(t)) return t.match(/^'([^']*)'/)![1];
  if (/^Date/.test(t)) return new Date().toISOString();
  if (!t || /^string/.test(t)) return stringFor(n);
  return {};
}

function numberFor(n: string): number {
  if (/(at|date|time|timestamp)$/.test(n)) return Date.now() - 3_600_000;
  if (/price|amount|total|cost|revenue|sales|income|spend|budget|balance|subtotal/.test(n)) return 1299;
  if (/^(number|num|no)$/.test(n)) return 1042;
  if (/qty|quantity/.test(n)) return 2;
  if (/count|size|length/.test(n)) return 12;
  if (/age/.test(n)) return 34;
  if (/star|rating|score/.test(n)) return 4;
  if (/id$/.test(n)) return 1042;
  return 42;
}

function stringFor(n: string): string {
  // Text fields that usually hold JSON (data, config, payload…): valid JSON, so the app can read them back.
  if (/^(data|json|payload|config|settings|meta|metadata|snapshot)$/.test(n)) return '{}';
  if (n === 'id' || n.endsWith('id')) return 'id-1042';
  if (/email/.test(n)) return 'ada@example.com';
  if (/(^|_)(name|title|label|heading)$/.test(n) || n === 'name' || n === 'title') return 'Order dashboard';
  if (/desc|summary|subtitle|bio|text|content|message|body/.test(n)) return 'A short description, long enough to wrap onto a second line in narrow cards.';
  if (/colou?r|accent|bg$|background|fg$|foreground|fill$|stroke$|tint$|shade$/.test(n)) return /fg$|foreground|text/.test(n) ? '#ffffff' : '#6366f1';
  if (/avatar|image|img|src|photo|picture|cover|thumbnail|logo/.test(n)) return PLACEHOLDER_IMAGE;
  if (/url|link|href/.test(n)) return '/';
  if (/status|state/.test(n)) return 'active';
  if (/(at|date|time)$/.test(n)) return new Date().toISOString();
  if (/phone/.test(n)) return '+1 555 0100';
  return `Example ${n}`;
}
