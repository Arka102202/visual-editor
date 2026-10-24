// Checks on a variant folder (docs/variants.md), each problem in plain words with what to do: missing pieces, variant
// ids, the variant in use, what would ship to users (designs, the static part or the starting data loaded up front),
// designs that use data, a static part that isn't a prototype (uses data, doesn't draw the switcher, ignores what it's
// given), and states missing what they need (NameStart in version 2, NameView in version 1). Pure: the folder, its
// files and the model in, problems out.

import { parse } from '@babel/parser';
import type * as t from '@babel/types';
import type { SourceFile } from '@visual-editor/contract';
import type { FeComponent } from './model';
import type { VariantFolder } from './variants';

const DATA_WORDS: Record<string, string> = { api: 'calls the API', query: 'loads data with', db: 'reads the database', store: 'reads the store', context: 'reads the context', router: 'uses the router' };

export function checkFolder(folder: VariantFolder, files: SourceFile[], components: FeComponent[]): string[] {
  const text = (path?: string) => (path ? files.find((f) => f.path === path)?.text : undefined);
  const base = (path: string) => path.split('/').pop() ?? path;
  const n = folder.name;
  const out: string[] = [];

  // Missing pieces.
  if (!folder.files.chooser) out.push(`There’s no index.tsx: the rest of the app has nothing to import that chooses between real and fixed data.`);
  if (!folder.files.types) out.push(`There’s no ${n}.types.ts: the real data, the mock data and the variants have no shared shape to keep them from drifting apart.`);
  if (!folder.files.data) out.push(`There’s no ${n}.data.tsx: the real data (hooks, API, stores) has nowhere to live.`);
  if (!folder.files.mock) out.push(folder.version === 2 ? `There’s no ${n}.mock.ts: the static part has no starting data.` : `There’s no ${n}.mock.ts: Preview has no fixed data to show the variants with.`);
  if (folder.version === 2 && !folder.files.static) out.push(`index.tsx draws a static part, but there’s no ${n}.static.tsx: Preview has no working prototype to show.`);
  if (!folder.variants.length) out.push(`There are no variants (${n}.variant.tsx): nothing to show.`);

  // Variant ids.
  const seen = new Map<string, string>();
  for (const v of folder.variants) {
    const had = seen.get(v.id);
    if (had) out.push(`Two variants have the id “${v.id}”: ${base(had)} and ${base(v.path)}. Give each its own (export const variant = { id, name }).`);
    seen.set(v.id, v.path);
    if (!/export\s+const\s+variant\s*(?::[^=]+)?=\s*\{[^}]*\bid\s*:/.test(text(v.path) ?? '')) out.push(`${base(v.path)} doesn’t say its id (export const variant = { id: '…', name: '…' }): it’s taken from the file name.`);
    if (!new RegExp(`\\b${n}View\\b`).test(text(v.path) ?? '') && folder.files.types) out.push(`${base(v.path)} doesn’t take ${n}View, so it may not match the data it’s given.`);
  }

  // The switcher: the variant in use, what loads up front, and the list for Preview.
  const sw = text(folder.files.switcher) ?? '';
  if (!folder.selected && !folder.situations && folder.variants.length) out.push(`${base(folder.files.switcher)} doesn’t import a variant the normal way, so the app has no variant in use.`);
  // Situations: a design in use for every one, made for it, and a state that shows it.
  const sit = folder.situations;
  if (sit) {
    for (const s of sit.names) {
      const id = sit.inUse[s];
      if (!id) out.push(`${base(folder.files.switcher)} has no design in use for “${s}”: add it to inUse (${s}: TheDesign).`);
      else {
        const v = folder.variants.find((x) => x.id === id);
        if (v?.for && !v.for.includes(s)) out.push(`${v.name} is in use for “${s}”, but it’s made only for ${v.for.map((x) => `“${x}”`).join(', ')}. Use another design for “${s}”, or add it to ${base(v.path)}’s \`for\`.`);
      }
      if (folder.files.mock && !Object.values(sit.ofState).includes(s)) out.push(`No state in ${base(folder.files.mock)} shows “${s}” (${sit.prop}: '${s}'), so the Playground can’t show its design.`);
    }
    for (const s of Object.keys(sit.inUse)) if (!sit.names.includes(s)) out.push(`${base(folder.files.switcher)} has a design in use for “${s}”, which isn’t one of ${n}Situation (${sit.names.join(', ')}).`);
  }
  // Read from the code itself (a commented-out line doesn't count).
  const swImports = importsOf(sw);
  const upFront = swImports.upFront;
  // Designs in use: the one (or one per situation); any other loaded up front would ship to users.
  const inUse = new Set(folder.situations ? Object.values(folder.situations.inUse) : folder.selected ? [folder.selected] : []);
  for (const v of folder.variants) {
    const file = base(v.path).replace(/\.[jt]sx?$/, '');
    if (!inUse.has(v.id) && upFront.some((u) => u.replace(/\.[jt]sx?$/, '') === file)) out.push(`${base(folder.files.switcher)} loads ${v.name} up front, but it isn’t in use, so it would ship to users. List it only in the development-only list (import()).`);
  }
  const listed = swImports.onRequest.map((m) => m.replace(/\.[jt]sx?$/, ''));
  for (const v of folder.variants) {
    if (!listed.includes(base(v.path).replace(/\.[jt]sx?$/, ''))) out.push(`${v.name} isn’t in ${base(folder.files.switcher)}’s list of variants, so Preview won’t show it.`);
  }
  if (listed.length && !/import\.meta\.env\.DEV|process\.env\.NODE_ENV/.test(stripComments(sw))) out.push(`${base(folder.files.switcher)}’s list of variants isn’t for development only (import.meta.env.DEV ? … : undefined), so every variant would ship to users.`);

  // The chooser: the real data in the app; the static part and the starting data only in development, on request.
  const ch = text(folder.files.chooser) ?? '';
  const chImports = importsOf(ch);
  const stem = (p: string) => base(p).replace(/\.[jt]sx?$/, '');
  const loads = (list: string[], file: string) => list.some((p) => p.replace(/\.[jt]sx?$/, '') === stem(file));
  if (folder.files.chooser && folder.files.data && !loads(chImports.upFront, folder.files.data)) out.push(`index.tsx doesn’t draw ${base(folder.files.data)}, so the app has no real data.`);
  const devOnly = /import\.meta\.env\.DEV|process\.env\.NODE_ENV/.test(stripComments(ch));
  for (const [file, what] of [[folder.files.mock, folder.version === 2 ? 'the starting data' : 'the mock data'], [folder.files.static, 'the static part']] as const) {
    if (!file || !folder.files.chooser) continue;
    if (loads(chImports.upFront, file)) out.push(`index.tsx loads ${base(file)} up front, so ${what} would ship to users. Load it with import(), for development only.`);
    else if (loads(chImports.onRequest, file) && !devOnly) out.push(`index.tsx loads ${what} in production too. Load it only when import.meta.env.DEV.`);
  }

  // The static part: a prototype. No data (its data is kept in memory), the switcher drawn, what it's given used.
  if (folder.files.static) {
    const st = text(folder.files.static) ?? '';
    const file = base(folder.files.static);
    for (const c of components.filter((x) => x.path === folder.files.static)) {
      for (const d of c.data) {
        out.push(
          d.kind === 'router'
            ? `${file} uses the router (${d.label}). A preview is one page: to “go” somewhere, call goTo('/the/address') from the helper; it shows where it would go and stays.`
            : `${file} ${DATA_WORDS[d.kind] ?? 'uses data:'} ${d.label}. The static part is a prototype with no network: keep its data in memory (React state), starting from ${n}.mock.ts.`,
        );
      }
    }
    if (!importsOf(st).upFront.some((p) => p.replace(/\.[jt]sx?$/, '') === `${n}.switcher`)) out.push(`${file} doesn’t draw ${n}.switcher, so the designs never get what it shapes.`);
    const takes = components.filter((x) => x.path === folder.files.static).some((c) => c.props.length > 0);
    if (!takes && fieldsOf(text(folder.files.types) ?? '', `${n}Start`).length) out.push(`${file} doesn’t take ${n}Start, so it can’t start from its starting data, or from what a parent passes.`);
  }

  // Variants show looks only: no data.
  for (const v of folder.variants) {
    for (const c of components.filter((x) => x.path === v.path)) {
      for (const d of c.data) out.push(`${v.name} (${base(v.path)}) ${DATA_WORDS[d.kind] ?? 'uses data:'} ${d.label}. A variant shows looks only: move it to ${n}.data.tsx and pass what it gives in ${n}View.`);
    }
  }

  // States: a default, and everything they need (version 2: what the static part starts from; version 1: the view).
  if (folder.files.mock) {
    // (With situations, states are named after them: Preview starts with the first.)
    if (folder.states.length && !folder.states.includes('default') && !folder.situations) out.push(`${base(folder.files.mock)} has no “default” state: Preview starts with it.`);
    if (!folder.states.length) out.push(`${base(folder.files.mock)} has no states (export const states = { default: { … } }).`);
    const type = folder.version === 2 ? `${n}Start` : `${n}View`;
    const typesText = text(folder.files.types) ?? '';
    if (folder.version === 2 && folder.files.types && !declares(typesText, type)) out.push(`${base(folder.files.types)} has no ${type}: what the static part starts from (for a component, usually the same as ${n}Props).`);
    const needs = fieldsOf(typesText, type);
    if (needs.length) {
      for (const [state, keys] of mockKeys(text(folder.files.mock) ?? '')) {
        if (!keys) continue;
        const missing = needs.filter((k) => !keys.has(k));
        if (missing.length) out.push(`The state “${state}” is missing ${missing.join(', ')} (${type} needs ${missing.length === 1 ? 'it' : 'them'}).`);
      }
    }
  }
  return out;
}

