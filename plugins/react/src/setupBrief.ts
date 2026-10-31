// What a project needs before Preview works in it, for the Set up project agent (docs/variants.md): Vite or not,
// Visual Editor's helper and its short name, the providers file (what every preview is wrapped in), what the app wraps
// itself in (read from its entry file, and the top of its App), a providers file made from those, and the components
// to make previewable first. Reading only: the agent saves what it decides as a draft.

import { posix } from 'node:path';
import { parse } from '@babel/parser';
import type * as t from '@babel/types';
import type { Item, PluginTool, ToolContext } from '@visual-editor/contract';
import { helperTemplate, helperVersion } from './helper';
import { entryFile, helperFile, providersFile } from './previewPage';
import { PROVIDERS_PATH } from './providers';
import { setupProject } from './setup';

type Read = (path: string) => Promise<string | undefined>;

/** One thing the app is wrapped in, and what it becomes around a preview. */
export interface Wrapper {
  name: string;
  /** Where it's imported from (a package, or a file of the project). */
  from?: string;
  /** The file it's used in. */
  file: string;
  becomes: 'router' | 'queries' | 'same' | 'left out';
  note: string;
}

export interface Providers {
  wrappers: Wrapper[];
  /** A providers file made from them (undefined: nothing to wrap previews in). */
  text?: string;
  /** What to look at before using it. */
  checks: string[];
}

/** Names the app is wrapped in that a preview doesn't need. */
const LEAVE_OUT = /^(React\.)?(StrictMode|Suspense|Profiler)$|ErrorBoundary$|^(React\.)?Fragment$/;
const ROUTERS = /^(BrowserRouter|HashRouter|Router|MemoryRouter)$/;
/** What a provider is called: ThemeProvider, ChakraProvider, Provider, BrowserRouter, PersistGate… */
const PROVIDER_LIKE = /Provider$|Router$|^PersistGate$|^(React\.)?(StrictMode|Suspense)$|ErrorBoundary$/;

/** Providers from packages that talk to a server or sign in: previews block the network, so they may not draw. */
const TALKS = /^(Auth0Provider|ClerkProvider|SessionProvider|MsalProvider|ApolloProvider|UrqlProvider|ConvexProvider|FirebaseAppProvider|SupabaseProvider|KindeProvider|LiveblocksProvider|RelayEnvironmentProvider|PostHogProvider|StatsigProvider|LDProvider)$/;

