import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONTRACT_VERSION, type Plugin } from '@visual-editor/contract';
import { ProjectIndex } from '../src/projectIndex';
import { findWorkspace } from '../src/projects';
import { PluginRegistry } from '../src/registry';

/** A plugin for projects with "fake" in package.json; one card per .txt file, and it counts its reads. */
function fakePlugin(reads: string[][]): Plugin {
  return {
    id: 'fake',
    name: 'Fake',
    version: '0.0.1',
    contract: CONTRACT_VERSION,
    detect: (p) => (p.packageJson?.dependencies?.fake ? { reason: 'fake is in package.json' } : undefined),
    readers: [
      {
        id: 'txt',
        wants: (path) => path.endsWith('.txt'),
        read: (files) => {
          reads.push(files.map((f) => f.path));
          return { items: files.map((f) => ({ id: `fake:${f.path}`, map: 'fake', kind: 'note', label: f.text })) };
        },
      },
    ],
  };
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), 've-index-'));
  writeFileSync(join(root, 'package.json'), '{"name":"p","dependencies":{"fake":"1"}}');
  writeFileSync(join(root, 'a.txt'), 'A');
  writeFileSync(join(root, 'b.md'), 'B');
  const registry = new PluginRegistry();
  const index = new ProjectIndex(registry);
  return { root, registry, index, done: () => rmSync(root, { recursive: true, force: true }) };
}

test('detects plugins and passes readers only the files they want', async () => {
  const { root, registry, index, done } = setup();
  try {
    const reads: string[][] = [];
    registry.register(fakePlugin(reads));
    await index.setProjects(findWorkspace(root).projects);
    const [state] = index.snapshot();
    assert.equal(state.detected[0].reason, 'fake is in package.json');
    assert.deepEqual(state.items.map((i) => i.label), ['A']);
    assert.deepEqual(reads.at(-1), ['a.txt']);
  } finally {
    done();
  }
});

test('a change re-reads only when a wanted file changed; added and removed files are seen', async () => {
  const { root, registry, index, done } = setup();
  try {
    const reads: string[][] = [];
    registry.register(fakePlugin(reads));
    await index.setProjects(findWorkspace(root).projects);
    const before = reads.length;

    await index.filesChanged([join(root, 'b.md')]);
    assert.equal(reads.length, before, 'b.md is not wanted, so nothing re-read');

    writeFileSync(join(root, 'c.txt'), 'C');
    await index.filesChanged([join(root, 'c.txt')]);
    assert.deepEqual(index.snapshot()[0].items.map((i) => i.label), ['A', 'C']);

    writeFileSync(join(root, 'a.txt'), 'A2');
    utimesSync(join(root, 'a.txt'), new Date(), new Date(Date.now() + 5000));
    unlinkSync(join(root, 'c.txt'));
    await index.filesChanged([join(root, 'a.txt'), join(root, 'c.txt')]);
    assert.deepEqual(index.snapshot()[0].items.map((i) => i.label), ['A2']);
  } finally {
    done();
  }
});

test('adding and removing a plugin adds and removes its cards', async () => {
  const { root, registry, index, done } = setup();
  try {
    await index.setProjects(findWorkspace(root).projects);
    assert.equal(index.snapshot()[0].items.length, 0);
    const registration = registry.register(fakePlugin([]));
    await index.idle();
    assert.equal(index.snapshot()[0].items.length, 1);
    registration.dispose();
    await index.idle();
    assert.equal(index.snapshot()[0].items.length, 0);
    assert.equal(index.snapshot()[0].detected.length, 0);
  } finally {
    done();
  }
});

test('a reader that fails is reported, and does not stop the others', async () => {
  const { root, registry, index, done } = setup();
  try {
    const broken: Plugin = { ...fakePlugin([]), id: 'broken', name: 'Broken', readers: [{ id: 'x', wants: () => true, read: () => { throw new Error('oops'); } }] };
    registry.register(broken);
    registry.register(fakePlugin([]));
    await index.setProjects(findWorkspace(root).projects);
    const [state] = index.snapshot();
    assert.equal(state.items.length, 1);
    assert.deepEqual(state.problems, [{ plugin: 'Broken', reader: 'x', message: 'oops' }]);
  } finally {
    done();
  }
});
