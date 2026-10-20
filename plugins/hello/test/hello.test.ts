import assert from 'node:assert/strict';
import test from 'node:test';
import { checkPlugin } from '../../../packages/shell/src/registry';
import { helloPlugin } from '../src/plugin';

test('hello: a valid plugin that adds one card', async () => {
  assert.equal(checkPlugin(helloPlugin, () => false), undefined);
  const project = { root: '/p', name: 'shop', files: ['package.json', 'README.md', 'src/a.ts'] };
  assert.ok(await helloPlugin.detect(project));
  const reader = helloPlugin.readers![0];
  assert.deepEqual(project.files.filter(reader.wants), ['package.json', 'README.md']);
  const result = await reader.read([{ path: 'README.md', text: '# Shop\nhi\n' }], project);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].label, 'Hello, shop');
  assert.equal(result.items[0].sub, '3 files in this project');
  assert.deepEqual(result.items[0].fields, [{ name: 'README.md', value: '3 lines' }]);
});
