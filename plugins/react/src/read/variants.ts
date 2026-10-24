// Variant folders (docs/variants.md): a component's looks kept apart from its data. A folder is one that has a
// Name.switcher.tsx; from its files: the variants (each Name[.<name>].variant.tsx, its `variant = { id, name }`), the
// one in use (the variant the switcher imports the normal way), the states (the keys of Name.mock.ts's `states`), and
// which way it's made: version 2 has a static part (Name.static.tsx, a working prototype) and starting data;
// version 1 had fixed views in Name.mock.ts. With situations (Button: primary, danger…), the switcher says the design in
// use per situation (`situation: 'kind', inUse: { primary: Rounded, … }`), the types list them (NameSituation), and
// each state shows one (its value for that prop). Pure: files in, folders out.

import { parse } from '@babel/parser';
import type * as t from '@babel/types';
import type { SourceFile } from '@visual-editor/contract';

export interface VariantFolder {
  /** The folder (relative path, forward slashes). */
  dir: string;
  /** The component's name (from the files: Name.switcher.tsx). */
  name: string;
  files: { chooser?: string; types?: string; data?: string; static?: string; mock?: string; switcher: string };
  /** 2: a static part (a working prototype) with starting data; 1: fixed views (folders made before it). */
  version: 1 | 2;
  variants: { id: string; name: string; path: string; for?: string[] }[];
  /** The id of the variant in use (without situations). */
  selected?: string;
  /** With situations: which prop picks one, every situation, the design in use for each, and each state's. */
  situations?: { prop: string; names: string[]; inUse: Record<string, string>; ofState: Record<string, string> };
  states: string[];
  /** What breaks the folder's rules, in words (variantChecks.ts). */
  problems?: string[];
}

const SWITCHER = /^(.*\/)?([^/]+)\.switcher\.[jt]sx?$/;

