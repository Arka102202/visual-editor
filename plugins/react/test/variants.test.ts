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
  // The mock data loaded up front ships to users.
  has(change('index.tsx', "const mock = import.meta.env.DEV ? () => import('./ProjectCard.mock') : undefined", "import * as mockData from './ProjectCard.mock'\nconst mock = async () => mockData"), /loads ProjectCard\.mock\.ts up front/);
  // A variant that reads a store.
  has(change('.compact.variant.tsx', 'export default function ProjectCardCompact({ name, updated, accentColor, onOpen, onDelete }: ProjectCardView) {', "import { useCanvasStore } from '../../../../store/canvasStore'\nexport default function ProjectCardCompact({ name, updated, accentColor, onOpen, onDelete }: ProjectCardView) {\n  const nodes = useCanvasStore((s) => s.nodes)"), /Compact \(ProjectCard\.compact\.variant\.tsx\) reads the store useCanvasStore\. A variant shows looks only: move it to ProjectCard\.data\.tsx/);
  // A mock state missing something the view needs.
  has(change('.mock.ts', "'no description': { ...base, description: '' },", "'no description': { name: 'x', description: '' },"), /The state “no description” is missing updated, accentColor, onOpen, onDelete/);
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
