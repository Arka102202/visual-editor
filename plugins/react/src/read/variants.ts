// Variant folders (docs/variants.md): a component's looks kept apart from its data. A folder is one that has a
// Name.switcher.tsx; from its files: the variants (each Name[.<name>].variant.tsx, its `variant = { id, name }`), the
// one in use (the variant the switcher imports the normal way), and the mock states (the keys of Name.mock.ts's
// `states`). Pure: files in, folders out.

import { parse } from '@babel/parser';
import type * as t from '@babel/types';
import type { SourceFile } from '@visual-editor/contract';

export interface VariantFolder {
  /** The folder (relative path, forward slashes). */
  dir: string;
  /** The component's name (from the files: Name.switcher.tsx). */
  name: string;
  files: { chooser?: string; types?: string; data?: string; mock?: string; switcher: string };
  variants: { id: string; name: string; path: string }[];
  /** The id of the variant in use. */
  selected?: string;
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
        return { id, name: info.name ?? title(id), path: v.path };
      })
      .sort((a, b) => (a.id === 'default' ? -1 : b.id === 'default' ? 1 : a.id.localeCompare(b.id)));

    // The variant in use: the one the switcher imports the normal way (not with import()).
    const imported = /^\s*import\s+[^;]*?from\s+['"](\.\/[^'"]+)['"]/gm;
    let selected: string | undefined;
    for (let hit = imported.exec(f.text); hit && !selected; hit = imported.exec(f.text)) {
      const target = hit[1].replace(/^\.\//, '');
      const v = variants.find((x) => x.path === at(target) || x.path.replace(/\.[jt]sx?$/, '') === at(target));
      if (v) selected = v.id;
    }

    const mock = first(`${name}.mock.ts`, `${name}.mock.tsx`, `${name}.mock.js`);
    out.push({
      dir,
      name,
      files: {
        switcher: f.path,
        chooser: first('index.tsx', 'index.jsx', 'index.ts', 'index.js'),
        types: first(`${name}.types.ts`, `${name}.types.tsx`),
        data: first(`${name}.data.tsx`, `${name}.data.jsx`, `${name}.data.ts`),
        mock,
      },
      variants,
      ...(selected ? { selected } : {}),
      states: mock ? mockStates(byPath.get(mock)!.text) : [],
    });
  }
  return out;
}

/** `export const variant = { id: 'compact', name: 'Compact' }`. */
function variantInfo(text: string): { id?: string; name?: string } {
  const block = /export\s+const\s+variant\s*(?::[^=]+)?=\s*\{([^}]*)\}/.exec(text)?.[1] ?? '';
  const read = (key: string) => new RegExp(`\\b${key}\\s*:\\s*(['"\`])(.*?)\\1`).exec(block)?.[2];
  return { id: read('id'), name: read('name') };
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
