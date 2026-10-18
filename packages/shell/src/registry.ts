// The plugins the shell knows about: added and removed at any time, checked before they're accepted.
// No VS Code APIs here, so it can be tested on its own.

import { CONTRACT_VERSION, type Disposable, type Plugin } from '@visual-editor/contract';

export interface PluginProblem {
  /** The plugin's id or name, as far as it can be told. */
  plugin: string;
  /** What's wrong, in plain words, and what to do about it. */
  message: string;
}

/** Why a plugin can't be used, or undefined when it can. */
export function checkPlugin(plugin: Partial<Plugin> | undefined, taken: (id: string) => boolean): string | undefined {
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
  for (const p of plugin.previews ?? []) {
    if (!p?.id || typeof p.wants !== 'function' || typeof p.render !== 'function') return 'One of its previews is missing an id, wants() or render().';
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
    const why = checkPlugin(plugin, (id) => this.plugins.has(id));
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

  /** Called whenever plugins are added or removed, or one is refused. */
  onChange(fn: () => void): Disposable {
    this.listeners.add(fn);
    return { dispose: () => this.listeners.delete(fn) };
  }

  private changed() {
    for (const fn of this.listeners) fn();
  }
}
