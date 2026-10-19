// Data the app keeps in the browser and reads back (a cart in localStorage, drafts in localForage or idb-keyval): the
// preview puts example data there first, worked out from the type the code reads it as, so components that start
// from saved data show something. Login tokens are left to the login situations. Pure, so it can be tested.

import type * as t from '@babel/types';
import { forEachChild, parseSource } from '../read/ast';
import type { TypeView } from '../read/types';
import { exampleOf } from './replies';
import type { Shape } from '../read/shapes';

export type SavedKind = 'local' | 'session' | 'localforage' | 'idb-keyval';

export interface FoundSaved {
  kind: SavedKind;
  key: string;
  /** Where the value read is kept: a typed variable (its name's position) or a function's return. */
  path: string;
  start: number;
  returned: boolean;
}

export interface SavedSeed {
  kind: SavedKind;
  key: string;
  value: unknown;
  /** The value's shape (for the situations it offers); not sent to the page. */
  shape?: Shape;
}

/** Keys that hold a login: the login situations set or clear those. */
const LOGIN_KEY = /token|auth|session|jwt|credential/i;

/** Saved data the code reads back, with where its type can be found. */
export function findSaved(files: { path: string; text: string }[]): FoundSaved[] {
  const out: FoundSaved[] = [];
  for (const f of files) {
    if (!/localStorage|sessionStorage|localforage|localForage|idb-keyval/.test(f.text)) continue;
    const ast = parseSource(f);
    if (!ast) continue;
    const constants = new Map([...f.text.matchAll(/const\s+(\w+)\s*=\s*(['"`])([^'"`$]+)\2/g)].map((m) => [m[1], m[3]]));
    // How this file reaches localForage and idb-keyval's get.
    const forage = new Set<string>();
    const keyval = new Set<string>();
    for (const s of ast.program.body) {
      if (s.type !== 'ImportDeclaration') continue;
      for (const spec of s.specifiers) {
        if (s.source.value === 'localforage') forage.add(spec.local.name);
        if (s.source.value === 'idb-keyval' && spec.type === 'ImportSpecifier' && spec.imported.type === 'Identifier' && spec.imported.name === 'get') keyval.add(spec.local.name);
      }
    }
    const keyOf = (n: t.Node | undefined): string | undefined => {
      if (!n) return undefined;
      if (n.type === 'StringLiteral') return n.value;
      if (n.type === 'TemplateLiteral' && !n.expressions.length) return n.quasis[0].value.cooked ?? undefined;
      if (n.type === 'Identifier') return constants.get(n.name);
      return undefined;
    };
    /** A read of saved data: its kind and key. */
    const readOf = (n: t.Node): { kind: SavedKind; key: string } | undefined => {
      if (n.type !== 'CallExpression') return undefined;
      const c = n.callee;
      // JSON.parse(localStorage.getItem(key) ?? '[]')
      if (c.type === 'MemberExpression' && c.object.type === 'Identifier' && c.object.name === 'JSON' && c.property.type === 'Identifier' && c.property.name === 'parse') {
        let arg = n.arguments[0];
        while (arg && (arg.type === 'LogicalExpression' || arg.type === 'TSNonNullExpression' || arg.type === 'TSAsExpression')) arg = arg.type === 'LogicalExpression' ? arg.left : arg.expression;
        if (arg?.type !== 'CallExpression' || arg.callee.type !== 'MemberExpression') return undefined;
        const store = arg.callee.object;
        const name = store.type === 'Identifier' ? store.name : store.type === 'MemberExpression' && store.property.type === 'Identifier' ? store.property.name : '';
        const kind = name === 'localStorage' ? 'local' : name === 'sessionStorage' ? 'session' : undefined;
        const key = keyOf(arg.arguments[0]);
        return kind && key && arg.callee.property.type === 'Identifier' && arg.callee.property.name === 'getItem' ? { kind, key } : undefined;
      }
      // localforage.getItem<T>(key)
      if (c.type === 'MemberExpression' && c.object.type === 'Identifier' && forage.has(c.object.name) && c.property.type === 'Identifier' && c.property.name === 'getItem') {
        const key = keyOf(n.arguments[0]);
        return key ? { kind: 'localforage', key } : undefined;
      }
      // get<T>(key) from idb-keyval
      if (c.type === 'Identifier' && keyval.has(c.name)) {
        const key = keyOf(n.arguments[0]);
        return key ? { kind: 'idb-keyval', key } : undefined;
      }
      return undefined;
    };
    const stack: t.Node[] = [];
    const visit = (n: t.Node) => {
      const read = readOf(n);
      if (read && !LOGIN_KEY.test(read.key)) {
        const where = holder(stack);
        if (where) out.push({ ...read, path: f.path, ...where });
      }
      stack.push(n);
      forEachChild(n as never, visit as never);
      stack.pop();
    };
    visit(ast.program);
  }
  // One per key: the first typed place that reads it.
  const seen = new Set<string>();
  return out.filter((s) => !seen.has(`${s.kind} ${s.key}`) && !!seen.add(`${s.kind} ${s.key}`));
}

/** Nodes a read value passes through unchanged on its way to where it's kept. */
const PASSES = new Set(['TSAsExpression', 'TSSatisfiesExpression', 'TSNonNullExpression', 'LogicalExpression', 'ConditionalExpression', 'AwaitExpression', 'ParenthesizedExpression', 'ReturnStatement', 'BlockStatement', 'TryStatement', 'ArrowFunctionExpression', 'FunctionExpression']);
/** Hooks whose first argument (or what it returns) becomes the variable's value. */
const KEEPS = /^(useState|useMemo|useRef|useReducer)$/;

/**
 * Where the value read ends up, looking out from the read: a variable (`const cart: Item[] = …`, `const [cart] =
 * useState<Item[]>(() => …)`) or a function that returns it (`function loadCart(): Item[]`). Anything else (passed to
 * a setter, used in an expression) has no type to go by.
 */
function holder(stack: t.Node[]): { start: number; returned: boolean } | undefined {
  let prev: t.Node | undefined;
  for (let i = stack.length - 1; i >= 0; i--) {
    const n = stack[i];
    if (n.type === 'VariableDeclarator') {
      const id = n.id.type === 'ArrayPattern' ? n.id.elements[0] : n.id;
      const returned = !!prev && (prev.type === 'ArrowFunctionExpression' || prev.type === 'FunctionExpression') && n.init === prev;
      return id?.type === 'Identifier' ? { start: id.start ?? 0, returned } : undefined;
    }
    if (n.type === 'FunctionDeclaration') return n.id ? { start: n.id.start ?? 0, returned: true } : undefined;
    const keeps = n.type === 'CallExpression' && n.callee.type === 'Identifier' && KEEPS.test(n.callee.name) && n.arguments[0] === prev;
    if (!PASSES.has(n.type) && !keeps) return undefined;
    // A function passed somewhere other than a keeping hook (useEffect, an event handler): not a holder.
    if ((n.type === 'ArrowFunctionExpression' || n.type === 'FunctionExpression') && stack[i - 1]?.type === 'CallExpression') {
      const call = stack[i - 1] as t.CallExpression;
      if (!(call.callee.type === 'Identifier' && KEEPS.test(call.callee.name))) return undefined;
    }
    prev = n;
  }
  return undefined;
}

/** Example values for the saved data, from the types the code reads it as. */
export function savedSeeds(found: FoundSaved[], view: TypeView | undefined): SavedSeed[] {
  if (!view) return [];
  const seeds: SavedSeed[] = [];
  for (const s of found) {
    let type = view.typeAt(s.path, s.start);
    if (type && s.returned) {
      const sig = type.getCallSignatures()[0];
      type = sig ? view.checker.getReturnTypeOfSignature(sig) : undefined;
    }
    const shape = type ? view.shapeOf(type) : undefined;
    if (!shape || (!shape.kind && !shape.fields && !shape.item)) continue;
    seeds.push({ kind: s.kind, key: s.key, value: exampleOf(shape, keyNoun(s.key)), shape });
  }
  return seeds;
}

/** What a key holds, for naming example values: `state-shop.wishlist` → "wishlist", `recent-searches` → "recentSearches". */
export function keyNoun(key: string): string {
  const last = key.split(/[.:/]/).filter(Boolean).pop() ?? key;
  return last.replace(/[^a-z0-9]+(.)?/gi, (_m, c: string | undefined) => (c ? c.toUpperCase() : '')).replace(/^./, (c) => c.toLowerCase());
}
