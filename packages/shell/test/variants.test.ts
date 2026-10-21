import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Item, Link } from '@visual-editor/contract';
import { exampleProps, pagesOf, readCases, suggestCases, variantsPath, writeCases } from '../src/variants';

const card: Item = {
  id: 'react:component:ProjectCard',
  map: 'components',
  kind: 'shared',
  label: 'ProjectCard',
  source: { path: 'src/cards/ProjectCard.tsx', line: 3 },
  fields: [
    { name: 'title', value: 'string' },
    { name: 'size', value: "'sm' | 'md' | 'lg'" },
    { name: 'compact', value: 'boolean', tag: 'optional' },
    { name: 'tags', value: 'string[]' },
    { name: 'count', value: 'number' },
    { name: 'onOpen', value: '() => void', tag: 'callback' },
  ],
};

test('playground: example props, and suggested cases that each change one thing', () => {
  const base = exampleProps(card.fields!);
  assert.deepEqual(base, { title: 'Title', size: 'sm', tags: [], count: 3, onOpen: { $action: 'onOpen' } });
  const cases = suggestCases(card.fields!, base);
  const names = cases.map((c) => c.name);
  assert.deepEqual(names, ['long title', 'empty title', 'size: md', 'size: lg', 'compact on', 'with compact', 'no tags', 'many tags', 'count zero', 'count huge']);
  // Each one is the base with one change.
  const long = cases.find((c) => c.name === 'long title')!;
  assert.equal(long.props.size, 'sm');
  assert.ok(String(long.props.title).length > 100);
  assert.equal((cases.find((c) => c.name === 'many tags')!.props.tags as string[]).length, 12);
  assert.ok(suggestCases(card.fields!, base, 3).length === 3, 'at most as many as asked');
});

test('playground: cases kept in Name.variants.json next to the component', () => {
  const root = mkdtempSync(join(tmpdir(), 've-cases-'));
  mkdirSync(join(root, 'src/cards'), { recursive: true });
  assert.equal(variantsPath(card), join('src/cards', 'ProjectCard.variants.json'));
  assert.deepEqual(readCases(root, card), []);
  writeCases(root, card, [{ name: 'long title', props: { title: 'x'.repeat(200) } }]);
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'src/cards/ProjectCard.variants.json'), 'utf8')).component, 'ProjectCard');
  assert.deepEqual(readCases(root, card).map((c) => c.name), ['long title']);
});

test('playground: the pages a component is drawn on (plain addresses first)', () => {
  const c = (id: string): Item => ({ id, map: 'components', kind: 'component', label: id });
  const r = (path: string): Item => ({ id: `route:${path}`, map: 'pages', kind: 'route', label: path });
  const items = [c('Editor'), c('Panel'), c('Settings'), r('/project/:id'), r('/settings')];
  const links: Link[] = [
    { from: 'route:/project/:id', to: 'Editor', kind: 'shows' },
    { from: 'route:/settings', to: 'Settings', kind: 'shows' },
    { from: 'Editor', to: 'Panel', kind: 'renders' },
    { from: 'Settings', to: 'Panel', kind: 'renders' },
  ];
  assert.deepEqual(pagesOf(items[1], items, links), ['/settings', '/project/:id']);
});

test('playground: with real data, suggestions also change what is inside it', () => {
  const real = { project: { id: 'p1', name: 'order-service', description: 'Takes orders.', tags: ['api'] }, accentColor: '#3860f5', onOpen: { $action: 'onOpen' } };
  const cases = suggestCases([{ name: 'project', value: 'Project' }, { name: 'accentColor', value: 'string' }], real, 20);
  const names = cases.map((c) => c.name);
  for (const n of ['long project.name', 'empty project.description', 'no project.tags', 'many project.tags']) assert.ok(names.includes(n), n);
  assert.ok(!names.includes('long project.id'), 'not ids');
  const long = cases.find((c) => c.name === 'long project.name')!;
  assert.equal((long.props.project as { description: string }).description, 'Takes orders.', 'only one thing changes');
  assert.equal(long.props.accentColor, '#3860f5');
  assert.equal(real.project.name, 'order-service', 'the real data is left as it was');
});

test('playground: Visual Editor’s own files are never "changed outside review"', async () => {
  const { OutsideChanges, isVisualEditorFile } = await import('../src/changes');
  assert.ok(isVisualEditorFile('src/cards/ProjectCard.variants.json'));
  assert.ok(isVisualEditorFile('.visual-editor/api/get-api-orders.json'));
  assert.ok(!isVisualEditorFile('src/cards/ProjectCard.tsx'));
  const changes = new OutsideChanges();
  changes.note('/p', 'src/cards/ProjectCard.variants.json', '/p/src/cards/ProjectCard.variants.json');
  changes.note('/p', 'src/cards/ProjectCard.tsx', '/p/src/cards/ProjectCard.tsx');
  assert.deepEqual([...changes.get('/p')], ['src/cards/ProjectCard.tsx']);
});
