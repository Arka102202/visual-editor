import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Item } from '@visual-editor/contract';
import { cardMarks, OutsideChanges } from '../src/changes';
import { counts, diffLines, hunks } from '../src/diff';
import { apply, conflicts, needsYou, needsYouWords, parseProposal, ProposalStore, safePath, undo, undoConflicts, type Files, type Proposal } from '../src/proposals';

/** Files kept in memory; `failOn` makes writing that path fail. */
function memoryFiles(start: Record<string, string>, failOn?: string): Files & { all: Record<string, string> } {
  const all = { ...start };
  return {
    all,
    read: async (p) => all[p],
    write: async (p, text) => {
      if (p === failOn) throw new Error(`disk full writing ${p}`);
      all[p] = text;
    },
    remove: async (p) => {
      delete all[p];
    },
  };
}

const proposal = (changes: Proposal['changes'], extra: Partial<Proposal> = {}): Proposal => ({
  id: 'p1',
  title: 'T',
  by: { kind: 'assistant', name: 'Assistant' },
  createdAt: '2026-10-18T10:00:00.000Z',
  status: 'proposed',
  changes,
  history: [],
  ...extra,
});

test('diff: marks added and removed lines, and keeps only nearby context', () => {
  const before = 'a\nb\nc\nd\ne\nf\ng\nh\ni\nj\n';
  const after = 'a\nB\nc\nd\ne\nf\ng\nh\ni\nj\nk\n';
  const kinds = diffLines(before, after).map((l) => (l.kind === 'same' ? ' ' : l.kind === 'added' ? '+' : '-') + l.text).join(',');
  assert.equal(kinds, ' a,-b,+B, c, d, e, f, g, h, i, j,+k');
  const h = hunks(before, after, 2);
  assert.equal(h.length, 2, 'two separate changes, far apart');
  assert.deepEqual(counts(before, after), { added: 2, removed: 1 });
  assert.deepEqual(counts(null, 'x\ny'), { added: 2, removed: 0 });
});

test('proposals: anything unsafe or broken is refused with a reason', () => {
  assert.ok(safePath('src/App.tsx'));
  for (const bad of ['../x', '/etc/passwd', 'C:\\x', 'a/../../x', '.git/config', 'node_modules/x/index.js', '.visual-editor/proposals/x.json']) assert.ok(!safePath(bad), bad);
  assert.equal(parseProposal('nope', 'x'), 'It is not valid JSON.');
  assert.equal(parseProposal('{"title":"t","changes":[]}', 'x'), 'It changes no files.');
  assert.match(parseProposal('{"title":"t","changes":[{"path":"../x","after":"y"}]}', 'x') as string, /outside the project/);
  const ok = parseProposal('{"title":" Add a button ","changes":[{"path":"a.ts","before":"1","after":"2"}]}', 'fallback') as Proposal;
  assert.equal(ok.id, 'fallback');
  assert.equal(ok.title, 'Add a button');
  assert.equal(ok.status, 'proposed');
  assert.equal(ok.by.name, 'Assistant');
});

test('proposals: apply all or nothing, refuse when files moved on, and undo', async () => {
  const p = proposal([
    { path: 'a.ts', before: 'one', after: 'ONE' },
    { path: 'new.ts', before: null, after: 'fresh' },
    { path: 'old.ts', before: 'bye', after: null },
  ]);
  const files = memoryFiles({ 'a.ts': 'one', 'old.ts': 'bye' });
  assert.deepEqual(await conflicts(p, files), []);
  await apply(p, files);
  assert.deepEqual(files.all, { 'a.ts': 'ONE', 'new.ts': 'fresh' });
  assert.deepEqual(await undoConflicts(p, files), []);
  await undo(p, files);
  assert.deepEqual(files.all, { 'a.ts': 'one', 'old.ts': 'bye' });

  // Someone edited a.ts after the proposal was made.
  const moved = memoryFiles({ 'a.ts': 'one!', 'old.ts': 'bye', 'new.ts': 'x' });
  assert.deepEqual(await conflicts(p, moved), ['a.ts changed since this was proposed.', 'new.ts already exists.']);

  // A write fails halfway: the files already changed are put back.
  const failing = memoryFiles({ 'a.ts': 'one', 'old.ts': 'bye' }, 'new.ts');
  await assert.rejects(apply(p, failing), /disk full/);
  assert.deepEqual(failing.all, { 'a.ts': 'one', 'old.ts': 'bye' });
});

