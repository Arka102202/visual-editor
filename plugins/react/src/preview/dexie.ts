// The Dexie stand-in: example rows for the app's own browser database, so components that read it show real-looking
// data in previews. Read from the code: the database class or instance, its tables, their keys (the last
// `.version(n).stores({…})`) and each row's type. A page's address decides the rows it needs: `/project/:projectId`
// gets a project whose id is the address's value, and rows elsewhere that point at it (their `projectId`).
// Pure: no VS Code, no file access (the files' texts are passed in), so it can be tested.

import { fieldsOfType, sample, type TypeFields } from './harness';

export interface DexieInfo {
  /** The file that makes the database (relative path) and the name it's exported as ('default' for a default export). */
  module: string;
  export: string;
  tables: { name: string; rowType?: string; key: string; numericKey: boolean }[];
}

/** Rows to put in each table before a preview draws (the "empty" situation leaves them empty). */
export interface DexieSeed {
  module: string;
  export: string;
  tables: Record<string, Record<string, unknown>[]>;
}

/** The value a page's address gets for each of its parts (`:projectId` → "example"). Shared with the preview page. */
export const ROUTE_VALUE = 'example';

/** Finds the app's Dexie database in its files, when it has one. */
export function findDexie(texts: Map<string, string>): DexieInfo | undefined {
  for (const [path, text] of texts) {
    if (!/\bfrom\s+['"]dexie['"]/.test(text) || !/\.stores\s*\(/.test(text)) continue;
    const cls = /class\s+(\w+)\s+extends\s+Dexie\b/.exec(text)?.[1];
    const exported =
      new RegExp(`export\\s+const\\s+(\\w+)\\s*=\\s*new\\s+(?:${cls ?? 'Dexie'}|Dexie)\\s*\\(`).exec(text)?.[1] ??
      (/export\s+default\s+new\s+\w+\s*\(/.test(text) ? 'default' : undefined) ??
      (() => {
        const name = /(?:const|let)\s+(\w+)\s*=\s*new\s+\w+\s*\(/.exec(text)?.[1];
        return name && new RegExp(`export\\s*\\{[^}]*\\b${name}\\b`).test(text) ? name : name && new RegExp(`export\\s+default\\s+${name}\\b`).test(text) ? 'default' : undefined;
      })();
    if (!exported) continue;
    // Row types from `name!: Table<Row, Key>` (or `Dexie.Table`, or `EntityTable<Row, 'id'>`).
    const rowTypes = new Map<string, { row: string; numeric: boolean }>();
    for (const m of text.matchAll(/(\w+)!?\s*:\s*(?:Dexie\.)?(?:Entity)?Table<\s*(\w+)\s*(?:,\s*([^>]+))?>/g)) rowTypes.set(m[1], { row: m[2], numeric: /number/.test(m[3] ?? '') });
    // The last stores({…}) wins for each table: it's the current version.
    const keys = new Map<string, string>();
    for (const block of text.matchAll(/\.stores\s*\(\s*\{([\s\S]*?)\}\s*\)/g)) {
      for (const m of block[1].matchAll(/['"]?(\w+)['"]?\s*:\s*(["'`])([^"'`]*)\2/g)) keys.set(m[1], m[3]);
    }
    if (!keys.size) continue;
    const tables = [...keys].map(([name, schema]) => {
      const first = schema.split(',')[0].trim();
      const key = first.replace(/^(\+\+|&)/, '') || 'id';
      return { name, ...(rowTypes.get(name) ? { rowType: rowTypes.get(name)!.row } : {}), key, numericKey: first.startsWith('++') || !!rowTypes.get(name)?.numeric };
    });
    return { module: path, export: exported, tables };
  }
  return undefined;
}

/** The parts of a route's address, e.g. "/project/:projectId" → ["projectId"]. */
export function routeParams(route: string | undefined): string[] {
  return [...(route ?? '').matchAll(/:(\w+)/g)].map((m) => m[1]);
}

/** The table a route part points at: projectId → projects (or project, projectes). */
function tableFor(param: string, tables: DexieInfo['tables']): string | undefined {
  const base = param.replace(/(Id|_id|ID)$/, '');
  if (base === param) return undefined;
  return [`${base}s`, base, `${base}es`, `${base.replace(/y$/, 'ie')}s`].find((t) => tables.some((x) => x.name === t));
}

const ROWS = 3;

/** Example rows for every table: the page's own row first (its address's value as the key), rows pointing at it. */
export function seedFor(db: DexieInfo, route: string | undefined, types: TypeFields): DexieSeed {
  const params = routeParams(route);
  const pointed = new Map(params.map((p) => [tableFor(p, db.tables), p]).filter((e): e is [string, string] => !!e[0]));
  const tables: Record<string, Record<string, unknown>[]> = {};
  for (const t of db.tables) {
    const fields = t.rowType ? (types(t.rowType) ?? []) : [];
    tables[t.name] = Array.from({ length: ROWS }, (_v, i) => {
      const row: Record<string, unknown> = {};
      for (const f of fields) {
        if (f.optional && /null|undefined/.test(f.type)) continue;
        // A field naming a part of the address (projectId) points at the page's row.
        row[f.name] = params.includes(f.name) ? ROUTE_VALUE : sample(f.name, f.type, 1, types);
      }
      row[t.key] = t.numericKey ? i + 1 : i === 0 && pointed.has(t.name) ? ROUTE_VALUE : `${t.name}-${i + 1}`;
      return row;
    });
  }
  return { module: db.module, export: db.export, tables };
}

/** Field types for a type name, looked up in the project's files. */
export function typesFrom(texts: Map<string, string>): TypeFields {
  const cache = new Map<string, ReturnType<TypeFields>>();
  return (name) => {
    if (cache.has(name)) return cache.get(name);
    let found: ReturnType<TypeFields>;
    for (const text of texts.values()) {
      if (!text.includes(name)) continue;
      found = fieldsOfType(text, name);
      if (found) break;
    }
    cache.set(name, found);
    return found;
  };
}
