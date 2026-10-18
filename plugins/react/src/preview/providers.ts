// The app's own providers, around every preview: whatever wraps <App /> in the app's entry file (main.tsx) is
// written into the preview folder as one component, in the same order, so components find their context (auth,
// theme, query client, store) like in the real app. The router is swapped for the preview's (pages open at their own
// address); known login providers are swapped for stand-ins that say "logged in". Top-level side effects of the entry
// (registering a service worker, starting analytics) are left out. Pure: text in, text out, so it can be tested.

import type * as t from '@babel/types';
import { posix } from 'node:path';
import { parseSource, walk } from '../read/ast';

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
  const write = (el: t.JSXElement): string => {
    const name = nameOf(el);
    const kids = el.children.filter((c): c is t.JSXElement => c.type === 'JSXElement');
    // The innermost element with no element inside is the app itself.
    if (!kids.length) return '{children}';
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
  if (!names.length && !standIns.length && !hasRouter) return noProviders();

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
  return { module, hasRouter, names, standIns };
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
 * A page as its route shows it: the route's element with its wrappers (`<RequireAuth><Admin /></RequireAuth>`), so a
 * guard does its job first (waits for the login check, sends logged-out people to /login), like in the app.
 * Undefined when the route shows the page bare (no wrapper), or isn't written as JSX this reader knows.
 */
export function routeElementModule(routeFile: string, text: string, path: string, previewDir: string): string | undefined {
  const ast = parseSource({ path: routeFile, text });
  if (!ast) return undefined;
  let element: t.Node | undefined;
  walk(ast, (n) => {
    if (element) return;
    // <Route path="/admin" element={…} />
    if (n.type === 'JSXOpeningElement' && n.name.type === 'JSXIdentifier' && n.name.name === 'Route') {
      const attr = (name: string) => n.attributes.find((a): a is t.JSXAttribute => a.type === 'JSXAttribute' && a.name.name === name);
      const p = attr('path')?.value;
      const e = attr('element')?.value;
      if (p?.type === 'StringLiteral' && p.value === path && e?.type === 'JSXExpressionContainer' && e.expression.type !== 'JSXEmptyExpression') element = e.expression;
    }
    // { path: '/admin', element: … }
    if (n.type === 'ObjectExpression') {
      const prop = (name: string) => n.properties.find((p): p is t.ObjectProperty => p.type === 'ObjectProperty' && p.key.type === 'Identifier' && p.key.name === name);
      const p = prop('path')?.value;
      const e = prop('element')?.value;
      if (p?.type === 'StringLiteral' && p.value === path && e) element = e;
    }
  });
  // Bare (<Admin />, no wrapper): the page itself is enough.
  if (!element || element.type !== 'JSXElement' || !element.children.some((c) => c.type === 'JSXElement')) return undefined;
  const lines = neededCode(ast, text, [element], posix.dirname(routeFile), posix.join(previewDir, 'routes'));
  return [`// Written by Visual Editor (React plugin): the ${path} route's element, as the app's routes define it.`, '// @ts-nocheck', ...lines, '', `export default function RouteElement() {`, `  return (${exact(text, element)})`, `}`, ''].join('\n');
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
function neededCode(ast: t.File, text: string, nodes: t.Node[], fromDir: string, toDir: string): string[] {
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
    const moved = from.startsWith('.') ? relativeFrom(toDir, posix.join(fromDir, from)) : from;
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