/** A module of the project itself: a relative path, or one of its short names (@/x, ~/x, #x, src/x, @routes). */
export const own = (from: string | undefined) => !!from && (/^(\.|@\/|~\/|#|src\/)/.test(from) || /^@[^/]+$/.test(from));

const EXTENSIONS = ['', '.tsx', '.ts', '.jsx', '.js', '/index.tsx', '/index.ts', '/index.jsx', '/index.js'];

function parseCode(code: string): t.File | undefined {
  try {
    return parse(code, { sourceType: 'module', plugins: ['typescript', 'jsx'] });
  } catch {
    return undefined;
  }
}

const nameOf = (el: t.JSXElement): string => {
  const n = el.openingElement.name;
  if (n.type === 'JSXIdentifier') return n.name;
  if (n.type === 'JSXMemberExpression') return `${n.object.type === 'JSXIdentifier' ? n.object.name : '?'}.${n.property.name}`;
  return `${n.namespace.name}:${n.name.name}`;
};
const elements = (el: t.JSXElement | t.JSXFragment) => el.children.filter((c): c is t.JSXElement => c.type === 'JSXElement');

/** A file's imports: each name, the module and how it's imported. */
function importsOf(ast: t.File): Map<string, { from: string; imported: string }> {
  const out = new Map<string, { from: string; imported: string }>();
  for (const s of ast.program.body) {
    if (s.type !== 'ImportDeclaration' || s.importKind === 'type') continue;
    for (const sp of s.specifiers) {
      const imported = sp.type === 'ImportDefaultSpecifier' ? 'default' : sp.type === 'ImportNamespaceSpecifier' ? '*' : sp.imported.type === 'Identifier' ? sp.imported.name : sp.imported.value;
      out.set(sp.local.name, { from: s.source.value, imported });
    }
  }
  return out;
}

/** Top-level declarations of a file (const theme = createTheme(…)), by name: their source text. */
function topLevel(ast: t.File, code: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const s0 of ast.program.body) {
    const s = s0.type === 'ExportNamedDeclaration' && s0.declaration ? s0.declaration : s0;
    if (s.type === 'VariableDeclaration') for (const d of s.declarations) if (d.id.type === 'Identifier') out.set(d.id.name, code.slice(s.start!, s.end!));
    if ((s.type === 'FunctionDeclaration' || s.type === 'ClassDeclaration') && s.id) out.set(s.id.name, code.slice(s.start!, s.end!));
  }
  return out;
}

/** What render() is given in the entry file: <StrictMode><App /></StrictMode>. */
function rendered(ast: t.File): t.JSXElement | undefined {
  let found: t.JSXElement | undefined;
  const visit = (n: unknown): void => {
    if (found || !n || typeof n !== 'object') return;
    const node = n as t.Node;
    if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression' && node.callee.property.type === 'Identifier' && node.callee.property.name === 'render' && node.arguments[0]?.type === 'JSXElement') {
      found = node.arguments[0];
      return;
    }
    for (const [k, v] of Object.entries(node)) if (k !== 'loc' && k !== 'leadingComments' && k !== 'trailingComments') Array.isArray(v) ? v.forEach(visit) : visit(v);
  };
  visit(ast.program);
  return found;
}

/** The JSX a component returns at its top (function App() { return (…) }, or const App = () => (…)). */
function returnedBy(ast: t.File, name: string | undefined): t.JSXElement | undefined {
  const bodyOf = (f: t.Node | null | undefined): t.JSXElement | undefined => {
    if (!f || (f.type !== 'FunctionDeclaration' && f.type !== 'ArrowFunctionExpression' && f.type !== 'FunctionExpression')) return undefined;
    const unwrap = (e: t.Node | null | undefined): t.JSXElement | undefined => (e?.type === 'JSXElement' ? e : e?.type === 'ParenthesizedExpression' ? unwrap(e.expression) : undefined);
    if (f.body.type !== 'BlockStatement') return unwrap(f.body);
    const ret = f.body.body.find((s): s is t.ReturnStatement => s.type === 'ReturnStatement');
    return unwrap(ret?.argument);
  };
  for (const s of ast.program.body) {
    if (s.type === 'ExportDefaultDeclaration') {
      if (s.declaration.type === 'Identifier') name = s.declaration.name;
      else if (!name || (s.declaration.type === 'FunctionDeclaration' && s.declaration.id?.name === name) || !s.declaration.type.includes('Declaration')) {
        const got = bodyOf(s.declaration);
        if (got) return got;
      }
    }
  }
  for (const s0 of ast.program.body) {
    const s = s0.type === 'ExportNamedDeclaration' && s0.declaration ? s0.declaration : s0;
    if (s.type === 'FunctionDeclaration' && s.id?.name === name) return bodyOf(s);
    if (s.type === 'VariableDeclaration') for (const d of s.declarations) if (d.id.type === 'Identifier' && d.id.name === name) return bodyOf(d.init);
  }
  return undefined;
}

async function resolve(read: Read, from: string, spec: string): Promise<string | undefined> {
  if (!spec.startsWith('.')) return undefined;
  const base = posix.normalize(posix.join(posix.dirname(from), spec));
  for (const ext of EXTENSIONS) if ((await read(base + ext)) !== undefined) return base + ext;
  return undefined;
}

