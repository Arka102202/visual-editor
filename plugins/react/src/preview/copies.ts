// Copies of the app's files in the preview folder, for what the app's own files can't show:
// - an inner component (not exported): its file, copied with that component exported;
// - a proposal: the files it changes, as they'd be, so Before and After can be drawn without touching the code.
// A copy's imports are pointed back at the app (or at the other copies), so it works from its new folder. Pure: text
// in, text out (files are looked up through the functions passed in), so it can be tested.

import type * as t from '@babel/types';
import { posix } from 'node:path';
import { forEachChild, parseSource } from '../read/ast';
import { SOURCE_EXTENSIONS, type Alias } from '../read/resolve';

/** Finds the project file an import names (undefined: a package, or nothing there). */
export type Locate = (spec: string, fromPath: string) => Promise<string | undefined>;

/**
 * Builds a Locate from a way to read files (the proposed text when previewing a proposal, so new files are found
 * too) and the project's aliases.
 */
export function locator(read: (path: string) => Promise<string | undefined>, aliases: Alias[]): Locate {
  return async (spec, fromPath) => {
    let base: string | undefined;
    if (spec.startsWith('.')) base = posix.join(posix.dirname(fromPath), spec);
    else {
      for (const a of aliases) {
        const p = a.prefix;
        if (spec === p || spec === p.replace(/\/$/, '')) base = a.target;
        else if (p.endsWith('/') ? spec.startsWith(p) : spec.startsWith(`${p}/`)) base = posix.join(a.target, spec.slice(p.endsWith('/') ? p.length : p.length + 1));
        if (base !== undefined) break;
      }
    }
    if (base === undefined) return undefined;
    const stem = base.replace(/\.(js|jsx|mjs|cjs)$/, '');
    for (const candidate of [base, ...SOURCE_EXTENSIONS.map((e) => stem + e), ...SOURCE_EXTENSIONS.map((e) => `${stem}/index${e}`)]) {
      if (/\.[cm]?[jt]sx?$/.test(candidate) && (await read(candidate)) !== undefined) return candidate;
    }
    return undefined;
  };
}

/** Every import source in a file: static imports, `export … from`, and `import('…')` with a plain string. */
function sources(ast: t.File): t.StringLiteral[] {
  const out: t.StringLiteral[] = [];
  const visit = (n: t.Node) => {
    if ((n.type === 'ImportDeclaration' || n.type === 'ExportNamedDeclaration' || n.type === 'ExportAllDeclaration') && n.source) out.push(n.source);
    if (n.type === 'CallExpression' && n.callee.type === 'Import' && n.arguments[0]?.type === 'StringLiteral') out.push(n.arguments[0]);
    forEachChild(n as never, visit as never);
  };
  visit(ast.program);
  return out;
}

/** Files a file imports from the project (relative or through an alias). */
export async function importsOf(path: string, text: string, locate: Locate): Promise<string[]> {
  const ast = parseSource({ path, text });
  if (!ast) return [];
  const found = await Promise.all(sources(ast).map((s) => locate(s.value, path)));
  return [...new Set(found.filter((f): f is string => !!f))];
}

const stripExt = (p: string) => p.replace(/\.[cm]?[jt]sx?$/, '');
const relativeFrom = (fromDir: string, to: string) => {
  const r = posix.relative(fromDir, to);
  return r.startsWith('.') ? r : `./${r}`;
};

/**
 * A file's text for a copy at `toPath`: relative imports point back at the app; imports of files that have copies of
 * their own (`copyOf`) point at those. Alias imports work from anywhere, so they're left as they are otherwise.
 */
export async function rehome(path: string, text: string, toPath: string, locate: Locate, copyOf: (path: string) => string | undefined = () => undefined): Promise<string> {
  const ast = parseSource({ path, text });
  if (!ast) return text;
  const edits: { start: number; end: number; text: string }[] = [];
  for (const s of sources(ast)) {
    const spec = s.value;
    const file = await locate(spec, path);
    const copy = file ? copyOf(file) : undefined;
    let next: string | undefined;
    if (copy) next = relativeFrom(posix.dirname(toPath), stripExt(copy));
    else if (spec.startsWith('.')) {
      // A source file without its extension (as written); anything else (styles, pictures) with it.
      next = file ? relativeFrom(posix.dirname(toPath), /\.[cm]?[jt]sx?$/.test(spec) ? file : stripExt(file)) : relativeFrom(posix.dirname(toPath), posix.join(posix.dirname(path), spec));
    }
    if (next !== undefined && next !== spec) edits.push({ start: s.start ?? 0, end: s.end ?? 0, text: `'${next}'` });
  }
  let out = text;
  for (const e of edits.sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return out;
}

/** Whether a file exports a component by this name (as itself, in an export list, or as the default export's name). */
export function exportsName(path: string, text: string, name: string): boolean {
  const ast = parseSource({ path, text });
  if (!ast) return true;
  for (const s of ast.program.body) {
    if (s.type === 'ExportNamedDeclaration') {
      const d = s.declaration;
      if ((d?.type === 'FunctionDeclaration' || d?.type === 'ClassDeclaration') && d.id?.name === name) return true;
      if (d?.type === 'VariableDeclaration' && d.declarations.some((v) => v.id.type === 'Identifier' && v.id.name === name)) return true;
      if (s.specifiers.some((sp) => sp.type === 'ExportSpecifier' && sp.local.name === name)) return true;
    }
    if (s.type === 'ExportDefaultDeclaration') {
      const d = s.declaration;
      if (d.type === 'Identifier' && d.name === name) return true;
      if ((d.type === 'FunctionDeclaration' || d.type === 'ClassDeclaration') && d.id?.name === name) return true;
    }
  }
  return false;
}

/** The export a copy of a file adds for its inner component. */
export const INNER_EXPORT = '__VeInner';

/** A copy of a file that also exports one of its inner (not exported) components. */
export function withInnerExport(text: string, name: string): string {
  return `${text}\n\n// Added by Visual Editor: this component isn't exported, so the preview shows it from this copy.\nexport { ${name} as ${INNER_EXPORT} }\n`;
}
