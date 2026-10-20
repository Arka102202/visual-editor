// The App panel (contract 8): a Preview panel showing what the running React app is made of. Its two scripts are
// built on their own (appPage: in the app's page; appPanel: in Visual Editor's window); this gives them to the shell,
// with the facts the panel needs from the project: which components are the developer's own, and which files export
// stores (Zustand, Redux).

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Field, Item, Link, PreviewPanel, ProjectInfo } from '@visual-editor/contract';

const ICON = '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M12 12l8-4.5M12 12v9M12 12L4 7.5"/>';

/** Files that make a store: they import Zustand or Redux and create one. */
export function isStoreFile(text: string): boolean {
  return (/from\s+['"]zustand(\/[\w/]+)?['"]/.test(text) && /\bcreate(Store)?\s*[(<]/.test(text)) || (/from\s+['"](@reduxjs\/toolkit|redux)['"]/.test(text) && /\b(configureStore|createStore)\s*\(/.test(text));
}

/** The project's store files (relative paths), read from its source. */
export function storeFiles(project: ProjectInfo, read: (path: string) => string = (p) => readFileSync(join(project.root, p), 'utf8')): string[] {
  const out: string[] = [];
  for (const path of project.files) {
    if (!/\.(m?[jt]sx?)$/.test(path) || /(\.test|\.spec|\.stories|\.d)\.[jt]sx?$/.test(path) || /(^|\/)(node_modules|dist|build)\//.test(path)) continue;
    let text: string;
    try {
      text = read(path);
    } catch {
      continue;
    }
    if (text.length < 300_000 && isStoreFile(text)) out.push(path);
    if (out.length >= 60) break;
  }
  return out;
}

// ---- Component mode: example props, and saved variants ----

/** A value for a prop, from its type as written (and its name: a title reads like a title). */
export function exampleFor(name: string, type = '', callback = false): unknown {
  const t = type.trim();
  if (callback || /=>/.test(t) || /^(on|handle)[A-Z]/.test(name)) return { $action: name };
  const parts = t.split('|').map((x) => x.trim()).filter((x) => x && x !== 'undefined' && x !== 'null');
  const literal = parts.find((x) => /^(['"`]).*\1$|^-?\d+(\.\d+)?$|^(true|false)$/.test(x));
  if (literal) return JSON.parse(literal.replace(/^['`](.*)['`]$/, '"$1"'));
  const one = parts[0] ?? '';
  if (/\[\]$|^(Readonly)?Array</.test(one)) return [];
  if (one === 'string') return textFor(name);
  if (one === 'number') return /count|total|size|amount|quantity|index|page/i.test(name) ? 3 : 42;
  if (one === 'boolean') return /^(is|show|open|visible|enabled|active|checked|selected|expanded)/i.test(name);
  if (/ReactNode|ReactElement|JSX\.Element|ReactChild/.test(one) || name === 'children') return textFor(name === 'children' ? 'label' : name);
  if (one === 'Date') return new Date(Date.UTC(2026, 9, 20, 9, 30)).toISOString();
  if (/^Record<|^\{/.test(one)) return {};
  return parts.length ? {} : null;
}

function textFor(name: string): string {
  const n = name.toLowerCase();
  if (/email/.test(n)) return 'ada@example.com';
  if (/url|href|link|src|image|avatar/.test(n)) return 'https://picsum.photos/seed/visual-editor/400/240';
  if (/date|at$/.test(n)) return '2026-10-20';
  if (/(^|_)id$|Id$/.test(name)) return 'id-1042';
  if (/name|author|user|owner/.test(n)) return 'Ada Lovelace';
  if (/desc|text|body|content|message|summary|note/.test(n)) return 'A short description, long enough to wrap onto a second line in narrow cards.';
  if (/status|state/.test(n)) return 'active';
  return name.replace(/^./, (c) => c.toUpperCase()).replace(/([a-z])([A-Z])/g, '$1 $2');
}

/** Example props for a component: the ones it needs (and children), from the types on its card. */
export function exampleProps(fields: Field[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    if (f.tag === 'optional' && f.name !== 'children') continue;
    out[f.name] = exampleFor(f.name, f.value, f.tag === 'callback');
  }
  return out;
}

/** Name.variants.json: a component's saved cases (each a name and its props), next to it, kept in the project. */
export interface VariantsFile {
  component: string;
  data: { name: string; props: Record<string, unknown> }[];
}

export function variantsPath(item: Item): string | undefined {
  return item.source ? join(dirname(item.source.path), `${item.label}.variants.json`) : undefined;
}

function readVariants(root: string, item: Item): VariantsFile {
  const rel = variantsPath(item);
  const file = rel ? join(root, rel) : undefined;
  try {
    if (file && existsSync(file)) {
      const data = JSON.parse(readFileSync(file, 'utf8'));
      return { component: item.label, data: Array.isArray(data.data) ? data.data : [] };
    }
  } catch {
    // Being edited: as if empty.
  }
  return { component: item.label, data: [] };
}

/** The pages a component is drawn on: the routes that show it, or show a component that draws it (by the map's lines). */
export function pagesOf(item: Item, items: Item[], links: Link[]): string[] {
  const seen = new Set([item.id]);
  const queue = [item.id];
  while (queue.length && seen.size < 500) {
    const id = queue.shift()!;
    for (const l of links) if (l.to === id && (l.kind === 'renders' || l.kind === 'uses') && !seen.has(l.from)) (seen.add(l.from), queue.push(l.from));
  }
  const byId = new Map(items.map((i) => [i.id, i]));
  const routes = links.filter((l) => l.kind === 'shows' && seen.has(l.to)).map((l) => byId.get(l.from)?.label).filter((x): x is string => !!x);
  // The plainest first: an address without :params can be opened as it is.
  return [...new Set(routes)].sort((a, b) => (a.match(/:/g) ?? []).length - (b.match(/:/g) ?? []).length || a.length - b.length);
}

/** What the App panel asks VS Code for. */
export function serve(request: unknown, project: ProjectInfo, items: Item[], links: Link[] = []): unknown {
  const r = request as { type: string; name?: string; variant?: string; props?: Record<string, unknown> };
  const item = items.find((i) => i.map === 'components' && i.label === r.name && i.source);
  if (r.type === 'component') {
    if (!item) return { found: false };
    return { found: true, file: item.source!.path, variants: variantsPath(item), example: exampleProps(item.fields ?? []), data: readVariants(project.root, item).data, pages: pagesOf(item, items, links) };
  }
  if (r.type === 'saveVariant') {
    if (!item) throw new Error(`${r.name} isn't one of the project's components, so its variants have nowhere to go.`);
    const rel = variantsPath(item)!;
    const file = readVariants(project.root, item);
    const name = (r.variant ?? '').trim() || `case ${file.data.length + 1}`;
    file.data = [...file.data.filter((d) => d.name !== name), { name, props: r.props ?? {} }];
    writeFileSync(join(project.root, rel), `${JSON.stringify(file, null, 2)}\n`);
    return { file: rel, name, data: file.data };
  }
  if (r.type === 'removeVariant') {
    if (!item) return { data: [] };
    const rel = variantsPath(item)!;
    const file = readVariants(project.root, item);
    file.data = file.data.filter((d) => d.name !== r.variant);
    writeFileSync(join(project.root, rel), `${JSON.stringify(file, null, 2)}\n`);
    return { file: rel, data: file.data };
  }
  return undefined;
}


/** The panel, given its two built scripts. */
export function appPanel(scripts: { page: string; panel: string }): PreviewPanel {
  return {
    id: 'app',
    name: 'App: components, stores, route and storage of the running app',
    icon: ICON,
    page: scripts.page,
    panel: scripts.panel,
    facts: (project: ProjectInfo, items: Item[]) => ({
      components: [...new Set(items.filter((i) => i.map === 'components').map((i) => i.label))],
      stores: storeFiles(project),
    }),
    serve,
  };
}

/** The built scripts next to the extension (dist/appPage.js, dist/appPanel.js); none in tests. */
export function builtScripts(dist: string): { page: string; panel: string } | undefined {
  try {
    // Served from elsewhere (the proxy, a blob): their source map links would lead nowhere.
    const read = (name: string) => readFileSync(join(dist, name), 'utf8').replace(/\n\/\/# sourceMappingURL=.*\s*$/, '\n');
    return { page: read('appPage.js'), panel: read('appPanel.js') };
  } catch {
    return undefined;
  }
}