/** Everything the providers file needs from one file: imports to copy, top-level code to copy, what can't come. */
class Needs {
  imports = new Map<string, Map<string, string>>();
  code = new Map<string, string>();
  missing = new Set<string>();
  constructor(private target: string) {}
  /** The names an expression or element uses, brought from where `file` gets them. */
  take(names: Iterable<string>, file: string, ast: t.File, code: string, seen = new Set<string>()) {
    const imports = importsOf(ast);
    const tops = topLevel(ast, code);
    for (const name of names) {
      const key = `${file}#${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const root = name.split('.')[0];
      const imp = imports.get(root);
      if (imp) {
        // Relative to the providers file (src/visual-editor.providers.tsx), as the project writes paths.
        const from = imp.from.startsWith('.') ? relative(this.target, posix.normalize(posix.join(posix.dirname(file), imp.from))) : imp.from;
        const m = this.imports.get(from) ?? new Map<string, string>();
        m.set(root, imp.imported);
        this.imports.set(from, m);
      } else if (tops.has(root)) {
        const text = tops.get(root)!;
        this.code.set(root, text.replace(/^export\s+/, ''));
        this.take(identifiers(text).filter((n) => n !== root), file, ast, code, seen);
      } else if (!GLOBALS.has(root)) this.missing.add(root);
    }
  }
  importLines(): string[] {
    return [...this.imports].map(([from, names]) => {
      const def = [...names].find(([, i]) => i === 'default')?.[0];
      const ns = [...names].find(([, i]) => i === '*')?.[0];
      const named = [...names].filter(([, i]) => i !== 'default' && i !== '*').map(([l, i]) => (l === i ? l : `${i} as ${l}`));
      const parts = [def, ns ? `* as ${ns}` : undefined, named.length ? `{ ${named.join(', ')} }` : undefined].filter(Boolean);
      return `import ${parts.join(', ')} from '${from}'`;
    });
  }
}

const GLOBALS = new Set(['React', 'window', 'document', 'undefined', 'null', 'true', 'false', 'JSON', 'Math', 'Object', 'Array', 'String', 'Number', 'Boolean', 'Date', 'console', 'process', 'new', 'import', 'meta', 'env']);
const relative = (fromFile: string, to: string) => {
  const r = posix.relative(posix.dirname(fromFile), to).replace(/\.(tsx|ts|jsx|js)$/, '').replace(/\/index$/, '');
  return r.startsWith('.') ? r : `./${r}`;
};
/** Identifiers in a piece of code (roughly: names, not property names after a dot or as an object's keys, not in strings). */
const identifiers = (code: string) =>
  [...new Set([...code.replace(/(['"`])(?:\\.|(?!\1).)*\1/g, '""').replace(/([{,]\s*)[A-Za-z_$][\w$]*(\s*:)/g, '$1$2').matchAll(/(?<![.\w$])[A-Za-z_$][\w$]*/g)].map((m) => m[0]))].filter((n) => !/^(const|let|var|function|return|new|true|false|null|undefined|typeof|if|else|export|default|class|extends|this|async|await|of|in|for|while)$/.test(n));

/**
 * What the app is wrapped in, read from its entry file's render() and the top of its App (providers only, down to the
 * first thing that isn't one), and a providers file made from them: routers become one in memory, React Query gets
 * its own client that doesn't retry, StrictMode and error boundaries are left out, the rest stays as it is.
 */
