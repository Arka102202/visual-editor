// The React plugin itself (no VS Code imports, so it can be tested on its own): finds React projects, reads their
// components, pages and API calls, and gives the shell three maps.

import { CONTRACT_VERSION, type Item, type Link, type MapDefinition, type Plugin, type ProjectInfo, type ReadResult, type SourceFile } from '@visual-editor/contract';
import { analyzeProject, IGNORED_FILE } from './read/analyzer';
import type { FeComponent, FeModel } from './read/model';
import { loadAliases } from './read/resolve';

const CODE = /\.[cm]?[jt]sx?$/;
/** Files that say how imports like "@/components/Card" resolve. */
const CONFIG = /(^|\/)(tsconfig[\w.-]*\.json|jsconfig\.json|(vite|webpack)\.config\.[cm]?[jt]s)$/;
const REACT_PACKAGES = ['react', 'preact', 'react-native'];

/** Shared pieces are used by this many components or more. */
export const SHARED_FROM = 3;
const SHARED_FROM_WORDS = `${SHARED_FROM} or more`;

export const MAPS: MapDefinition[] = [
  {
    id: 'components',
    title: 'Components',
    description: 'Every component with its props; lines show what renders what.',
    kinds: {
      page: 'A whole screen: the component a route shows when someone opens its address.',
      layout: 'The frame around pages (header, sidebar, menus), with the page shown inside it.',
      shared: `A common building block, used by ${SHARED_FROM_WORDS} other components. Changing it changes all of them.`,
      'uses data': 'Talks to data: it calls an API, or reads a store, context or database.',
      component: 'A plain piece of the screen: it shows what it is given and has no data of its own.',
    },
    lines: {
      renders: 'The first component draws the second one inside itself.',
      uses: 'The first component passes the second one on without drawing it itself (for example as a node type or a route element).',
    },
  },
  {
    id: 'pages',
    title: 'Pages',
    description: 'The routes of the app; lines show which page sits inside which.',
    kinds: { route: 'An address in the app, like /settings, and the screen it opens.' },
    lines: { contains: 'The second route sits inside the first: its address starts with the first one.' },
  },
  {
    id: 'api',
    title: 'API calls',
    description: 'Each address the app calls, which components call it, and when (on load or on a click).',
    kinds: { 'api call': 'An address the app calls on a server, like GET /api/orders, with the components that call it.' },
  },
];

export const componentId = (c: { id: string }) => `react:component:${c.id}`;
export const routeId = (path: string) => `react:route:${path}`;
export const apiId = (id: string) => `react:api:${id}`;

/** Which React package the project uses, when it does. */
export function reactPackage(project: ProjectInfo): string | undefined {
  const deps = { ...project.packageJson?.dependencies, ...project.packageJson?.devDependencies, ...project.packageJson?.peerDependencies as Record<string, string> | undefined };
  return REACT_PACKAGES.find((p) => deps[p]);
}

export function wantsFile(path: string): boolean {
  return (CODE.test(path) && !path.endsWith('.d.ts') && !IGNORED_FILE.test(path)) || CONFIG.test(path);
}

/** Reads the files into the React model. */
export function readModel(files: SourceFile[]): FeModel {
  const code = files.filter((f) => CODE.test(f.path) && !CONFIG.test(f.path));
  const configs = files.filter((f) => CONFIG.test(f.path));
  return analyzeProject(code, loadAliases(configs));
}

const WHEN: Record<string, string> = { load: 'on load', action: 'on click' };

