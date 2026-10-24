// Visual Editor's Claude Code plugin, made from what every installed plugin gives assistants (contract 8): the shell's
// own skill (how to use the map tools), each plugin's skills, and for each plugin agent a worker, a checker and the
// skill that runs them in turn. Written as a one-plugin marketplace in VS Code's storage (never in the project) and
// installed per project (`claude plugin install … -s local`). Claude Code sees them as "visual-editor:<name>".
// Pure: parts in, files out.

import { createHash } from 'node:crypto';
import type { AgentPart, Plugin, PluginAgent, PluginSkill, PluginTool } from '@visual-editor/contract';
import { INSTRUCTIONS, SERVER_NAME } from './tools';
import { HUB_TOOLS } from '../registry';

/** The plugin's name in Claude Code (its skills and agents are "visual-editor:…"). */
export const CLAUDE_PLUGIN = 'visual-editor';

export interface ClaudeParts {
  tools: { plugin: Plugin; tool: PluginTool }[];
  skills: { plugin: Plugin; skill: PluginSkill }[];
  agents: { plugin: Plugin; agent: PluginAgent }[];
}

/** What the hub's tools are called in Claude Code. */
const mcp = (tool: string) => `mcp__${SERVER_NAME}__${tool}`;
/** The hub's tools that only read, for parts that don't say which tools they use. */
const READING = ['overview', 'list_cards', 'card', 'memory'];
/** Claude Code's own tools that change files: never given (changes reach the developer only as proposals). */
const CHANGING = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/** Every file of the marketplace, by path inside its folder. `marketplace` is its name in Claude Code. */
export function claudePluginFiles(parts: ClaudeParts, version: string, marketplace: string): Record<string, string> {
  const files: Record<string, string> = {};
  const at = (path: string, text: string) => (files[`${CLAUDE_PLUGIN}/${path}`] = text);
  const from = [...new Set([...parts.skills, ...parts.agents].map((p) => p.plugin.name))];
  files['.claude-plugin/marketplace.json'] = json({
    name: marketplace,
    owner: { name: 'Visual Editor' },
    description: 'Made by the Visual Editor VS Code extension for this computer.',
    plugins: [{ name: CLAUDE_PLUGIN, source: `./${CLAUDE_PLUGIN}`, description: 'Visual Editor’s agents and know-how' }],
  });
  at('.claude-plugin/plugin.json', json({
    name: CLAUDE_PLUGIN,
    version,
    author: { name: 'Visual Editor' },
    description: `Visual Editor’s agents and know-how${from.length ? ` (from ${from.join(', ')})` : ''}. Kept up to date by the Visual Editor VS Code extension.`,
  }));
  at('skills/visual-editor/SKILL.md', mapSkill(parts.tools));
  for (const { plugin, skill } of parts.skills) at(`skills/${skill.name}/SKILL.md`, page({ name: skill.name, description: skill.description }, made(plugin), skill.text));
  const toolNames = new Set([...HUB_TOOLS, ...parts.tools.map((t) => t.tool.name)]);
  for (const { plugin, agent } of parts.agents) {
    const rounds = agent.rounds ?? 3;
    at(`skills/${agent.name}/SKILL.md`, page({ name: agent.name, description: `${agent.description} (Runs a worker, then a checker that proves the work.)` }, made(plugin), runSkill(agent, rounds)));
    at(`agents/${agent.name}-worker.md`, page(
      { name: `${agent.name}-worker`, description: `The worker of “${agent.title}”: makes the draft. Run it through the ${agent.name} skill, not on its own.`, tools: toolsOf(agent.worker, toolNames) },
      made(plugin),
      `${agent.worker.prompt.trim()}\n\nNever edit files yourself. End with your draft and what you did, in plain words.`,
    ));
    at(`agents/${agent.name}-checker.md`, page(
      { name: `${agent.name}-checker`, description: `The checker of “${agent.title}”: proves the worker’s draft or sends it back. Run it through the ${agent.name} skill, not on its own.`, tools: toolsOf(agent.checker, toolNames) },
      made(plugin),
      `${agent.checker.prompt.trim()}\n\nNever edit files yourself. Start your answer with PASSED (then the proof) or SENT BACK (then each reason, so the worker can fix it).`,
    ));
  }
  return files;
}

/** Changes whenever the files would (the version aside): a new key means a new version for Claude Code to update to. */
export function claudePluginKey(parts: ClaudeParts): string {
  const files = claudePluginFiles(parts, '0', '');
  return createHash('sha256').update(JSON.stringify(Object.entries(files).sort())).digest('hex').slice(0, 16);
}

function mapSkill(tools: ClaudeParts['tools']): string {
  const lines = tools.map(({ plugin, tool }) => `- \`${tool.name}\` (${plugin.name}): ${tool.description}`);
  return page(
    {
      name: 'visual-editor',
      description:
        'Use first, before searching or reading files, for anything about this project’s code: which components, pages, routes, API calls and data exist and how they connect, the project’s rules, and before changing anything (every change goes to the developer’s Review through propose_change).',
    },
    'Made by the Visual Editor VS Code extension.',
    `# Visual Editor\n\n${INSTRUCTIONS}\n${lines.length ? `\nTools from Visual Editor’s plugins:\n${lines.join('\n')}\n` : ''}`,
  );
}

function runSkill(agent: PluginAgent, rounds: number): string {
  return `# ${agent.title}

${agent.description}

This job has two parts. Run them with the Agent tool, one after the other:
1. The worker, \`${CLAUDE_PLUGIN}:${agent.name}-worker\`: give it the developer’s request (and, after the first round, the
   checker’s reasons). It answers with a draft.
2. The checker, \`${CLAUDE_PLUGIN}:${agent.name}-checker\`: give it the request and the worker’s whole answer. It answers
   PASSED with its proof, or SENT BACK with its reasons.

When it's sent back, run the worker again with the reasons, then the checker: ${rounds === 1 ? 'only once in all' : `at most ${rounds} times in all`}.
Then tell the developer, in plain words, what was done and the proof, or why it stopped.
Never edit files yourself: changes reach the developer only as proposals in Review.
`;
}

/** A part's tools in Claude Code's names: the hub's and plugins' get the MCP prefix; tools that change files are left out. */
function toolsOf(part: AgentPart, hub: Set<string>): string {
  const names = part.tools ?? [...READING, 'Read', 'Grep', 'Glob'];
  return names.filter((n) => !CHANGING.has(n)).map((n) => (hub.has(n) ? mcp(n) : n)).join(', ');
}

const made = (plugin: Plugin) => `Made by the Visual Editor VS Code extension from its ${plugin.name} plugin.`;

/** A Markdown file with frontmatter, and a note that it's made (and replaced) by the extension. */
function page(front: Record<string, string>, note: string, body: string): string {
  // Quoted the JSON way, which YAML reads too, so a colon or a quote in a description can't break it.
  const head = Object.entries(front).map(([k, v]) => `${k}: ${JSON.stringify(v.replace(/\s*\n\s*/g, ' ').trim())}`).join('\n');
  return `---\n${head}\n---\n\n<!-- ${note} Changes here are replaced when it updates. -->\n\n${body.trim()}\n`;
}

const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;
