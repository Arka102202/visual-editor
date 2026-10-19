import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONTRACT_VERSION, type Plugin, type Previewer } from '@visual-editor/contract';
import { helloPlugin } from '../../../plugins/hello/src/plugin';
import { choiceProposal, isLocalUrl, overlay, previewable, previewableFor, previewerFor, proposalSides, render, situations, versionsOf } from '../src/previews';
import { safePath } from '../src/proposals';
import { PreviewServer } from '../src/previewServer';
import type { ProjectState } from '../src/projectIndex';
import type { Proposal } from '../src/proposals';
import { checkPlugin } from '../src/registry';

const card = { id: 'hello:card', map: 'hello', kind: 'example', label: 'Hello, shop', source: { path: 'README.md' } };
const state: ProjectState = {
  project: { root: '/p', name: 'shop', files: ['README.md'] },
  detected: [{ plugin: helloPlugin, reason: 'any' }],
  items: [card, { id: 'other', map: 'hello', kind: 'x', label: 'Other' }],
  links: [],
  cards: {},
  problems: [],
};
const found = (previewer: Partial<Previewer>) => ({ plugin: { name: 'Test' } as Plugin, previewer: { id: 't', wants: () => true, ...previewer } as Previewer });
const request = { item: card, project: state.project, situation: 'normal', theme: 'light' as const, width: 375, read: async () => undefined };

test('previews: the right plugin previews a card; others are not previewable', () => {
  assert.equal(previewerFor(state, card)?.plugin.id, 'hello');
  assert.deepEqual([...previewable(state)], ['hello:card']);
  assert.deepEqual(situations(previewerFor(state, card)!, card), ['normal', 'empty']);
  assert.deepEqual(situations(found({ situations: () => { throw new Error('x'); } }), card), ['normal']);
  // A plugin whose preview is missing render() is refused, with a reason.
  const broken = { ...helloPlugin, id: 'broken', contract: CONTRACT_VERSION, previews: [{ id: 'p', wants: () => true }] } as unknown as Plugin;
  assert.match(checkPlugin(broken, () => false)!, /previews is missing/);
});

test('previews: failures, wrong answers, internet addresses and slow plugins come back as plain sentences', async () => {
  assert.deepEqual(await render(found({ render: () => ({ html: '<p>hi</p>' }) }), request), { output: { html: '<p>hi</p>' } });
  assert.deepEqual(await render(found({ render: () => ({ url: 'http://localhost:5173/x' }) }), request), { output: { url: 'http://localhost:5173/x' } });
  assert.match((await render(found({ render: () => ({ url: 'https://evil.example' }) }), request)).error!, /nothing that can be shown/);
  assert.equal((await render(found({ render: () => { throw new Error('no React here'); } }), request)).error, 'no React here');
  assert.match((await render(found({ render: () => new Promise(() => {}) }), request, 50)).error!, /took longer/);
  assert.ok(isLocalUrl('http://127.0.0.1:3000') && !isLocalUrl('file:///etc/passwd') && !isLocalUrl('nope'));
});

test('previews: Before and After read the proposed files, nothing else changes', async () => {
  const p = { changes: [{ path: 'README.md', before: 'a', after: 'a\nb' }, { path: 'NEW.md', before: null, after: 'x' }], items: [] } as unknown as Proposal;
  const sides = proposalSides(p);
  const disk = async (path: string) => (path === 'package.json' ? '{}' : path === 'README.md' ? 'on disk' : undefined);
  const before = overlay(disk, sides.before);
  const after = overlay(disk, sides.after);
  assert.equal(await before('README.md'), 'a');
  assert.equal(await after('README.md'), 'a\nb');
  assert.equal(await before('NEW.md'), undefined);
  assert.equal(await after('NEW.md'), 'x');
  assert.equal(await after('package.json'), '{}');
  assert.deepEqual(previewableFor(state, p).map((i) => i.id), ['hello:card']);
});

test('preview server: pages at unguessable local addresses, nothing else', async () => {
  const server = new PreviewServer();
  await server.start();
  try {
    const url = server.host('<p>hello</p>');
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/p\/[a-f0-9]{32}$/);
    const res = await fetch(url);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), '<p>hello</p>');
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal((await fetch(url.replace(/[a-f0-9]{32}$/, '0'.repeat(32)))).status, 404);
    assert.equal((await fetch(new URL('/etc/passwd', url))).status, 404);
  } finally {
    await server.stop();
  }
});

test('previews: versions come from the previewer (none when it has none or fails); a choice becomes a proposal', async () => {
  assert.deepEqual(await versionsOf(found({}), card, state.project), []);
  assert.deepEqual(await versionsOf(found({ versions: () => { throw new Error('x'); } }), card, state.project), []);
  const list = await versionsOf(found({ versions: async () => [{ id: 'a', label: 'Compact' }, { id: 7 } as never] }), card, state.project);
  assert.deepEqual(list, [{ id: 'a', label: 'Compact' }]);
  const read = async (p: string) => (p === 'README.md' ? '# old' : undefined);
  const p = await choiceProposal({ title: 'Use Compact', why: 'shorter', changes: [{ path: 'README.md', after: '# new' }, { path: 'NEW.md', after: 'x' }] }, 'Test', card, read, safePath);
  assert.equal(p.status, 'proposed');
  assert.deepEqual(p.by, { kind: 'plugin', name: 'Test' });
  assert.deepEqual(p.changes, [{ path: 'README.md', before: '# old', after: '# new' }, { path: 'NEW.md', before: null, after: 'x' }]);
  assert.deepEqual(p.items, ['hello:card']);
  await assert.rejects(choiceProposal({ title: 'x', changes: [{ path: '../outside.txt', after: 'x' }] }, 'Test', card, read, safePath), /isn't a place in the project/);
  await assert.rejects(choiceProposal({ title: 'x', changes: [] }, 'Test', card, read, safePath), /gave no changes/);
});