/** The React model as cards and lines on three maps. */
export function toMaps(model: FeModel): ReadResult {
  const items: Item[] = [];
  const links: Link[] = [];
  const seen = new Set<string>();
  const link = (from: string, to: string, kind: string) => {
    const key = `${from}|${to}|${kind}`;
    if (!seen.has(key)) {
      seen.add(key);
      links.push({ from, to, kind });
    }
  };
  const byId = new Map(model.components.map((c) => [c.id, c]));
  const layouts = new Set(model.routes.flatMap((r) => r.layouts ?? []));
  // Who uses each component: renders it, or passes it on (e.g. as a React Flow node type).
  const users = new Map<string, Set<string>>();
  for (const c of model.components) {
    for (const r of c.renders) if (r.target && r.target !== c.id) users.set(r.target, (users.get(r.target) ?? new Set()).add(c.id));
    for (const u of c.usedBy) if (u.from && u.from !== c.id) users.set(c.id, (users.get(c.id) ?? new Set()).add(u.from));
  }

  // Components: props on the card; "renders" and "uses" lines between them.
  for (const c of model.components) {
    items.push({
      id: componentId(c),
      map: 'components',
      kind: kindOf(c, layouts, users.get(c.id)?.size ?? 0),
      label: c.name,
      sub: c.routes.length ? `${c.routes.join(', ')} · ${c.path}` : c.path,
      fields: c.props.map((p) => ({ name: p.name, ...(p.type ? { value: p.type } : {}), ...(p.isCallback ? { tag: 'callback' } : p.optional ? { tag: 'optional' } : {}) })),
      source: { path: c.path, line: c.line + 1 },
    });
    for (const r of c.renders) if (r.target && r.target !== c.id && byId.has(r.target)) link(componentId(c), componentId({ id: r.target }), 'renders');
    for (const u of c.usedBy) {
      if (u.how === 'references' && u.from && u.from !== c.id && byId.has(u.from)) link(componentId({ id: u.from }), componentId(c), 'uses');
    }
  }

  // Pages: one card per route, inside its closest parent route; each shows its component.
  const routes = model.routes.filter((r, i, all) => all.findIndex((x) => x.path === r.path) === i);
  const paths = routes.map((r) => r.path);
  for (const r of routes) {
    const target = r.target ? byId.get(r.target) : undefined;
    items.push({
      id: routeId(r.path),
      map: 'pages',
      kind: 'route',
      label: r.path,
      sub: target?.name ?? r.label,
      fields: (r.layouts ?? []).map((l) => ({ name: byId.get(l)?.name ?? l, tag: 'layout' })),
      source: { path: r.file, line: r.line + 1 },
    });
    const parent = parentRoute(r.path, paths);
    if (parent) link(routeId(parent), routeId(r.path), 'contains');
    if (target) link(routeId(r.path), componentId(target), 'shows');
  }

  // API calls: one card per address; components call it on load or on a click.
  for (const e of model.apis) {
    const first = e.callers[0];
    items.push({
      id: apiId(e.id),
      map: 'api',
      kind: 'api call',
      label: e.id,
      sub: `${e.callers.length} caller${e.callers.length === 1 ? '' : 's'}${e.issues.length ? ` · ${e.issues.length} problem${e.issues.length === 1 ? '' : 's'}` : ''}`,
      fields: e.callers.map((k) => ({ name: byId.get(k.component)?.name ?? k.component, ...(k.trigger ? { value: WHEN[k.trigger] } : {}), ...(k.via ? { tag: 'via hook' } : {}) })),
      ...(first ? { source: { path: first.request.path, line: first.request.line + 1 } } : {}),
    });
    for (const k of e.callers) if (byId.has(k.component)) link(componentId({ id: k.component }), apiId(e.id), k.trigger === 'action' ? 'calls on click' : k.trigger === 'load' ? 'calls on load' : 'calls');
  }
  return { items, links };
}



/**
 * What a component is, in the developer's words: a page (on a route), a layout (around pages), a shared piece (used by
 * several), one that uses data (API, store, context), or a plain component.
 */
export function kindOf(c: FeComponent, layouts: Set<string>, users: number): string {
  if (c.routes.length) return 'page';
  if (layouts.has(c.id)) return 'layout';
  if (users >= SHARED_FROM) return 'shared';
  // Read from the code: it calls an API or reads a store, context or database.
  if (c.data.some((d) => d.kind !== 'router')) return 'uses data';
  return 'component';
}

/** The longest other route whose address starts this one ("/shop" contains "/shop/:id"). */
export function parentRoute(path: string, all: string[]): string | undefined {
  const parts = path.split('/').filter(Boolean);
  for (let n = parts.length - 1; n >= 0; n--) {
    const candidate = '/' + parts.slice(0, n).join('/');
    if (candidate !== path && all.includes(candidate)) return candidate;
  }
  return undefined;
}

/** A component's own card, for other parts of the plugin. */
export function componentById(model: FeModel, itemId: string): FeComponent | undefined {
  return model.components.find((c) => componentId(c) === itemId);
}

export const reactPlugin: Plugin = {
  id: 'react',
  name: 'React',
  version: '0.1.0',
  contract: CONTRACT_VERSION,
  description: 'Components and their props, pages, and API calls, for React apps.',
  detect: (project) => {
    const pkg = reactPackage(project);
    return pkg ? { reason: `${pkg} is in package.json` } : undefined;
  },
  maps: MAPS,
  readers: [{ id: 'react', wants: wantsFile, read: (files) => toMaps(readModel(files)) }],
};
