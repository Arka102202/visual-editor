// The app's own providers, around every preview: whatever wraps <App /> in the app's entry file (main.tsx) is
// written into the preview folder as one component, in the same order, so components find their context (auth,
// theme, query client, store) like in the real app. The router is swapped for the preview's (pages open at their own
// address); known login providers are swapped for stand-ins that say "logged in". Top-level side effects of the entry
// (registering a service worker, starting analytics) are left out. Pure: text in, text out, so it can be tested.

import type * as t from '@babel/types';
import { posix } from 'node:path';
import { forEachChild, parseSource, walk } from '../read/ast';

const forEach = (n: t.Node, fn: (c: t.Node) => void) => forEachChild(n as never, fn as never);

const ROUTERS = new Set(['BrowserRouter', 'HashRouter', 'MemoryRouter', 'Router', 'unstable_HistoryRouter']);
/** Login providers with a stand-in in the preview (see STAND_INS in harness.ts). */
export const AUTH_STAND_INS: Record<string, { pkg: string; standIn: string }> = {
  Auth0Provider: { pkg: '@auth0/auth0-react', standIn: 'PreviewAuth0' },
};

export interface AppProviders {
  /** The module text (`.visual-editor/preview/app-providers.tsx`). */
  module: string;
  /** The app puts its router among these providers: the preview passes its own router in instead. */
  hasRouter: boolean;
  /** Names of the providers kept, outermost first (for messages and tests). */
  names: string[];
  /** Login providers swapped for stand-ins. */
  standIns: string[];
  /** The app component the entry renders (`<App />`), when it comes from the project: its file and export. */
  app?: { from: string; export: string };
}

const GENERATED = '// Written by Visual Editor (React plugin): the app\'s own providers, from its entry file. Replaced when it changes.';

/** A module that wraps nothing: the app has no providers in its entry (or no entry). */
export function noProviders(): AppProviders {
  return {
    module: `${GENERATED}\nimport type { ReactNode } from 'react'\nexport function AppProviders({ children }: { children: ReactNode; Router?: unknown }) { return <>{children}</> }\n`,
    hasRouter: false,
    names: [],
    standIns: [],
  };
}

/**
 * Reads the entry file (path relative to the project, text) and writes the providers module for the preview folder
 * (`previewDir`, relative to the project).
 */
