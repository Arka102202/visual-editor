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
  const c = useVariant(item, 'compact', project, (p) => texts[p]);
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
  const c = useVariant(item, 'compact', project, (p) => commented[p]);
  assert.ok(typeof c !== 'string');
  assert.match(c.changes[0].after, /^\/\/ import Selected, \{ variant \} from '\.\/ProjectCard\.compact\.variant'\nimport Selected, \{ variant \} from '\.\/ProjectCard\.compact\.variant'$/m);
  assert.equal(useVariant(item, 'default', project, (p) => texts[p]), 'Default is already the one in use.');
  assert.equal(useVariant(item, 'wide', project, (p) => texts[p]), 'ProjectCard has no variant “wide”.');
  assert.match(String(useVariant(item, 'compact', { ...project, files: project.files.filter((f) => f !== sw) }, (p) => texts[p])), /no switcher file/);
});