/** The project files a file imports (./ only): the normal way (loaded up front) and with import() (on request). */
function importsOf(text: string): { upFront: string[]; onRequest: string[] } {
  const out = { upFront: [] as string[], onRequest: [] as string[] };
  const ast = parseCode(text);
  if (!ast) return out;
  const visit = (n: unknown): void => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) return n.forEach(visit);
    const node = n as t.Node;
    if (node.type === 'ImportDeclaration' && node.importKind !== 'type' && node.source.value.startsWith('./') && !node.specifiers.every((s) => s.type === 'ImportSpecifier' && s.importKind === 'type')) out.upFront.push(node.source.value.slice(2));
    if (node.type === 'CallExpression' && node.callee.type === 'Import' && node.arguments[0]?.type === 'StringLiteral' && node.arguments[0].value.startsWith('./')) out.onRequest.push(node.arguments[0].value.slice(2));
    for (const [k, v] of Object.entries(node)) if (k !== 'loc' && k !== 'leadingComments' && k !== 'trailingComments' && k !== 'innerComments' && v && typeof v === 'object') visit(v);
  };
  visit(ast.program.body);
  return out;
}

/** Code without its comments (for looking for words in it). */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

function parseCode(text: string) {
  try {
    return parse(text, { sourceType: 'module', plugins: ['typescript', 'jsx'], errorRecovery: true });
  } catch {
    return undefined;
  }
}

