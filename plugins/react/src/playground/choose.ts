// Choosing a version: its code becomes the real component, in the component's own file, under its own name and
// export, so nothing that uses it needs to change. The helpers it uses come along, and the imports it needs are
// added with paths that work from the component's folder. Pure: no VS Code APIs.
// From No-Code Map's Playground, where it was proven.

import type * as t from '@babel/types';
import { parseSource, walk } from '../read/ast';
import { ensureImport } from './imports';
import { asNamedExport, readVariantDecls } from './variantsFile';

type N = t.Node;

const dirOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');

/** `a/b/c` + `../d` → `a/d` (paths relative to the project, forward slashes). */
function resolvePath(fromDir: string, spec: string): string {
  const parts = fromDir ? fromDir.split('/') : [];
  for (const seg of spec.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg !== '.') parts.push(seg);
  }
  return parts.join('/');
}

function relativeImport(fromFile: string, toPath: string): string {
  const a = dirOf(fromFile).split('/').filter(Boolean);
  const b = toPath.split('/');
  let i = 0;
  while (i < a.length && i < b.length - 1 && a[i] === b[i]) i++;
  const r = [...Array(a.length - i).fill('..'), ...b.slice(i)].join('/');
  return r.startsWith('.') ? r : `./${r}`;
}

const stripExt = (p: string) => p.replace(/\.[cm]?[jt]sx?$/, '');

/** Names a piece of code refers to (identifiers and JSX tags), to know which helpers and imports it needs. */
function namesUsed(node: N): Set<string> {
  const out = new Set<string>();
  walk(node, (n) => {
    if (n.type === 'Identifier') out.add(n.name);
    if (n.type === 'JSXIdentifier') out.add(n.name);
    if (n.type === 'TSTypeReference' && n.typeName.type === 'Identifier') out.add(n.typeName.name);
  });
  return out;
}

/** Top-level declarations: name → statement (without `export`). */
function topDeclarations(ast: t.File): Map<string, { stmt: t.Statement; decl: N }> {
  const out = new Map<string, { stmt: t.Statement; decl: N }>();
  for (const stmt of ast.program.body) {
    const decl = (stmt.type === 'ExportNamedDeclaration' || stmt.type === 'ExportDefaultDeclaration') && stmt.declaration ? stmt.declaration : stmt;
    const names =
      (decl.type === 'FunctionDeclaration' || decl.type === 'ClassDeclaration' || decl.type === 'TSInterfaceDeclaration' || decl.type === 'TSTypeAliasDeclaration' || decl.type === 'TSEnumDeclaration') && decl.id
        ? [decl.id.name]
        : decl.type === 'VariableDeclaration'
          ? decl.declarations.flatMap((d) => (d.id.type === 'Identifier' ? [d.id.name] : []))
          : [];
    for (const name of names) out.set(name, { stmt, decl });
  }
  return out;
}

/**
 * The component's file with the chosen version in place of the component. `variants` is variants.tsx (or an older
 * one-version file); `exportName` the version in it (undefined: the file's default export).
 */
