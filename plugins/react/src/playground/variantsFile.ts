// One file for all the versions of a component: `.visual-editor/playground/<Name>/variants.tsx`. Each version is an exported
// component (`export function Compact(props: Props) {…}`), the comment above it is its notes, and the imports and
// helpers at the top are shared. Pure text in, text out, so it can be tested.

export const VARIANTS_FILE = 'variants.tsx';

export interface VariantDecl {
  /** The exported name, e.g. "Compact". */
  exportName: string;
  /** The comment just above it, if any. */
  notes?: string;
  /** Where its part of the file starts (its comment included) and ends. */
  start: number;
  end: number;
  /** 1-based line of the export. */
  line: number;
}

// `export function Compact(`, `export const Compact = (`, `= memo(`, `= forwardRef(`… at the start of a line.
const DECL = /^export\s+(?:(?:async\s+)?function\s+([A-Z]\w*)|const\s+([A-Z]\w*)\s*(?::[^=\n]+)?=\s*(?:async\s*)?(?:\(|function\b|(?:React\.)?(?:memo|forwardRef)\b|[a-zA-Z_$][\w$]*\s*=>))/gm;

/** The versions in a variants file, in file order. */
export function readVariantDecls(text: string): VariantDecl[] {
  const found: { exportName: string; at: number; start: number; notes?: string }[] = [];
  for (const m of text.matchAll(DECL)) {
    const at = m.index ?? 0;
    const before = text.slice(0, at).replace(/\s+$/, '');
    let start = at;
    let notes: string | undefined;
    if (before.endsWith('*/')) {
      const open = before.lastIndexOf('/*');
      if (open >= 0) {
        start = open;
        notes = cleanComment(before.slice(open));
      }
    }
    found.push({ exportName: m[1] ?? m[2], at, start, notes });
  }
  return found.map((f, i) => ({
    exportName: f.exportName,
    notes: f.notes,
    start: f.start,
    end: i + 1 < found.length ? found[i + 1].start : text.length,
    line: text.slice(0, f.at).split('\n').length,
  }));
}

function cleanComment(c: string): string | undefined {
  const t = c
    .replace(/^\/\*\*?|\*\/$/g, '')
    .split('\n')
    .map((l) => l.replace(/^\s*\*\s?/, '').trim())
    .filter(Boolean)
    .join(' ');
  return t || undefined;
}

/** "Dense list" → "DenseList", not one of `taken`. */
export function exportNameFor(name: string, taken: Iterable<string>): string {
  const base =
    name
      .replace(/[^A-Za-z0-9]+/g, ' ')
      .trim()
      .split(' ')
      .filter(Boolean)
      .map((w) => w[0].toUpperCase() + w.slice(1))
      .join('')
      .replace(/^\d+/, '') || 'Version';
  const used = new Set(taken);
  let out = base;
  for (let i = 2; used.has(out); i++) out = `${base}${i}`;
  return out;
}

/** "DenseList" → "Dense list". */
export const labelOf = (exportName: string) => exportName.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/ ([A-Z])(?=[a-z])/g, (_m, c: string) => ` ${c.toLowerCase()}`);

const IMPORT = /^import\s[\s\S]*?['"][^'"\n]+['"][ \t]*;?[ \t]*(?:\r?\n|$)/gm;

/** A piece of code split into its import statements and the rest. */
export function splitImports(code: string): { imports: string[]; rest: string } {
  const imports = [...code.matchAll(IMPORT)].map((m) => m[0].trim().replace(/;$/, ''));
  return { imports, rest: code.replace(IMPORT, '').replace(/^\s+/, '') };
}

/**
 * Import statements merged: the same module imported by several versions becomes one statement, so the same name
 * isn't imported twice. Statements it can't read are kept as they are (once).
 */
