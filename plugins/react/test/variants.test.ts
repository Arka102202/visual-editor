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
