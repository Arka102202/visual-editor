// The React model as cards and lines, and reading files into it: pure, with no VS Code parts, so it can
// run anywhere (in a worker thread for big projects, or in tests).

import type { Item, Link, ProjectInfo, ReadResult, SourceFile } from '@visual-editor/contract';
import { analyzeProject, IGNORED_FILE } from './read/analyzer';
import type { FeComponent, FeModel } from './read/model';
import { loadAliases } from './read/resolve';
import { readVariantFolders } from './read/variants';
import { checkFolder } from './read/variantChecks';

const CODE = /\.[cm]?[jt]sx?$/;
/** Files that say how imports like "@/components/Card" resolve. */
const CONFIG = /(^|\/)(tsconfig[\w.-]*\.json|jsconfig\.json|(vite|webpack)\.config\.[cm]?[jt]s)$/;

/** Shared pieces are used by this many components or more. */
export const SHARED_FROM = 3;
export const SHARED_FROM_WORDS = `${SHARED_FROM} or more`;

export const componentId = (c: { id: string }) => `react:component:${c.id}`;
export const routeId = (path: string) => `react:route:${path}`;
export const apiId = (id: string) => `react:api:${id}`;

const REACT_PACKAGES = ['react', 'preact', 'react-native'];

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
  const model = analyzeProject(code, loadAliases(configs));
  return { ...model, variantFolders: readVariantFolders(code).map((f) => ({ ...f, problems: checkFolder(f, code, model.components) })) };
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
  // A folder made previewable is one card: its chooser (index.tsx). Its other pieces (the real data, the switcher, the
  // variants) are parts of that card: their lines start from it, and the card knows its variants and states.
  const partOf = new Map<string, string>();
  const preview = new Map<string, Item['preview']>();
  /** A folder card's real data file (what it does with data is there, not in the chooser or the switcher). */
  const dataFile = new Map<string, string | undefined>();
  for (const f of model.variantFolders ?? []) {
    const chooser = model.components.find((c) => c.path === f.files.chooser && c.name === f.name) ?? model.components.find((c) => c.path === f.files.chooser);
    if (!chooser) continue;
    const inFolder = (p: string) => (f.dir ? p.startsWith(`${f.dir}/`) && !p.slice(f.dir.length + 1).includes('/') : !p.includes('/'));
    for (const c of model.components) if (c.id !== chooser.id && inFolder(c.path)) partOf.set(c.id, chooser.id);
    preview.set(chooser.id, { variants: f.variants.map((v) => ({ ...v, inUse: v.id === f.selected })), states: f.states, ...(f.problems?.length ? { problems: f.problems } : {}) });
    dataFile.set(chooser.id, f.files.data);
  }
  const own = (id: string) => partOf.get(id) ?? id;
  // Visual Editor's helper (src/visual-editor.tsx) is plumbing, not part of the app: no cards for it.
  const helper = (path: string) => /(^|\/)visual-editor\.[cm]?[jt]sx?$/.test(path);
  const byId = new Map(model.components.map((c) => [c.id, c]));
  const layouts = new Set(model.routes.flatMap((r) => r.layouts ?? []));
  // Who uses each component: renders it, or passes it on (e.g. as a React Flow node type).
  const users = new Map<string, Set<string>>();
  for (const c of model.components) {
    for (const r of c.renders) if (r.target && own(r.target) !== own(c.id)) users.set(own(r.target), (users.get(own(r.target)) ?? new Set()).add(own(c.id)));
    for (const u of c.usedBy) if (u.from && own(u.from) !== own(c.id)) users.set(own(c.id), (users.get(own(c.id)) ?? new Set()).add(own(u.from)));
  }

  // Components: props on the card; "renders" and "uses" lines between them.
  for (const c of model.components) {
    if (helper(c.path)) continue;
    // A part of a previewable folder: its lines are its folder card's.
    if (partOf.has(c.id)) {
      for (const r of c.renders) if (r.target && byId.has(r.target) && own(r.target) !== own(c.id)) link(componentId({ id: own(c.id) }), componentId({ id: own(r.target) }), 'renders');
      continue;
    }
    const shows = preview.get(c.id);
    // A folder card does with data what its real data file does (the chooser only asks Visual Editor's helper for
    // the key: that isn't app data).
    const parts = shows ? model.components.filter((p) => partOf.get(p.id) === c.id) : [];
    const whole = shows ? { ...c, data: parts.filter((p) => p.path === dataFile.get(c.id)).flatMap((p) => p.data), routes: [...new Set([...c.routes, ...parts.flatMap((p) => p.routes)])] } : c;
    items.push({
      id: componentId(c),
      map: 'components',
      kind: kindOf(whole, layouts, users.get(c.id)?.size ?? 0),
      label: c.name,
      sub: c.routes.length ? `${c.routes.join(', ')} · ${c.path}` : c.path,
      fields: c.props.map((p) => ({ name: p.name, ...(p.type ? { value: p.type } : {}), ...(p.isCallback ? { tag: 'callback' } : p.optional ? { tag: 'optional' } : {}) })),
      source: { path: c.path, line: c.line + 1 },
      ...(shows ? { preview: shows } : {}),
    });
    for (const r of c.renders) if (r.target && own(r.target) !== c.id && byId.has(r.target)) link(componentId(c), componentId({ id: own(r.target) }), 'renders');
    for (const u of c.usedBy) {
      if (u.how === 'references' && u.from && own(u.from) !== c.id && byId.has(u.from)) link(componentId({ id: own(u.from) }), componentId(c), 'uses');
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
    if (target) link(routeId(r.path), componentId({ id: own(target.id) }), 'shows');
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
      fields: e.callers.map((k) => ({ name: byId.get(own(k.component))?.name ?? k.component, ...(k.trigger ? { value: WHEN[k.trigger] } : {}), ...(k.via ? { tag: 'via hook' } : {}) })),
      ...(first ? { source: { path: first.request.path, line: first.request.line + 1 } } : {}),
    });
    for (const k of e.callers) if (byId.has(k.component)) link(componentId({ id: own(k.component) }), apiId(e.id), k.trigger === 'action' ? 'calls on click' : k.trigger === 'load' ? 'calls on load' : 'calls');
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
