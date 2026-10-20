import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Item, Link } from '@visual-editor/contract';
import { exampleFor, exampleProps, pagesOf, serve, variantsPath } from '../src/previewPanel';

test('component mode: the pages a component is drawn on, through the components that draw it', () => {
  const c = (id: string): Item => ({ id: `react:component:${id}`, map: 'components', kind: 'component', label: id });
  const r = (path: string): Item => ({ id: `react:route:${path}`, map: 'pages', kind: 'route', label: path });
  const items = [c('Editor'), c('RightSidebar'), c('InspectorPanel'), c('Settings'), r('/project/:projectId'), r('/settings'), r('/')];
  const links: Link[] = [
    { from: 'react:route:/project/:projectId', to: 'react:component:Editor', kind: 'shows' },
    { from: 'react:route:/settings', to: 'react:component:Settings', kind: 'shows' },
    { from: 'react:component:Editor', to: 'react:component:RightSidebar', kind: 'renders' },
    { from: 'react:component:Settings', to: 'react:component:InspectorPanel', kind: 'renders' },
    { from: 'react:component:RightSidebar', to: 'react:component:InspectorPanel', kind: 'renders' },
  ];
  // Plain addresses first (they can be opened as they are).
  assert.deepEqual(pagesOf(items[2], items, links), ['/settings', '/project/:projectId']);
  assert.deepEqual(pagesOf(items[1], items, links), ['/project/:projectId']);
  assert.deepEqual(pagesOf(c('Lonely'), items, links), []);
});

test('component mode: example props from the types on a component card', () => {
  assert.equal(exampleFor('title', 'string'), 'Title');
  assert.equal(exampleFor('email', 'string'), 'ada@example.com');
  assert.equal(exampleFor('count', 'number'), 3);
  assert.equal(exampleFor('isOpen', 'boolean'), true);
  assert.equal(exampleFor('size', "'sm' | 'md' | 'lg'"), 'sm');
  assert.deepEqual(exampleFor('items', 'Project[]'), []);
  assert.deepEqual(exampleFor('onSelect', '(id: string) => void'), { $action: 'onSelect' });
  assert.equal(exampleFor('children', 'React.ReactNode'), 'Label');
  // Only what it needs (and children); callbacks say when they're called.
  assert.deepEqual(
    exampleProps([
      { name: 'project', value: 'Project' },
      { name: 'compact', value: 'boolean', tag: 'optional' },
      { name: 'onOpen', value: '() => void', tag: 'callback' },
    ]),
    { project: {}, onOpen: { $action: 'onOpen' } },
  );
});

test('component mode: variants kept next to the component (Name.variants.json)', () => {
  const root = mkdtempSync(join(tmpdir(), 've-variants-'));
  mkdirSync(join(root, 'src/cards'), { recursive: true });
  const card: Item = { id: 'react:component:x', map: 'components', kind: 'shared', label: 'ProjectCard', fields: [{ name: 'title', value: 'string' }], source: { path: 'src/cards/ProjectCard.tsx', line: 3 } };
  const project = { root, name: 'x', files: [] };
  assert.equal(variantsPath(card), join('src/cards', 'ProjectCard.variants.json'));
  const info = serve({ type: 'component', name: 'ProjectCard' }, project, [card]) as { found: boolean; example: unknown; data: unknown[] };
  assert.deepEqual([info.found, info.example, info.data], [true, { title: 'Title' }, []]);
  serve({ type: 'saveVariant', name: 'ProjectCard', variant: 'long title', props: { title: 'A very long title' } }, project, [card]);
  serve({ type: 'saveVariant', name: 'ProjectCard', variant: 'empty', props: { title: '' } }, project, [card]);
  // The same name again replaces it.
  serve({ type: 'saveVariant', name: 'ProjectCard', variant: 'empty', props: { title: ' ' } }, project, [card]);
  const file = JSON.parse(readFileSync(join(root, 'src/cards/ProjectCard.variants.json'), 'utf8'));
  assert.deepEqual(file, { component: 'ProjectCard', data: [{ name: 'long title', props: { title: 'A very long title' } }, { name: 'empty', props: { title: ' ' } }] });
  serve({ type: 'removeVariant', name: 'ProjectCard', variant: 'long title' }, project, [card]);
  assert.deepEqual((serve({ type: 'component', name: 'ProjectCard' }, project, [card]) as { data: { name: string }[] }).data.map((d) => d.name), ['empty']);
  assert.deepEqual(serve({ type: 'component', name: 'Missing' }, project, [card]), { found: false });
});
