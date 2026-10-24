import { test } from 'node:test';
import assert from 'node:assert/strict';
import { helperTemplate, helperVersion, updateHelper } from '../src/helper';

const project = { root: '/x', name: 'shop', files: ['src/main.tsx', 'src/visual-editor.tsx'] };

test('helper: the one the plugin ships is version 3', () => {
  const t = helperTemplate();
  assert.ok(t, 'found next to the plugin');
  assert.equal(helperVersion(t), 3);
  // Version 1 didn't say its version.
  assert.equal(helperVersion('export function mountPreview() {}'), 1);
});

test('helper: added when missing, updated when older, left alone when current or newer', () => {
  const t = 'export const HELPER_VERSION = 2\n// v2\n';
  const added = updateHelper({ ...project, files: ['src/main.tsx'] }, () => undefined, t);
  assert.ok(typeof added !== 'string');
  assert.equal(added.title, 'Add Visual Editor’s helper (version 2)');
  assert.deepEqual(added.changes, [{ path: '.visual-editor/react/visual-editor.tsx', before: null, after: t }]);

  const older = updateHelper(project, () => '// v1\nexport function mountPreview() {}\n', t);
  assert.ok(typeof older !== 'string');
  assert.equal(older.title, 'Update Visual Editor’s helper (version 1 → 2)');
  assert.equal(older.changes[0].after, t);

  assert.equal(updateHelper(project, () => t, t), 'Visual Editor’s helper is up to date (version 2).');
  assert.match(String(updateHelper(project, () => 'export const HELPER_VERSION = 3\n', t)), /newer than the React plugin’s/);
});
