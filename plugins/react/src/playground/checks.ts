// Checks on every version in a playground, so a version that ignores the project's components or design is visible
// before anyone picks it:
// - reuse: which of the project's components it uses, and plain elements or helpers that duplicate one it has
// - design: colours the project never uses (read from its own code) and one-off values like `w-[317px]`
// - types: type errors (from the project's TypeScript)
// - new pieces: components the version invents, so a new shared component is a choice, not an accident
// Pure: no VS Code APIs. From No-Code Map's Playground, where it was proven.

import type * as t from '@babel/types';
import { parseSource, walk } from '../read/ast';
import type { FeModel } from '../read/model';
import { canonical } from './imports';
import type { VariantDecl } from './variantsFile';

export interface CheckItem {
  kind: 'reuse' | 'design' | 'types' | 'new';
  /** False when it's something to fix. */
  ok: boolean;
  text: string;
  /** 1-based line in variants.tsx. */
  line?: number;
}

export interface VersionChecks {
  /** e.g. "Uses 3 components · 2 off-design values · ✓ types". */
  summary: string;
  /** How many things to look at (off-design values, duplicates, type errors). */
  problems: number;
  items: CheckItem[];
}

const COLOR_UTILS = 'bg|text|border|border-[trblxy]|ring|ring-offset|from|via|to|fill|stroke|outline|divide|decoration|accent|caret|shadow|placeholder';
const COLOR = new RegExp(`^(?:${COLOR_UTILS})-((?:[a-z]+)-(?:50|[1-9]00|950)|black|white)(?:\\/\\d+)?$`);
const COLOR_IN_TEXT = new RegExp(`(?:^|[\\s"'\`:])(?:${COLOR_UTILS})-([a-z]+-(?:50|[1-9]00|950)|black|white)(?=[\\s"'\`/]|$)`, 'g');
const ARBITRARY = /^[a-z][\w-]*-\[[^\]]+\]$/;
const HEX = /#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?(?:[0-9a-fA-F]{2})?\b/;

/** HTML elements, and the project components that usually replace them. */
const REPLACES: Record<string, string[]> = {
  button: ['Button', 'IconButton'],
  input: ['Input', 'TextField', 'TextInput'],
  textarea: ['Textarea', 'TextArea'],
  select: ['Select', 'Dropdown'],
  a: ['Link', 'NavLink'],
  img: ['Image', 'Img', 'Avatar'],
  table: ['Table', 'DataTable'],
  dialog: ['Dialog', 'Modal'],
  label: ['Label'],
  hr: ['Divider', 'Separator'],
};

/** The colour classes a project's own code uses (`indigo-600`, `slate-200`, `white`…): its palette in practice. */
export function projectPalette(sources: { path: string; text: string }[]): Map<string, number> {
  const used = new Map<string, number>();
  for (const s of sources) {
    if (s.path.startsWith('.visual-editor/') || !/\.([cm]?[jt]sx?|html|vue|svelte)$/.test(s.path)) continue;
    for (const m of s.text.matchAll(COLOR_IN_TEXT)) used.set(m[1], (used.get(m[1]) ?? 0) + 1);
  }
  return used;
}

/** The closest colour the project does use: the same family, or the most used one with a similar shade. */
function suggestion(color: string, palette: Map<string, number>): string | undefined {
  const [family, shade] = color.split('-');
  const known = [...palette.keys()];
  const sameFamily = known.filter((k) => k.startsWith(`${family}-`));
  const near = (list: string[]) => list.sort((a, b) => Math.abs(Number(a.split('-')[1]) - Number(shade)) - Math.abs(Number(b.split('-')[1]) - Number(shade)) || (palette.get(b) ?? 0) - (palette.get(a) ?? 0))[0];
  if (sameFamily.length) return near(sameFamily);
  const families = new Map<string, number>();
  for (const [k, n] of palette) if (k.includes('-')) families.set(k.split('-')[0], (families.get(k.split('-')[0]) ?? 0) + n);
  // An accent colour gets the project's accent; a grey gets its grey.
  const neutral = (f: string) => /^(slate|gray|zinc|neutral|stone|black|white)$/.test(f);
  const ranked = [...families].sort((a, b) => b[1] - a[1]).map(([f]) => f);
  const top = ranked.find((f) => neutral(f) === neutral(family)) ?? ranked[0];
  return top ? near(known.filter((k) => k.startsWith(`${top}-`))) : undefined;
}

