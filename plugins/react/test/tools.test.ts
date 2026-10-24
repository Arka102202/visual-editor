import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Item } from '@visual-editor/contract';
import { previewableText } from '../src/tools';
import { reactPlugin } from '../src/plugin';

const card: Item = {
  id: 'react:component:src/ProjectCard/index.tsx#ProjectCard', map: 'components', kind: 'component', label: 'ProjectCard', source: { path: 'src/ProjectCard/index.tsx' },
  preview: {
    variants: [
      { id: 'default', name: 'Default', path: 'src/ProjectCard/ProjectCard.variant.tsx', inUse: false },
      { id: 'compact', name: 'Compact', path: 'src/ProjectCard/ProjectCard.compact.variant.tsx', inUse: true },
    ],
    states: ['default', 'empty'],
    problems: ['ProjectCard.wide.variant.tsx calls an API: designs get their data from the dynamic part.'],
  },
};
const button: Item = {
  id: 'react:component:src/Button/index.tsx#Button', map: 'components', kind: 'shared', label: 'Button',
  preview: {
    variants: [
      { id: 'default', name: 'Default', path: 'src/Button/Button.variant.tsx', inUse: true, inUseFor: ['primary'] },
      { id: 'outline', name: 'Outline', path: 'src/Button/Button.outline.variant.tsx', inUse: true, inUseFor: ['danger'], for: ['danger'] },
    ],
    states: ['primary', 'danger'],
    situations: { prop: 'kind', names: ['primary', 'danger'], ofState: { primary: 'primary', danger: 'danger' } },
  },
};
const items: Item[] = [
  card, button,
  { id: 'react:component:src/Home.tsx#Home', map: 'components', kind: 'page', label: 'Home', source: { path: 'src/Home.tsx' } },
  { id: 'react:component:src/Nav.tsx#Nav', map: 'components', kind: 'layout', label: 'Nav', source: { path: 'src/Nav.tsx' } },
  { id: 'react:route:/', map: 'pages', kind: 'route', label: '/' },
];

test('previewable: designs (the one in use), states, situations and problems; then what cannot be previewed yet', () => {
  const text = previewableText(items);
  assert.match(text, /^Can be previewed \(2\):/);
  assert.match(text, /- ProjectCard \(component\) · react:component:src\/ProjectCard\/index\.tsx#ProjectCard/);
  assert.match(text, /Designs: Default, Compact \(in use\)/);
  assert.match(text, /States: default, empty/);
  assert.match(text, /Problem: ProjectCard\.wide\.variant\.tsx calls an API/);
  assert.match(text, /Designs: Default \(in use for primary\), Outline \(in use for danger\) \[made for danger\]/);
  assert.match(text, /Situations \(picked by the prop "kind"\): primary, danger/);
  assert.match(text, /Not previewable yet \(2: 1 page, 1 layout\):\n- Home \(page\) · src\/Home\.tsx\n- Nav \(layout\)/);
  assert.doesNotMatch(text, /route/, 'only components and pages');
});

test('previewable: search narrows it, and says when nothing matches', () => {
  assert.match(previewableText(items, 'home'), /^None can be previewed yet[^\n]*\n\nNot previewable yet \(1: 1 page\)/);
  assert.equal(previewableText(items, 'zzz'), 'No component or page matches "zzz".');
});

test('the React plugin hands the shell its tool', () => {
  assert.deepEqual(reactPlugin.tools?.map((t) => t.name), ['previewable']);
});
