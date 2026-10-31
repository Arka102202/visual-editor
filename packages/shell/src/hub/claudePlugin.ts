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
const READING = ['overview', 'list_cards', 'card', 'memory', 'read_draft'];
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
      { name: `${agent.name}-worker`, description: `The worker of “${agent.title}”: makes the draft. Run it through the ${agent.name} skill, not on its own.`, tools: toolsOf(agent.worker, toolNames, 'worker') },
      made(plugin),
      `${WORKER}\n\n## ${agent.title}\n\n${agent.worker.prompt.trim()}`,
    ));
    at(`agents/${agent.name}-checker.md`, page(
      { name: `${agent.name}-checker`, description: `The checker of “${agent.title}”: proves the worker’s draft or sends it back. Run it through the ${agent.name} skill, not on its own.`, tools: toolsOf(agent.checker, toolNames, 'checker') },
      made(plugin),
      `${CHECKER}\n\n## ${agent.title}\n\n${agent.checker.prompt.trim()}`,
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
  const worker = `\`${CLAUDE_PLUGIN}:${agent.name}-worker\``;
  const checker = `\`${CLAUDE_PLUGIN}:${agent.name}-checker\``;
  return `# ${agent.title}

${agent.description}

Visual Editor runs this as a job: a worker makes a draft, a checker proves it or sends it back, at most ${rounds} round${rounds === 1 ? '' : 's'}.
Visual Editor keeps the rounds, the time limit and the developer's Stop. Follow these steps exactly:

1. Call \`job_start\` with agent "${agent.name}" and the developer's request in their own words. It gives a job id.
2. Run the worker ${worker} with the Agent tool. Tell it the job id and the request (from round 2, also the checker's
   reasons, from \`job_status\`).
3. Call \`job_status\`. When it says to run the checker, run ${checker} with the job id and the request.
4. Call \`job_status\` again and do what its "Next" says: run the worker again with the reasons, or stop.
   Repeat until it says the job passed, failed, was stopped or ran out of time.
5. Tell the developer in plain words: what was made, the proof, and the proposal waiting in Review; or why it stopped.

Never edit files yourself, and never do the worker's job yourself when it fails: say what happened.
`;
}

/** What every worker is told first (its own instructions follow). */
const WORKER = `You are the worker of a Visual Editor job: you are given a job id and a request (after the first round, also the
checker's reasons, which you must fix).
- Make the change as a draft with \`save_draft\` (to change your draft, pass its id). Never edit files.
- Check it yourself first with the plugin check tools, passing the draft, and fix what they find.
- Then hand it in with \`job_hand_in\` (job, draft, a note) and end your answer with what you did, in plain words.
- If a job tool says the job was stopped or ran out of time, stop at once.`;

/** What every checker is told first (its own instructions follow). */
const CHECKER = `You are the checker of a Visual Editor job: you are given a job id. Read the job (\`job_status\`) and its draft
(\`read_draft\`). Never edit files, and never change the draft: your job is to prove it or send it back.
- Prove it does what was asked and follows the rules: run the plugin check tools with the draft (their answers are kept
  as proof for Review), and look for yourself.
- Then give your verdict with \`job_verdict\`: passed (only with proof that passed on this version) or sent back with
  specific reasons the worker can act on. End your answer with your verdict and why.
- If a job tool says the job was stopped or ran out of time, stop at once.`;

/** The tools each role always has, and the ones it never gets (so neither can skip the other). */
const ROLE_TOOLS = { worker: ['save_draft', 'read_draft', 'job_status', 'job_hand_in'], checker: ['read_draft', 'add_evidence', 'job_status', 'job_verdict'] };
const NEVER = { worker: ['job_verdict', 'submit_draft', 'propose_change', 'start_session', 'continue_proposal', 'open_session'], checker: ['save_draft', 'job_hand_in', 'submit_draft', 'propose_change', 'start_session', 'continue_proposal', 'open_session'] };

/**
 * A part's tools in Claude Code's names: its own (the hub's reading tools when it says none), plus what its role always
 * needs; tools that change files, or that would skip the other role, are left out. The hub's and plugins' get the MCP
 * prefix.
 */
function toolsOf(part: AgentPart, hub: Set<string>, role: 'worker' | 'checker'): string {
  const names = [...new Set([...(part.tools ?? [...READING, 'Read', 'Grep', 'Glob']), ...ROLE_TOOLS[role]])];
  return names.filter((n) => !CHANGING.has(n) && !NEVER[role].includes(n)).map((n) => (hub.has(n) ? mcp(n) : n)).join(', ');
}

const made = (plugin: Plugin) => `Made by the Visual Editor VS Code extension from its ${plugin.name} plugin.`;

/** A Markdown file with frontmatter, and a note that it's made (and replaced) by the extension. */
function page(front: Record<string, string>, note: string, body: string): string {
  // Quoted the JSON way, which YAML reads too, so a colon or a quote in a description can't break it.
  const head = Object.entries(front).map(([k, v]) => `${k}: ${JSON.stringify(v.replace(/\s*\n\s*/g, ' ').trim())}`).join('\n');
  return `---\n${head}\n---\n\n<!-- ${note} Changes here are replaced when it updates. -->\n\n${body.trim()}\n`;
}

const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;
