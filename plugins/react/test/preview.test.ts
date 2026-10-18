import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { devPlan } from '../src/preview/devServer';
import { appSetup, CALLBACK, exampleProps, fieldsOfType, PLACEHOLDER_IMAGE, PREVIEW_DIR, previewHtml, previewTsx } from '../src/preview/harness';
import { writeHarness } from '../src/preview/previewer';
import type { FeComponent } from '../src/read/model';

const component = (props: FeComponent['props']) => ({ id: 'src/Card.tsx#Card', name: 'Card', path: 'src/Card.tsx', props }) as unknown as FeComponent;

test('preview: example props from names and types; callbacks report their calls', () => {
  const types = (n: string) => (n === 'Order' ? fieldsOfType('interface Order { id: string; total: number; items?: string[] }', 'Order') : undefined);
  const props = exampleProps(
    component([
      { name: 'title', type: 'string', optional: false, isCallback: false, source: 'type' },
      { name: 'avatar', type: 'string', optional: true, isCallback: false, source: 'type' },
      { name: 'count', type: 'number', optional: false, isCallback: false, source: 'type' },
      { name: 'isOpen', type: 'boolean', optional: false, isCallback: false, source: 'type' },
      { name: 'order', type: 'Order', optional: false, isCallback: false, source: 'type' },
      { name: 'tags', type: 'string[]', optional: false, isCallback: false, source: 'type' },
      { name: 'onOpen', type: '(id: string) => void', optional: false, isCallback: true, source: 'type' },
    ]),
    types,
  );
  assert.equal(props.title, 'Order dashboard');
  assert.equal(props.avatar, PLACEHOLDER_IMAGE);
  assert.equal(props.count, 12);
  assert.equal(props.isOpen, true);
  assert.deepEqual(props.order, { id: 'id-1042', total: 1299, items: ['Example item', 'Example item'] });
  assert.equal((props.tags as unknown[]).length, 2);
  assert.deepEqual(props.onOpen, { [CALLBACK]: 'onOpen' });
});

test('preview: the page uses the app head, its styles and its providers', () => {
  const root = mkdtempSync(join(tmpdir(), 've-preview-'));
  try {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { dev: 'vite' }, dependencies: { react: '19', '@tanstack/react-query': '5', 'react-router-dom': '7' }, devDependencies: { vite: '6' } }));
    writeFileSync(join(root, 'index.html'), '<html class="x"><head><title>App</title><link rel="icon" href="/i.svg"></head><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>');
    writeFileSync(join(root, 'main.tsx'), '');
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src/main.tsx'), "import './index.css'\nimport 'some-lib/styles.css'\n");
    writeFileSync(join(root, 'src/index.css'), '@import "tailwindcss";');
    const setup = appSetup(root);
    assert.deepEqual(setup.css, ['../../src/index.css', 'some-lib/styles.css']);
    assert.equal(setup.providers.reactQuery, true);
    assert.equal(setup.providers.router, 'react-router-dom');
    const html = previewHtml(setup.index);
    assert.match(html, /<html class="x">/);
    assert.match(html, /<title>Preview<\/title>/);
    assert.match(html, /src="\.\/preview\.tsx"/);
    assert.doesNotMatch(html, /main\.tsx/);
    const tsx = previewTsx(setup);
    assert.match(tsx, /import '\.\.\/\.\.\/src\/index\.css'/);
    assert.match(tsx, /QueryClientProvider/);
    assert.match(tsx, /MemoryRouter/);
    assert.ok(!('unsupported' in devPlan(root)), 'a Vite app can be previewed');
    writeHarness(root);
    for (const f of ['index.html', 'preview.tsx', 'situations.js', '.gitignore']) assert.ok(existsSync(join(root, PREVIEW_DIR, f)), f);
    assert.match(readFileSync(join(root, PREVIEW_DIR, '.gitignore'), 'utf8'), /^\*$/m);
    assert.match(readFileSync(join(root, PREVIEW_DIR, 'situations.js'), 'utf8'), /export function installSituations/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('preview: projects it cannot draw yet are told why, in plain words', () => {
  const root = mkdtempSync(join(tmpdir(), 've-preview-'));
  try {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { dev: 'next dev' }, dependencies: { next: '15', react: '19' } }));
    assert.match((devPlan(root) as { unsupported: string }).unsupported, /Next\.js plugin/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