export function readVariantFolders(files: SourceFile[]): VariantFolder[] {
  const byPath = new Map(files.map((f) => [f.path, f]));
  const out: VariantFolder[] = [];
  for (const f of files) {
    const m = SWITCHER.exec(f.path);
    if (!m) continue;
    const dir = (m[1] ?? '').replace(/\/$/, '');
    const name = m[2];
    const inDir = (rest: RegExp) => files.filter((x) => x.path.startsWith(dir ? `${dir}/` : '') && !x.path.slice(dir ? dir.length + 1 : 0).includes('/') && rest.test(x.path.slice(dir ? dir.length + 1 : 0)));
    const at = (file: string) => (dir ? `${dir}/${file}` : file);
    const first = (...names: string[]) => names.map(at).find((p) => byPath.has(p));
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    const variants = inDir(new RegExp(`^${esc}(\\.[\\w-]+)?\\.variant\\.[jt]sx?$`))
      .map((v) => {
        const file = v.path.slice(dir ? dir.length + 1 : 0);
        const middle = new RegExp(`^${esc}\\.([\\w-]+)\\.variant\\.`).exec(file)?.[1];
        const info = variantInfo(v.text);
        const id = info.id ?? middle ?? 'default';
        return { id, name: info.name ?? title(id), path: v.path, ...(info.for ? { for: info.for } : {}) };
      })
      .sort((a, b) => (a.id === 'default' ? -1 : b.id === 'default' ? 1 : a.id.localeCompare(b.id)));

    // The design in use: the one the switcher imports the normal way (not with import()); with situations, the one
    // its inUse names for each situation.
    const switcher = readSwitcher(f.text, (source) => variants.find((x) => x.path.replace(/\.[jt]sx?$/, '') === at(source.replace(/^\.\//, '')).replace(/\.[jt]sx?$/, ''))?.id);
    const selected = switcher.situation ? undefined : switcher.selected;

    const mock = first(`${name}.mock.ts`, `${name}.mock.tsx`, `${name}.mock.js`);
    const types = first(`${name}.types.ts`, `${name}.types.tsx`);
    const situations = switcher.situation
      ? {
          prop: switcher.situation.prop,
          names: situationNames(types ? (byPath.get(types)?.text ?? '') : '', `${name}Situation`) ?? Object.keys(switcher.situation.inUse),
          inUse: switcher.situation.inUse,
          ofState: mock ? stateValues(byPath.get(mock)!.text, switcher.situation.prop) : {},
        }
      : undefined;
    const chooser = first('index.tsx', 'index.jsx', 'index.ts', 'index.js');
    const staticPart = first(`${name}.static.tsx`, `${name}.static.jsx`, `${name}.static.ts`);
    // Version 2 when it has a static part, or its chooser draws one.
    const version = staticPart || /\bStaticPart\b/.test(chooser ? (byPath.get(chooser)?.text ?? '') : '') ? 2 : 1;
    out.push({
      dir,
      name,
      files: {
        switcher: f.path,
        chooser,
        types,
        data: first(`${name}.data.tsx`, `${name}.data.jsx`, `${name}.data.ts`),
        ...(staticPart ? { static: staticPart } : {}),
        mock,
      },
      version,
      variants,
      ...(selected ? { selected } : {}),
      ...(situations ? { situations } : {}),
      states: mock ? mockStates(byPath.get(mock)!.text) : [],
    });
  }
  return out;
}

/** `export const variant = { id: 'compact', name: 'Compact', for: ['danger'] }`. */
function variantInfo(text: string): { id?: string; name?: string; for?: string[] } {
  const block = /export\s+const\s+variant\s*(?::[^=]+)?=\s*\{([^}]*)\}/.exec(text)?.[1] ?? '';
  const read = (key: string) => new RegExp(`\\b${key}\\s*:\\s*(['"\`])(.*?)\\1`).exec(block)?.[2];
  const list = /\bfor\s*:\s*\[([^\]]*)\]/.exec(block)?.[1];
  const made = list !== undefined ? [...list.matchAll(/(['"`])(.*?)\1/g)].map((m) => m[2]) : undefined;
  return { id: read('id'), name: read('name'), ...(made ? { for: made } : {}) };
}

function parseCode(text: string) {
  try {
    return parse(text, { sourceType: 'module', plugins: ['typescript', 'jsx'], errorRecovery: true });
  } catch {
    return undefined;
  }
}

/**
 * The switcher, read from its code (a commented-out line doesn't count): the design imported the normal way, or, with
 * situations, the prop that picks one and the design in use for each (`makeSwitcher({ situation, inUse: { … } })`).
 */
function readSwitcher(text: string, designOf: (source: string) => string | undefined): { selected?: string; situation?: { prop: string; inUse: Record<string, string> } } {
  const ast = parseCode(text);
  if (!ast) return {};
  const local = new Map<string, string>();
  let selected: string | undefined;
  for (const st of ast.program.body) {
    if (st.type !== 'ImportDeclaration' || st.importKind === 'type' || !st.source.value.startsWith('./')) continue;
    const design = designOf(st.source.value);
    if (!design) continue;
    for (const sp of st.specifiers) if (sp.type === 'ImportDefaultSpecifier') local.set(sp.local.name, design);
    if (!selected && st.specifiers.some((sp) => sp.type === 'ImportDefaultSpecifier')) selected = design;
  }
  let situation: { prop: string; inUse: Record<string, string> } | undefined;
  const visit = (n: unknown): void => {
    if (situation || !n || typeof n !== 'object') return;
    if (Array.isArray(n)) return n.forEach(visit);
    const node = n as t.Node;
    if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === 'makeSwitcher' && node.arguments[0]?.type === 'ObjectExpression') {
      const props = node.arguments[0].properties.filter((p): p is t.ObjectProperty => p.type === 'ObjectProperty');
      const key = (p: t.ObjectProperty) => (p.key.type === 'Identifier' ? p.key.name : p.key.type === 'StringLiteral' ? p.key.value : undefined);
      const prop = props.find((p) => key(p) === 'situation')?.value;
      const map = props.find((p) => key(p) === 'inUse')?.value;
      if (prop?.type === 'StringLiteral' && map?.type === 'ObjectExpression') {
        const inUse: Record<string, string> = {};
        for (const p of map.properties) {
          if (p.type !== 'ObjectProperty') continue;
          const k = key(p);
          const design = p.value.type === 'Identifier' ? local.get(p.value.name) : undefined;
          if (k && design) inUse[k] = design;
        }
        situation = { prop: prop.value, inUse };
        return;
      }
    }
    for (const [k, v] of Object.entries(node)) if (k !== 'loc' && !k.endsWith('Comments') && v && typeof v === 'object') visit(v);
  };
  visit(ast.program.body);
  return { selected, situation };
}

/** The situations a types file lists: `type NameSituation = 'primary' | 'danger'`. */
function situationNames(text: string, typeName: string): string[] | undefined {
  const ast = parseCode(text);
  for (const st of ast?.program.body ?? []) {
    const d: t.Node = st.type === 'ExportNamedDeclaration' && st.declaration ? st.declaration : st;
    if (d.type !== 'TSTypeAliasDeclaration' || d.id.name !== typeName) continue;
    const parts = d.typeAnnotation.type === 'TSUnionType' ? d.typeAnnotation.types : [d.typeAnnotation];
    const names = parts.flatMap((p) => (p.type === 'TSLiteralType' && p.literal.type === 'StringLiteral' ? [p.literal.value] : []));
    return names.length ? names : undefined;
  }
  return undefined;
}

/** Each state's value for one prop (following spreads of the file's own objects): which situation it shows. */
function stateValues(text: string, prop: string): Record<string, string> {
  const ast = parseCode(text);
  if (!ast) return {};
  const consts = new Map<string, t.Node>();
  let states: t.ObjectExpression | undefined;
  const unwrap = (n: t.Node | null | undefined) => {
    while (n && (n.type === 'TSSatisfiesExpression' || n.type === 'TSAsExpression' || n.type === 'ParenthesizedExpression')) n = n.expression;
    return n;
  };
  for (const st of ast.program.body) {
    const d: t.Node = st.type === 'ExportNamedDeclaration' && st.declaration ? st.declaration : st;
    if (d.type !== 'VariableDeclaration') continue;
    for (const v of d.declarations) {
      const init = unwrap(v.init);
      if (v.id.type !== 'Identifier' || !init) continue;
      if (v.id.name === 'states' && init.type === 'ObjectExpression') states = init;
      else consts.set(v.id.name, init);
    }
  }
  const valueIn = (node: t.Node | null | undefined, depth = 0): string | undefined => {
    node = unwrap(node);
    if (!node || depth > 5) return undefined;
    if (node.type === 'Identifier') return valueIn(consts.get(node.name), depth + 1);
    if (node.type !== 'ObjectExpression') return undefined;
    let found: string | undefined;
    for (const p of node.properties) {
      if (p.type === 'SpreadElement') found = valueIn(p.argument, depth + 1) ?? found;
      else if (p.type === 'ObjectProperty' && ((p.key.type === 'Identifier' && p.key.name === prop) || (p.key.type === 'StringLiteral' && p.key.value === prop))) {
        const v = unwrap(p.value as t.Node);
        found = v?.type === 'StringLiteral' ? v.value : found;
      }
    }
    return found;
  };
  const out: Record<string, string> = {};
  for (const p of states?.properties ?? []) {
    if (p.type !== 'ObjectProperty') continue;
    const name = p.key.type === 'Identifier' ? p.key.name : p.key.type === 'StringLiteral' ? p.key.value : undefined;
    const value = name ? valueIn(p.value as t.Node) : undefined;
    if (name && value) out[name] = value;
  }
  return out;
}

/** The names of the states in `export const states = { … }`. */
function mockStates(text: string): string[] {
  let ast;
  try {
    ast = parse(text, { sourceType: 'module', plugins: ['typescript', 'jsx'], errorRecovery: true });
  } catch {
    return [];
  }
  for (const st of ast.program.body) {
    const d: t.Node = st.type === 'ExportNamedDeclaration' && st.declaration ? st.declaration : st;
    if (d.type !== 'VariableDeclaration') continue;
    for (const v of d.declarations) {
      if (v.id.type !== 'Identifier' || v.id.name !== 'states') continue;
      let init = v.init;
      while (init && (init.type === 'TSSatisfiesExpression' || init.type === 'TSAsExpression')) init = init.expression;
      if (init?.type !== 'ObjectExpression') return [];
      return init.properties.flatMap((p) => (p.type === 'ObjectProperty' ? (p.key.type === 'Identifier' ? [p.key.name] : p.key.type === 'StringLiteral' ? [p.key.value] : []) : []));
    }
  }
  return [];
}

function title(id: string): string {
  return id.replace(/[-_]+/g, ' ').replace(/^./, (c) => c.toUpperCase());
}