export function chooseVersion(input: {
  variants: { path: string; text: string };
  exportName?: string;
  target: { path: string; name: string; text: string };
}): { text: string; helpers: string[]; imports: string[] } {
  let source = input.variants.text;
  let exportName = input.exportName;
  if (!exportName) {
    const named = asNamedExport(source, input.target.name);
    source = named.code;
    exportName = named.exportName;
  }
  const vAst = parseSource({ path: input.variants.path, text: source });
  const tAst = parseSource({ path: input.target.path, text: input.target.text });
  if (!vAst || !tAst) throw new Error("Couldn't read the files.");
  const vTop = topDeclarations(vAst);
  const version = vTop.get(exportName);
  if (!version || !readVariantDecls(source).some((d) => d.exportName === exportName)) throw new Error(`There's no version ${exportName} in ${input.variants.path}.`);

  // Helpers the version uses (and the helpers they use), but not the other versions.
  const others = new Set(readVariantDecls(source).map((d) => d.exportName));
  const imported = new Map<string, t.ImportDeclaration>();
  for (const s of vAst.program.body) if (s.type === 'ImportDeclaration') for (const sp of s.specifiers) imported.set(sp.local.name, s);
  const needed = new Set<string>();
  const queue = [...namesUsed(version.decl)];
  while (queue.length) {
    const name = queue.pop()!;
    if (needed.has(name) || name === exportName || others.has(name)) continue;
    if (vTop.has(name) || imported.has(name)) {
      needed.add(name);
      if (vTop.has(name)) queue.push(...namesUsed(vTop.get(name)!.decl));
    }
  }
  const tTop = topDeclarations(tAst);
  const original = tTop.get(input.target.name);
  if (!original) throw new Error(`Couldn't find ${input.target.name} in ${input.target.path}.`);

  // A helper with the same name as one the component's file already has: the same code is reused; different code
  // replaces the old one when only the old component used it, else the version's gets a name of its own.
  let helperNames = [...needed].filter((n) => vTop.has(n));
  const renames = new Map<string, string>([[exportName, input.target.name]]);
  const replaced = new Map<string, N>();
  const same = (a: N, aText: string, b: N, bText: string) => aText.slice(a.start!, a.end!).replace(/\s+/g, ' ') === bText.slice(b.start!, b.end!).replace(/\s+/g, ' ');
  const usedElsewhere = (name: string, own: t.Statement) =>
    tAst.program.body.some((st) => st !== original.stmt && st !== own && st.type !== 'ImportDeclaration' && namesUsed(st).has(name));
  const taken = new Set([...tTop.keys(), ...vTop.keys()]);
  for (const n of helperNames.filter((x) => tTop.has(x) && x !== input.target.name)) {
    const old = tTop.get(n)!;
    if (same(old.decl, input.target.text, vTop.get(n)!.decl, source)) helperNames = helperNames.filter((x) => x !== n);
    else if (!usedElsewhere(n, old.stmt)) replaced.set(n, old.decl);
    else {
      let fresh = `${n}2`;
      for (let i = 3; taken.has(fresh); i++) fresh = `${n}${i}`;
      taken.add(fresh);
      renames.set(n, fresh);
    }
  }

  // The version's code under the component's name, and its helpers (renamed where needed), in file order.
  const versionText = sliceRenamed(source, version.decl, renames);
  const helperDecls = [...new Set(helperNames.map((n) => vTop.get(n)!.decl))].sort((a, b) => a.start! - b.start!);
  const replacedDecls = new Set(replaced.values());
  const newHelper = new Map(helperDecls.map((d) => [d, sliceRenamed(source, d, renames)]));
  const inserted = helperDecls.filter((d) => ![...replaced].some(([n]) => vTop.get(n)!.decl === d));
  const helperText = inserted.map((d) => newHelper.get(d)!).join('\n\n');

  // Replace the component's declaration (keeping its export), and the old helpers the version replaces.
  const isDefault = original.stmt.type === 'ExportDefaultDeclaration';
  const before = helperText ? `${helperText}\n\n` : '';
  const edits: { start: number; end: number; text: string }[] = [];
  if (isDefault && version.decl.type !== 'FunctionDeclaration') {
    edits.push({ start: original.stmt.start!, end: original.stmt.end!, text: `${before}${versionText}\n\nexport default ${input.target.name}` });
  } else {
    // `export function X` / `export const X` / `function X` (+ a separate `export default X`) keep their prefix.
    edits.push({ start: original.stmt.start!, end: original.stmt.start!, text: before }, { start: original.decl.start!, end: original.decl.end!, text: versionText });
  }
  for (const [n, oldDecl] of replaced) if (replacedDecls.has(oldDecl)) edits.push({ start: oldDecl.start!, end: oldDecl.end!, text: newHelper.get(vTop.get(n)!.decl)! });
  let text = input.target.text;
  for (const e of edits.sort((x, y) => y.start - x.start || y.end - x.end)) text = text.slice(0, e.start) + e.text + text.slice(e.end);

  // The imports it needs, with paths from the component's folder; the component's own file isn't imported.
  const fromDir = dirOf(input.variants.path);
  const self = stripExt(input.target.path);
  const tImported = new Set<string>();
  for (const s of tAst.program.body) if (s.type === 'ImportDeclaration') for (const sp of s.specifiers) tImported.add(sp.local.name);
  const addedImports: string[] = [];
  const byModule = new Map<string, { names: string[]; types: string[]; others: string[] }>();
  for (const name of needed) {
    const imp = imported.get(name);
    if (!imp || tImported.has(name) || tTop.has(name)) continue;
    const spec = imp.source.value;
    const resolved = spec.startsWith('.') ? resolvePath(fromDir, spec) : undefined;
    if (resolved && stripExt(resolved) === self) continue;
    const module = resolved ? stripExt(relativeImport(input.target.path, resolved)) : spec;
    const sp = imp.specifiers.find((x) => x.local.name === name)!;
    const entry = byModule.get(module) ?? { names: [], types: [], others: [] };
    if (sp.type === 'ImportSpecifier') {
      const importedName = sp.imported.type === 'Identifier' ? sp.imported.name : sp.imported.value;
      const text = importedName === name ? name : `${importedName} as ${name}`;
      (imp.importKind === 'type' || sp.importKind === 'type' ? entry.types : entry.names).push(text);
    } else entry.others.push(sp.type === 'ImportDefaultSpecifier' ? `import ${name} from '${module}'` : `import * as ${name} from '${module}'`);
    byModule.set(module, entry);
  }
  for (const [module, e] of byModule) {
    if (e.names.length) text = ensureImport(text, input.target.path, module, e.names);
    if (e.types.length) text = ensureImport(text, input.target.path, module, e.types, true);
    const semi = /^import[^\n]*['"];$/m.test(input.target.text) ? ';' : '';
    for (const line of e.others.map((l) => l + semi)) {
      const ast = parseSource({ path: input.target.path, text });
      const last = ast?.program.body.filter((s) => s.type === 'ImportDeclaration').pop();
      text = last ? text.slice(0, last.end!) + '\n' + line + text.slice(last.end!) : `${line}\n${text}`;
    }
    addedImports.push(...e.names, ...e.types, ...e.others.map((o) => o.replace(/^import (\* as )?(\w+).*/, '$2')));
  }
  // A version that is a client component (variants.tsx has 'use client'): the real file becomes one too.
  if (/^\s*['"]use client['"]/.test(source) && !/^(?:\s*(?:\/\/[^\n]*|\/\*[\s\S]*?\*\/))*\s*['"]use client['"]/.test(text)) {
    const semi = /^import[^\n]*['"];$/m.test(input.target.text) ? ';' : '';
    text = `'use client'${semi}\n\n${text.replace(/^\s+/, '')}`;
  }
  return { text, helpers: helperNames.map((n) => renames.get(n) ?? n), imports: addedImports };
}

/**
 * A declaration's text with some names changed (`renames`): every use of the name in it, but not object keys or
 * properties that only happen to have the same name.
 */
function sliceRenamed(text: string, decl: N, renames: Map<string, string>): string {
  const edits: { start: number; end: number; name: string }[] = [];
  const visit = (n: N, parent: N | undefined) => {
    if ((n.type === 'Identifier' || n.type === 'JSXIdentifier') && renames.has(n.name)) {
      const prop =
        (parent?.type === 'MemberExpression' || parent?.type === 'OptionalMemberExpression') && parent.property === n && !parent.computed
          ? true
          : (parent?.type === 'ObjectProperty' || parent?.type === 'ObjectMethod' || parent?.type === 'ClassProperty' || parent?.type === 'TSPropertySignature') && (parent as { key?: N }).key === n && !(parent as { computed?: boolean }).computed
            ? !(parent.type === 'ObjectProperty' && parent.shorthand)
            : parent?.type === 'JSXAttribute' || (parent?.type === 'JSXMemberExpression' && parent.property === n);
      if (!prop) edits.push({ start: n.start! - decl.start!, end: n.end! - decl.start!, name: renames.get(n.name)! });
    }
    for (const key of Object.keys(n) as (keyof N)[]) {
      if (key === 'loc' || key === 'start' || key === 'end' || key === 'leadingComments' || key === 'trailingComments' || key === 'innerComments' || key === 'extra') continue;
      const v = n[key] as unknown;
      if (Array.isArray(v)) for (const c of v) c && typeof c === 'object' && typeof (c as N).type === 'string' && visit(c as N, n);
      else if (v && typeof v === 'object' && typeof (v as N).type === 'string') visit(v as N, n);
    }
  };
  visit(decl, undefined);
  let out = text.slice(decl.start!, decl.end!);
  for (const e of edits.sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + e.name + out.slice(e.end);
  return out;
}
