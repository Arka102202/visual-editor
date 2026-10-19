import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exportsName, importsOf, locator, rehome, withInnerExport } from '../src/preview/copies';

const files: Record<string, string> = {
  'src/pages/Cart.tsx': `import { useCart } from '../store/cart'\nimport { Price } from '@/components/Price'\nimport './cart.css'\nexport function Cart() { return <Price /> }`,
  'src/store/cart.ts': 'export const useCart = () => []',
  'src/components/Price.tsx': 'export function Price() { return null }',
  // New in a proposal (not on disk): found through the proposed text.
  'src/components/Badge.tsx': 'export function Badge() { return null }',
};
const read = async (p: string) => files[p];
const locate = locator(read, [{ prefix: '@/', target: 'src' }]);

test('copies: imports are found (relative and through aliases, with or without extensions)', async () => {
  assert.deepEqual((await importsOf('src/pages/Cart.tsx', files['src/pages/Cart.tsx'], locate)).sort(), ['src/components/Price.tsx', 'src/store/cart.ts']);
  assert.equal(await locate('react', 'src/pages/Cart.tsx'), undefined);
});

test('copies: a copy points back at the app; alias imports stay unless they point at another copy', async () => {
  const to = '.visual-editor/preview/proposed/abc/src/pages/Cart.tsx';
  const plain = await rehome('src/pages/Cart.tsx', files['src/pages/Cart.tsx'], to, locate);
  assert.match(plain, /from '..\/..\/..\/..\/..\/..\/src\/store\/cart'/);
  assert.match(plain, /from '@\/components\/Price'/);
  assert.match(plain, /import '..\/..\/..\/..\/..\/..\/src\/pages\/cart\.css'/);
  // Price changed too: the copy imports Price's copy.
  const copyOf = (p: string) => (p === 'src/components/Price.tsx' ? '.visual-editor/preview/proposed/abc/src/components/Price.tsx' : undefined);
  const both = await rehome('src/pages/Cart.tsx', files['src/pages/Cart.tsx'], to, locate, copyOf);
  assert.match(both, /from '..\/components\/Price'/);
});

test('copies: exported or not, and a copy that exports an inner component', () => {
  const text = `const Dot = () => <i />\nfunction Row() { return <Dot /> }\nexport function List() { return <Row /> }\nconst Card = () => null\nexport default Card\nexport { Row as TableRow }`;
  assert.equal(exportsName('a.tsx', text, 'List'), true);
  assert.equal(exportsName('a.tsx', text, 'Card'), true);
  assert.equal(exportsName('a.tsx', text, 'Row'), true);
  assert.equal(exportsName('a.tsx', text, 'Dot'), false);
  assert.match(withInnerExport(text, 'Dot'), /export \{ Dot as __VeInner \}\n$/);
});
