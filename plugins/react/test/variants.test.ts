import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readVariantFolders } from '../src/read/variants';
import { readModel, toMaps } from '../src/cards';

const dir = 'plugins/react/test/fixtures/variant-folder';
const at = 'src/pages/ProjectList/components/ProjectCard';
const folder = readdirSync(join(dir, 'ProjectCard')).map((f) => ({ path: `${at}/${f}`, text: readFileSync(join(dir, 'ProjectCard', f), 'utf8') }));

test('variants: a folder made previewable is read: its variants, the one in use, its states', () => {
  const [f] = readVariantFolders(folder);
  assert.equal(f.name, 'ProjectCard');
  assert.equal(f.dir, at);
  assert.deepEqual(f.variants.map((v) => `${v.id}:${v.name}`), ['default:Default', 'compact:Compact']);
  assert.equal(f.selected, 'default');
  assert.deepEqual(f.states, ['default', 'long name', 'no description', 'just created']);
  assert.equal(f.files.chooser, `${at}/index.tsx`);
  assert.equal(f.files.data, `${at}/ProjectCard.data.tsx`);
  assert.equal(f.files.static, `${at}/ProjectCard.static.tsx`);
  assert.equal(f.version, 2);
  // The switcher imports another variant: that one is in use.
  const switched = folder.map((x) => (x.path.endsWith('.switcher.tsx') ? { ...x, text: x.text.replace("from './ProjectCard.variant'", "from './ProjectCard.compact.variant'") } : x));
  assert.equal(readVariantFolders(switched)[0].selected, 'compact');
});

test('variants: on the map, the folder is one card that knows its variants (its parts fold into it)', () => {
  const list = `import { ProjectCard } from './components/ProjectCard'\nexport default function ProjectList() { return <ProjectCard project={p} accentColor="#000" onOpen={() => {}} onDelete={() => {}} /> }\n`;
  const files = [...folder, { path: 'src/pages/ProjectList/ProjectList.tsx', text: list }];
  const { items, links } = toMaps(readModel(files));
  const cards = items.filter((i) => i.map === 'components').map((i) => i.label).sort();
  assert.deepEqual(cards, ['ProjectCard', 'ProjectList'], 'no cards for the data, the switcher or the variants');
  const card = items.find((i) => i.label === 'ProjectCard')!;
  assert.deepEqual(card.preview?.variants.map((v) => `${v.id}${v.inUse ? ' (in use)' : ''}`), ['default (in use)', 'compact']);
  assert.equal(card.preview?.states.length, 4);
  // Its other files belong to it (a hand edit to the switcher marks this card).
  assert.deepEqual(card.preview?.files?.map((f) => f.split('/').pop()), ['ProjectCard.compact.variant.tsx', 'ProjectCard.data.tsx', 'ProjectCard.mock.ts', 'ProjectCard.static.tsx', 'ProjectCard.switcher.tsx', 'ProjectCard.types.ts', 'ProjectCard.variant.tsx']);
  assert.ok(card.source?.path.endsWith('ProjectCard/index.tsx'));
  const byLabel = new Map(items.map((i) => [i.id, i.label]));
  assert.deepEqual((links ?? []).map((l) => `${byLabel.get(l.from)} ${l.kind} ${byLabel.get(l.to)}`), ['ProjectList renders ProjectCard']);
});

test('variants: a folder card is "uses data" only when its real data file uses data', () => {
  const list = `import { ProjectCard } from './components/ProjectCard'\nexport default function ProjectList() { return <ProjectCard /> }\n`;
  const kind = (files: { path: string; text: string }[]) => toMaps(readModel([...files, { path: 'src/pages/ProjectList/ProjectList.tsx', text: list }])).items.find((i) => i.label === 'ProjectCard')!.kind;
  assert.equal(kind(folder), 'component');
  const fetching = folder.map((x) => (x.path.endsWith('.data.tsx') ? { ...x, text: x.text.replace("export default function", "import { useQuery } from '@tanstack/react-query'\nexport default function").replace('return (', "const q = useQuery({ queryKey: ['p'], queryFn: () => fetch('/api/projects').then((r) => r.json()) })\n  return (") } : x));
  assert.equal(kind(fetching), 'uses data');
});

test('variants: Visual Editor’s helper file gets no cards', () => {
  const helper = readFileSync('plugins/react/runtime/visual-editor.tsx', 'utf8');
  const { items } = toMaps(readModel([...folder, { path: 'src/visual-editor.tsx', text: helper }]));
  assert.deepEqual(items.filter((i) => i.map === 'components').map((i) => i.label), ['ProjectCard']);
});

