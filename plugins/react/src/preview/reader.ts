// Previews from static data. For one component (the root), the whole tree it draws (every component it draws, or
// hands on, all the way down) is found; each component's sources of data (sources.ts) get values, from their types,
// which make up the data list. The values are kept next to each file (`Name.preview.json`, meant to be committed): an
// unchanged file isn't read again, and the developer's own values ("yours") are never overwritten. To draw, the files
// between the root and its tree are copied into the preview folder with each source replaced by its value
// (`globalThis.__veValue(id)`); nothing else is changed. No VS Code APIs, so it can be tested.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type * as t from '@babel/types';
import type { Need, SourceFile } from '@visual-editor/contract';
import { forEachChild, parseSource, walk } from '../read/ast';
import type { FeComponent, FeModel } from '../read/model';
import { loadAliases, resolveImport, type Alias } from '../read/resolve';
import { example } from './examples';
import type { Shape } from './shape';
import { planOf, type Plan } from './sources';
import { flowHints, putAt } from './flow';
import { typeScriptFor, TypeView } from './typeView';

type N = t.Node;

/** Where the preview page and the static copies are written in the project. */
export const PREVIEW_DIR = '.visual-editor/preview';
export const STATIC_DIR = `${PREVIEW_DIR}/static`;
/** The exports a static copy adds for each of its file's components (the page picks the root by its name). */
export const EXPORT_PREFIX = '__Ve_';
const CONFIG = /(^|\/)(tsconfig[\w.-]*\.json|jsconfig\.json|(vite|webpack)\.config\.[cm]?[jt]s)$/;

/** One need as kept in a `.preview.json`. */
interface Kept {
  label: string;
  type?: string;
  required: boolean;
  from?: string;
  line?: number;
  generated?: unknown;
  missing?: string[];
  yours?: unknown;
  /** Its type changed since the developer gave a value: worth a look. */
  check?: string;
}

/** A `.preview.json`: each component of the file, with the fingerprint of the file its data was made from. */
interface KeptFile {
  '//'?: string;
  components: Record<string, { source: string; needs: Record<string, Kept> }>;
}

/** Bumped when the way values are made changes: kept generated values are then made again (the developer's stay). */
const GENERATOR = 6;
const ABOUT = 'Example data for Visual Editor previews: what each component in this file needs to be drawn. Values under "yours" are kept as they are; "generated" ones are made again from the code when it changes.';

/** What drawing a root needs: the static copies to write, the root's copy, and its export there. */
export interface DrawSpec {
  root: string;
  exportName: string;
  files: { path: string; text: string }[];
}

export class PreviewReader {
  private readonly texts: Map<string, string>;
  private readonly asts = new Map<string, t.File | undefined>();
  private view: TypeView | null | undefined;
  private aliasList: Alias[] | undefined;
  private readonly byId: Map<string, FeComponent>;
  /** Each file's components. */
  private readonly componentsIn = new Map<string, FeComponent[]>();
  /** Who hands on whom (`nodeTypes = { ms: MicroserviceNode }`): component id → the components it references. */
  private readonly references = new Map<string, string[]>();

  constructor(
    readonly model: FeModel,
    readonly files: SourceFile[],
    /** The project's folder on disk (TypeScript reads from it; the `.preview.json` files are written in it). */
    readonly root: string,
  ) {
    this.texts = new Map(files.map((f) => [f.path, f.text]));
    this.byId = new Map(model.components.map((c) => [c.id, c]));
    for (const c of model.components) this.componentsIn.set(c.path, [...(this.componentsIn.get(c.path) ?? []), c]);
    for (const c of model.components) {
      for (const u of c.usedBy) if (u.how === 'references' && u.from) this.references.set(u.from, [...(this.references.get(u.from) ?? []), c.id]);
    }
  }

  private types(): TypeView | undefined {
    if (this.view === undefined) {
      try {
        this.view = new TypeView(typeScriptFor(this.root), this.root);
      } catch {
        this.view = null;
      }
    }
    return this.view ?? undefined;
  }

  private ast(path: string): t.File | undefined {
    if (!this.asts.has(path)) {
      const text = this.texts.get(path);
      this.asts.set(path, text === undefined ? undefined : parseSource({ path, text }));
    }
    return this.asts.get(path);
  }

  private aliases(): Alias[] {
    return (this.aliasList ??= loadAliases(this.files.filter((f) => CONFIG.test(f.path))));
  }

