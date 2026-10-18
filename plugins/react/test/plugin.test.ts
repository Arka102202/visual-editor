import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { checkPlugin } from '../../../packages/shell/src/registry';
import { parentRoute, reactPlugin, wantsFile } from '../src/plugin';

const root = 'plugins/react/test/fixtures/web';
const files: { path: string; text: string }[] = [];
const walk = (dir: string) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else files.push({ path: relative(root, p), text: readFileSync(p, 'utf8') });
  }
};
walk(root);
const project = { root, name: 'web', files: files.map((f) => f.path), packageJson: { dependencies: { react: '^18' } } };

test('react: a valid plugin, turned on only for React projects', async () => {
  assert.equal(checkPlugin(reactPlugin, () => false), undefined);
  assert.deepEqual(await reactPlugin.detect(project), { reason: 'react is in package.json' });
  assert.equal(await reactPlugin.detect({ ...project, packageJson: { dependencies: { express: '4' } } }), undefined);
  assert.ok(wantsFile('src/App.jsx') && wantsFile('tsconfig.json') && wantsFile('vite.config.ts'));
  assert.ok(!wantsFile('src/App.test.tsx') && !wantsFile('src/types.d.ts') && !wantsFile('README.md'));
});

test('react: components with props and "renders" lines, pages inside pages, API calls with when they run', async () => {
  const reader = reactPlugin.readers![0];
  const { items, links = [] } = await reader.read(files.filter((f) => reader.wants(f.path)), project);
  const on = (map: string) => items.filter((i) => i.map === map);
  const card = (label: string) => items.find((i) => i.label === label)!;

  assert.ok(on('components').length >= 5, `components: ${on('components').map((i) => i.label)}`);
  const app = card('App');
  assert.equal(app.source?.path, 'src/App.jsx');
  assert.ok((app.source?.line ?? 0) >= 1);
  assert.ok(links.some((l) => l.from === app.id && l.kind === 'renders'), 'App renders something');
  // Every line joins two cards that exist.
  const ids = new Set(items.map((i) => i.id));
  for (const l of links) assert.ok(ids.has(l.from) && ids.has(l.to), `${l.from} → ${l.to}`);

  assert.ok(on('pages').length >= 1, 'routes are read');
  assert.ok(links.some((l) => l.kind === 'shows'), 'a page shows its component');

  const apis = on('api');
  assert.ok(apis.length >= 1, 'API calls are read');
  assert.ok(apis.every((a) => /^(GET|POST|PUT|PATCH|DELETE|HEAD|\?) /.test(a.label)), apis.map((a) => a.label).join(', '));
  assert.ok(links.some((l) => l.kind === 'calls on load' || l.kind === 'calls on click'), 'calls say when they run');
});

test('react: a route sits inside the closest route its address starts with', () => {
  const all = ['/', '/shop', '/shop/:id', '/shop/:id/reviews', '/about'];
  assert.equal(parentRoute('/shop/:id/reviews', all), '/shop/:id');
  assert.equal(parentRoute('/shop', all), '/');
  assert.equal(parentRoute('/', all), undefined);
});