export function appProviders(entryPath: string, text: string, previewDir: string): AppProviders {
  const ast = parseSource({ path: entryPath, text });
  if (!ast) return noProviders();

  // The JSX handed to createRoot(…).render(…) / ReactDOM.render(…).
  let root: t.JSXElement | undefined;
  walk(ast, (n) => {
    if (root || n.type !== 'CallExpression') return;
    const callee = n.callee;
    const isRender = callee.type === 'MemberExpression' && callee.property.type === 'Identifier' && (callee.property.name === 'render' || callee.property.name === 'hydrateRoot');
    const arg = n.arguments[0];
    if (isRender && arg?.type === 'JSXElement') root = arg;
  });
  if (!root) return noProviders();

  const names: string[] = [];
  const standIns: string[] = [];
  let hasRouter = false;
  const nameOf = (el: t.JSXElement) => {
    const n = el.openingElement.name;
    return n.type === 'JSXIdentifier' ? n.name : n.type === 'JSXMemberExpression' ? `${(n.object as t.JSXIdentifier).name}.${n.property.name}` : 'unknown';
  };
  /** An element as JSX text, with the app itself replaced by {children} and the router by the preview's. */
  let leaf: string | undefined;
  const write = (el: t.JSXElement): string => {
    const name = nameOf(el);
    const kids = el.children.filter((c): c is t.JSXElement => c.type === 'JSXElement');
    // The innermost element with no element inside is the app itself.
    if (!kids.length) {
      leaf = name;
      return '{children}';
    }
    const attrs = el.openingElement.attributes.map((a) => exact(text, a)).join(' ');
    const inner = kids.map(write).join('');
    if (ROUTERS.has(name.split('.').pop()!)) {
      hasRouter = true;
      return `<PreviewRouter>${inner}</PreviewRouter>`;
    }
    const auth = AUTH_STAND_INS[name];
    if (auth) {
      standIns.push(name);
      return `<${auth.standIn}${attrs ? ` ${attrs}` : ''}>${inner}</${auth.standIn}>`;
    }
    names.unshift(name);
    return `<${name}${attrs ? ` ${attrs}` : ''}>${inner}</${name}>`;
  };
  const kept: t.JSXElement[] = [];
  walk(root, (n) => {
    if (n.type === 'JSXElement' && n.children.some((c) => c.type === 'JSXElement')) kept.push(n);
  });
  const tree = write(root);
  // Where <App /> comes from (its own providers, in its file, are read next).
  let app: AppProviders['app'];
  for (const s of ast.program.body) {
    if (s.type !== 'ImportDeclaration' || !s.source.value.startsWith('.')) continue;
    const spec = s.specifiers.find((x) => x.local.name === leaf);
    if (spec && spec.type !== 'ImportNamespaceSpecifier') {
      app = { from: posix.join(posix.dirname(entryPath), s.source.value), export: spec.type === 'ImportDefaultSpecifier' ? 'default' : spec.imported.type === 'Identifier' ? spec.imported.name : spec.imported.value };
    }
  }
  if (!names.length && !standIns.length && !hasRouter) return { ...noProviders(), ...(app ? { app } : {}) };

  // Only what the providers use (a query client made once, a store…), with the imports those need: the rest of the
  // entry (the app, a service worker, analytics, listeners) is left out.
  const used = kept.filter((el) => !ROUTERS.has(nameOf(el).split('.').pop()!) && !AUTH_STAND_INS[nameOf(el)]).map((el) => el.openingElement);
  const lines = neededCode(ast, text, used, posix.dirname(entryPath), previewDir);
  const module = [
    GENERATED,
    '// @ts-nocheck',
    `import type { ReactNode, ComponentType } from 'react'`,
    ...(standIns.length ? [`import { ${[...new Set(standIns.map((s) => AUTH_STAND_INS[s].standIn))].join(', ')} } from './stand-ins'`] : []),
    ...lines,
    '',
    `const Passthrough = ({ children }: { children: ReactNode }) => <>{children}</>`,
    `export function AppProviders({ children, Router }: { children: ReactNode; Router?: ComponentType<{ children: ReactNode }> }) {`,
    `  const PreviewRouter = Router ?? Passthrough`,
    `  return ${tree}`,
    `}`,
    '',
  ].join('\n');
  return { module, hasRouter, names, standIns, ...(app ? { app } : {}) };
}

// ---------------------------------------------------------------------------
// The app component's own providers (in App.tsx)
// ---------------------------------------------------------------------------

/** Where an app shows its pages: everything around one of these is the app's frame (providers, a router, a layout). */
const PAGE_SLOTS = new Set(['Routes', 'Switch', 'RouterProvider', 'Outlet']);
/** Wrappers that give components something (context, a boundary): kept around every preview. Others are layout. */
const PROVIDERISH = /(Provider|Boundary)$|^(React\.)?(StrictMode|Suspense)$/;

export interface AppShell {
  /** Files for the preview folder (paths relative to it): `app-shell.tsx`, and copies of the app's components. */
  modules: Record<string, string>;
  /** The app component puts its router among these providers: the preview passes its own router in instead. */
  hasRouter: boolean;
  /** Providers kept, outermost first. */
  names: string[];
  /** The app component (its file, relative to the project, and its name) when it has providers or a router. */
  file?: string;
  component?: string;
  /** Every component on the way to the routes (App, AppRouter…): each is drawn as the whole app. */
  steps?: { path: string; name?: string }[];
}

