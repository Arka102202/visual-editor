import assert from 'node:assert/strict';
import test from 'node:test';
import { CONTRACT_VERSION, type Plugin, type PluginAgent } from '@visual-editor/contract';
import { claudePluginFiles, claudePluginKey, type ClaudeParts } from '../src/hub/claudePlugin';

const react: Plugin = { id: 'react', name: 'React', version: '0', contract: CONTRACT_VERSION, detect: () => undefined };
const agent: PluginAgent = {
  name: 'make-previewable',
  title: 'Make previewable',
  description: 'Splits a component into its two parts: "dynamic" and static.',
  worker: { prompt: 'Split it.', tools: ['variant_brief', 'card', 'Read', 'Edit', 'Write'] },
  checker: { prompt: 'Prove it.' },
};
const parts: ClaudeParts = {
  tools: [{ plugin: react, tool: { name: 'variant_brief', title: 'Brief', description: 'Everything about a card for a job.', run: () => '' } }],
  skills: [{ plugin: react, skill: { name: 'variant-rules', description: 'The rules: one folder per component.', text: '# Rules\n\nOne folder.' } }],
  agents: [{ plugin: react, agent }],
};

/** A Markdown file's frontmatter, read the way Claude Code does (each value must be valid). */
function front(text: string): Record<string, string> {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  assert.ok(m, 'has frontmatter');
  return Object.fromEntries(m[1].split('\n').map((l) => [l.slice(0, l.indexOf(':')), JSON.parse(l.slice(l.indexOf(':') + 1))]));
}

test('claude plugin: a one-plugin marketplace with the map skill, plugins’ skills, and each agent as worker, checker and the skill that runs them', () => {
  const files = claudePluginFiles(parts, '1.0.4', 'visual-editor');
  assert.deepEqual(Object.keys(files).sort(), [
    '.claude-plugin/marketplace.json',
    'visual-editor/.claude-plugin/plugin.json',
    'visual-editor/agents/make-previewable-checker.md',
    'visual-editor/agents/make-previewable-worker.md',
    'visual-editor/skills/make-previewable/SKILL.md',
    'visual-editor/skills/variant-rules/SKILL.md',
    'visual-editor/skills/visual-editor/SKILL.md',
  ]);
  const market = JSON.parse(files['.claude-plugin/marketplace.json']);
  assert.equal(market.name, 'visual-editor');
  assert.deepEqual(market.plugins.map((p: { name: string; source: string }) => [p.name, p.source]), [['visual-editor', './visual-editor']]);
  const manifest = JSON.parse(files['visual-editor/.claude-plugin/plugin.json']);
  assert.equal(manifest.version, '1.0.4');
  assert.match(manifest.description, /from React/);

  // The shell's own skill: the map tools first, plugins' tools listed.
  const map = files['visual-editor/skills/visual-editor/SKILL.md'];
  assert.equal(front(map).name, 'visual-editor');
  assert.match(front(map).description, /^Use first/);
  assert.match(map, /NEVER edit files directly/);
  assert.match(map, /- `variant_brief` \(React\): Everything about a card for a job\./);

  const rules = files['visual-editor/skills/variant-rules/SKILL.md'];
  assert.deepEqual(front(rules), { name: 'variant-rules', description: 'The rules: one folder per component.' }, 'a colon in a description stays readable');
  assert.match(rules, /from its React plugin.*replaced when it updates/);
  assert.match(rules, /# Rules\n\nOne folder\.\n$/);

  // The agent: a skill that runs worker then checker, at most 3 rounds.
  const run = files['visual-editor/skills/make-previewable/SKILL.md'];
  assert.equal(front(run).description, 'Splits a component into its two parts: "dynamic" and static. (Runs a worker, then a checker that proves the work.)');
  assert.match(run, /`visual-editor:make-previewable-worker`/);
  assert.match(run, /`visual-editor:make-previewable-checker`/);
  assert.match(run, /at most 3 times in all/);

  // Tools: the hub's and plugins' in Claude Code's names; tools that change files never given; reading tools by default.
  const worker = files['visual-editor/agents/make-previewable-worker.md'];
  assert.equal(front(worker).name, 'make-previewable-worker');
  assert.equal(front(worker).tools, 'mcp__visual-editor__variant_brief, mcp__visual-editor__card, Read');
  assert.match(worker, /Split it\.\n\nNever edit files yourself\./);
  const checker = files['visual-editor/agents/make-previewable-checker.md'];
  assert.equal(front(checker).tools, 'mcp__visual-editor__overview, mcp__visual-editor__list_cards, mcp__visual-editor__card, mcp__visual-editor__memory, Read, Grep, Glob');
  assert.match(checker, /Start your answer with PASSED \(then the proof\) or SENT BACK/);
});

test('claude plugin: a new version only when what plugins give changes', () => {
  const key = claudePluginKey(parts);
  assert.equal(claudePluginKey({ ...parts }), key);
  assert.notEqual(claudePluginKey({ ...parts, agents: [{ plugin: react, agent: { ...agent, checker: { prompt: 'Prove it twice.' } } }] }), key);
  assert.notEqual(claudePluginKey({ ...parts, skills: [] }), key);
  assert.match(claudePluginFiles({ tools: [], skills: [], agents: [{ plugin: react, agent: { ...agent, rounds: 1 } }] }, '1', 'm')['visual-editor/skills/make-previewable/SKILL.md'], /only once in all/);
});
