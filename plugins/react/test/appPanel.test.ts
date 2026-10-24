import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkPlugin } from '../../../packages/shell/src/registry';
import type { Item } from '@visual-editor/contract';
import { appPanel, designFacts, isStoreFile, storeFiles } from '../src/previewPanel';
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
  assert.deepEqual(facts, { components: ['Editor', 'Button'], stores: [], designs: {}, previewable: [] });
});

test('react app panel: which components are designs, of which card (so a picked element can say so)', () => {
  const at = 'src/components/shared/Button';
  const item: Item = {
    id: `react:component:${at}/index.tsx#Button`, map: 'components', kind: 'component', label: 'Button', source: { path: `${at}/index.tsx` },
    preview: {
      variants: [
        { id: 'rounded', name: 'Rounded', path: `${at}/Button.variant.tsx`, inUse: true, inUseFor: ['primary', 'secondary'] },
        { id: 'sharp', name: 'Sharp', path: `${at}/Button.sharp.variant.tsx`, inUse: true, inUseFor: ['danger'] },
      ],
      states: ['primary'],
    },
  };
  const texts: Record<string, string> = {
    [`${at}/Button.variant.tsx`]: "export const variant = { id: 'rounded' }\nexport default function ButtonRounded() { return null }\n",
    [`${at}/Button.sharp.variant.tsx`]: "const ButtonSharp = () => null\nexport default ButtonSharp\n",
  };
  const f = designFacts({ root: '/x', name: 'shop', files: Object.keys(texts) }, [item], (p) => texts[p]);
  assert.deepEqual(f.previewable, ['Button']);
  assert.deepEqual(f.designs.ButtonRounded, { card: 'Button', design: 'Rounded', id: 'rounded', inUse: true, inUseFor: ['primary', 'secondary'] });
  assert.equal(f.designs.ButtonSharp?.design, 'Sharp');
});