test('variant checks: the worked example breaks no rule', () => {
  const [f] = readModel(folder).variantFolders!;
  assert.deepEqual(f.problems, []);
});

test('variant checks: each broken rule is said in words, with what to do', () => {
  const change = (end: string, from: string | RegExp, to: string) => folder.map((x) => (x.path.endsWith(end) ? { ...x, text: x.text.replace(from, to) } : x));
  const problems = (files: { path: string; text: string }[]) => readModel(files).variantFolders![0].problems ?? [];
  const has = (files: { path: string; text: string }[], words: RegExp) => assert.ok(problems(files).some((p) => words.test(p)), `${words}: ${JSON.stringify(problems(files))}`);

  // Another variant loaded up front ships to users.
  has(change('.switcher.tsx', "import type { ProjectCardView }", "import Compact from './ProjectCard.compact.variant'\nimport type { ProjectCardView }"), /loads Compact up front, so it would ship to users/);
  // A variant left out of the list isn't shown in Preview.
  has(change('.switcher.tsx', ", import('./ProjectCard.compact.variant')", ''), /Compact isn’t in ProjectCard\.switcher\.tsx’s list/);
  // The list must be for development only.
  has(change('.switcher.tsx', 'import.meta.env.DEV ? ', 'true ? '), /isn’t for development only/);
  // The starting data loaded up front ships to users.
  has(change('index.tsx', "import { StaticPart, useVariantKey }", "import * as startData from './ProjectCard.mock'\nimport { StaticPart, useVariantKey }"), /loads ProjectCard\.mock\.ts up front, so the starting data would ship to users/);
  // A variant that reads a store.
  has(change('.compact.variant.tsx', 'export default function ProjectCardCompact({ name, updated, accentColor, onOpen, onDelete }: ProjectCardView) {', "import { useCanvasStore } from '../../../../store/canvasStore'\nexport default function ProjectCardCompact({ name, updated, accentColor, onOpen, onDelete }: ProjectCardView) {\n  const nodes = useCanvasStore((s) => s.nodes)"), /Compact \(ProjectCard\.compact\.variant\.tsx\) reads the store useCanvasStore\. A variant shows looks only: move it to ProjectCard\.data\.tsx/);
  // A state missing something the static part starts from.
  has(change('.mock.ts', "'no description': { ...base, project: { ...base.project, description: '' } },", "'no description': { project: base.project },"), /The state “no description” is missing accentColor, onOpen, onDelete \(ProjectCardStart needs them\)/);
  // Two variants with one id.
  has(change('.compact.variant.tsx', "id: 'compact'", "id: 'default'"), /Two variants have the id “default”/);
  // No variant imported the normal way: nothing in use.
  has(change('.switcher.tsx', "import Selected, { variant } from './ProjectCard.variant'", "const Selected = () => null; const variant = { id: 'x' }"), /doesn’t import a variant the normal way/);
  // A missing piece.
  has(folder.filter((x) => !x.path.endsWith('.mock.ts')), /There’s no ProjectCard\.mock\.ts/);
});

test('variant checks: a commented-out line doesn’t count (even for the variant in use)', () => {
  const files = folder.map((x) => {
    if (!x.path.endsWith('.switcher.tsx')) return x;
    // As a formatter would write it, with the variant in use left out of the list in a comment.
    return { ...x, text: x.text.replace("import Selected, { variant } from './ProjectCard.variant'", 'import Selected, { variant } from "./ProjectCard.compact.variant";').replace("() => [import('./ProjectCard.variant'), import('./ProjectCard.compact.variant')]", '() => [\n        import("./ProjectCard.variant"),\n        // import("./ProjectCard.compact.variant"),\n      ]') };
  });
  const [f] = readModel(files).variantFolders!;
  assert.equal(f.selected, 'compact');
  assert.ok(f.problems!.some((p) => /Compact isn’t in ProjectCard\.switcher\.tsx’s list/.test(p)), JSON.stringify(f.problems));
});

// Version 2: a page with a static part (a working prototype) and starting data.
const pageAt = 'src/pages/ProjectList';
const page = readdirSync('plugins/react/test/fixtures/variant-page/ProjectList').map((f) => ({ path: `${pageAt}/${f}`, text: readFileSync(join('plugins/react/test/fixtures/variant-page/ProjectList', f), 'utf8') }));
const swap = (files: typeof page, file: string, change: (text: string) => string) => files.map((x) => (x.path === `${pageAt}/${file}` ? { ...x, text: change(x.text) } : x));

