import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Item } from '@visual-editor/contract';
import { filesOf, fingerprint, outOfDate, readSummaries, summariesOf, summaryPrompt, SummaryStore } from '../src/summaries';
import { CARDS_PER_RUN, SummaryWriter } from '../src/summaryWriter';

const card = (label: string, path: string, more: Partial<Item> = {}): Item => ({ id: `react:${label}`, map: 'components', kind: 'component', label, source: { path }, ...more });

test('summaries: kept by card; a summary whose code changed since says so', () => {
  const root = mkdtempSync(join(tmpdir(), 've-sum-'));
  try {
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src/Card.tsx'), 'export const Card = () => null;\n');
    const store = new SummaryStore(root);
    const files = ['src/Card.tsx'];
    store.save([{ id: 'react:Card', label: 'Card', text: 'Shows a project.', at: '2026-11-01T10:00:00.000Z', files, hash: fingerprint(root, files) }]);
    store.save([{ id: 'react:List', label: 'List', text: 'Lists them.', at: '2026-11-01T10:00:00.000Z', files: [], hash: fingerprint(root, []) }]);
    assert.deepEqual(Object.keys(store.all()).sort(), ['react:Card', 'react:List'], 'saving one keeps the others');
    assert.equal(outOfDate(root, store.get('react:Card')!), false);
    writeFileSync(join(root, 'src/Card.tsx'), 'export const Card = () => 1;\n');
    assert.equal(outOfDate(root, store.get('react:Card')!), true, 'its code changed: it may be out of date');
    assert.deepEqual(summariesOf('src/Card.tsx', store.all()).map((s) => s.id), ['react:Card']);
    assert.deepEqual(summariesOf('src/Other.tsx', store.all()), []);
    store.remove('react:List');
    assert.deepEqual(Object.keys(store.all()), ['react:Card']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('summaries: the writer is told what the map knows (Claude reads the files); its answer keeps only the cards asked for', () => {
  const c = card('ProjectCard', 'src/ProjectCard/index.tsx', { fields: [{ name: 'project', value: 'Project' }], preview: { variants: [{ id: 'default', name: 'Default', path: 'x', inUse: true }], states: ['default', 'empty'], files: ['src/ProjectCard/ProjectCard.data.tsx'] } });
  const list = card('ProjectList', 'src/ProjectList.tsx');
  assert.deepEqual(filesOf(c), ['src/ProjectCard/index.tsx', 'src/ProjectCard/ProjectCard.data.tsx']);
  const p = summaryPrompt([c], [{ from: list.id, to: c.id, kind: 'renders' }], [c, list]);
  assert.match(p, /## ProjectCard \(id react:ProjectCard\)\nA component\. Files: src\/ProjectCard\/index\.tsx, src\/ProjectCard\/ProjectCard\.data\.tsx\nIt takes: project \(Project\)\nUsed by: ProjectList renders it\nDesigns: Default \(in use\); states: default, empty/);
  assert.match(p, /Read each card's files to be sure; say only what the code does/);
  const got = readSummaries('Sure:\n{"summaries": [{"id": "react:ProjectCard", "text": " Shows one project. "}, {"id": "react:Made-up", "text": "?"}]}', [c.id]) as Map<string, string>;
  assert.deepEqual([...got], [['react:ProjectCard', 'Shows one project.']]);
  assert.match(readSummaries('no idea', [c.id]) as string, /didn't answer with summaries/);
  assert.match(readSummaries('{"summaries": []}', [c.id]) as string, /didn't answer with summaries/);
});

test('summaries: the writer writes several cards in one run (more make more runs), each shown as it goes; a failed run says why', async () => {
  const root = mkdtempSync(join(tmpdir(), 've-sum-'));
  try {
    const items = Array.from({ length: CARDS_PER_RUN + 2 }, (_, i) => card(`C${i}`, `src/C${i}.tsx`));
    items.push({ id: 'react:api', map: 'api', kind: 'api call', label: 'GET /x' });
    const runs: number[] = [];
    let answer: (ids: string[]) => string = (ids) => JSON.stringify({ summaries: ids.map((id) => ({ id, text: `About ${id}` })) });
    const changed: string[] = [];
    const writer = new SummaryWriter({
      project: () => ({ items, links: [] }),
      ask: async (_root, prompt) => {
        const ids = [...prompt.matchAll(/\(id (react:[\w]+)\)/g)].map((m) => m[1]);
        runs.push(ids.length);
        return { result: answer(ids) };
      },
      changed: (r) => changed.push(r),
    });
    const why = await writer.write(root, items.map((i) => i.id), 'p1');
    assert.equal(why, undefined);
    assert.deepEqual(runs, [CARDS_PER_RUN, 2], 'one run per ten cards; the API call has no file and is left out');
    assert.equal(writer.jobs.get('p1')!.ended, true);
    assert.deepEqual([...new Set(writer.jobs.get('p1')!.cards.map((c) => c.state))], ['done']);
    assert.equal(new SummaryStore(root).get('react:C3')!.text, 'About react:C3');
    assert.ok(changed.length >= 3, 'its views followed as it went');
    // A run that fails: its cards are marked so, with why; nothing is saved for them.
    answer = () => 'nope';
    assert.match((await writer.write(root, ['react:C0'], 'p2'))!, /didn't answer/);
    assert.deepEqual(writer.jobs.get('p2')!.cards.map((c) => c.state), ['failed']);
    assert.match(writer.jobs.get('p2')!.error!, /didn't answer/);
    assert.equal(writer.isWriting(root, 'react:C0'), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