/** One component on the way from the app component down to where pages are shown. */
export interface ShellStep {
  path: string;
  text: string;
  /** Its name in its file, or 'default' for the file's default export. */
  name: string;
  /** The tag it draws the next step with (`AppRouter`), when there's a next step. */
  nextTag?: string;
}

const SHELL_HEAD = "// Written by Visual Editor (React plugin): the app component's own providers, from its files. Replaced when they change.";
const SHELL_DIR = 'shell';

/** The app component has no providers or router of its own. */
export function noShell(): AppShell {
  return {
    modules: { 'app-shell.tsx': `${SHELL_HEAD}\nimport type { ReactNode } from 'react'\nexport const HAS_SHELL = false\nexport function AppShell({ children }: { children?: ReactNode; Router?: unknown; whole?: boolean }) { return <>{children}</> }\n` },
    hasRouter: false,
    names: [],
  };
}

/**
 * The app component (`App`) as a frame for previews. Its file is copied with its JSX keeping only what leads to where
 * pages are shown (`<Routes>`), and of that only the providers (and the router, swapped for the preview's). Its hooks
 * and variables stay as written, so a provider's value works like in the app. `whole` draws the app as it is (for
 * previewing App itself), with only the router swapped. When App hands over to another component that holds the
 * routes (`<AppRouter />`), each component on the way is copied too, pointing at the next copy.
 */
export function appShell(appPath: string, text: string, exportName: string, previewDir: string): AppShell {
  return appShellChain([{ path: appPath, text, name: exportName }], previewDir);
}

/** The frame from a chain of components, the app component first and the one holding the routes last. */
export function appShellChain(chain: ShellStep[], previewDir: string): AppShell {
  if (!chain.length) return noShell();
  const dir = posix.join(previewDir, SHELL_DIR);
  const last = chain[chain.length - 1];
  const frame = frameCopy(last, dir);
  if (!frame) return noShell();
  const modules: Record<string, string> = {};
  modules[`${SHELL_DIR}/${chain.length - 1}.tsx`] = frame.text;
  for (let i = chain.length - 2; i >= 0; i--) {
    const hop = hopCopy(chain[i], dir, `./${i + 1}`);
    if (!hop) return noShell();
    modules[`${SHELL_DIR}/${i}.tsx`] = hop;
  }
  modules['app-shell.tsx'] = [
    SHELL_HEAD,
    '// @ts-nocheck',
    `import { __ve, __VePassthrough } from './shell-state'`,
    `import { __VeHop as Top } from './${SHELL_DIR}/0'`,
    `export const HAS_SHELL = true`,
    `export function AppShell({ Router, children, whole }) {`,
    `  __ve.Router = Router ?? __VePassthrough`,
    `  __ve.children = children`,
    `  __ve.whole = !!whole`,
    `  return <Top />`,
    `}`,
    '',
  ].join('\n');
  modules['shell-state.tsx'] = [
    SHELL_HEAD,
    '// @ts-nocheck',
    `export const __VePassthrough = ({ children }) => <>{children}</>`,
    `/** What the frame draws: set by AppShell, read by the copy that holds the routes. */`,
    `export const __ve = { Router: __VePassthrough, children: undefined, whole: false }`,
    '',
  ].join('\n');
  const top = located(chain[0]);
  const steps = chain.map((c, i) => ({ path: c.path, name: i === 0 ? top?.name : c.name === 'default' ? located(c)?.name : c.name }));
  return { modules, hasRouter: frame.hasRouter, names: frame.names, file: chain[0].path, component: top?.name, steps };
}