  /** The whole tree a component draws: itself first, then every component it draws or hands on, all the way down. */
  tree(rootId: string): FeComponent[] {
    const out: FeComponent[] = [];
    const seen = new Set<string>();
    const queue = [rootId];
    while (queue.length) {
      const id = queue.shift()!;
      if (seen.has(id)) continue;
      seen.add(id);
      const c = this.byId.get(id);
      if (!c) continue;
      out.push(c);
      for (const r of c.renders) if (r.target) queue.push(r.target);
      queue.push(...(this.references.get(id) ?? []));
    }
    return out;
  }

  /** A component's own function in its file. */
  private functionOf(c: FeComponent): t.Function | undefined {
    const ast = this.ast(c.path);
    if (!ast) return undefined;
    let found: t.Function | undefined;
    const fnIn = (n: N | null | undefined): t.Function | undefined => {
      if (!n) return undefined;
      if (n.type === 'ArrowFunctionExpression' || n.type === 'FunctionExpression' || n.type === 'FunctionDeclaration') return n;
      // memo(…) / forwardRef(…) / observer(…)
      if (n.type === 'CallExpression') return n.arguments.map((a) => fnIn(a as N)).find(Boolean);
      if (n.type === 'TSAsExpression' || n.type === 'ParenthesizedExpression' || n.type === 'TSSatisfiesExpression') return fnIn(n.expression);
      return undefined;
    };
    walk(ast, (n) => {
      if (found) return;
      if (n.type === 'FunctionDeclaration' && n.id?.name === c.name) found = n;
      else if (n.type === 'VariableDeclarator' && n.id.type === 'Identifier' && n.id.name === c.name) found = fnIn(n.init);
    });
    return found;
  }

  private planFor(c: FeComponent): Plan {
    const fn = this.functionOf(c);
    return fn ? planOf(fn, this.texts.get(c.path) ?? '') : { sources: [], drops: [] };
  }

  // ---- The data list ----

  /** Everything the tree needs: the root's props, then each component's sources, in the tree's order. */
  needsOf(rootId: string): Need[] {
    const tree = this.tree(rootId);
    if (!tree.length) return [];
    this.types()?.want([...new Set(tree.map((c) => c.path))]);
    const names = new Map<string, number>();
    for (const c of tree) names.set(c.name, (names.get(c.name) ?? 0) + 1);
    const out: Need[] = [];
    const written = new Map<string, KeptFile>();
    for (const [i, c] of tree.entries()) {
      const isRoot = i === 0;
      const kept = this.keptFor(c, isRoot, written);
      const group = names.get(c.name)! > 1 ? `${c.name} · ${c.path.split('/').slice(-2).join('/')}` : c.name;
      for (const [local, k] of Object.entries(kept)) {
        const prop = local.startsWith('prop:');
        if (prop && !isRoot) continue;
        out.push({
          id: prop ? local : `${c.id}|${local}`,
          group: isRoot && prop ? `${c.name} · props` : group,
          label: prop ? local.slice(5) : k.label,
          ...(k.type ? { type: k.type } : {}),
          required: k.required,
          ...(k.generated !== undefined ? { value: k.generated } : {}),
          ...(k.missing?.length ? { missing: k.missing } : {}),
          ...('yours' in k ? { yours: k.yours } : {}),
          ...(k.check ? { check: k.check } : {}),
          ...(k.from ? { from: k.from } : {}),
          place: { path: c.path, ...(k.line ? { line: k.line } : {}) },
        });
      }
    }
    for (const [path, file] of written) this.writeKept(path, file);
    return out;
  }

  private keptPath(path: string): string {
    return join(this.root, `${path.replace(/\.[cm]?[jt]sx?$/, '')}.preview.json`);
  }

  private readKept(path: string): KeptFile {
    try {
      const file = this.keptPath(path);
      if (!existsSync(file)) return { components: {} };
      const kept = JSON.parse(readFileSync(file, 'utf8')) as KeptFile;
      return kept && typeof kept.components === 'object' ? kept : { components: {} };
    } catch {
      return { components: {} };
    }
  }

  private writeKept(path: string, kept: KeptFile) {
    const sorted: KeptFile = { '//': ABOUT, components: Object.fromEntries(Object.entries(kept.components).sort(([a], [b]) => a.localeCompare(b))) };
    const text = `${JSON.stringify(sorted, null, 2)}\n`;
    const file = this.keptPath(path);
    try {
      if (existsSync(file) && readFileSync(file, 'utf8') === text) return;
      writeFileSync(file, text);
    } catch {
      // A folder that can't be written: the data is still used, just not kept.
    }
  }

