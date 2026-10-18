// Which project the developer is looking at. With several projects open, one is shown at a time; the choice is
// remembered. When the chosen one disappears, the first project a plugin understands is shown instead.
// No VS Code APIs here, so it can be tested on its own.

import type { Disposable } from '@visual-editor/contract';
import type { ProjectState } from './projectIndex';

export interface Memory {
  get(): string | undefined;
  set(root: string | undefined): void;
}

export class CurrentProject {
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly projects: () => ProjectState[],
    private readonly memory: Memory,
  ) {}

  /** The project shown now, or undefined when there are none. */
  get(): ProjectState | undefined {
    const all = this.projects();
    const chosen = this.memory.get();
    return all.find((p) => p.project.root === chosen) ?? all.find((p) => p.detected.length) ?? all[0];
  }

  choose(root: string) {
    if (this.memory.get() === root) return;
    this.memory.set(root);
    for (const fn of this.listeners) fn();
  }

  onChange(fn: () => void): Disposable {
    this.listeners.add(fn);
    return { dispose: () => this.listeners.delete(fn) };
  }
}
