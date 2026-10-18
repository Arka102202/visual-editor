import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { findWorkspace, matchesGlob } from '../src/projects';

/** Makes a folder from { "relative/path": "text" }. */
function folder(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 've-projects-'));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

test('one project: its files, without dependencies or build output', () => {
  const root = folder({
    'package.json': '{"name":"shop"}',
    'src/App.tsx': 'x',
    'node_modules/react/index.js': 'x',
    'dist/app.js': 'x',
    '.next/cache.json': 'x',
  });
  try {
    const ws = findWorkspace(root);
    assert.equal(ws.shape, 'single');
    assert.equal(ws.projects.length, 1);
    assert.equal(ws.projects[0].name, 'shop');
    assert.deepEqual(ws.projects[0].files, ['package.json', 'src/App.tsx']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('several projects side by side, each with only its own files', () => {
  const root = folder({
    'web/package.json': '{"name":"web"}',
    'web/src/a.ts': 'x',
    'api/package.json': '{"name":"api"}',
    'api/server.js': 'x',
    'billing/go.mod': 'module billing',
    'notes.md': 'x',
  });
  try {
    const ws = findWorkspace(root);
    assert.equal(ws.shape, 'several');
    const byName = Object.fromEntries(ws.projects.map((p) => [p.name, p]));
    assert.deepEqual(Object.keys(byName).sort(), ['api', 'billing', 'web']);
    assert.deepEqual(byName.web.files, ['package.json', 'src/a.ts']);
    assert.deepEqual(byName.billing.files, ['go.mod']);
    assert.equal(byName.web.group, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a monorepo: packages grouped, and the root does not swallow their files', () => {
  const root = folder({
    'package.json': '{"name":"acme","workspaces":["apps/*","packages/*"]}',
    'turbo.json': '{}',
    'apps/web/package.json': '{"name":"@acme/web"}',
    'apps/web/page.tsx': 'x',
    'packages/ui/package.json': '{"name":"@acme/ui"}',
    'packages/ui/Button.tsx': 'x',
  });
  try {
    const ws = findWorkspace(root);
    assert.equal(ws.shape, 'monorepo');
    const byName = Object.fromEntries(ws.projects.map((p) => [p.name, p]));
    assert.deepEqual(byName.acme.files, ['package.json', 'turbo.json']);
    assert.deepEqual(byName['@acme/ui'].files, ['Button.tsx', 'package.json']);
    assert.equal(byName['@acme/web'].group, 'acme');
    assert.equal(byName.acme.group, 'acme');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('pnpm workspaces count as a monorepo', () => {
  const root = folder({
    'package.json': '{"name":"mono"}',
    'pnpm-workspace.yaml': "packages:\n  - 'services/*'\n",
    'services/orders/package.json': '{"name":"orders"}',
  });
  try {
    assert.equal(findWorkspace(root).shape, 'monorepo');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a folder with no project file is still read as one project', () => {
  const root = folder({ 'index.html': 'x' });
  try {
    const ws = findWorkspace(root);
    assert.equal(ws.shape, 'empty');
    assert.deepEqual(ws.projects[0].files, ['index.html']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('loose code beside the projects is read as its own project; a lone README is not', () => {
  const root = folder({
    'blog/package.json': '{"name":"blog"}',
    'blog/page.tsx': 'x',
    'web/src/App.jsx': 'x',
    'prisma/schema.prisma': 'x',
    'README.md': 'x',
  });
  const tidy = folder({ 'a/package.json': '{"name":"a"}', 'README.md': 'x' });
  try {
    const ws = findWorkspace(root);
    assert.equal(ws.shape, 'several');
    const loose = ws.projects.find((p) => p.root === root)!;
    assert.deepEqual(loose.files, ['README.md', 'prisma/schema.prisma', 'web/src/App.jsx']);
    assert.deepEqual(ws.projects.find((p) => p.name === 'blog')!.files, ['package.json', 'page.tsx']);
    const t = findWorkspace(tidy);
    assert.equal(t.shape, 'single');
    assert.deepEqual(t.projects.map((p) => p.name), ['a']);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(tidy, { recursive: true, force: true });
  }
});

test('workspace globs', () => {
  assert.ok(matchesGlob('packages/ui', 'packages/*'));
  assert.ok(!matchesGlob('packages/ui/inner', 'packages/*'));
  assert.ok(matchesGlob('apps/a/b', 'apps/**'));
  assert.ok(matchesGlob('tools/cli', './tools/cli/'));
  assert.ok(!matchesGlob('packages/ui', '!packages/ui'));
});
