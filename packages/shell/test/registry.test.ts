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

test('registry: tools, skills and agents are checked and collected from every plugin', () => {
  const tool = (name: string) => ({ name, title: 'T', description: 'D', run: () => 'ok' });
  const agent = { name: 'make-previewable', title: 'Make previewable', description: 'D', worker: { prompt: 'Do' }, checker: { prompt: 'Check' } };
  const r = new PluginRegistry();
  r.register(plugin({ id: 'a', name: 'A', tools: [tool('variant_brief')], skills: [{ name: 'variant-rules', description: 'D', text: 'T' }], agents: [agent] }));
  r.register(plugin({ id: 'b', name: 'B', tools: [tool('routes_brief')] }));
  assert.deepEqual(r.tools().map((t) => `${t.plugin.id}:${t.tool.name}`), ['a:variant_brief', 'b:routes_brief']);
  assert.deepEqual(r.skills().map((s) => s.skill.name), ['variant-rules']);
  assert.deepEqual(r.agents().map((a) => a.agent.name), ['make-previewable']);
  // Names stay apart: from the hub's tools and from other plugins'.
  assert.throws(() => r.register(plugin({ id: 'c', tools: [tool('variant_brief')] })), /same name as another tool/);
  assert.throws(() => r.register(plugin({ id: 'd', tools: [tool('overview')] })), /same name as another tool/);
  assert.throws(() => r.register(plugin({ id: 'e', agents: [agent] })), /agent "make-previewable" has the same name/);
  const check = (p: Partial<Plugin>) => checkPlugin(plugin(p), () => false);
  assert.match(check({ tools: [tool('Bad-Name')] })!, /underscores/);
  assert.match(check({ tools: [{ ...tool('x'), input: { project: { type: 'string', description: 'p' } } }] })!, /the shell adds that one/);
  assert.match(check({ tools: [{ ...tool('x'), input: { n: { type: 'date' as never, description: 'n' } } }] })!, /without a type/);
  assert.match(check({ skills: [{ name: 's', description: 'D', text: '' }] })!, /missing a description or its text/);
  assert.match(check({ agents: [{ ...agent, checker: { prompt: '' } }] })!, /checker's instructions/);
  assert.match(check({ agents: [{ ...agent, rounds: 5 }] })!, /1 to 3 times, not 5/);
});