  /**
   * A component's needs: kept ones when its file hasn't changed since they were made, otherwise made again from its
   * code and types (the developer's own values carried over, flagged when their type changed).
   */
  private keptFor(c: FeComponent, withProps: boolean, written: Map<string, KeptFile>): Record<string, Kept> {
    const text = this.texts.get(c.path) ?? '';
    const source = `${createHash('sha1').update(text).digest('hex').slice(0, 16)}.${GENERATOR}`;
    const file = written.get(c.path) ?? this.readKept(c.path);
    const old = file.components[c.name];
    const hasProps = !!old && (!c.props.length || Object.keys(old.needs).some((k) => k.startsWith('prop:')));
    if (old && old.source === source && (!withProps || hasProps)) return old.needs;
    const made = this.make(c, withProps || Object.keys(old?.needs ?? {}).some((k) => k.startsWith('prop:')));
    for (const [local, k] of Object.entries(made)) {
      const before = old?.needs[local];
      if (!before || !('yours' in before)) continue;
      k.yours = before.yours;
      if (before.type !== k.type) k.check = `Its type changed${before.type ? ` (it was ${before.type})` : ''}: check your value still fits.`;
      else if (before.check) k.check = before.check;
    }
    file.components[c.name] = { source, needs: made };
    written.set(c.path, file);
    return made;
  }

  /** A component's needs, made from its code and types: its props (when asked), then its sources. */
  private make(c: FeComponent, withProps: boolean): Record<string, Kept> {
    const view = this.types();
    const out: Record<string, Kept> = {};
    if (withProps) {
      let typed: ReturnType<TypeView['propsList']>;
      try {
        typed = view?.propsList(c.path, c.name);
      } catch {
        typed = undefined;
      }
      const seen = new Set<string>();
      for (const p of typed ?? []) {
        if (!p.shape) continue;
        seen.add(p.name);
        const made = example(p.shape, p.name, true);
        out[`prop:${p.name}`] = kept(p.name, p.optional ? p.type.replace(/ \| undefined$/, '') : p.type, !p.optional, made, 'from its type', c.line + 1);
      }
      for (const p of c.props) {
        if (seen.has(p.name) || p.name === '...') continue;
        const shape = p.type ? shapeOfText(p.type) : p.isCallback ? { kind: 'function' as const } : undefined;
        const made = example(shape, p.name, true);
        out[`prop:${p.name}`] = kept(p.name, p.type, !p.optional, made, shape ? 'from its type' : 'guessed from its name', c.line + 1);
      }
    }
    const plan = this.planFor(c);
    for (const s of plan.sources) {
      let shape: Shape | undefined;
      let type: string | undefined;
      try {
        const ty = view?.typeOfSpan(c.path, s.typeStart, s.typeEnd);
        if (ty) {
          shape = view!.shapeOf(ty);
          type = view!.text(ty);
        }
      } catch {
        // No type: guessed below.
      }
      // Inside the tree, what covers the screen (a dialog, a menu, a toast, loading) starts closed.
      const made = example(shape, s.name, true, true);
      out[s.local] = kept(s.label, type, true, made, shape ? 'from its type' : 'nothing in the code says what it is', s.line + 1);
    }
    this.canvases(c, plan, out);
    return out;
  }

  /**
   * React Flow canvases the component draws: their example nodes are one of each kind in the `nodeTypes` map (with
   * that node component's own data), laid out in a grid, joined by one edge of each kind in `edgeTypes`.
   */
  private canvases(c: FeComponent, plan: Plan, out: Record<string, Kept>) {
    const fn = this.functionOf(c);
    const ast = this.ast(c.path);
    if (!fn || !ast) return;
    const view = this.types();
    for (const hint of flowHints(fn, ast, plan.sources)) {
      const nodes = hint.nodeTypes.map((entry, i) => {
        // The node component's own data type (NodeProps<…>['data']), for its data.
        const drawn = this.model.components.find((x) => x.name === entry.component);
        let data: Shape | undefined;
        try {
          data = drawn && view ? view.propsList(drawn.path, drawn.name)?.find((p) => p.name === 'data')?.shape : undefined;
        } catch {
          data = undefined;
        }
        return {
          id: `node-${i + 1}`,
          type: entry.key,
          position: { x: 60 + (i % 3) * 420, y: 60 + Math.floor(i / 3) * 360 },
          data: data ? example(data, entry.key, true, true).value : { label: entry.key },
        };
      });
      if (hint.nodes && out[hint.nodes.local]?.generated !== undefined && nodes.length) {
        const k = out[hint.nodes.local];
        k.generated = putAt(k.generated, hint.nodes.at, nodes);
      }
      if (hint.edges && out[hint.edges.local]?.generated !== undefined) {
        const kinds = hint.edgeTypes.length ? hint.edgeTypes.map((e) => e.key) : [undefined];
        const edges = nodes.slice(1).map((n, i) => ({ id: `edge-${i + 1}`, source: nodes[i].id, target: n.id, ...(kinds[i % kinds.length] ? { type: kinds[i % kinds.length] } : {}) }));
        const k = out[hint.edges.local];
        k.generated = putAt(k.generated, hint.edges.at, edges);
      }
    }
  }