/** Starting from the app component, the components to follow down to the one holding the routes (up to 3 steps). */
export function shellChain(start: ShellStep, rendersOf: (step: ShellStep) => { tag: string; step: ShellStep }[], depth = 0): ShellStep[] | undefined {
  if (/createRoot\s*\(|ReactDOM\.render\s*\(|hydrateRoot\s*\(/.test(start.text)) return undefined;
  if (frameCopy(start, '.')) return [start];
  if (depth >= 3) return undefined;
  for (const next of rendersOf(start)) {
    const rest = shellChain(next.step, rendersOf, depth + 1);
    if (rest) return [{ ...start, nextTag: next.tag }, ...rest];
  }
  return undefined;
}

type Fn = t.FunctionDeclaration | t.ArrowFunctionExpression | t.FunctionExpression;
const isFn = (n: t.Node | null | undefined): n is Fn => !!n && (n.type === 'FunctionDeclaration' || n.type === 'ArrowFunctionExpression' || n.type === 'FunctionExpression');

/** A component in its file: its function, its local name (undefined for an unnamed default export), and its JSX. */
function located(step: ShellStep): { ast: t.File; fn: Fn; name?: string; defaultDecl?: t.ExportDefaultDeclaration; jsx?: t.JSXElement | t.JSXFragment } | undefined {
  const ast = parseSource({ path: step.path, text: step.text });
  if (!ast) return undefined;
  const byName = (name: string): Fn | undefined => {
    for (const st of ast.program.body) {
      const d = st.type === 'ExportNamedDeclaration' || st.type === 'ExportDefaultDeclaration' ? st.declaration : st;
      if (d?.type === 'FunctionDeclaration' && d.id?.name === name) return d;
      if (d?.type === 'VariableDeclaration') for (const v of d.declarations) if (v.id.type === 'Identifier' && v.id.name === name && isFn(v.init)) return v.init;
    }
    return undefined;
  };
  let fn: Fn | undefined;
  let name: string | undefined;
  let defaultDecl: t.ExportDefaultDeclaration | undefined;
  if (step.name === 'default') {
    defaultDecl = ast.program.body.find((st): st is t.ExportDefaultDeclaration => st.type === 'ExportDefaultDeclaration');
    const d = defaultDecl?.declaration;
    if (d?.type === 'Identifier') fn = byName((name = d.name));
    else if (isFn(d)) {
      fn = d;
      name = d.type === 'FunctionDeclaration' ? d.id?.name : undefined;
    }
  } else fn = byName((name = step.name));
  if (!fn) return undefined;
  // What it returns: the JSX of its last return (or of an arrow's body).
  let jsx: t.JSXElement | t.JSXFragment | undefined;
  if (fn.body.type === 'JSXElement' || fn.body.type === 'JSXFragment') jsx = fn.body;
  else if (fn.body.type === 'BlockStatement') {
    const own = (n: t.Node) => {
      if (n.type === 'ReturnStatement' && (n.argument?.type === 'JSXElement' || n.argument?.type === 'JSXFragment')) jsx = n.argument;
      if (!isFn(n) || n === fn) forEach(n, own);
    };
    own(fn.body);
  }
  return { ast, fn, name, defaultDecl, jsx };
}

/** Edits shared by every copy: imports re-pointed from the copy's folder, an unnamed default export named, `__VeHop` exported. */
function copyEdits(step: ShellStep, at: NonNullable<ReturnType<typeof located>>, toDir: string): { edits: { start: number; end: number; text: string }[]; name: string } {
  const edits: { start: number; end: number; text: string }[] = [];
  for (const st of at.ast.program.body) {
    if (st.type !== 'ImportDeclaration' || !st.source.value.startsWith('.')) continue;
    edits.push({ start: st.source.start ?? 0, end: st.source.end ?? 0, text: `'${relativeFrom(toDir, posix.join(posix.dirname(step.path), st.source.value))}'` });
  }
  let name = at.name;
  if (!name && at.defaultDecl) {
    name = '__VeApp';
    if (at.fn.type === 'FunctionDeclaration') edits.push({ start: at.fn.start ?? 0, end: (at.fn.start ?? 0) + 'function'.length, text: 'function __VeApp' });
    else edits.push({ start: at.defaultDecl.start ?? 0, end: at.fn.start ?? 0, text: 'const __VeApp = ' }, { start: at.defaultDecl.end ?? 0, end: at.defaultDecl.end ?? 0, text: '\nexport default __VeApp' });
  }
  return { edits, name: name ?? '__VeApp' };
}

/** The component holding the routes, copied as the frame; undefined when it holds no routes (or no providers or router around them). */
function frameCopy(step: ShellStep, toDir: string): { text: string; hasRouter: boolean; names: string[] } | undefined {
  const at = located(step);
  if (!at?.jsx) return undefined;
  const { jsx } = at;
  const text = step.text;
  // The way down to where pages are shown.
  const routesVar = /const\s+(\w+)\s*=\s*useRoutes\s*\(/.exec(text)?.[1];
  let path: (t.JSXElement | t.JSXFragment)[] | undefined;
  let slot: t.Node | undefined;
  const down = (n: t.JSXElement | t.JSXFragment, above: (t.JSXElement | t.JSXFragment)[]) => {
    if (path) return;
    if (n.type === 'JSXElement' && PAGE_SLOTS.has(jsxNameOf(n))) {
      path = above;
      slot = n;
      return;
    }
    for (const c of n.children) {
      if (c.type === 'JSXElement' || c.type === 'JSXFragment') down(c, [...above, n]);
      else if (c.type === 'JSXExpressionContainer' && routesVar && c.expression.type === 'Identifier' && c.expression.name === routesVar && !path) {
        path = [...above, n];
        slot = c;
      }
    }
  };
  down(jsx, []);
  if (!path || !slot) return undefined;
  const wrappers = path.filter((n): n is t.JSXElement => n.type === 'JSXElement');
  const routerAt = wrappers.filter((n) => ROUTERS.has(jsxNameOf(n).split('.').pop()!));
  const kept = wrappers.filter((n) => !routerAt.includes(n) && PROVIDERISH.test(jsxNameOf(n)));
  if (!routerAt.length && !kept.length) return undefined;

  // Only the frame: providers kept, the router swapped, layout and siblings left out; pages go where <Routes> was.
  let frame = '{__ve.children}';
  for (const n of [...wrappers].reverse()) {
    if (routerAt.includes(n)) frame = `<__ve.Router>${frame}</__ve.Router>`;
    else if (kept.includes(n)) {
      const attrs = n.openingElement.attributes.map((a) => exact(text, a)).join(' ');
      frame = `<${jsxNameOf(n)}${attrs ? ` ${attrs}` : ''}>${frame}</${jsxNameOf(n)}>`;
    }
  }
  // The whole app, with only its router swapped.
  const jsxStart = jsx.start ?? 0;
  const inner: { start: number; end: number; text: string }[] = [];
  for (const r of routerAt) {
    inner.push({ start: r.openingElement.start ?? 0, end: r.openingElement.end ?? 0, text: '<__ve.Router>' });
    if (r.closingElement) inner.push({ start: r.closingElement.start ?? 0, end: r.closingElement.end ?? 0, text: '</__ve.Router>' });
  }
  const whole = applyEdits(text, inner).slice(jsxStart, (jsx.end ?? 0) + inner.reduce((d, e) => d + e.text.length - (e.end - e.start), 0));
  const { edits, name } = copyEdits(step, at, toDir);
  edits.push({ start: jsxStart, end: jsx.end ?? 0, text: `(__ve.whole ? (${whole}) : (<>${frame}</>))` });
  const copy = [SHELL_HEAD, '// @ts-nocheck', `import { __ve } from '../shell-state'`, applyEdits(text, edits), '', `export { ${name} as __VeHop }`, ''].join('\n');
  return { text: copy, hasRouter: routerAt.length > 0, names: kept.map(jsxNameOf) };
}

/** A component on the way to the routes, copied whole, drawing the next copy where it drew the next component. */
function hopCopy(step: ShellStep, toDir: string, next: string): string | undefined {
  const at = located(step);
  if (!at?.jsx) return undefined;
  const { edits, name } = copyEdits(step, at, toDir);
  // Every <Next …> in what it returns becomes the next copy (the original import stays, unused).
  const tags = new Set<string>();
  walk(at.jsx, (n) => {
    if (n.type === 'JSXElement' && n.openingElement.name.type === 'JSXIdentifier' && /^[A-Z]/.test(n.openingElement.name.name)) tags.add(n.openingElement.name.name);
  });
  const nextTag = step.nextTag && tags.has(step.nextTag) ? step.nextTag : undefined;
  if (!nextTag) return undefined;
  walk(at.jsx, (n) => {
    if (n.type !== 'JSXElement' || n.openingElement.name.type !== 'JSXIdentifier' || n.openingElement.name.name !== nextTag) return;
    edits.push({ start: n.openingElement.name.start ?? 0, end: n.openingElement.name.end ?? 0, text: '__VeNext' });
    if (n.closingElement) edits.push({ start: n.closingElement.name.start ?? 0, end: n.closingElement.name.end ?? 0, text: '__VeNext' });
  });
  return [SHELL_HEAD, '// @ts-nocheck', `import { __VeHop as __VeNext } from '${next}'`, applyEdits(step.text, edits), '', `export { ${name} as __VeHop }`, ''].join('\n');
}

function jsxNameOf(el: t.JSXElement): string {
  const n = el.openingElement.name;
  return n.type === 'JSXIdentifier' ? n.name : n.type === 'JSXMemberExpression' ? `${exact('', n) || (n.object as t.JSXIdentifier).name}.${n.property.name}` : 'unknown';
}

/** Text with replacements (ranges in the original text, not overlapping). */
function applyEdits(text: string, edits: { start: number; end: number; text: string }[]): string {
  let out = text;
  for (const e of [...edits].sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return out;
}

/** An import path from one folder to a file, both relative to the project ("../../src/auth"). */
function relativeFrom(fromDir: string, to: string): string {
  const r = posix.relative(fromDir, to);
  return r.startsWith('.') ? r : `./${r}`;
}

/**
 * Stand-ins for login providers, written next to the providers module: they look logged in (or logged out, in the
 * "logged out" situation) to every hook the app uses, with a fake user. Only the ones the app uses are written, so a
 * package the app doesn't have is never imported.
 */
export function standInsModule(standIns: string[]): string {
  const parts = [`// Written by Visual Editor (React plugin): stand-ins for login providers in previews.`, `// @ts-nocheck`, `import type { ReactNode } from 'react'`];
  if (standIns.includes('Auth0Provider')) {
    parts.push(
      `import { Auth0Context } from '@auth0/auth0-react'`,
      `const loggedOut = ['loggedOut', 'expired'].includes(new URLSearchParams(location.search).get('s') ?? '')`,
      `const say = (name: string) => () => { window.parent.postMessage({ source: 'visual-editor-preview', type: 'callback', name, args: '' }, '*'); return Promise.resolve(undefined) }`,
      `const user = { sub: 'preview|1042', name: 'Ada Lovelace', given_name: 'Ada', family_name: 'Lovelace', email: 'ada@example.com', email_verified: true, picture: 'data:image/svg+xml;utf8,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2264%22 height=%2264%22%3E%3Crect width=%2264%22 height=%2264%22 fill=%22%2394a3b8%22/%3E%3C/svg%3E' }`,
      `/** Auth0, logged in as an example user (logged out in that situation); nothing reaches Auth0. */`,
      `export function PreviewAuth0({ children }: { children: ReactNode }) {`,
      `  const value = {`,
      `    isAuthenticated: !loggedOut, isLoading: false, error: undefined, user: loggedOut ? undefined : user,`,
      `    getAccessTokenSilently: async () => 'preview-token', getAccessTokenWithPopup: async () => 'preview-token', getIdTokenClaims: async () => (loggedOut ? undefined : { __raw: 'preview', ...user }),`,
      `    loginWithRedirect: say('loginWithRedirect'), loginWithPopup: say('loginWithPopup'), logout: say('logout'), handleRedirectCallback: async () => ({}), connectAccountWithRedirect: say('connectAccountWithRedirect'),`,
      `  }`,
      `  return <Auth0Context.Provider value={value as never}>{children}</Auth0Context.Provider>`,
      `}`,
    );
  }
  return parts.join('\n') + '\n';
}

/**
 * A page as its routes show it: its own element with its wrappers (`<RequireAuth><Admin /></RequireAuth>`) and the
 * elements of the routes around it (a layout or a guard that renders the page in its `<Outlet />`), so a guard does
 * its job first (waits for the login check, sends logged-out people to /login), like in the app. `line` (0-based) is
 * where the page's route is written. Undefined when the page is shown bare (nothing wraps it).
 */
export function routeElementModule(routeFile: string, text: string, line: number, previewDir: string, router = 'react-router-dom', replace: Record<string, string> = {}): string | undefined {
  const ast = parseSource({ path: routeFile, text });
  if (!ast) return undefined;
  /** A route's element: `<Route element={…}>`, or `{ element: … }` in a route object. */
  const elementOf = (n: t.Node): t.Node | undefined => {
    if (n.type === 'JSXElement' && n.openingElement.name.type === 'JSXIdentifier' && n.openingElement.name.name === 'Route') {
      const v = n.openingElement.attributes.find((a): a is t.JSXAttribute => a.type === 'JSXAttribute' && a.name.name === 'element')?.value;
      return v?.type === 'JSXExpressionContainer' && v.expression.type !== 'JSXEmptyExpression' ? v.expression : undefined;
    }
    if (n.type === 'ObjectExpression') {
      return n.properties.find((p): p is t.ObjectProperty => p.type === 'ObjectProperty' && p.key.type === 'Identifier' && p.key.name === 'element')?.value;
    }
    return undefined;
  };
  // The route on that line, and the routes it sits in (outer first).
  let chain: t.Node[] | undefined;
  const stack: t.Node[] = [];
  const visit = (n: t.Node) => {
    if (chain) return;
    const el = elementOf(n);
    if (el && (n.loc?.start.line ?? 0) - 1 === line) {
      chain = [...stack, el];
      return;
    }
    if (el) stack.push(el);
    forEach(n, visit);
    if (el) stack.pop();
  };
  visit(ast.program);
  if (!chain) return undefined;
  const page = chain[chain.length - 1];
  const wrappers = chain.slice(0, -1);
  const pageWrapped = page.type === 'JSXElement' && page.children.some((c) => c.type === 'JSXElement');
  if (!wrappers.length && !pageWrapped) return undefined;
  // Around routes render the page in their <Outlet />: the same routes, without addresses (the preview opened the
  // page's address already).
  let body = exact(text, page);
  const names: t.Node[] = [...chain];
  if (wrappers.length) {
    body = `<__VeRoutes>${wrappers.map((w) => `<__VeRoute element={${exact(text, w)}}>`).join('')}<__VeRoute index element={${body}} />${wrappers.map(() => '</__VeRoute>').join('')}</__VeRoutes>`;
  }
  const lines = neededCode(ast, text, names, posix.dirname(routeFile), posix.join(previewDir, 'routes'), replace);
  return [
    `// Written by Visual Editor (React plugin): the page as the app's routes show it (with their guards and layouts).`,
    '// @ts-nocheck',
    ...(wrappers.length ? [`import { Routes as __VeRoutes, Route as __VeRoute } from '${router}'`] : []),
    ...lines,
    '',
    `export default function RouteElement() {`,
    `  return (${body})`,
    `}`,
    '',
  ].join('\n');
}

/** A node's source text, exactly as written. */
function exact(text: string, node: t.Node): string {
  return text.slice(node.start ?? 0, node.end ?? 0);
}

/** Every name a piece of code mentions (over-collecting is harmless: unknown names are skipped). */
function namesIn(node: t.Node, into: Set<string>) {
  walk(node, (n) => {
    if (n.type === 'Identifier' || n.type === 'JSXIdentifier') into.add(n.name);
  });
}

/**
 * The imports and top-level declarations of a file that some nodes need, followed step by step (a provider uses
 * `queryClient`, which uses `QueryClient`, which is imported). Imports keep only the names used, re-pointed from
 * `toDir`; declarations lose `export`; nothing else from the file comes along (no side effects).
 */
function neededCode(ast: t.File, text: string, nodes: t.Node[], fromDir: string, toDir: string, replace: Record<string, string> = {}): string[] {
  const declared = new Map<string, t.Statement>();
  const imported = new Map<string, { decl: t.ImportDeclaration; spec: t.ImportDeclaration['specifiers'][number] }>();
  for (const s of ast.program.body) {
    const d = s.type === 'ExportNamedDeclaration' || s.type === 'ExportDefaultDeclaration' ? s.declaration : s;
    if (!d) continue;
    if (d.type === 'ImportDeclaration') for (const spec of d.specifiers) imported.set(spec.local.name, { decl: d, spec });
    else if (d.type === 'VariableDeclaration') {
      for (const v of d.declarations) if (v.id.type === 'Identifier') declared.set(v.id.name, d);
    } else if ((d.type === 'FunctionDeclaration' || d.type === 'ClassDeclaration' || d.type === 'TSInterfaceDeclaration' || d.type === 'TSTypeAliasDeclaration' || d.type === 'TSEnumDeclaration') && d.id) {
      declared.set(d.id.name, d as t.Statement);
    }
  }
  const wanted = new Set<string>();
  for (const n of nodes) namesIn(n, wanted);
  const decls = new Set<t.Statement>();
  const specs = new Map<t.ImportDeclaration, Set<t.ImportDeclaration['specifiers'][number]>>();
  const done = new Set<string>();
  const queue = [...wanted];
  while (queue.length) {
    const name = queue.pop()!;
    if (done.has(name)) continue;
    done.add(name);
    const d = declared.get(name);
    if (d && !decls.has(d)) {
      decls.add(d);
      const more = new Set<string>();
      namesIn(d, more);
      queue.push(...more);
    }
    const imp = imported.get(name);
    if (imp) specs.set(imp.decl, (specs.get(imp.decl) ?? new Set()).add(imp.spec));
  }
  const lines: string[] = [];
  for (const [decl, used] of specs) {
    const from = decl.source.value;
    // `replace`: imports to point elsewhere (a proposed copy of the page), as project paths.
    const moved = replace[from] ? relativeFrom(toDir, replace[from]) : from.startsWith('.') ? relativeFrom(toDir, posix.join(fromDir, from)) : from;
    const parts = [...used];
    const def = parts.find((p) => p.type === 'ImportDefaultSpecifier');
    const ns = parts.find((p) => p.type === 'ImportNamespaceSpecifier');
    const named = parts.filter((p): p is t.ImportSpecifier => p.type === 'ImportSpecifier').map((p) => exact(text, p));
    const type = decl.importKind === 'type' ? 'type ' : '';
    if (ns) lines.push(`import ${type}${def ? `${def.local.name}, ` : ''}* as ${ns.local.name} from '${moved}'`);
    else lines.push(`import ${type}${[def?.local.name, named.length ? `{ ${named.join(', ')} }` : ''].filter(Boolean).join(', ')} from '${moved}'`);
  }
  // In the file's order, so a declaration comes after what it uses.
  for (const s of ast.program.body) {
    const d = s.type === 'ExportNamedDeclaration' || s.type === 'ExportDefaultDeclaration' ? s.declaration : s;
    if (d && decls.has(d as t.Statement)) lines.push(exact(text, d));
  }
  return lines;
}