export function mergeImports(statements: string[]): string[] {
  const modules = new Map<string, { side: boolean; defaults: Set<string>; namespaces: Set<string>; named: Map<string, string>; types: Map<string, string> }>();
  const raw: string[] = [];
  const mod = (m: string) => {
    let x = modules.get(m);
    if (!x) modules.set(m, (x = { side: false, defaults: new Set(), namespaces: new Set(), named: new Map(), types: new Map() }));
    return x;
  };
  const localOf = (spec: string) => spec.replace(/^type\s+/, '').split(/\s+as\s+/).pop()!.trim();
  for (const s of statements) {
    const side = /^import\s+['"]([^'"]+)['"]$/.exec(s);
    if (side) {
      mod(side[1]).side = true;
      continue;
    }
    const m = /^import\s+(type\s+)?([\s\S]*?)\s+from\s+['"]([^'"]+)['"]$/.exec(s);
    if (!m) {
      if (!raw.includes(s)) raw.push(s);
      continue;
    }
    const [, typeOnly, clause, from] = m;
    const x = mod(from);
    const braces = /\{([\s\S]*)\}/.exec(clause);
    for (const spec of braces?.[1].split(',').map((p) => p.trim()).filter(Boolean) ?? []) {
      if (typeOnly || spec.startsWith('type ')) x.types.set(localOf(spec), spec.replace(/^type\s+/, ''));
      else x.named.set(localOf(spec), spec);
    }
    for (const part of clause.replace(/\{[\s\S]*\}/, '').split(',').map((p) => p.trim()).filter(Boolean)) {
      if (part.startsWith('*')) x.namespaces.add(part);
      else if (typeOnly) x.types.set(part, `default as ${part}`);
      else x.defaults.add(part);
    }
  }
  const out: string[] = [];
  for (const [from, x] of modules) {
    for (const ns of x.namespaces) out.push(`import ${ns} from '${from}'`);
    const named = [...x.named.values()];
    const [first, ...otherDefaults] = [...x.defaults];
    // A second default name for the same module is the same thing under another name.
    for (const d of otherDefaults) named.push(`default as ${d}`);
    const types = [...x.types].filter(([local]) => !x.named.has(local) && !x.defaults.has(local)).map(([, spec]) => spec);
    if (first || named.length) out.push(`import ${[first, named.length ? `{ ${named.join(', ')} }` : ''].filter(Boolean).join(', ')} from '${from}'`);
    if (types.length) out.push(`import type { ${types.join(', ')} } from '${from}'`);
    if (x.side && !first && !named.length && !x.namespaces.size && !types.length) out.push(`import '${from}'`);
  }
  return [...out, ...raw];
}

/**
 * One version's code as a named export. Accepts `export function X`, `export const X =`, or a default export
 * (`export default function X(…)`, `export default function (…)`), which is renamed to `wanted`.
 */
export function asNamedExport(code: string, wanted: string): { code: string; exportName: string } {
  const own = readVariantDecls(code);
  if (own.length) return { code, exportName: own[0].exportName };
  const fn = /^export\s+default\s+(async\s+)?function\s*([A-Za-z_$][\w$]*)?\s*(?=[(<])/m;
  if (fn.test(code)) return { code: code.replace(fn, (_m, a?: string) => `export ${a ?? ''}function ${wanted}`), exportName: wanted };
  const named = /^export\s+default\s+([A-Z][\w$]*)\s*;?\s*$/m.exec(code);
  if (named) return { code: `${code.replace(named[0], '').trimEnd()}\n\nexport const ${wanted} = ${named[1]}`, exportName: wanted };
  throw new Error(`The code for "${wanted}" has no exported component: write it as \`export function ${wanted}(props) {…}\`.`);
}

/** Top-level names declared twice (two versions both defining `Row`, say): the file wouldn't compile. */
export function duplicateNames(text: string): string[] {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const m of text.matchAll(/^(?:export\s+)?(?:declare\s+)?(?:async\s+)?(?:function\*?|const|let|var|class|enum)\s+([A-Za-z_$][\w$]*)/gm)) {
    if (seen.has(m[1])) dup.add(m[1]);
    seen.add(m[1]);
  }
  return [...dup];
}

