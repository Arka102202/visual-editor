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

test('hello: previews its card, reading files through the shell (so proposals show)', async () => {
  const preview = helloPlugin.previews![0];
  const item = { id: 'hello:card', map: 'hello', kind: 'example', label: 'Hello, shop' };
  assert.ok(preview.wants(item));
  assert.deepEqual(preview.situations!(item), ['normal', 'empty']);
  const project = { root: '/p', name: 'shop <b>', files: ['README.md'] };
  const read = async (p: string) => (p === 'README.md' ? 'a\nb\nc' : undefined);
  const page = (await preview.render({ item, project, situation: 'normal', theme: 'dark', width: 375, read })) as { html: string };
  assert.match(page.html, /Hello, shop &lt;b&gt;/);
  assert.match(page.html, /README.md<\/span><b>3 lines/);
  assert.doesNotMatch(page.html, /package.json/);
  const empty = (await preview.render({ item, project, situation: 'empty', theme: 'light', width: 375, read })) as { html: string };
  assert.match(empty.html, /No files to show/);
});
