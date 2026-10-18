import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { changeEntry, forCard, MemoryStore, parseEntry, rulesText } from '../src/memory';
import type { Proposal } from '../src/proposals';

const proposal: Proposal = {
  id: 'p1',
  title: 'Add onOpen to PostCard',
  why: 'Cards should open the post',
  by: { kind: 'agent', name: 'Variant designer' },
  createdAt: '2026-10-18T10:00:00.000Z',
  status: 'applied',
  changes: [{ path: 'src/PostCard.tsx', before: 'a', after: 'b' }],
  items: ['react:page:/'],
  history: [],
};

test('memory: a reviewed change remembers what, why, who, the note, and what it touched', () => {
  const e = changeEntry(proposal, 'sent-back', ['react:component:src/PostCard.tsx#PostCard'], 'Use the theme colour');
  assert.equal(e.kind, 'change');
  assert.equal(e.text, 'Add onOpen to PostCard');
  assert.equal(e.detail, 'Cards should open the post');
  assert.equal(e.note, 'Use the theme colour');
  assert.equal(e.outcome, 'sent-back');
  assert.equal(e.proposal, 'p1');
  assert.deepEqual(e.paths, ['src/PostCard.tsx']);
  assert.deepEqual(e.items, ['react:page:/', 'react:component:src/PostCard.tsx#PostCard']);
});

test('memory: saved one file per entry, read back newest first; broken files are skipped', () => {
  const root = mkdtempSync(join(tmpdir(), 've-memory-'));
  try {
    const store = new MemoryStore(root);
    assert.deepEqual(store.list(), []);
    const rule = store.add('rule', '  Use theme colours, never fixed ones ');
    store.save({ ...changeEntry(proposal, 'applied', []), at: '2026-10-17T00:00:00.000Z' });
    writeFileSync(join(store.dir, 'broken.json'), '{"kind":"rule"}');
    const all = store.list();
    assert.deepEqual(all.map((e) => e.kind), ['rule', 'change']);
    assert.equal(all[0].text, 'Use theme colours, never fixed ones');
    store.save({ ...all[0], text: 'Use theme colours' });
    assert.equal(store.list()[0].text, 'Use theme colours');
    store.remove(rule.id);
    assert.deepEqual(store.list().map((e) => e.kind), ['change']);
    store.remove('../../etc');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('memory: a card gets the notes on it and the changes to it or its file', () => {
  const card = { id: 'c', map: 'm', kind: 'component', label: 'PostCard', source: { path: 'src/PostCard.tsx' } };
  const entries = [
    changeEntry(proposal, 'applied', []),
    { ...changeEntry({ ...proposal, changes: [{ path: 'src/Other.tsx', before: 'a', after: 'b' }], items: [] }, 'applied', []) },
    { id: 'n', at: '2026-10-18T00:00:00.000Z', kind: 'note' as const, text: 'Shown on every page', by: { kind: 'developer' as const, name: 'You' }, items: ['c'] },
  ];
  assert.deepEqual(forCard(entries, card).map((e) => e.text), ['Add onOpen to PostCard', 'Shown on every page']);
});

test('memory: rules and decisions as plain text for assistants', () => {
  const by = { kind: 'developer' as const, name: 'You' };
  const text = rulesText([
    { id: '1', at: '', kind: 'rule', text: 'No new packages without asking', by },
    { id: '2', at: '', kind: 'decision', text: 'Server state lives in React Query', detail: 'one cache', by },
    { id: '3', at: '', kind: 'note', text: 'ignored here', by },
  ]);
  assert.equal(text, 'Rules for this project:\n- No new packages without asking\n\nDecisions made:\n- Server state lives in React Query (one cache)');
  assert.equal(parseEntry('{"kind":"rule","text":"x","by":{"kind":"hacker"}}', 'id')?.by.kind, 'developer');
  assert.equal(parseEntry('{"kind":"secret","text":"x"}', 'id'), undefined);
});
