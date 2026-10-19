import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { TypeView } from '../src/read/types';
import { findStores, storeNoun, storeSeeds } from '../src/preview/stores';

const ts = createRequire(__filename)('typescript-5');
const root = resolve('plugins/react/test/fixtures/ts-shop');
const files: { path: string; text: string }[] = [];
const walk = (d: string) => {
  for (const n of readdirSync(d)) {
    const p = join(d, n);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.tsx?$/.test(n)) files.push({ path: relative(root, p), text: readFileSync(p, 'utf8') });
  }
};
walk(root);

test('stores: zustand, Redux, Jotai and Valtio stores are found; atoms worked out from others are not', () => {
  const found = findStores(files).map((s) => `${s.kind} ${s.name}`);
  assert.deepEqual(found.sort(), ['jotai selectedOrderAtom', 'redux store', 'valtio ui', 'zustand useCartStore']);
});

test('stores: example state from each store\'s type, without its actions', () => {
  const seeds = storeSeeds(findStores(files), new TypeView(ts, root));
  const by = Object.fromEntries(seeds.map((s) => [s.export, s.example])) as Record<string, any>;
  // zustand: the state of the hook's store; actions left out.
  assert.equal(by.useCartStore.items.length, 3);
  assert.equal(by.useCartStore.items[0].name, 'Cart item 1');
  assert.ok(['light', 'dark'].includes(by.useCartStore.theme));
  assert.equal('add' in by.useCartStore, false);
  // Redux: the whole state, slice by slice.
  assert.equal(by.store.auth.user.name, 'Ada Lovelace');
  assert.ok(['admin', 'staff', 'customer'].includes(by.store.auth.user.role));
  // Jotai: the atom's value; Valtio: the proxy's fields.
  assert.ok(by.selectedOrderAtom.id);
  assert.equal(by.ui.recent.length, 3);
});

test('stores: names say what a store holds', () => {
  assert.equal(storeNoun('useCartStore'), 'cart');
  assert.equal(storeNoun('userAtom'), 'user');
  assert.equal(storeNoun('store'), 'store');
});

import { findSaved, savedSeeds } from '../src/preview/saved';

test('saved data: typed reads from localStorage and sessionStorage get example values; logins are left alone', () => {
  const found = findSaved(files);
  assert.deepEqual(found.map((f) => `${f.kind} ${f.key}`).sort(), ['local prefs', 'local shop.cart', 'session recent-searches']);
  const seeds = Object.fromEntries(savedSeeds(found, new TypeView(ts, root)).map((s) => [s.key, s.value])) as Record<string, any>;
  assert.equal(seeds['shop.cart'].length, 3);
  assert.ok(seeds['shop.cart'][0].sku);
  assert.equal(seeds['recent-searches'].length, 3);
  assert.ok(['EUR', 'USD'].includes(seeds.prefs.currency));
});

test('stores: Supabase and Firebase login clients are found, and get the example person', () => {
  const files = [
    { path: 'src/supabase.ts', text: `import { createClient } from '@supabase/supabase-js'\nexport const supabase = createClient(import.meta.env.VITE_SUPABASE_URL ?? 'https://x.supabase.co', 'key')` },
    { path: 'src/firebase.ts', text: `import { initializeApp } from 'firebase/app'\nimport { getAuth } from 'firebase/auth'\nconst app = initializeApp({})\nexport const auth = getAuth(app)` },
  ];
  const found = findStores(files);
  assert.deepEqual(found.map((s) => `${s.kind} ${s.name}`), ['supabase supabase', 'firebaseAuth auth']);
  const seeds = storeSeeds(found, new TypeView(ts, root));
  assert.equal((seeds[0].example as any).user.name, 'Ada Lovelace');
});