  /** The developer's own value for a need (undefined: back to the generated one), kept in its `.preview.json`. */
  keep(rootId: string, needId: string, value: unknown) {
    const prop = needId.startsWith('prop:');
    const [componentId, local] = prop ? [rootId, needId] : [needId.slice(0, needId.lastIndexOf('|')), needId.slice(needId.lastIndexOf('|') + 1)];
    const c = this.byId.get(componentId);
    if (!c) return;
    const file = this.readKept(c.path);
    const k = file.components[c.name]?.needs[local];
    if (!k) return;
    if (value === undefined) delete k.yours;
    else k.yours = value;
    delete k.check;
    this.writeKept(c.path, file);
  }

  // ---- Drawing ----

  /**
   * The static copies for a root: every file between the root and the components of its tree (following imports),
   * with each tree component's sources replaced by their values and the code that brings data in left out; imports
   * of other copied files point at the copies, and everything else at the app's own files.
   */
  drawSpec(rootId: string): DrawSpec | undefined {
    const rootComponent = this.byId.get(rootId);
    if (!rootComponent) return undefined;
    // A copy is the same whichever component is previewed (so previews never rewrite each other's copies): every
    // file with components, or importing one that has, is copied, with all its components rewritten.
    const copies = this.copiesFrom(rootComponent.path);
    const files = new Set(this.texts.keys());
    const out: DrawSpec['files'] = [];
    for (const path of copies) {
      const text = this.texts.get(path);
      const ast = this.ast(path);
      if (text === undefined || !ast) continue;
      const edits: { start: number; end: number; text: string }[] = [];
      // Imports: other copies, or the app's own files from the project's root.
      const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
      for (const s of importSources(ast)) {
        const resolved = resolveImport(s.value, path, this.aliases(), files);
        const next = this.needsCopy(resolved) ? `/${STATIC_DIR}/${resolved}` : s.value.startsWith('.') ? `/${joinPath(dir, s.value)}` : undefined;
        if (next && next !== s.value) edits.push({ start: s.start ?? 0, end: s.end ?? 0, text: JSON.stringify(next) });
      }
      // Its components: sources replaced, data-bringing code left out.
      const top = topNames(ast);
      const own = (this.componentsIn.get(path) ?? []).filter((c) => !c.parent && top.has(c.name));
      for (const c of own) {
        const plan = this.planFor(c);
        for (const s of plan.sources) {
          const value = `globalThis.__veValue(${JSON.stringify(`${c.id}|${s.local}`)})`;
          if (s.insertAt !== undefined) edits.push({ start: s.insertAt, end: s.insertAt, text: value });
          else edits.push({ start: s.start, end: s.end, text: value });
        }
        for (const d of plan.drops) edits.push({ start: d.start, end: d.end, text: '/* left out by the preview */' });
      }
      let next = text;
      for (const e of edits.sort((a, b) => b.start - a.start)) next = next.slice(0, e.start) + e.text + next.slice(e.end);
      if (own.length) next += `\n\n// Added by Visual Editor: its components, for previews to draw.\nexport { ${own.map((c) => `${c.name} as ${EXPORT_PREFIX}${c.name}`).join(', ')} }\n`;
      out.push({ path: `${STATIC_DIR}/${path}`, text: next });
    }
    return { root: `${STATIC_DIR}/${rootComponent.path}`, exportName: `${EXPORT_PREFIX}${rootComponent.name}`, files: out };
  }

  /** A file's project imports (code only). */
  private importsOf(path: string): string[] {
    const files = new Set(this.texts.keys());
    const ast = this.ast(path);
    return (ast ? importSources(ast) : []).map((s) => resolveImport(s.value, path, this.aliases(), files)).filter((to) => !to.startsWith('pkg:') && /\.[cm]?[jt]sx?$/.test(to));
  }