test('variants v2: a page with a static part is read and breaks no rule', () => {
  const [f] = readModel(page).variantFolders!;
  assert.equal(f.version, 2);
  assert.equal(f.files.static, `${pageAt}/ProjectList.static.tsx`);
  assert.deepEqual(f.states, ['default', 'empty', 'many', 'loading']);
  assert.equal(f.selected, 'default');
  assert.deepEqual(f.problems ?? [], []);
  // On the map it's one card (the page), with its static part folded in.
  const cards = toMaps(readModel(page)).items.filter((i) => i.map === 'components').map((i) => i.label);
  assert.ok(cards.includes('ProjectList'));
  assert.ok(!cards.some((c) => /Static|Data/.test(c)), cards.join(', '));
});

test('variants v2: a static part that isn’t a prototype is said in words, with what to do', () => {
  const problems = (files: typeof page) => readModel(files).variantFolders![0].problems ?? [];
  // It calls the API.
  const api = swap(page, 'ProjectList.static.tsx', (t) => t.replace("import { useState } from 'react'", "import { useState, useEffect } from 'react'").replace('const [isModalOpen, setModalOpen] = useState(false)', "const [isModalOpen, setModalOpen] = useState(false)\n  useEffect(() => { void fetch('/api/projects').then((r) => r.json()).then(setProjects) }, [])"));
  assert.ok(problems(api).some((p) => /ProjectList\.static\.tsx calls the API/.test(p) && /keep its data in memory/.test(p)), `got: ${problems(api).join(' | ')}`);
  // It navigates with the router instead of goTo().
  const nav = swap(page, 'ProjectList.static.tsx', (t) => t.replace("import { useState } from 'react'", "import { useState } from 'react'\nimport { useNavigate } from 'react-router-dom'").replace('const [isModalOpen, setModalOpen] = useState(false)', 'const [isModalOpen, setModalOpen] = useState(false)\n  const navigate = useNavigate()').replace('goTo(toEditor(id))', 'navigate(toEditor(id))'));
  assert.ok(problems(nav).some((p) => /uses the router/.test(p) && /goTo\('\/the\/address'\)/.test(p)), problems(nav).join('\n'));
  // The chooser loads the static part up front: it would ship to users.
  const upFront = swap(page, 'index.tsx', (t) => `import ProjectListStatic from './ProjectList.static'\n${t}`);
  assert.ok(problems(upFront).some((p) => /loads ProjectList\.static\.tsx up front, so the static part would ship to users/.test(p)));
  // A state is missing what the static part starts from.
  const missing = swap(page, 'ProjectList.mock.ts', (t) => t.replace('empty: { projects: [] },', 'empty: {},'));
  assert.ok(problems(missing).includes('The state “empty” is missing projects (ProjectListStart needs it).'), problems(missing).join('\n'));
  // The chooser draws a static part that doesn't exist.
  const gone = page.filter((x) => !x.path.endsWith('ProjectList.static.tsx'));
  assert.ok(problems(gone).some((p) => /there’s no ProjectList\.static\.tsx/.test(p)));
  // The types don't say what the static part starts from.
  const noStart = swap(page, 'ProjectList.types.ts', (t) => t.replace(/export interface ProjectListStart \{[\s\S]*?\n\}\n/, ''));
  assert.ok(problems(noStart).some((p) => /has no ProjectListStart/.test(p)), problems(noStart).join('\n'));
});

// Version 1 (fixed views, no static part): folders made before version 2 keep working, checked by their own rules.
const v1 = readdirSync('plugins/react/test/fixtures/variant-folder-v1/ProjectCard').map((f) => ({ path: `${at}/${f}`, text: readFileSync(join('plugins/react/test/fixtures/variant-folder-v1/ProjectCard', f), 'utf8') }));

test('variants v1: a folder made the version 1 way is read and breaks no rule', () => {
  const [f] = readModel(v1).variantFolders!;
  assert.equal(f.version, 1);
  assert.equal(f.files.static, undefined);
  assert.equal(f.selected, 'default');
  assert.deepEqual(f.problems ?? [], []);
  // Its states are views: one missing what the view needs is said so.
  const broken = v1.map((x) => (x.path.endsWith('.mock.ts') ? { ...x, text: x.text.replace("'no description': { ...base, description: '' },", "'no description': { name: 'x', description: '' },") } : x));
  assert.ok((readModel(broken).variantFolders![0].problems ?? []).some((p) => /missing updated, accentColor, onOpen, onDelete \(ProjectCardView needs them\)/.test(p)));
});
