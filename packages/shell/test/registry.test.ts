import assert from 'node:assert/strict';
import test from 'node:test';
import { CONTRACT_VERSION, type Plugin } from '@visual-editor/contract';
import { checkPlugin, PluginRegistry } from '../src/registry';

const plugin = (over: Partial<Plugin> = {}): Plugin => ({
  id: 'react',
  name: 'React',
  version: '0.1.0',
  contract: CONTRACT_VERSION,
  detect: () => ({ reason: 'react is in package.json' }),
  ...over,
});

test('registry: plugins come and go, and listeners hear about it', () => {
  const r = new PluginRegistry();
  let changes = 0;
  r.onChange(() => changes++);
  const a = r.register(plugin({ id: 'react', name: 'React' }));
  r.register(plugin({ id: 'express', name: 'Express' }));
  assert.deepEqual(r.list().map((p) => p.name), ['Express', 'React'], 'sorted by name');
  a.dispose();
  assert.deepEqual(r.list().map((p) => p.id), ['express']);
  a.dispose();
  assert.equal(changes, 3, 'disposing twice changes nothing');
});

test('registry: plugins that cannot be used are refused with a reason the developer can act on', () => {
  const r = new PluginRegistry();
  r.register(plugin());
  assert.throws(() => r.register(plugin()), /already uses the id "react"/);
  assert.throws(() => r.register(plugin({ id: 'old', contract: CONTRACT_VERSION - 1 })), /built for an older Visual Editor.*Update the plugin/);
  assert.throws(() => r.register(plugin({ id: 'new', contract: CONTRACT_VERSION + 1 })), /needs a newer Visual Editor.*Update Visual Editor/);
  assert.equal(r.problems.length, 3, 'kept to show in the Plugins list');
  assert.match(checkPlugin(plugin({ id: 'Bad Id' }), () => false)!, /lowercase/);
  assert.match(checkPlugin(plugin({ detect: undefined as never }), () => false)!, /detect\(\)/);
  assert.match(checkPlugin(plugin({ readers: [{ id: 'x' } as never] }), () => false)!, /readers is missing/);
  assert.equal(checkPlugin(undefined, () => false), 'It registered nothing usable.');
  assert.equal(r.list().length, 1, 'refused plugins are not added');
});