export async function readProviders(read: Read, entry: string, deps: Record<string, string> = {}): Promise<Providers> {
  const code = await read(entry);
  const ast = code ? parseCode(code) : undefined;
  const top = ast ? rendered(ast) : undefined;
  if (!code || !ast || !top) return { wrappers: [], checks: [`${entry} couldn't be read for what the app is wrapped in: write the providers file by hand.`] };
  const wrappers: Wrapper[] = [];
  const checks: string[] = [];
  const needs = new Needs(PROVIDERS_PATH);
  let router: string | undefined;
  let queries: string | undefined;

  /** What an element is around a preview: a wrapper (kept or changed), a package's piece to keep (<CssBaseline />, a
   * Toaster), or the app's own part (it becomes {children}, once). */
  type Part = 'wrapper' | 'keep' | 'app';
  /**
   * The JSX for a preview: `el` rewritten, the app's own part replaced by {children}. Returns undefined for the app's
   * own part after {children} is placed.
   */
  const rewrite = (el: t.JSXElement, file: string, fileAst: t.File, fileCode: string, partOf: (e: t.JSXElement) => Part, placed: { done: boolean }, depth: number): string | undefined => {
    const pad = '  '.repeat(depth);
    const part = partOf(el);
    const name = nameOf(el);
    const imports = importsOf(fileAst);
    const from = imports.get(name.split('.')[0])?.from;
    const attrs = fileCode.slice(el.openingElement.name.end!, el.openingElement.selfClosing ? el.openingElement.end! - 2 : el.openingElement.end! - 1).trim();
    if (part === 'app') {
      if (placed.done) return undefined;
      placed.done = true;
      return `${pad}{children}`;
    }
    if (part === 'keep') {
      needs.take([name, ...identifiers(attrs.replace(/\b[\w-]+=(?=\{|")/g, ''))], file, fileAst, fileCode);
      wrappers.push({ name, from, file, becomes: 'same', note: 'kept next to the preview (it adds styles or listens, and draws nothing of the app)' });
      return `${pad}<${name}${attrs ? ` ${attrs}` : ''} />`;
    }
    const inner = (d = depth + 1) =>
      el.children
        .filter((c) => c.type === 'JSXElement')
        .map((c) => rewrite(c as t.JSXElement, file, fileAst, fileCode, partOf, placed, d))
        .filter((l): l is string => l !== undefined);
    const wrap = (open: string, close: string, kids: string[]) => (kids.length ? [`${pad}${open}`, ...kids, `${pad}${close}`].join('\n') : `${pad}${open.replace(/>$/, ' />')}`);

    if (LEAVE_OUT.test(name)) {
      wrappers.push({ name, from, file, becomes: 'left out', note: 'not needed around a preview' });
      return inner(depth).join('\n');
    }
    if (ROUTERS.test(name) || name === 'RouterProvider') {
      router = from === 'react-router' ? 'react-router' : 'react-router-dom';
      wrappers.push({ name, from, file, becomes: 'router', note: 'a router in memory (MemoryRouter): links show where they would go, and the preview stays on its one page' });
      // (RouterProvider holds the app's routes itself: the preview goes inside the router.)
      if (name === 'RouterProvider') placed.done = true;
      return wrap('<MemoryRouter>', '</MemoryRouter>', name === 'RouterProvider' ? [`${pad}  {children}`] : inner());
    }
    if (name === 'QueryClientProvider') {
      queries = from ?? '@tanstack/react-query';
      wrappers.push({ name, from, file, becomes: 'queries', note: 'its own query client that never retries (previews have no network)' });
      return wrap('<QueryClientProvider client={previewQueries}>', '</QueryClientProvider>', inner());
    }
    // Kept as it is: its own name, and what its attributes use, brought along.
    needs.take([name, ...identifiers(attrs.replace(/\b[\w-]+=(?=\{|")/g, ''))], file, fileAst, fileCode);
    const theirs = own(from);
    const talks = !theirs && TALKS.test(name);
    wrappers.push({ name, from, file, becomes: 'same', note: theirs ? 'kept: the project’s own, so check it doesn’t load anything (previews block the network)' : talks ? 'kept, but it talks to a server: check previews draw with it' : 'kept as it is' });
    if (theirs) checks.push(`${name} (${from}) is the project's own: if it loads data or signs in, give previews a version with fixed data instead.`);
    if (talks) checks.push(`${name} (${from}) talks to a server or signs in, and previews block the network: if a preview doesn't draw with it, leave it out or give previews its test version (for example MockedProvider for Apollo).`);
    return wrap(`<${name}${attrs ? ` ${attrs}` : ''}>`, `</${name}>`, inner());
  };
  const fromPackage = (e: t.JSXElement, imports: Map<string, { from: string }>) => {
    const from = imports.get(nameOf(e).split('.')[0])?.from;
    return !!from && !own(from);
  };

  // The entry: everything on the way to <App /> wraps it; next to it, a package's piece with nothing inside is kept.
  const entryImports = importsOf(ast);
  const appEl = (function find(el: t.JSXElement): t.JSXElement | undefined {
    if (!elements(el).length && own(entryImports.get(nameOf(el).split('.')[0])?.from)) return el;
    for (const c of elements(el)) {
      const f = find(c);
      if (f) return f;
    }
    return undefined;
  })(top);
  const entryPart = (e: t.JSXElement): Part => (e === appEl ? 'app' : elements(e).length || ROUTERS.test(nameOf(e)) || nameOf(e) === 'RouterProvider' ? 'wrapper' : fromPackage(e, entryImports) ? 'keep' : 'app');
  let body = rewrite(top, entry, ast, code, entryPart, { done: false }, 2) ?? '    {children}';

  // The top of the App: providers it puts around its pages (ThemeProvider, BrowserRouter…), down to its own part.
  const appName = appEl ? nameOf(appEl) : undefined;
  const appFrom = appName ? entryImports.get(appName) : undefined;
  const appFile = appFrom ? await resolve(read, entry, appFrom.from) : undefined;
  const appCode = appFile ? await read(appFile) : undefined;
  const appAst = appCode ? parseCode(appCode) : undefined;
  const appTop = appAst ? returnedBy(appAst, appFrom?.imported === 'default' ? undefined : appFrom?.imported) : undefined;
  if (appFile && appCode && appAst && appTop && PROVIDER_LIKE.test(nameOf(appTop)) && elements(appTop).length) {
    const appImports = importsOf(appAst);
    const appPart = (e: t.JSXElement): Part =>
      !elements(e).length ? (fromPackage(e, appImports) && !/^(Routes|Route|Outlet|RouterProvider)$/.test(nameOf(e)) ? 'keep' : nameOf(e) === 'RouterProvider' ? 'wrapper' : 'app') : PROVIDER_LIKE.test(nameOf(e)) ? 'wrapper' : 'app';
    const inner = rewrite(appTop, appFile, appAst, appCode, appPart, { done: false }, 0) ?? '{children}';
    body = body.replace(/^( *)\{children\}$/m, (_m, pad: string) => inner.split('\n').map((l) => pad + l).join('\n'));
  }

  // The app uses react-router, but its router is inside its own part (<AppRouter />): links in previews still need one.
  const routerPackage = deps['react-router-dom'] ? 'react-router-dom' : deps['react-router'] ? 'react-router' : undefined;
  if (!router && routerPackage) {
    router = routerPackage;
    wrappers.push({ name: 'MemoryRouter', from: routerPackage, file: entry, becomes: 'router', note: `added: the app uses ${routerPackage}, and links in a preview need a router (one in memory)` });
    body = body.replace(/^( *)\{children\}$/m, (_m, pad: string) => `${pad}<MemoryRouter>\n${pad}  {children}\n${pad}</MemoryRouter>`);
  }

  // What the entry runs besides drawing the app (a theme set on <html>, a service worker…): previews don't run it.
  const before = ast.program.body
    .filter((st): st is t.ExpressionStatement => st.type === 'ExpressionStatement' && !(st.expression.type === 'CallExpression' && st.expression.callee.type === 'MemberExpression' && st.expression.callee.property.type === 'Identifier' && st.expression.callee.property.name === 'render'))
    .map((st) => code.slice(st.start!, st.end!).replace(/\s+/g, ' ').slice(0, 90));
  if (before.length) checks.push(`${entry} also runs this before the app draws, which previews don't: ${before.map((b) => `\`${b}\``).join('; ')}. If one sets the look (a theme on <html>, a font), do the same in the providers file; leave out the rest.`);

  if (needs.missing.size) checks.push(`These are made inside a component, so they can't come along as they are: ${[...needs.missing].join(', ')}. Give previews a fixed value for each (the default the app starts with).`);
  const kept = wrappers.filter((w) => w.becomes !== 'left out');
  if (!kept.length) return { wrappers, checks };

  const lines = [
    '// What every Visual Editor preview (Preview, Playground) is wrapped in: what the app is wrapped in, made for previews.',
    "// Your file: add what else previews need. The app itself doesn't use it.",
    "import type { ReactNode } from 'react'",
    ...(router ? [`import { MemoryRouter } from '${router}'`] : []),
    ...(queries ? [`import { QueryClient, QueryClientProvider } from '${queries}'`] : []),
    ...needs.importLines(),
    '',
    ...[...needs.code.values()].flatMap((c) => [c, '']),
    ...(queries ? ['// Previews have no network: a query never waits for retries.', 'const previewQueries = new QueryClient({ defaultOptions: { queries: { retry: false } } })', ''] : []),
    'export default function PreviewProviders({ children }: { children: ReactNode }) {',
    '  return (',
    body,
    '  )',
    '}',
    '',
  ];
  return { wrappers, text: lines.join('\n'), checks };
}

/** Components to make previewable first: plain ones (no data of their own), shortest first. */
export async function firstCandidates(items: Item[], read: Read, max = 5): Promise<{ item: Item; lines: number }[]> {
  const not = items.filter((i) => i.map === 'components' && !i.preview && i.source);
  // Plain ones first; a fresh app may have only its App: then any.
  const plainOnes = not.filter((i) => i.kind === 'component' || i.kind === 'shared');
  const plain = plainOnes.length ? plainOnes : not;
  const sized = await Promise.all(plain.map(async (item) => ({ item, lines: (await read(item.source!.path))?.split('\n').length ?? 0 })));
  return sized.filter((s) => s.lines >= 5 || sized.length === 1).sort((a, b) => a.lines - b.lines || a.item.label.localeCompare(b.item.label)).slice(0, max);
}

/** The whole brief, in words. */
export async function setupBriefText(ctx: Pick<ToolContext, 'project' | 'items' | 'read'>, template: string | undefined = helperTemplate()): Promise<string> {
  const { project, items } = ctx;
  const read: Read = (p) => ctx.read(p);
  const out: string[] = [`# Setting up ${project.name} for Preview`];
  const vite = project.files.find((f) => /^vite\.config\.[cm]?[jt]s$/.test(f));
  if (!vite) {
    const other = project.files.some((f) => /^next\.config\./.test(f)) ? 'Next.js' : project.packageJson?.dependencies?.['react-scripts'] || project.packageJson?.devDependencies?.['react-scripts'] ? 'Create React App' : 'no Vite config';
    out.push('', `NOT SUPPORTED: only Vite projects can be set up for now, and this one uses ${other}. Don't change anything: tell the developer so.`);
    return out.join('\n');
  }

  // The helper and its short name (Visual Editor keeps them in place by itself when the project is opened).
  const files = new Map<string, string | undefined>();
  for (const p of ['.visual-editor/react/visual-editor.tsx', 'tsconfig.app.json', 'tsconfig.json', 'jsconfig.json', vite]) files.set(p, await read(p));
  const setup = setupProject((p) => files.get(p), template);
  const helper = helperFile(project);
  out.push('', '## Visual Editor’s helper');
  if (!setup) out.push(`Ready: ${helper ?? '.visual-editor/react/visual-editor.tsx'} (version ${helperVersion(files.get('.visual-editor/react/visual-editor.tsx') ?? '')}), and its short name @visual-editor/react in the TypeScript and Vite configs.`);
  else {
    if (setup.changes.length) out.push(`Not all in place: ${setup.changes.map((c) => c.path).join(', ')}. Visual Editor writes these by itself when the project is opened: don't put them in the draft; tell the developer to open the folder again if they stay missing.`);
    for (const p of setup.problems ?? []) out.push(`Problem: ${p}`);
  }

  // The providers file.
  out.push('', '## The providers file (what every preview is wrapped in)');
  const theEntry = await entryFileAsync(read);
  const deps = { ...(project.packageJson?.dependencies ?? {}), ...(project.packageJson?.devDependencies ?? {}) } as Record<string, string>;
  const providers = theEntry ? await readProviders(read, theEntry, deps) : { wrappers: [], checks: ['The app\'s entry file wasn\'t found (index.html\'s module script, or src/main.tsx).'] };
  const existing = providersFile(project);
  if (theEntry) out.push(`The app starts in ${theEntry}.`);
  if (providers.wrappers.length) {
    out.push('What the app is wrapped in, and what each becomes around a preview:');
    for (const w of providers.wrappers) out.push(`- ${w.name}${w.from ? ` (from ${w.from})` : ''}, in ${w.file}: ${w.becomes === 'left out' ? 'left out' : w.becomes === 'same' ? 'the same' : w.becomes === 'router' ? 'a router in memory' : 'its own query client'}: ${w.note}`);
  } else out.push('The app isn’t wrapped in anything: previews need no providers file.');
  for (const c of providers.checks) out.push(`Check: ${c}`);
  if (existing) out.push('', `There is one already, ${existing}: keep it, and add only what's missing from what the app is wrapped in.`, '```tsx', (await read(existing)) ?? '', '```');
  if (providers.text) out.push('', `${existing ? 'Made from what the app is wrapped in (for comparing)' : `Suggested ${PROVIDERS_PATH}`}, made from what the app is wrapped in (look at it, change what the checks say, then save it in the draft):`, '```tsx', providers.text, '```');

  // What's previewable, and what to make previewable first.
  const components = items.filter((i) => i.map === 'components');
  const ready = components.filter((i) => i.preview);
  out.push('', '## Previewable components');
  if (ready.length) out.push(`${ready.length} already: ${ready.map((i) => i.label).join(', ')}. Making one more is not needed unless the developer asks.`);
  else {
    const first = await firstCandidates(items, read);
    if (!first.length) out.push('None, and no plain component to start with: say so; the developer can start a "New component" session instead.');
    else {
      out.push('None yet. Make one previewable, to prove Preview works here: the one the developer named, or the first of these (plain ones if there are any, the shortest first):');
      for (const f of first) out.push(`- ${f.item.label} · ${f.item.id} · ${f.item.source!.path} (${f.lines} lines)`);
    }
  }
  return out.join('\n');
}

async function entryFileAsync(read: Read): Promise<string | undefined> {
  const html = (await read('index.html')) ?? '';
  const known = entryFile((p) => (p === 'index.html' ? html : undefined));
  if (known) return known;
  for (const p of ['src/main.tsx', 'src/main.ts', 'src/main.jsx', 'src/index.tsx', 'src/index.jsx']) if ((await read(p)) !== undefined) return p;
  return undefined;
}

export const setupBriefTool: PluginTool = {
  name: 'setup_brief',
  title: 'What the project needs for Preview',
  summary: 'Says what a project still needs before Preview works in it: the helper, the providers file (made from what the app is wrapped in), and a first component to make previewable.',
  description:
    'Everything needed to set a React project up for Preview and the Playground: whether it can be (Vite only for now), Visual Editor\'s helper, what the app is wrapped in (router, theme, store, queries…) and a providers file made from it, and the components to make previewable first. Use before setting a project up; with a draft, it reads the project as the draft would leave it.',
  run: (_input, ctx) => setupBriefText(ctx),
};
