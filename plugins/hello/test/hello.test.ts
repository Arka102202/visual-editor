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

test('hello: an example tool, skill and agent for assistants', async () => {
  const tool = helloPlugin.tools![0];
  const project = { root: '/p', name: 'shop', files: ['package.json', 'README.md', 'src/a.ts'] };
  const context = { project, items: [], links: [], read: async () => undefined };
  assert.equal(await tool.run({}, context), 'shop has 3 file(s).');
  assert.equal(await tool.run({ ending: '.md' }, context), 'shop has 1 file(s) ending with .md.');
  assert.deepEqual(helloPlugin.skills!.map((s) => s.name), ['hello-greetings']);
  assert.deepEqual(helloPlugin.agents!.map((a) => a.name), ['hello-note']);
});