function unwrap(n: t.Node | null | undefined): t.Node | null | undefined {
  while (n && (n.type === 'TSSatisfiesExpression' || n.type === 'TSAsExpression' || n.type === 'ParenthesizedExpression')) n = n.expression;
  return n;
}

/** The fields a type needs (not optional): `interface X { … }`, `type X = { … }`, or `type X = Y` (Y in the same file). */
function fieldsOf(text: string, name: string, depth = 0): string[] {
  const ast = parseCode(text);
  if (!ast || depth > 3) return [];
  for (const st of ast.program.body) {
    const d: t.Node = st.type === 'ExportNamedDeclaration' && st.declaration ? st.declaration : st;
    if (d.type === 'TSTypeAliasDeclaration' && d.id.name === name && d.typeAnnotation.type === 'TSTypeReference' && d.typeAnnotation.typeName.type === 'Identifier') return fieldsOf(text, d.typeAnnotation.typeName.name, depth + 1);
    const members = d.type === 'TSInterfaceDeclaration' && d.id.name === name ? d.body.body : d.type === 'TSTypeAliasDeclaration' && d.id.name === name && d.typeAnnotation.type === 'TSTypeLiteral' ? d.typeAnnotation.members : undefined;
    if (members) return members.flatMap((m) => (m.type === 'TSPropertySignature' && !m.optional && m.key.type === 'Identifier' ? [m.key.name] : []));
  }
  return [];
}

/** Whether a file declares a type (interface or type alias) by this name. */
function declares(text: string, name: string): boolean {
  const ast = parseCode(text);
  return !!ast?.program.body.some((st) => {
    const d: t.Node = st.type === 'ExportNamedDeclaration' && st.declaration ? st.declaration : st;
    return (d.type === 'TSInterfaceDeclaration' || d.type === 'TSTypeAliasDeclaration') && d.id.name === name;
  });
}

/** Each mock state and the keys it sets (spreads of the file's own objects followed); undefined when it can't be told. */
function mockKeys(text: string): [string, Set<string> | undefined][] {
  const ast = parseCode(text);
  if (!ast) return [];
  const consts = new Map<string, t.Node>();
  let states: t.ObjectExpression | undefined;
  for (const st of ast.program.body) {
    const d: t.Node = st.type === 'ExportNamedDeclaration' && st.declaration ? st.declaration : st;
    if (d.type !== 'VariableDeclaration') continue;
    for (const v of d.declarations) {
      if (v.id.type !== 'Identifier') continue;
      const init = unwrap(v.init);
      if (!init) continue;
      if (v.id.name === 'states' && init.type === 'ObjectExpression') states = init;
      else consts.set(v.id.name, init);
    }
  }
  const keysOf = (node: t.Node | null | undefined, depth = 0): Set<string> | undefined => {
    node = unwrap(node);
    if (!node || depth > 5) return undefined;
    if (node.type === 'Identifier') return keysOf(consts.get(node.name), depth + 1);
    if (node.type !== 'ObjectExpression') return undefined;
    const out = new Set<string>();
    for (const p of node.properties) {
      if (p.type === 'SpreadElement') {
        const inner = keysOf(p.argument, depth + 1);
        if (!inner) return undefined;
        for (const k of inner) out.add(k);
      } else if ((p.type === 'ObjectProperty' || p.type === 'ObjectMethod') && (p.key.type === 'Identifier' || p.key.type === 'StringLiteral')) {
        out.add(p.key.type === 'Identifier' ? p.key.name : p.key.value);
      }
    }
    return out;
  };
  if (!states) return [];
  return states.properties.flatMap((p) => (p.type === 'ObjectProperty' && (p.key.type === 'Identifier' || p.key.type === 'StringLiteral') ? [[p.key.type === 'Identifier' ? p.key.name : p.key.value, keysOf(p.value as t.Node)] as [string, Set<string> | undefined]] : []));
}
