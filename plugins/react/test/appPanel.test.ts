import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkPlugin } from '../../../packages/shell/src/registry';
import { appPanel, isStoreFile, storeFiles } from '../src/previewPanel';
import { reactPlugin } from '../src/plugin';

test('react app panel: finds the files that make stores (Zustand, Redux)', () => {
  assert.ok(isStoreFile(`import { create } from 'zustand'\nexport const useCart = create((set) => ({ items: [] }))`));
  assert.ok(isStoreFile(`import { create } from 'zustand';\nexport const useX = create<State>()(persist(() => ({}), { name: 'x' }))`));
  assert.ok(isStoreFile(`import { configureStore } from '@reduxjs/toolkit'\nexport const store = configureStore({ reducer: {} })`));
  assert.ok(!isStoreFile(`import { useCart } from './store'\nexport function Cart() { return useCart((s) => s.items) }`), 'using a store is not making one');
  assert.ok(!isStoreFile(`const x = create()`), 'create from elsewhere');
  const files: Record<string, string> = {
    'src/store/cart.ts': `import { create } from 'zustand'\nexport const useCart = create(() => ({}))`,
    'src/store/cart.test.ts': `import { create } from 'zustand'\ncreate(() => ({}))`,
    'src/App.tsx': `export default function App() { return null }`,
    'README.md': 'zustand create(',
  };
  assert.deepEqual(storeFiles({ root: '/x', name: 'x', files: Object.keys(files) }, (p) => files[p]), ['src/store/cart.ts']);
});

test('react app panel: a Preview panel the shell accepts, with the facts it needs', async () => {
  const panel = appPanel({ page: '/* page */', panel: '/* panel */' });
  assert.equal(checkPlugin({ ...reactPlugin, previewPanels: [panel] }, () => false), undefined);
  assert.match(checkPlugin({ ...reactPlugin, previewPanels: [panel, panel] }, () => false) ?? '', /its own id/);
  const facts = (await panel.facts!({ root: '/x', name: 'x', files: [] }, [
    { id: 'react:component:a', map: 'components', kind: 'page', label: 'Editor' },
    { id: 'react:component:b', map: 'components', kind: 'shared', label: 'Button' },
    { id: 'react:route:/', map: 'pages', kind: 'route', label: '/' },
  ])) as { components: string[]; stores: string[] };
  assert.deepEqual(facts, { components: ['Editor', 'Button'], stores: [] });
});
