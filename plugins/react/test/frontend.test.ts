import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { analyzeProject, type SourceFile } from '../src/read/analyzer';
import { loadAliases, parseJsonc, resolveImport } from '../src/read/resolve';

const root = 'plugins/react/test/fixtures/web';
const sources: SourceFile[] = [];
const walk = (dir: string) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else sources.push({ path: relative(root, p), text: readFileSync(p, 'utf8') });
  }
};
walk(root);
const code = sources.filter((s) => /\.[jt]sx?$/.test(s.path));
const aliases = loadAliases(sources.filter((s) => s.path === 'jsconfig.json'));
const model = analyzeProject(code, aliases);
const get = (name: string) => {
  const c = model.components.find((x) => x.name === name);
  assert.ok(c, `component ${name} not found`);
  return c;
};
const names = (list: { name: string }[]) => list.map((x) => x.name);

test('reads jsconfig with comments and trailing commas', () => {
  assert.deepEqual(aliases, [{ prefix: '@', target: 'src' }]);
  assert.deepEqual(parseJsonc('{ /* a */ "x": [1, 2,], // b\n }'), { x: [1, 2] });
});

test('resolves aliases, index files, extensions and packages', () => {
  const files = new Set(['src/a/index.ts', 'src/b.tsx', 'src/c.ts']);
  const as = loadAliases([
    { path: 'tsconfig.json', text: '{"compilerOptions":{"baseUrl":".","paths":{"~/*":["src/*"]}}}' },
    { path: 'vite.config.ts', text: "alias: { '@lib': path.resolve(__dirname, 'src/a') }" },
  ]);
  assert.equal(resolveImport('~/b', 'src/x.ts', as, files), 'src/b.tsx');
  assert.equal(resolveImport('@lib', 'src/x.ts', as, files), 'src/a/index.ts');
  assert.equal(resolveImport('./c.js', 'src/x.ts', as, files), 'src/c.ts');
  assert.equal(resolveImport('@tanstack/react-query/x', 'src/x.ts', as, files), 'pkg:@tanstack/react-query');
});

test('finds components written in any style and survives broken files', () => {
  assert.deepEqual(model.stats.parseErrors, ['src/broken.jsx']);
  for (const name of ['App', 'Hero', 'FeatureList', 'Home', 'Card', 'Modal', 'Header', 'Widget', 'OldButton', 'PrimaryBtn', 'SubmitButton', 'Cart', 'Orders', 'ProductPage', 'Settings']) {
    get(name);
  }
  assert.equal(get('Home').path, 'src/pages/Home.jsx'); // anonymous default export named after the file
  assert.equal(get('Card').path, 'src/components/Card.js'); // memo(function () {})
  assert.equal(get('Widget').kind, 'class'); // connect()(Widget)
  assert.equal(get('Header').parent, get('Modal').id); // component defined inside a component
});

test('works out inputs from types or from usage', () => {
  const modal = get('Modal');
  assert.deepEqual(names(modal.props), ['title', 'open', 'onClose', 'footer']); // forwardRef<_, Props> + interface extends
  assert.equal(modal.props.find((p) => p.name === 'title')?.type, 'string');
  assert.equal(modal.props.find((p) => p.name === 'onClose')?.isCallback, true);
  assert.equal(modal.acceptsRest, true);

  assert.deepEqual(names(get('Hero').props), ['title', 'subtitle']); // destructured, no types
  assert.equal(get('Hero').props[1].optional, true); // has a default
  assert.deepEqual(names(get('Card').props).sort(), ['children', 'onOpen', 'title']); // props.x usage
  assert.deepEqual(names(get('OldButton').props), ['onPress', 'text']); // this.props.x
  assert.equal(get('OldButton').props[0].isCallback, true);
});

test('connects parents and children through aliases, memo, connect and lazy', () => {
  const tree = (name: string) => get(name).renders.filter((r) => r.target).map((r) => r.tag);
  assert.deepEqual(tree('App'), ['Home', 'ProductPage', 'Dashboard', 'Orders', 'Cart', 'Settings']);
  assert.deepEqual(tree('ProductPage'), ['SubmitButton', 'Modal']);
  assert.deepEqual(tree('Settings'), ['Widget']);
  assert.deepEqual(tree('FeatureList'), ['Card']);
  assert.ok(get('App').renders.some((r) => r.tag === 'Routes' && r.pkg === 'react-router-dom'));
  assert.deepEqual(
    get('Card').usedBy.map((u) => u.from?.split('#')[1]).sort(),
    ['FeatureList', 'Orders'],
  );
  assert.equal(get('App').isRoot, true);
});

test('finds routes, including nested and constant paths', () => {
  assert.deepEqual(
    model.routes.map((r) => `${r.path} ${r.label}`),
    ['/ Home', '/products/:id ProductPage', '/dashboard Dashboard', '/account/orders Orders', '/account/cart Cart', '/account/settings Settings'],
  );
  assert.deepEqual(get('Settings').routes, ['/account/settings']); // lazy(() => import(...))
});

test('follows data through hooks, API objects and stores', () => {
  const data = (name: string) => get(name).data.map((d) => `${d.kind} ${d.label}${d.via ? ` via ${d.via}` : ''}`);
  assert.deepEqual(data('Home'), ['api GET /api/features']);
  assert.deepEqual(data('Orders'), ['api GET /api/orders via api.getOrders', 'api DELETE /api/orders/:id via api.cancelOrder']);
  assert.deepEqual(data('ProductPage'), [
    'router useParams',
    'store useCartStore',
    'api GET /api/products/:id via useProduct',
  ]);
  assert.deepEqual(data('Cart'), [
    'store useCartStore',
    'api POST /api/orders via useCheckout',
    'api POST /api/checkout/session via useCheckout',
    'api POST /api/checkout/resume via useCheckout',
  ]);
});

test('flags problems a reviewer would care about', () => {
  const kinds = (name: string) => get(name).issues.map((i) => i.kind);
  assert.deepEqual(kinds('OldButton'), ['unused']);
  assert.deepEqual(kinds('Home'), ['no-error-state']); // has a loading state, no error state
  assert.deepEqual(kinds('Orders'), ['no-error-state', 'no-loading-state']);
  assert.deepEqual(kinds('ProductPage'), []); // has both
  assert.ok(kinds('PrimaryBtn').includes('similar'));
  assert.equal(get('PrimaryBtn').issues.find((i) => i.kind === 'similar')?.related, get('SubmitButton').id);
  assert.equal(get('Cart').states.empty, true);
});

test('Next.js file routes only apply in Next.js projects', () => {
  const next = analyzeProject(
    [
      { path: 'app/(shop)/products/[id]/page.tsx', text: "import Link from 'next/link'\nexport default function P() { return <Link href='/'>x</Link> }" },
      { path: 'pages/about.jsx', text: 'export default function About() { return <div/> }' },
    ],
    [],
  );
  assert.deepEqual(next.routes.map((r) => `${r.path} ${r.label}`), ['/products/:id P', '/about About']);
  // Same folder names without Next.js: not routes.
  assert.deepEqual(analyzeProject([{ path: 'pages/about.jsx', text: 'export default function About() { return <div/> }' }], []).routes, []);
});
