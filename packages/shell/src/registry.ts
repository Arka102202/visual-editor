// The plugins the shell knows about: added and removed at any time, checked before they're accepted.
// No VS Code APIs here, so it can be tested on its own.

import { CONTRACT_VERSION, type Disposable, type Plugin, type PluginAgent, type PluginSkill, type PluginTool } from '@visual-editor/contract';

/** The hub's own tools (hub/tools.ts): a plugin's tool can't take one of these names. */
export const HUB_TOOLS = ['overview', 'list_cards', 'card', 'memory', 'propose_change', 'proposal_status', 'remember'];
const TOOL_NAME = /^[a-z][a-z0-9_]{0,47}$/;
const NAME = /^[a-z][a-z0-9-]{0,47}$/;

export interface PluginProblem {
  /** The plugin's id or name, as far as it can be told. */
  plugin: string;
  /** What's wrong, in plain words, and what to do about it. */
  message: string;
}

/** Why a plugin can't be used, or undefined when it can. */
export function checkPlugin(plugin: Partial<Plugin> | undefined, taken: (id: string) => boolean, others: Plugin[] = []): string | undefined {
  if (!plugin || typeof plugin !== 'object') return 'It registered nothing usable.';
  if (!plugin.id || !/^[a-z][a-z0-9-]*$/.test(plugin.id)) return 'Its id must be short lowercase letters, digits and dashes, like "react".';
  if (!plugin.name) return 'It has no name to show.';
  if (typeof plugin.contract !== 'number') return 'It does not say which contract version it was built for.';
  if (plugin.contract !== CONTRACT_VERSION) {
    return plugin.contract < CONTRACT_VERSION
      ? `It was built for an older Visual Editor (contract ${plugin.contract}; this one speaks ${CONTRACT_VERSION}). Update the plugin.`
      : `It needs a newer Visual Editor (contract ${plugin.contract}; this one speaks ${CONTRACT_VERSION}). Update Visual Editor.`;
  }
  if (typeof plugin.detect !== 'function') return 'It has no detect() to say which projects it is for.';
  if (taken(plugin.id)) return `Another plugin already uses the id "${plugin.id}".`;
  for (const r of plugin.readers ?? []) {
    if (!r?.id || typeof r.wants !== 'function' || typeof r.read !== 'function') return 'One of its readers is missing an id, wants() or read().';
  }
  const panels = new Set<string>();
  for (const p of plugin.previewPanels ?? []) {
    if (!p?.id || !/^[a-z][a-z0-9-]*$/.test(p.id) || panels.has(p.id)) return 'Each of its Preview panels needs its own id: short lowercase letters, digits and dashes.';
    panels.add(p.id);
    if (!p.name || typeof p.icon !== 'string' || typeof p.page !== 'string' || typeof p.panel !== 'string') return `Its Preview panel "${p.id}" is missing a name, an icon, or its page or panel script.`;
  }
  return checkHelpers(plugin, others);
}

/** Its tools, skills and agents: well formed, and named apart from the hub's tools and every other plugin's. */
function checkHelpers(plugin: Partial<Plugin>, others: Plugin[]): string | undefined {
  const toolNames = new Set([...HUB_TOOLS, ...others.flatMap((o) => (o.tools ?? []).map((t) => t.name))]);
  for (const t of plugin.tools ?? []) {
    if (!t?.name || !TOOL_NAME.test(t.name)) return 'Each of its tools needs a name of lowercase letters, digits and underscores, like "variant_brief".';
    if (toolNames.has(t.name)) return `Its tool "${t.name}" has the same name as another tool.`;
    toolNames.add(t.name);
    if (!t.title || !t.description || typeof t.run !== 'function') return `Its tool "${t.name}" is missing a title, a description or run().`;
    for (const [name, input] of Object.entries(t.input ?? {})) {
      if (name === 'project') return `Its tool "${t.name}" can't have an input called "project": the shell adds that one.`;
      if (!input?.description || !['string', 'number', 'integer', 'boolean', 'strings'].includes(input.type)) return `Its tool "${t.name}" has an input "${name}" without a type or a description.`;
    }
  }
  // Skills and agents share one list in Claude Code (an agent comes with a skill of its name), next to the shell's own.
  const skillNames = new Set(['visual-editor', ...others.flatMap((o) => [...(o.skills ?? []), ...(o.agents ?? [])].map((s) => s.name))]);
  for (const s of plugin.skills ?? []) {
    if (!s?.name || !NAME.test(s.name)) return 'Each of its skills needs a name of lowercase letters, digits and dashes, like "variant-rules".';
    if (skillNames.has(s.name)) return `Its skill "${s.name}" has the same name as another skill or agent.`;
    skillNames.add(s.name);
    if (!s.description || !s.text) return `Its skill "${s.name}" is missing a description or its text.`;
  }
  for (const a of plugin.agents ?? []) {
    if (!a?.name || !NAME.test(a.name)) return 'Each of its agents needs a name of lowercase letters, digits and dashes, like "make-previewable".';
    if (skillNames.has(a.name)) return `Its agent "${a.name}" has the same name as another skill or agent.`;
    skillNames.add(a.name);
    if (!a.title || !a.description || !a.worker?.prompt || !a.checker?.prompt) return `Its agent "${a.name}" is missing a title, a description, or the worker's or checker's instructions.`;
    if (a.rounds !== undefined && (!Number.isInteger(a.rounds) || a.rounds < 1 || a.rounds > 3)) return `Its agent "${a.name}" can send work back 1 to 3 times, not ${a.rounds}.`;
  }
  return undefined;
}

export class PluginRegistry {
  private readonly plugins = new Map<string, Plugin>();
  private readonly listeners = new Set<() => void>();
  /** Plugins that were refused, kept to show the developer why. */
  readonly problems: PluginProblem[] = [];

  /** Adds a plugin. Throws with a readable message when it can't be used (and remembers the problem). */
  register(plugin: Plugin): Disposable {
    const why = checkPlugin(plugin, (id) => this.plugins.has(id), [...this.plugins.values()]);
    if (why) {
      const name = (plugin as Partial<Plugin> | undefined)?.name ?? (plugin as Partial<Plugin> | undefined)?.id ?? 'A plugin';
      this.problems.push({ plugin: name, message: why });
      this.changed();
      throw new Error(`${name} can't be used: ${why}`);
    }
    this.plugins.set(plugin.id, plugin);
    this.changed();
    return {
      dispose: () => {
        if (this.plugins.get(plugin.id) === plugin) {
          this.plugins.delete(plugin.id);
          this.changed();
        }
      },
    };
  }

  list(): Plugin[] {
    return [...this.plugins.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  get(id: string): Plugin | undefined {
    return this.plugins.get(id);
  }

  /** Every plugin's tools, skills and agents, each with its plugin. */
  tools(): { plugin: Plugin; tool: PluginTool }[] {
    return this.list().flatMap((plugin) => (plugin.tools ?? []).map((tool) => ({ plugin, tool })));
  }

  skills(): { plugin: Plugin; skill: PluginSkill }[] {
    return this.list().flatMap((plugin) => (plugin.skills ?? []).map((skill) => ({ plugin, skill })));
  }

  agents(): { plugin: Plugin; agent: PluginAgent }[] {
    return this.list().flatMap((plugin) => (plugin.agents ?? []).map((agent) => ({ plugin, agent })));
  }

  /** Called whenever plugins are added or removed, or one is refused. */
  onChange(fn: () => void): Disposable {
    this.listeners.add(fn);
    return { dispose: () => this.listeners.delete(fn) };
  }

  private changed() {
    for (const fn of this.listeners) fn();
  }
}