const comment = (notes?: string) => (notes ? `/** ${notes.replace(/\*\//g, '* /').replace(/\s*\n\s*/g, ' ')} */\n` : '');

function checked(text: string): string {
  const dup = duplicateNames(text);
  if (dup.length) throw new Error(`Two versions both declare ${dup.map((d) => `\`${d}\``).join(', ')}: all versions share one file, so give each helper its own name (e.g. CompactRow, DenseRow).`);
  return text;
}

function assemble(header: string, imports: string[], body: string): string {
  return `${[header.trim(), mergeImports(imports).join('\n'), body.trim()].filter(Boolean).join('\n\n')}\n`;
}

/** A new variants file from several versions. */
/** `'use client'` at the very top (Next.js client components): kept first whatever else changes. */
const DIRECTIVE = /^\s*(['"])use client\1;?[ \t]*\r?\n?/;
function splitDirective(text: string): { directive: string; rest: string } {
  const m = DIRECTIVE.exec(text);
  return m ? { directive: "'use client'\n\n", rest: text.slice(m[0].length) } : { directive: '', rest: text };
}

/** A new variants file from several versions. `client`: versions of a Next.js client component. */
export function composeVariants(component: string, parts: { exportName: string; notes?: string; code: string }[], client = false): string {
  const imports: string[] = [];
  const bodies = parts.map((p) => {
    const { imports: own, rest } = splitImports(splitDirective(p.code).rest);
    imports.push(...own);
    return `${comment(p.notes)}${rest.trim()}`;
  });
  const header = `// Versions of ${component} for the No-Code Map Playground. Each exported component is one version (the comment\n// above it is its notes); imports and helpers at the top are shared. Edit freely: the Playground updates.`;
  return checked((client ? "'use client'\n\n" : '') + assemble(header, imports, bodies.join('\n\n')));
}

/** A variants file without one version. */
export function removeVariant(text: string, exportName: string): string {
  const d = readVariantDecls(text).find((x) => x.exportName === exportName);
  return d ? `${text.slice(0, d.start).trimEnd()}\n\n${text.slice(d.end).trimStart()}`.trimEnd() + '\n' : text;
}

/** Adds a version to a variants file, or replaces the one with the same export name. */
export function upsertVariant(whole: string, part: { exportName: string; notes?: string; code: string }): string {
  const { directive, rest: text } = splitDirective(whole);
  // A version that is a client component makes the file one ('use client' must come first).
  const own = splitDirective(part.code);
  const keep = directive || own.directive;
  const { imports: added, rest } = splitImports(own.rest);
  const { imports: existing } = splitImports(text);
  // The file without its imports: header comments, shared helpers, versions.
  const body = text.replace(IMPORT, '');
  const firstDecl = readVariantDecls(body)[0];
  const head = firstDecl ? body.slice(0, firstDecl.start) : body;
  const decls = readVariantDecls(body);
  const target = decls.find((d) => d.exportName === part.exportName);
  const notes = part.notes ?? target?.notes;
  const piece = `${comment(notes)}${rest.trim()}\n\n`;
  const versions = target ? body.slice(firstDecl!.start, target.start) + piece + body.slice(target.end) : `${firstDecl ? body.slice(firstDecl.start).trimEnd() + '\n\n' : ''}${piece}`;
  // The header is the leading comment; the rest of `head` is shared code.
  const lead = /^(?:\s*\/\/[^\n]*\n|\s*\/\*[\s\S]*?\*\/\s*\n)*/.exec(head)?.[0] ?? '';
  const shared = head.slice(lead.length).trim();
  return checked(keep + assemble(lead, [...existing, ...added], [shared, versions.trim()].filter(Boolean).join('\n\n')));
}
