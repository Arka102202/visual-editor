import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Item, ToolContext } from '@visual-editor/contract';
import { checkVariantFilesTool, previewableText, rememberModel, variantBriefTool, variantRulesSkill } from '../src/tools';
import { reactPlugin } from '../src/plugin';
import { readModel, toMaps } from '../src/cards';

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

test('the React plugin hands the shell its tools and know-how', () => {
  assert.deepEqual(reactPlugin.tools?.map((t) => t.name), ['previewable', 'variant_brief', 'check_variant_files']);
  assert.deepEqual(reactPlugin.skills?.map((s) => s.name), ['variant-rules']);
  assert.match(variantRulesSkill.text, /^# Variants: how a component or page is made previewable/, 'the rules doc, bundled as text');
});

// A small project: ProjectCard's folder (previewable), the list that draws it, and a badge that isn't previewable.
const at = 'src/pages/ProjectList/components/ProjectCard';
const fixture = 'plugins/react/test/fixtures/variant-folder/ProjectCard';
const texts: Record<string, string> = {
  ...Object.fromEntries(readdirSync(fixture).map((f) => [`${at}/${f}`, readFileSync(join(fixture, f), 'utf8')])),
  'src/pages/ProjectList/ProjectList.tsx': `import ProjectCard from './components/ProjectCard'
import { Badge } from '../../components/Badge'
export default function ProjectList({ projects }: { projects: { id: string; name: string }[] }) {
  return <div><Badge label="all" />{projects.map((p) => <ProjectCard key={p.id} project={p as never} accentColor="red" onOpen={() => {}} onDelete={() => {}} />)}</div>
}
`,
  'src/components/Badge.tsx': `import { useEffect, useState } from 'react'
export function Badge({ label }: { label: string }) {
  const [n, setN] = useState(0)
  useEffect(() => { fetch('/api/count').then((r) => r.json()).then(setN) }, [])
  return <span>{label} {n}</span>
}
`,
};

/** What the shell gives a tool: the project, today's cards, and files (as a draft would leave them, with one). */
function context(draft?: Record<string, string | null>): ToolContext {
  const files = Object.keys(texts);
  const model = readModel(files.map((path) => ({ path, text: texts[path] })));
  const { items, links } = toMaps(model);
  rememberModel('/x', model);
  const all = draft ? [...files.filter((f) => draft[f] !== null), ...Object.keys(draft).filter((f) => draft[f] !== null && !files.includes(f))] : files;
  return {
    project: { root: '/x', name: 'shop', files: all },
    items,
    links: links ?? [],
    read: async (path) => (draft && path in draft ? (draft[path] ?? undefined) : texts[path]),
    ...(draft ? { draft: { id: 'd1', title: 'A draft', changes: Object.entries(draft).map(([path, after]) => ({ path, after })) } } : {}),
  };
}
const run = async (tool: typeof variantBriefTool, input: Record<string, unknown>, ctx: ToolContext) => {
  const r = await tool.run(input, ctx);
  return typeof r === 'string' ? r : `PROBLEM ${r.problem}`;
};

test('variant_brief: a previewable component: props, who uses it, its folder, designs and states', async () => {
  const text = await run(variantBriefTool, { card: 'ProjectCard' }, context());
  assert.match(text, /^# ProjectCard \(component\) · react:component:src\/pages\/ProjectList\/components\/ProjectCard\/index\.tsx#ProjectCard/);
  assert.match(text, /Props: project: Project; accentColor/);
  assert.match(text, /Used by: ProjectList \(src\/pages\/ProjectList\/ProjectList\.tsx\)/);
  assert.match(text, /Previewable \(version 2\)\. Folder: src\/pages\/ProjectList\/components\/ProjectCard/);
  assert.match(text, /Files: chooser index\.tsx, types ProjectCard\.types\.ts, dynamic ProjectCard\.data\.tsx, static ProjectCard\.static\.tsx, starting data ProjectCard\.mock\.ts, switcher ProjectCard\.switcher\.tsx/);
  assert.match(text, /- Default \(id default\) · ProjectCard\.variant\.tsx · in use\n- Compact \(id compact\) · ProjectCard\.compact\.variant\.tsx\n/);
  assert.match(text, /States: default, long name, no description, just created/);
  assert.match(text, /visual-editor:variant-rules skill/);
});

test('variant_brief: one that is not previewable yet: its data, and the folder it would become', async () => {
  const text = await run(variantBriefTool, { card: 'Badge' }, context());
  assert.match(text, /Data it uses:\n- calls the API GET \/api\/count, on load · src\/components\/Badge\.tsx:4/);
  assert.match(text, /Not previewable yet\. Made previewable, its folder would be src\/components\/Badge:/);
  assert.match(text, /- src\/components\/Badge\/index\.tsx: the chooser; exports Badge as Badge\.tsx does now, so nothing that imports it changes \(it replaces src\/components\/Badge\.tsx\)/);
  assert.match(text, /- src\/components\/Badge\/Badge\.data\.tsx: the dynamic part, with the data above \(GET \/api\/count\)/);
  assert.equal(await run(variantBriefTool, { card: 'Nope' }, context()), 'PROBLEM No component or page called "Nope". Use previewable or list_cards to find it.');
});

test('check_variant_files: today’s folders, and a draft checked as it would leave the project', async () => {
  assert.match(await run(checkVariantFilesTool, {}, context()), /✓ ProjectCard \(src\/pages\/ProjectList\/components\/ProjectCard\): follows the rules\. Designs: Default, Compact; states: default, long name, no description, just created\.\nPASSED$/);

  // A new design that loads its own data: caught, only in the draft.
  const wide = `${at}/ProjectCard.wide.variant.tsx`;
  const bad = await run(checkVariantFilesTool, {}, context({ [wide]: `import { useEffect, useState } from 'react'
import type { ProjectCardView } from './ProjectCard.types'
export const variant = { id: 'wide', name: 'Wide' }
export default function ProjectCardWide({ name }: ProjectCardView) {
  const [n, setN] = useState(0)
  useEffect(() => { fetch('/api/stars').then((r) => r.json()).then(setN) }, [])
  return <div>{name} {n}</div>
}
` }));
  assert.match(bad, /✗ ProjectCard \(src\/pages\/ProjectList\/components\/ProjectCard\): 2 problems\n  - Wide isn’t in ProjectCard\.switcher\.tsx’s list of variants[^\n]*\n  - Wide \(ProjectCard\.wide\.variant\.tsx\) calls the API GET \/api\/stars\. A variant shows looks only/);
  assert.match(bad, /PROBLEMS$/);

  // Removing the static part: the folder says what's missing.
  assert.match(await run(checkVariantFilesTool, { card: 'ProjectCard' }, context({ [`${at}/ProjectCard.static.tsx`]: null })), /there’s no ProjectCard\.static\.tsx[\s\S]*PROBLEMS$/);

  // Moving Badge without leaving anything at its old place: ProjectList can no longer find it.
  const moved = await run(checkVariantFilesTool, {}, context({ 'src/components/Badge.tsx': null, 'src/components/Badge/Badge.variant.tsx': 'export default function BadgeLook() { return null }\n' }));
  assert.match(moved, /✗ src\/components\/Badge: has variant files but no Name\.switcher\.tsx/);
  assert.match(moved, /✗ The draft breaks imports:\n  - ProjectList \(src\/pages\/ProjectList\/ProjectList\.tsx\): Could not find where <Badge> comes from\./);
  assert.match(await run(checkVariantFilesTool, { card: 'Badge' }, context()), /Badge has no variant folder[\s\S]*PROBLEMS/);
});