/**
 * Checks each version of a variants file. `typeErrors` are the errors in variants.tsx (or why types weren't checked).
 */
export function checkVariants(input: {
  text: string;
  path: string;
  decls: VariantDecl[];
  fe: FeModel | null;
  palette: Map<string, number>;
  typeErrors: { line: number; message: string }[] | { skipped: string };
}): Record<string, VersionChecks> {
  const ast = parseSource({ path: input.path, text: input.text });
  const lineOf = (pos: number) => input.text.slice(0, pos).split('\n').length;
  const components = new Map((input.fe?.components ?? []).filter((c) => !c.path.startsWith('.visual-editor/')).map((c) => [c.name, c]));
  const byCanonical = new Map([...components.values()].map((c) => [canonical(c.name), c]));
  const variantNames = new Set(input.decls.map((d) => d.exportName));

  // What the file imports, and the components it defines that aren't versions (helpers: "new pieces").
  const imported = new Set<string>();
  const helpers = new Map<string, { line: number; start: number; end: number }>();
  if (ast) {
    for (const s of ast.program.body) {
      if (s.type === 'ImportDeclaration') for (const sp of s.specifiers) imported.add(sp.local.name);
    }
    walk(ast, (n) => {
      const name =
        n.type === 'FunctionDeclaration' && n.id ? n.id.name : n.type === 'VariableDeclarator' && n.id.type === 'Identifier' && n.init && /Function|Call/.test(n.init.type) ? n.id.name : undefined;
      if (!name || !/^[A-Z][a-z]/.test(name) || variantNames.has(name)) return;
      const body = n.type === 'FunctionDeclaration' ? n.body : (n as t.VariableDeclarator).init!;
      let jsx = false;
      walk(body, (x) => {
        if (x.type === 'JSXElement' || x.type === 'JSXFragment') jsx = true;
      });
      if (jsx) helpers.set(name, { line: lineOf(n.start!), start: n.start!, end: n.end! });
    });
  }

  const out: Record<string, VersionChecks> = {};
  const header = input.decls[0]?.start ?? input.text.length;
  // Each version's own code: its exported declaration (helpers between versions belong to whoever uses them).
  const own = new Map<string, { start: number; end: number }>();
  for (const s of ast?.program.body ?? []) {
    if (s.type !== 'ExportNamedDeclaration' || !s.declaration) continue;
    const decl = s.declaration;
    const names = decl.type === 'FunctionDeclaration' && decl.id ? [decl.id.name] : decl.type === 'VariableDeclaration' ? decl.declarations.flatMap((x) => (x.id.type === 'Identifier' ? [x.id.name] : [])) : [];
    for (const name of names) own.set(name, { start: s.start!, end: s.end! });
  }
  for (const d of input.decls) {
    const items: CheckItem[] = [];
    const range = own.get(d.exportName) ?? { start: d.start, end: d.end };
    const inside = (n: t.Node) => n.start! >= range.start && n.end! <= range.end;
    const reused = new Set<string>();
    const plain = new Map<string, number>();
    const usedHelpers = new Set<string>();
    const offColors = new Map<string, number>();
    const oneOff = new Map<string, number>();
    const hexes = new Map<string, number>();

    if (ast) {
      walk(ast, (n) => {
        if (!inside(n)) return;
        if (n.type === 'JSXOpeningElement' && n.name.type === 'JSXIdentifier') {
          const tag = n.name.name;
          if (/^[A-Z]/.test(tag)) {
            if (helpers.has(tag)) usedHelpers.add(tag);
            else if (imported.has(tag) && components.has(tag)) reused.add(tag);
          } else if (REPLACES[tag] && !plain.has(tag)) plain.set(tag, lineOf(n.start!));
        }
        if (n.type === 'JSXAttribute' && n.name.type === 'JSXIdentifier' && /^(className|class)$/.test(n.name.name) && n.value) {
          walk(n.value, (v) => {
            const texts = v.type === 'StringLiteral' ? [v.value] : v.type === 'TemplateElement' ? [v.value.cooked ?? ''] : [];
            for (const text of texts) {
              for (const raw of text.split(/\s+/).filter(Boolean)) {
                const cls = raw.split(':').pop()!.replace(/^!/, '');
                const color = COLOR.exec(cls)?.[1];
                if (color && color !== 'white' && color !== 'black' && input.palette.size && !input.palette.has(color) && !offColors.has(color)) offColors.set(color, lineOf(v.start!));
                if (ARBITRARY.test(cls) && !oneOff.has(cls)) oneOff.set(cls, lineOf(v.start!));
              }
            }
          });
        }
        if (n.type === 'StringLiteral' && HEX.test(n.value)) {
          const hex = HEX.exec(n.value)![0];
          if (!hexes.has(hex)) hexes.set(hex, lineOf(n.start!));
        }
      });
    }
    // Helpers defined inside the version count as its new pieces too.
    for (const [name, h] of helpers) if (h.start >= range.start && h.end <= range.end) usedHelpers.add(name);

    // Reuse
    if (reused.size) items.push({ kind: 'reuse', ok: true, text: `Uses ${[...reused].sort().join(', ')}` });
    else if (components.size) items.push({ kind: 'reuse', ok: true, text: 'Uses none of the project\'s components' });
    for (const [tag, line] of plain) {
      const has = REPLACES[tag].map((n) => components.get(n)).find(Boolean);
      if (has && !reused.has(has.name)) items.push({ kind: 'reuse', ok: false, text: `A plain <${tag}>: the project has ${has.name} (${has.path})`, line });
    }
    for (const name of usedHelpers) {
      const twin = byCanonical.get(canonical(name)) ?? [...byCanonical.values()].find((c) => name.endsWith(c.name) && c.name.length >= 4);
      const h = helpers.get(name)!;
      if (twin) items.push({ kind: 'reuse', ok: false, text: `Defines its own ${name}: the project has ${twin.name} (${twin.path})`, line: h.line });
      else items.push({ kind: 'new', ok: true, text: `New piece: ${name}`, line: h.line });
    }

    // Design
    for (const [color, line] of offColors) {
      const s = suggestion(color, input.palette);
      items.push({ kind: 'design', ok: false, text: `Colour ${color} isn't used anywhere in the project${s ? `; closest it uses: ${s}` : ''}`, line });
    }
    for (const [cls, line] of oneOff) items.push({ kind: 'design', ok: false, text: `One-off value ${cls}: use a size or colour from the design system`, line });
    for (const [hex, line] of hexes) items.push({ kind: 'design', ok: false, text: `Hard-coded colour ${hex}`, line });

    // Types: errors inside this version, and in the shared part at the top (they break every version).
    if ('skipped' in input.typeErrors) items.push({ kind: 'types', ok: true, text: `Types not checked: ${input.typeErrors.skipped}` });
    else {
      const startLine = lineOf(d.start);
      const endLine = lineOf(d.end);
      const mine = input.typeErrors.filter((e) => (e.line >= startLine && e.line < endLine) || (d === input.decls[input.decls.length - 1] && e.line >= startLine) || e.line < lineOf(header));
      for (const e of mine.slice(0, 5)) items.push({ kind: 'types', ok: false, text: e.message, line: e.line });
      if (mine.length > 5) items.push({ kind: 'types', ok: false, text: `…and ${mine.length - 5} more type errors` });
      if (!mine.length) items.push({ kind: 'types', ok: true, text: 'No type errors' });
    }

    const typeErrors = items.filter((i) => i.kind === 'types' && !i.ok).length;
    const design = items.filter((i) => i.kind === 'design').length;
    const dup = items.filter((i) => i.kind === 'reuse' && !i.ok).length;
    const parts = [
      reused.size ? `Uses ${reused.size} component${reused.size === 1 ? '' : 's'}` : components.size ? 'Uses no project components' : '',
      dup ? `${dup} duplicate${dup === 1 ? '' : 's'}` : '',
      design ? `${design} off-design value${design === 1 ? '' : 's'}` : '',
      'skipped' in input.typeErrors ? '' : typeErrors ? `✗ ${mine(typeErrors)}` : '✓ types',
    ].filter(Boolean);
    out[d.exportName] = { summary: parts.join(' · '), problems: typeErrors + design + dup, items };
  }
  return out;
}

const mine = (n: number) => `${n} type error${n === 1 ? '' : 's'}`;