  private readonly copyMemo = new Map<string, boolean>();

  /** Whether a file is copied for previews: it has components, or imports (in the end) a file that has. */
  private needsCopy(path: string, visiting = new Set<string>()): boolean {
    const known = this.copyMemo.get(path);
    if (known !== undefined) return known;
    if (!this.texts.has(path)) return false;
    if ((this.componentsIn.get(path) ?? []).length) {
      this.copyMemo.set(path, true);
      return true;
    }
    if (visiting.has(path)) return false;
    visiting.add(path);
    const yes = this.importsOf(path).some((to) => this.needsCopy(to, visiting));
    visiting.delete(path);
    // Only a settled answer is kept (one found in the middle of an import loop may be incomplete).
    if (yes || !visiting.size) this.copyMemo.set(path, yes);
    return yes;
  }

  /** The files a preview from this file copies: those it reaches through imports that need copying. */
  private copiesFrom(from: string): Set<string> {
    const out = new Set<string>();
    const queue = [from];
    while (queue.length) {
      const path = queue.shift()!;
      if (out.has(path) || !this.needsCopy(path)) continue;
      out.add(path);
      queue.push(...this.importsOf(path));
    }
    return out;
  }
}

function kept(label: string, type: string | undefined, required: boolean, made: { value: unknown; missing: string[] }, from: string, line: number): Kept {
  const whole = made.missing.includes('');
  return {
    label,
    ...(type ? { type } : {}),
    required,
    from: whole ? 'nothing in the code says what it is' : from,
    line,
    ...(whole ? {} : { generated: made.value }),
    ...(made.missing.length ? { missing: made.missing } : {}),
  };
}

/** The names declared at the top of a file (what an export line can name). */
function topNames(ast: t.File): Set<string> {
  const out = new Set<string>();
  for (let st of ast.program.body as N[]) {
    if ((st.type === 'ExportNamedDeclaration' || st.type === 'ExportDefaultDeclaration') && st.declaration) st = st.declaration as N;
    if ((st.type === 'FunctionDeclaration' || st.type === 'ClassDeclaration') && st.id) out.add(st.id.name);
    if (st.type === 'VariableDeclaration') for (const d of st.declarations) if (d.id.type === 'Identifier') out.add(d.id.name);
  }
  return out;
}

/** Every import source in a file: static imports, `export … from`, and `import('…')` with a plain string. */
function importSources(ast: t.File): t.StringLiteral[] {
  const out: t.StringLiteral[] = [];
  const visit = (n: N) => {
    if ((n.type === 'ImportDeclaration' || n.type === 'ExportNamedDeclaration' || n.type === 'ExportAllDeclaration') && n.source) out.push(n.source);
    if (n.type === 'CallExpression' && n.callee.type === 'Import' && n.arguments[0]?.type === 'StringLiteral') out.push(n.arguments[0]);
    forEachChild(n, visit);
  };
  visit(ast.program);
  return out;
}

/** Joins a folder and a relative path, posix style ('src/a', '../b/c' → 'src/b/c'). */
function joinPath(dir: string, rel: string): string {
  const parts = dir ? dir.split('/') : [];
  for (const p of rel.split('/')) {
    if (p === '..') parts.pop();
    else if (p !== '.' && p) parts.push(p);
  }
  return parts.join('/');
}

/** A type as written in code, as a shape, for the simple cases (string, 'a' | 'b', Item[], () => void). */
export function shapeOfText(type: string): Shape | undefined {
  const t = type.replace(/\s+/g, ' ').trim().replace(/\s*\|\s*(null|undefined)\b/g, '');
  if (/=>/.test(t)) return { kind: 'function' };
  if (/^(string|`.*`)$/.test(t)) return { kind: 'string' };
  if (/^number$/.test(t)) return { kind: 'number' };
  if (/^boolean$/.test(t)) return { kind: 'boolean' };
  if (/^(React\.)?(ReactNode|ReactElement|JSX\.Element)$/.test(t)) return { kind: 'node' };
  if (/^Date$/.test(t)) return { kind: 'date' };
  if (/^('[^']*'( \| '[^']*')*)$/.test(t)) return { kind: 'string', values: [...t.matchAll(/'([^']*)'/g)].map((m) => m[1]) };
  if (/\[\]$/.test(t)) return { kind: 'array', item: shapeOfText(t.slice(0, -2)) ?? {} };
  return undefined;
}
