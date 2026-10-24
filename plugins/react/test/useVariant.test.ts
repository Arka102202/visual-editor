import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Item } from '@visual-editor/contract';
import { useVariant } from '../src/useVariant';

const dir = 'plugins/react/test/fixtures/variant-folder/ProjectCard';
const at = 'src/pages/ProjectList/components/ProjectCard';
const texts: Record<string, string> = Object.fromEntries(readdirSync(dir).map((f) => [`${at}/${f}`, readFileSync(join(dir, f), 'utf8')]));
const project = { root: '/x', name: 'shop', files: Object.keys(texts) };
const item: Item = {
  id: `react:component:${at}/index.tsx#ProjectCard`, map: 'components', kind: 'component', label: 'ProjectCard',
  source: { path: `${at}/index.tsx` },
  preview: {
    variants: [
      { id: 'default', name: 'Default', path: `${at}/ProjectCard.variant.tsx`, inUse: true },
      { id: 'compact', name: 'Compact', path: `${at}/ProjectCard.compact.variant.tsx`, inUse: false },
    ],
    states: ['default'],
  },
};

test('use this design: only the switcher’s one import line changes, with before and after to look at', () => {
  const c = useVariant(item, 'compact', project, undefined, (p) => texts[p]);
  assert.ok(typeof c !== 'string', String(c));
  assert.equal(c.title, 'ProjectCard: use Compact instead of Default');
  assert.equal(c.changes.length, 1);
  const { path, before, after } = c.changes[0];
  assert.equal(path, `${at}/ProjectCard.switcher.tsx`);
  const changed = after.split('\n').filter((l, i) => l !== (before ?? '').split('\n')[i]);
  assert.deepEqual(changed, ["import Selected, { variant } from './ProjectCard.compact.variant'"]);
  // The list of every variant (import()) is left as it was.
  assert.match(after, /import\('\.\/ProjectCard\.variant'\), import\('\.\/ProjectCard\.compact\.variant'\)/);
  assert.equal(c.look, `/__ve/preview?item=${encodeURIComponent(item.id)}&compare=default%2Ccompact`);
});

test('use this design: a commented-out line isn’t the one changed; what can’t be done is said in words', () => {
  const sw = `${at}/ProjectCard.switcher.tsx`;
  const commented: Record<string, string> = { ...texts, [sw]: texts[sw].replace("import Selected, { variant } from './ProjectCard.variant'", "// import Selected, { variant } from './ProjectCard.compact.variant'\nimport Selected, { variant } from './ProjectCard.variant'") };
  const c = useVariant(item, 'compact', project, undefined, (p) => commented[p]);
  assert.ok(typeof c !== 'string');
  assert.match(c.changes[0].after, /^\/\/ import Selected, \{ variant \} from '\.\/ProjectCard\.compact\.variant'\nimport Selected, \{ variant \} from '\.\/ProjectCard\.compact\.variant'$/m);
  assert.equal(useVariant(item, 'default', project, undefined, (p) => texts[p]), 'Default is already the one in use.');
  assert.equal(useVariant(item, 'wide', project, undefined, (p) => texts[p]), 'ProjectCard has no variant “wide”.');
  assert.match(String(useVariant(item, 'compact', { ...project, files: project.files.filter((f) => f !== sw) }, undefined, (p) => texts[p])), /no switcher file/);
});

// Situations: a Button with one design in use per situation.
const bDir = 'plugins/react/test/fixtures/variant-situations/Button';
const bAt = 'src/components/shared/Button';
const bTexts: Record<string, string> = Object.fromEntries(readdirSync(bDir).map((f) => [`${bAt}/${f}`, readFileSync(join(bDir, f), 'utf8')]));
const bProject = { root: '/x', name: 'shop', files: Object.keys(bTexts) };
const button: Item = {
  id: `react:component:${bAt}/index.tsx#Button`, map: 'components', kind: 'component', label: 'Button',
  source: { path: `${bAt}/index.tsx` },
  preview: {
    variants: [
      { id: 'pill', name: 'Pill', path: `${bAt}/Button.pill.variant.tsx`, inUse: false, inUseFor: [] },
      { id: 'rounded', name: 'Rounded', path: `${bAt}/Button.variant.tsx`, inUse: true, inUseFor: ['primary', 'secondary'] },
      { id: 'sharp', name: 'Sharp', path: `${bAt}/Button.sharp.variant.tsx`, inUse: true, inUseFor: ['danger'] },
    ],
    states: ['primary', 'secondary', 'danger', 'danger disabled'],
    situations: { prop: 'kind', names: ['primary', 'secondary', 'danger'], ofState: { primary: 'primary', secondary: 'secondary', danger: 'danger', 'danger disabled': 'danger' } },
  },
};
const changedLines = (c: ReturnType<typeof useVariant>) => {
  assert.ok(typeof c !== 'string', String(c));
  const before = (c.changes[0].before ?? '').split('\n');
  const after = c.changes[0].after.split('\n');
  return { removed: before.filter((l) => !after.includes(l)), added: after.filter((l) => !before.includes(l)) };
};

test('use this design, with situations: only that situation’s line changes', () => {
  // A design the switcher already imports: one line.
  const c = useVariant(button, 'rounded', bProject, 'danger', (p) => bTexts[p]);
  assert.ok(typeof c !== 'string');
  assert.equal(c.title, 'Button: use Rounded for “danger” instead of Sharp');
  const lines = changedLines(c);
  // Sharp isn't used by any situation now: its import goes too, so it doesn't ship.
  assert.deepEqual(lines.removed.map((l) => l.trim()).sort(), ["danger: Sharp,", "import Sharp from './Button.sharp.variant'"]);
  assert.deepEqual(lines.added.map((l) => l.trim()), ['danger: Rounded,']);
  assert.match(c.look!, /compare=sharp%2Crounded&situation=danger$/);
});

test('use this design, with situations: a design not imported yet is added; one still used stays', () => {
  const c = useVariant(button, 'pill', bProject, 'primary', (p) => bTexts[p]);
  const lines = changedLines(c);
  // Rounded is still in use for secondary: its import stays.
  assert.deepEqual(lines.removed.map((l) => l.trim()), ['primary: Rounded,']);
  assert.deepEqual(lines.added.map((l) => l.trim()).sort(), ["import Pill from './Button.pill.variant'", 'primary: Pill,']);
  // What can't be done is said in words.
  assert.match(String(useVariant(button, 'pill', bProject, undefined, (p) => bTexts[p])), /say which one Pill is for/);
  assert.equal(useVariant(button, 'sharp', bProject, 'danger', (p) => bTexts[p]), 'Sharp is already the design in use for “danger”.');
});