test('proposals: saved in the project, read back newest first, with history', () => {
  const root = mkdtempSync(join(tmpdir(), 've-review-'));
  try {
    const store = new ProposalStore(root);
    assert.deepEqual(store.list(), []);
    store.save(proposal([{ path: 'a.ts', before: '1', after: '2' }], { id: 'older', createdAt: '2026-10-17T00:00:00.000Z' }));
    store.save(proposal([{ path: 'a.ts', before: '1', after: '2' }], { id: 'newer' }));
    writeFileSync(join(store.dir, 'broken.json'), '{');
    assert.deepEqual(store.list().map((p) => p.id), ['newer', 'older']);
    assert.deepEqual(store.problems, [{ file: 'broken.json', message: 'It is not valid JSON.' }]);
    store.mark(store.get('newer')!, 'sent-back', 'Use the theme colour');
    const back = store.get('newer')!;
    assert.equal(back.status, 'sent-back');
    assert.equal(back.history.at(-1)?.note, 'Use the theme colour');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('marks: yellow for cards a waiting proposal changes, blue for code changed outside review', () => {
  const item = (id: string, path?: string): Item => ({ id, map: 'm', kind: 'k', label: id, ...(path ? { source: { path } } : {}) });
  const items = [item('a', 'src/a.tsx'), item('b', 'src/b.tsx'), item('c'), item('d', 'src/d.tsx')];
  const waiting = proposal([{ path: 'src/a.tsx', before: 'x', after: 'y' }], { items: ['c'] });
  const done = proposal([{ path: 'src/d.tsx', before: 'x', after: 'y' }], { status: 'applied' });
  assert.deepEqual(cardMarks(items, [waiting, done], new Set(['src/a.tsx', 'src/b.tsx'])), { a: 'proposed', b: 'changed', c: 'proposed' });

  const outside = new OutsideChanges();
  let heard = 0;
  outside.onChange(() => heard++);
  outside.expectWrite('/p/src/a.tsx');
  outside.note('/p', 'src/a.tsx', '/p/src/a.tsx');
  assert.equal(outside.get('/p').size, 0, 'our own write is not outside review');
  outside.note('/p', 'src/b.tsx', '/p/src/b.tsx');
  outside.note('/p', 'src/b.tsx', '/p/src/b.tsx');
  assert.deepEqual([...outside.get('/p')], ['src/b.tsx']);
  assert.equal(heard, 1);
  outside.clear('/p');
  assert.equal(outside.get('/p').size, 0);
});

test('a card’s other files count as the card: a hand edit to a variant folder’s switcher marks its card', () => {
  const card: Item = {
    id: 'react:component:src/Card/index.tsx#Card', map: 'components', kind: 'component', label: 'Card', source: { path: 'src/Card/index.tsx' },
    preview: { variants: [], states: [], files: ['src/Card/Card.switcher.tsx', 'src/Card/Card.variant.tsx'] },
  };
  assert.deepEqual(cardMarks([card], [], new Set(['src/Card/Card.switcher.tsx'])), { [card.id]: 'changed' });
  const waiting: Proposal = { id: 'p1', title: 'x', by: { kind: 'developer', name: 'You' }, createdAt: '', status: 'proposed', changes: [{ path: 'src/Card/Card.variant.tsx', before: 'a', after: 'b' }], history: [] };
  assert.deepEqual(cardMarks([card], [waiting], new Set()), { [card.id]: 'proposed' });
});

test('a proposal can show how it looks: only at the app’s own address', () => {
  const base = { title: 'Use Wide', changes: [{ path: 'src/a.tsx', before: 'a', after: 'b' }] };
  const read = (look: unknown) => {
    const p = parseProposal(JSON.stringify({ ...base, look }), 'x');
    return typeof p === 'string' ? p : p.look;
  };
  assert.equal(read('/__ve/preview?item=a&compare=x,y'), '/__ve/preview?item=a&compare=x,y');
  assert.equal(read('https://evil.example/'), undefined);
  assert.equal(read('//evil.example/'), undefined);
  assert.equal(read('/\\evil.example/'), undefined);
  assert.equal(read(42), undefined);
});

test('a file that comes and goes at once (a tool’s temporary file) isn’t a change; a real one deleted is', () => {
  const outside = new OutsideChanges();
  // sed -i: a temporary file next to the real one, then the real one changes.
  outside.note('/p', 'src/a.tsx.tmp1', '/p/src/a.tsx.tmp1', 'created');
  outside.note('/p', 'src/a.tsx', '/p/src/a.tsx', 'changed');
  outside.note('/p', 'src/a.tsx.tmp1', '/p/src/a.tsx.tmp1', 'deleted');
  assert.deepEqual([...outside.get('/p')], ['src/a.tsx']);
  // A file that was there and is deleted is a change.
  outside.note('/p', 'src/b.tsx', '/p/src/b.tsx', 'deleted');
  assert.deepEqual([...outside.get('/p')].sort(), ['src/a.tsx', 'src/b.tsx']);
});

test('needs you: changes to approve, test cases to run and held back are all counted and marked yellow; decided ones aren\'t', () => {
  const item = (id: string, path: string): Item => ({ id, map: 'm', kind: 'k', label: id, source: { path } });
  const at = (path: string, status: Proposal['status']) => proposal([{ path, before: 'x', after: 'y' }], { status });
  const list = [at('src/a.tsx', 'proposed'), at('src/b.tsx', 'awaiting-checks'), at('src/c.tsx', 'awaiting-checks'), at('src/d.tsx', 'held-back'), at('src/e.tsx', 'applied'), at('src/f.tsx', 'rejected')];
  assert.deepEqual(needsYou(list), { approve: 1, run: 2, held: 1, total: 4 });
  assert.equal(needsYouWords(needsYou(list)), '1 to approve · 2 test cases to run · 1 held back');
  assert.equal(needsYouWords(needsYou([at('src/e.tsx', 'applied')])), '', 'nothing needs you: no words');
  const items = ['a', 'b', 'd', 'e', 'f'].map((x) => item(x, `src/${x}.tsx`));
  assert.deepEqual(cardMarks(items, list, new Set()), { a: 'proposed', b: 'proposed', d: 'proposed' });
});
