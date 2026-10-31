import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DraftStore, parseDraft, type Draft } from '../src/drafts';

const draft = (id: string, updatedAt: string): Draft => ({
  id, title: 'T', why: 'W', by: { kind: 'assistant', name: 'Claude Code' }, createdAt: updatedAt, updatedAt, status: 'draft',
  changes: [{ path: 'src/a.ts', before: null, after: 'x' }], revision: 1, evidence: [],
});

test('drafts: saved and listed newest first, the folder kept out of git, bad files skipped', () => {
  const root = mkdtempSync(join(tmpdir(), 've-drafts-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: root });
    const store = new DraftStore(root);
    store.save(draft('a', '2026-10-24T10:00:00.000Z'));
    store.save(draft('b', '2026-10-24T11:00:00.000Z'));
    writeFileSync(join(store.dir, 'broken.json'), '{');
    assert.deepEqual(store.list().map((d) => d.id), ['b', 'a']);
    assert.match(readFileSync(join(store.dir, '.gitignore'), 'utf8'), /^# Visual Editor's drafts[^\n]*\n\*\n$/);
    assert.equal(execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: root, encoding: 'utf8' }), '', 'git sees nothing');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('drafts: a file is checked like a proposal', () => {
  assert.equal(parseDraft('{"title":"T","changes":[{"path":"../x","after":"y"}]}', 'f'), 'A change has a path outside the project: ../x');
  assert.equal(parseDraft('[]', 'f'), 'It is not a draft.');
  const d = parseDraft('{"title":"T","changes":[{"path":"src/a.ts","after":"y"}],"status":"submitted","proposal":"p1"}', 'f');
  assert.ok(typeof d !== 'string');
  assert.deepEqual([d.id, d.status, d.proposal, d.changes[0].before], ['f', 'submitted', 'p1', null]);
});

test('drafts: each version is kept (a design session goes back to one); discarding removes it all; a session is kept', () => {
  const root = mkdtempSync(join(tmpdir(), 've-drafts-'));
  const store = new DraftStore(root);
  const at = '2026-10-25T10:00:00.000Z';
  const d: Draft = { id: 'd1', title: 'Design session: Card', why: '', by: { kind: 'assistant', name: 'Design session' }, createdAt: at, updatedAt: at, status: 'draft', changes: [], revision: 1, evidence: [], session: { card: 'react:component:src/Card.tsx#Card', openedAt: at } };
  store.save(d);
  assert.deepEqual(store.versions('d1'), [], 'nothing changed yet: no version kept');
  store.save({ ...d, changes: [{ path: 'src/Card.tsx', before: 'a', after: 'b' }], revision: 2 });
  store.save({ ...d, changes: [{ path: 'src/Card.tsx', before: 'a', after: 'c' }], revision: 3 });
  // Saved again with the same version (proof added): the kept version stays as it was first saved.
  store.save({ ...d, changes: [{ path: 'src/Card.tsx', before: 'a', after: 'changed?' }], revision: 3 });
  assert.deepEqual(store.versions('d1').map((v) => [v.revision, v.changes[0].after]), [[3, 'c'], [2, 'b']]);
  assert.deepEqual(store.list()[0].session, { card: 'react:component:src/Card.tsx#Card', openedAt: at });
  store.remove('d1');
  assert.deepEqual([store.list(), existsSync(join(store.dir, 'd1'))], [[], false]);
  store.remove('../escape');
  rmSync(root, { recursive: true, force: true });
});

test('drafts: a discarded session is kept (its history); finished, only its last version\'s pictures stay', () => {
  const root = mkdtempSync(join(tmpdir(), 've-drafts-'));
  try {
    const store = new DraftStore(root);
    const d = { ...draft('s1', '2026-10-31T10:00:00.000Z'), revision: 3, evidence: [{ kind: 'picture' as const, title: 'Tester', text: 'tester-17-1.png', by: 'Visual Editor', at: '', revision: 3 }] };
    store.save(d);
    const dir = join(root, '.visual-editor', 'drafts', 's1');
    for (const n of ['Card-v1.png', 'Card-v2.png', 'Card-v3.png', 'app-home-v2-after.png', 'app-home-v3-after.png', 'tester-11-1.png', 'tester-17-1.png']) writeFileSync(join(dir, n), 'png');
    // Still being worked on: every picture stays.
    store.save(d);
    assert.equal(['Card-v1.png', 'tester-11-1.png'].every((n) => existsSync(join(dir, n))), true);
    store.save({ ...d, status: 'discarded' });
    assert.equal(store.list()[0].status, 'discarded', 'kept, as discarded');
    assert.deepEqual(['Card-v1.png', 'Card-v2.png', 'Card-v3.png', 'app-home-v2-after.png', 'app-home-v3-after.png', 'tester-11-1.png', 'tester-17-1.png'].filter((n) => existsSync(join(dir, n))), ['Card-v3.png', 'app-home-v3-after.png', 'tester-17-1.png'], 'its last version\'s and what its proof shows');
    assert.equal(existsSync(join(dir, 'versions', 'v3.json')), true, 'its versions stay');
    assert.equal(parseDraft(readFileSync(join(root, '.visual-editor', 'drafts', 's1.json'), 'utf8'), 's1').valueOf() !== undefined, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
