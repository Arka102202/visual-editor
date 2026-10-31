import assert from 'node:assert/strict';
import test from 'node:test';
import type { Item } from '@visual-editor/contract';
import { sessionKinds } from '../src/sessions';

const card: Item = {
  id: 'react:component:src/pages/ProjectList/components/ProjectCard/index.tsx#ProjectCard',
  map: 'components',
  kind: 'component',
  label: 'ProjectCard',
  source: { path: 'src/pages/ProjectList/components/ProjectCard/index.tsx' },
  preview: { variants: [{ id: 'default', name: 'Default', path: 'src/pages/ProjectList/components/ProjectCard/ProjectCard.variant.tsx', inUse: true }, { id: 'compact', name: 'Compact', path: 'src/pages/ProjectList/components/ProjectCard/ProjectCard.compact.variant.tsx', inUse: false }], states: ['default', 'long name'] },
};
const kind = (id: string) => sessionKinds.find((k) => k.id === id)!;

test('sessions: React offers four kinds, each saying what it needs', () => {
  assert.deepEqual(sessionKinds.map((k) => [k.id, k.title, k.needs]), [
    ['new-design', 'New design', { card: 'previewable' }],
    ['change-design', 'Change a design', { card: 'previewable', design: true }],
    ['new-component', 'New component', { name: 'The new component’s name, e.g. ProjectBadge' }],
    ['new-page', 'New page', { name: 'The new page’s name, e.g. Billing', page: true }],
  ]);
});

test('sessions: each brief says what to make, where, and how to work in the session', () => {
  const design = kind('new-design').brief({ card });
  assert.match(design, /NEW DESIGN for ProjectCard: one more look, next to its designs \(Default \(id "default", in use\), Compact \(id "compact"\)\)/);
  assert.match(design, /src\/pages\/ProjectList\/components\/ProjectCard\/ProjectCard\.<id>\.variant\.tsx/);
  assert.match(design, /Don't change which design is in use unless the developer asks/);
  const change = kind('change-design').brief({ card, design: 'compact' });
  assert.match(change, /CHANGES ONE DESIGN of ProjectCard: "Compact" \(id "compact", in src\/pages\/ProjectList\/components\/ProjectCard\/ProjectCard\.compact\.variant\.tsx\)/);
  const component = kind('new-component').brief({ name: 'ProjectBadge' });
  assert.match(component, /NEW COMPONENT, ProjectBadge[\s\S]*ProjectBadge\.types\.ts[\s\S]*ProjectBadge\.mock\.ts \(named states/);
  const page = kind('new-page').brief({ name: 'Billing', page: '/billing' });
  assert.match(page, /NEW PAGE, Billing, at \/billing[\s\S]*Add its route to the app's router so \/billing shows it[\s\S]*in the app at \/billing \(real data\) and in the Playground/);
  // Every brief: work in the session's draft, don't propose, keep to the rules.
  for (const b of [design, change, component, page]) assert.match(b, /save_draft[\s\S]*don't propose it[\s\S]*"variant-rules" skill/);
});
