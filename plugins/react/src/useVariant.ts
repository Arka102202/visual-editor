// "Use this design": the change that makes another design the one in use. The switcher says which, in one import
// line (docs/variants.md); only that line's address changes, so every other design stays in the list and switching
// back is just as easy. With situations (Button: primary, danger…), only that situation's line in `inUse` changes: the
// design is imported if the switcher doesn't have it yet, and a design no situation uses any more stops being imported
// (so it doesn't ship). Read from the code itself, so a commented-out line can't be the one changed.

import { existsSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { parse } from '@babel/parser';
import type * as t from '@babel/types';
import type { Item, ProjectInfo, ProposedChange } from '@visual-editor/contract';

type Read = (path: string) => string | undefined;

export function useVariant(item: Item, variant: string, project: ProjectInfo, situation?: string, read?: Read): ProposedChange | string {
  read ??= (p) => (existsSync(join(project.root, p)) ? readFileSync(join(project.root, p), 'utf8') : undefined);
  const p = item.preview;
  if (!p || !item.source) return `${item.label} has no variants.`;
  const next = p.variants.find((v) => v.id === variant);
  if (!next) return `${item.label} has no variant “${variant}”.`;
  const dir = posix.dirname(item.source.path);
  const switcher = project.files.find((f) => posix.dirname(f) === dir && /\.switcher\.[cm]?[jt]sx?$/.test(f));
  if (!switcher) return `${item.label} has no switcher file (${item.label}.switcher.tsx), so there's no line that says which variant is in use.`;
  const before = read(switcher);
  if (before === undefined) return `${switcher} couldn't be read.`;
  let ast;
  try {
    ast = parse(before, { sourceType: 'module', plugins: ['typescript', 'jsx'] });
  } catch (e) {
    return `${posix.basename(switcher)} doesn't read as code right now (${e instanceof Error ? e.message : String(e)}). Fix it first.`;
  }
  let address = posix.relative(dir, next.path).replace(/\.[cm]?[jt]sx?$/, '');
  if (!address.startsWith('.')) address = `./${address}`;
  return p.situations ? bySituation(item, next, address, switcher, before, ast.program.body, situation) : single(item, next, address, switcher, before, ast.program.body);
}

/** One design in use: the switcher's normal import of a design file points at the new one. */
function single(item: Item, next: Variant, address: string, switcher: string, before: string, body: t.Statement[]): ProposedChange | string {
  if (next.inUse) return `${next.name} is already the one in use.`;
  const now = item.preview!.variants.find((v) => v.inUse);
  const line = body.find((s) => s.type === 'ImportDeclaration' && isDesignImport(s));
  if (!line || line.type !== 'ImportDeclaration' || line.source.start == null || line.source.end == null) return `${posix.basename(switcher)} doesn't import a variant the normal way, so there's no line to change.`;
  const quote = before[line.source.start];
  const after = before.slice(0, line.source.start) + quote + address + quote + before.slice(line.source.end);
  if (after === before) return `${next.name} is already the one in use.`;
  return {
    title: `${item.label}: use ${next.name} instead of ${now ? now.name : 'the one in use'}`,
    why: `Chosen in the Playground. Only one line changes: the switcher's import of the variant in use. ${now ? `${now.name} stays in the list of variants, so switching back is just as easy.` : ''}`.trim(),
    changes: [{ path: switcher, before, after }],
    look: lookOf(item, [now?.id, next.id]),
  };
}

/** One design in use per situation: that situation's line in `inUse` names the new design. */
function bySituation(item: Item, next: Variant, address: string, switcher: string, before: string, body: t.Statement[], situation?: string): ProposedChange | string {
  const s = item.preview!.situations!;
  if (!situation) return `${item.label} has situations (${s.names.join(', ')}): say which one ${next.name} is for.`;
  if (!s.names.includes(situation)) return `“${situation}” isn't one of ${item.label}'s situations (${s.names.join(', ')}).`;
  if (next.inUseFor?.includes(situation)) return `${next.name} is already the design in use for “${situation}”.`;
  const now = item.preview!.variants.find((v) => v.inUseFor?.includes(situation));

  // The design's local name, if the switcher imports it already (the normal way).
  const imports = body.filter((st): st is t.ImportDeclaration => st.type === 'ImportDeclaration' && isDesignImport(st));
  const localOf = (to: string) => imports.find((st) => st.source.value.replace(/\.[cm]?[jt]sx?$/, '') === to)?.specifiers.find((x) => x.type === 'ImportDefaultSpecifier')?.local.name;
  const map = findInUse(body);
  const entry = map?.properties.find((x): x is t.ObjectProperty => x.type === 'ObjectProperty' && keyOf(x) === situation);
  if (!map || !entry || entry.value.start == null || entry.value.end == null || entry.value.type !== 'Identifier') return `${posix.basename(switcher)} has no line for “${situation}” in inUse, so there's nothing to change.`;
  const oldLocal = entry.value.name;
  let newLocal = localOf(address);
  const edits: { start: number; end: number; text: string }[] = [];
  if (!newLocal) {
    // Imported the normal way, after the last design import (so the app can draw it).
    const taken = new Set(imports.flatMap((st) => st.specifiers.map((x) => x.local.name)));
    const base = next.name.replace(/[^A-Za-z0-9]+/g, '') || 'Design';
    newLocal = /^[A-Z]/.test(base) ? base : `Design${base}`;
    for (let i = 2; taken.has(newLocal); i++) newLocal = `${base}${i}`;
    const last = imports[imports.length - 1];
    const quote = last ? before[last.source.start!] : "'";
    const at = last ? last.end! : 0;
    edits.push({ start: at, end: at, text: `${last ? '\n' : ''}import ${newLocal} from ${quote}${address}${quote}${last ? '' : '\n'}` });
  }
  edits.push({ start: entry.value.start, end: entry.value.end, text: newLocal });
  // The old design: no situation uses it any more → its import goes (it would ship for nothing).
  const stillUsed = map.properties.some((x) => x !== entry && x.type === 'ObjectProperty' && x.value.type === 'Identifier' && x.value.name === oldLocal);
  const oldImport = imports.find((st) => st.specifiers.some((x) => x.type === 'ImportDefaultSpecifier' && x.local.name === oldLocal));
  if (!stillUsed && oldImport && oldImport.specifiers.length === 1 && countName(body, oldLocal) === 2) {
    let end = oldImport.end!;
    if (before[end] === '\n') end++;
    edits.push({ start: oldImport.start!, end, text: '' });
  }
  let after = before;
  for (const e of edits.sort((a, b) => b.start - a.start)) after = after.slice(0, e.start) + e.text + after.slice(e.end);
  return {
    title: `${item.label}: use ${next.name} for “${situation}” instead of ${now ? now.name : 'the one in use'}`,
    why: `Chosen in the Playground. Only “${situation}” changes: the switcher's line for it${edits.length > 1 ? ' (and the design imports that go with it)' : ''}. Other situations keep their designs.`,
    changes: [{ path: switcher, before, after }],
    look: lookOf(item, [now?.id, next.id], situation),
  };
}

type Variant = NonNullable<Item['preview']>['variants'][number];

/** Review's before and after: the variants page with only these designs (and this situation's states). */
function lookOf(item: Item, ids: (string | undefined)[], situation?: string): string {
  return `/__ve/preview?item=${encodeURIComponent(item.id)}&compare=${encodeURIComponent(ids.filter(Boolean).join(','))}${situation ? `&situation=${encodeURIComponent(situation)}` : ''}`;
}

/** A normal import (not a type, not import()) of a design file, with a default name. */
function isDesignImport(s: t.ImportDeclaration): boolean {
  return s.importKind !== 'type' && s.source.value.startsWith('./') && /\.variant$/.test(s.source.value.replace(/\.[cm]?[jt]sx?$/, '')) && s.specifiers.some((x) => x.type === 'ImportDefaultSpecifier');
}

function keyOf(p: t.ObjectProperty): string | undefined {
  return p.key.type === 'Identifier' ? p.key.name : p.key.type === 'StringLiteral' ? p.key.value : undefined;
}

/** `makeSwitcher({ …, inUse: { … } })`: the inUse object. */
function findInUse(body: t.Statement[]): t.ObjectExpression | undefined {
  let found: t.ObjectExpression | undefined;
  const visit = (n: unknown): void => {
    if (found || !n || typeof n !== 'object') return;
    if (Array.isArray(n)) return n.forEach(visit);
    const node = n as t.Node;
    if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === 'makeSwitcher' && node.arguments[0]?.type === 'ObjectExpression') {
      const map = node.arguments[0].properties.find((p): p is t.ObjectProperty => p.type === 'ObjectProperty' && keyOf(p) === 'inUse');
      if (map?.value.type === 'ObjectExpression') found = map.value;
      return;
    }
    for (const [k, v] of Object.entries(node)) if (k !== 'loc' && !k.endsWith('Comments') && v && typeof v === 'object') visit(v);
  };
  visit(body);
  return found;
}

/** How many times a name appears as an identifier in the file (its import counts once). */
function countName(body: t.Statement[], name: string): number {
  let n = 0;
  const visit = (x: unknown): void => {
    if (!x || typeof x !== 'object') return;
    if (Array.isArray(x)) return x.forEach(visit);
    const node = x as t.Node;
    if (node.type === 'Identifier' && node.name === name) n++;
    for (const [k, v] of Object.entries(node)) if (k !== 'loc' && !k.endsWith('Comments') && v && typeof v === 'object') visit(v);
  };
  visit(body);
  return n;
}
