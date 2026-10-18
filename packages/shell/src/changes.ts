// What the map marks: cards a waiting proposal would change (yellow), and cards whose code changed outside review
// (blue: edited by hand, by a formatter, by git…). Changes made by approving a proposal don't count as outside.
// No VS Code APIs here, so it can be tested on its own.

import type { Disposable, Item } from '@visual-editor/contract';
import type { Proposal } from './proposals';

export type Mark = 'proposed' | 'changed';

/** How long after writing a file its change event still counts as ours. */
const OWN_WRITE_MS = 3000;

export class OutsideChanges {
  private readonly changed = new Map<string, Set<string>>();
  private readonly ownWrites = new Map<string, number>();
  private readonly listeners = new Set<() => void>();

  /** The shell is about to write this file (absolute path): its change event is not "outside review". */
  expectWrite(path: string) {
    this.ownWrites.set(path, Date.now() + OWN_WRITE_MS);
  }

  /** A file in a project changed. `path` is relative to `root`; `absolute` is the full path. */
  note(root: string, path: string, absolute: string) {
    const until = this.ownWrites.get(absolute);
    if (until !== undefined && until > Date.now()) return;
    this.ownWrites.delete(absolute);
    const set = this.changed.get(root) ?? new Set<string>();
    if (set.has(path)) return;
    set.add(path);
    this.changed.set(root, set);
    this.fire();
  }

  /** Files changed outside review in a project (relative paths). */
  get(root: string): ReadonlySet<string> {
    return this.changed.get(root) ?? new Set();
  }

  /** The developer has seen them: the blue marks go away. */
  clear(root: string) {
    if (this.changed.delete(root)) this.fire();
  }

  onChange(fn: () => void): Disposable {
    this.listeners.add(fn);
    return { dispose: () => this.listeners.delete(fn) };
  }

  private fire() {
    for (const fn of this.listeners) fn();
  }
}

/** The mark on each card: a waiting proposal wins over a change outside review. */
export function cardMarks(items: Item[], proposals: Proposal[], changed: ReadonlySet<string>): Record<string, Mark> {
  const waiting = proposals.filter((p) => p.status === 'proposed');
  const proposedPaths = new Set(waiting.flatMap((p) => p.changes.map((c) => c.path)));
  const proposedIds = new Set(waiting.flatMap((p) => p.items ?? []));
  const marks: Record<string, Mark> = {};
  for (const item of items) {
    const path = item.source?.path;
    if (proposedIds.has(item.id) || (path && proposedPaths.has(path))) marks[item.id] = 'proposed';
    else if (path && changed.has(path)) marks[item.id] = 'changed';
  }
  return marks;
}
