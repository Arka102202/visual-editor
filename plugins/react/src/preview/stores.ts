// The app's stores (zustand, Redux, Jotai, Valtio) in previews: their state as the app starts it, with the empty
// parts (no user yet, an empty cart) filled with example data worked out from the store's TypeScript type, so a
// component that reads a store shows something real. What the app sets itself (a theme, a flag) stays as it is.
// Finding stores and working out examples is here (pure, so it can be tested); filling happens in the preview page.

import type * as t from '@babel/types';
import { parseSource } from '../read/ast';
import type { Shape } from '../read/shapes';
import type { TypeView } from '../read/types';
import { exampleOf } from './replies';

export type StoreKind = 'zustand' | 'redux' | 'jotai' | 'valtio' | 'supabase' | 'firebaseAuth';

export interface FoundStore {
  kind: StoreKind;
  /** The file (relative to the project) and the exported name. */
  path: string;
  name: string;
  /** Where the name is written (for its type). */
  start: number;
}

/** What the preview page gets for a store: where to find it and the example state to fill its empty parts with. */
export interface StoreSeed {
  kind: StoreKind;
  module: string;
  export: string;
  example: unknown;
  /** The state's shape (for the situations it offers, like "role: admin"); not sent to the page. */
  shape?: Shape;
}

/** Which call makes which kind of store, by the package it's imported from. */
const MAKERS: Record<string, { kind: StoreKind; names: string[] }> = {
  zustand: { kind: 'zustand', names: ['create', 'createStore'] },
  'zustand/vanilla': { kind: 'zustand', names: ['createStore'] },
  'zustand/traditional': { kind: 'zustand', names: ['createWithEqualityFn'] },
  '@reduxjs/toolkit': { kind: 'redux', names: ['configureStore'] },
  redux: { kind: 'redux', names: ['createStore', 'legacy_createStore'] },
  jotai: { kind: 'jotai', names: ['atom'] },
  'jotai/utils': { kind: 'jotai', names: ['atomWithStorage', 'atomWithReset'] },
  valtio: { kind: 'valtio', names: ['proxy'] },
  'valtio/vanilla': { kind: 'valtio', names: ['proxy'] },
  // Login clients: the preview answers "who is logged in" for them.
  '@supabase/supabase-js': { kind: 'supabase', names: ['createClient'] },
  'firebase/auth': { kind: 'firebaseAuth', names: ['getAuth', 'initializeAuth'] },
};

/** The person every preview is logged in as (changed by "role: …" and similar situations like any example data). */
export const PREVIEW_PERSON = { id: 'preview-1042', name: 'Ada Lovelace', email: 'ada@example.com' };

/** Exported stores in the project's files. */
export function findStores(files: { path: string; text: string }[]): FoundStore[] {
  const out: FoundStore[] = [];
  for (const f of files) {
    if (!/zustand|redux|jotai|valtio|supabase|firebase\/auth/.test(f.text)) continue;
    const ast = parseSource(f);
    if (!ast) continue;
    // Local names of the store makers this file imports.
    const makers = new Map<string, StoreKind>();
    for (const s of ast.program.body) {
      if (s.type !== 'ImportDeclaration') continue;
      const m = MAKERS[s.source.value];
      if (!m) continue;
      for (const spec of s.specifiers) {
        const imported = spec.type === 'ImportSpecifier' ? (spec.imported.type === 'Identifier' ? spec.imported.name : spec.imported.value) : spec.type === 'ImportDefaultSpecifier' ? 'default' : '';
        if (m.names.includes(imported) || (imported === 'default' && m.kind === 'zustand')) makers.set(spec.local.name, m.kind);
      }
    }
    if (!makers.size) continue;
    for (const s of ast.program.body) {
      if (s.type !== 'ExportNamedDeclaration' || s.declaration?.type !== 'VariableDeclaration') continue;
      for (const d of s.declaration.declarations) {
        if (d.id.type !== 'Identifier' || !d.init) continue;
        const kind = makerOf(d.init, makers);
        if (kind) out.push({ kind, path: f.path, name: d.id.name, start: d.id.start ?? 0 });
      }
    }
  }
  return out;
}

/** The kind of store a value is made with: `create(…)`, `create<T>()(…)`, `configureStore(…)`, `atom(value)`… */
function makerOf(init: t.Node, makers: Map<string, StoreKind>): StoreKind | undefined {
  let call = init.type === 'TSAsExpression' || init.type === 'TSSatisfiesExpression' ? init.expression : init;
  if (call.type !== 'CallExpression') return undefined;
  // create<T>()(…): the maker is the inner call.
  if (call.callee.type === 'CallExpression') call = call.callee;
  if (call.type !== 'CallExpression' || call.callee.type !== 'Identifier') return undefined;
  const kind = makers.get(call.callee.name);
  if (!kind) return undefined;
  // A Jotai atom made from a function is worked out from others: nothing to fill.
  if (kind === 'jotai') {
    const value = call.arguments[call.callee.name === 'atom' ? 0 : 1];
    if (!value || value.type === 'ArrowFunctionExpression' || value.type === 'FunctionExpression') return undefined;
  }
  return kind;
}

/** Example state for each store, from its type (stores without a usable type are left as the app makes them). */
export function storeSeeds(stores: FoundStore[], view: TypeView | undefined): StoreSeed[] {
  if (!view) return [];
  const seeds: StoreSeed[] = [];
  for (const s of stores) {
    if (s.kind === 'supabase' || s.kind === 'firebaseAuth') {
      seeds.push({ kind: s.kind, module: s.path, export: s.name, example: { user: PREVIEW_PERSON } });
      continue;
    }
    const type = view.typeAt(s.path, s.start);
    if (!type) continue;
    const state = s.kind === 'zustand' || s.kind === 'redux' ? view.returnOfMember(type, 'getState') : s.kind === 'jotai' ? view.memberType(type, 'init') : type;
    const shape = state ? view.shapeOf(state) : undefined;
    const data = shape && dataOnly(shape);
    if (!data) continue;
    seeds.push({ kind: s.kind, module: s.path, export: s.name, example: exampleOf(data, storeNoun(s.name)), shape: data });
  }
  return seeds;
}

/** A shape without its functions (a store's actions aren't data). */
function dataOnly(shape: Shape): Shape | undefined {
  if (shape.kind === 'function') return undefined;
  if (shape.fields) {
    const fields = Object.fromEntries(Object.entries(shape.fields).flatMap(([k, v]) => {
      const d = dataOnly(v);
      return d ? [[k, d]] : [];
    }));
    return Object.keys(fields).length ? { ...shape, fields } : undefined;
  }
  if (shape.item) {
    const item = dataOnly(shape.item);
    return item ? { ...shape, item } : shape;
  }
  return shape;
}

/** `useCartStore` → "cart", `userAtom` → "user": what the store holds, for naming example values. */
export function storeNoun(name: string): string {
  const bare = name.replace(/^use(?=[A-Z])/, '').replace(/(Store|Atom|State|Slice)$/, '');
  return bare ? bare[0].toLowerCase() + bare.slice(1) : name;
}
