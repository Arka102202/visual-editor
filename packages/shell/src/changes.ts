// What the map marks: cards a waiting proposal would change (yellow), and cards whose code changed outside review
// (blue: edited by hand, by a formatter, by git…). Changes made by approving a proposal don't count as outside.
// No VS Code APIs here, so it can be tested on its own.

import type { Disposable, Item } from '@visual-editor/contract';
import type { Proposal } from './proposals';

export type Mark = 'proposed' | 'changed';

/** How long after writing a file its change event still counts as ours. */
const OWN_WRITE_MS = 3000;

/** A file created and deleted within this long came and went (a tool's temporary file). */
const CAME_AND_WENT_MS = 5000;

export class OutsideChanges {
  /** When files were created (outside review), to tell a temporary file (created, then deleted at once) from a change. */
  private readonly born = new Map<string, number>();
  private readonly changed = new Map<string, Set<string>>();
  private readonly ownWrites = new Map<string, number>();
  private readonly listeners = new Set<() => void>();

  /** The shell is about to write this file (absolute path): its change event is not "outside review". */
  expectWrite(path: string) {
    this.ownWrites.set(path, Date.now() + OWN_WRITE_MS);
  }

  /** A file in a project changed. `path` is relative to `root`; `absolute` is the full path. */
  note(root: string, path: string, absolute: string, how: 'created' | 'changed' | 'deleted' = 'changed') {
    // Visual Editor's own files (fakes, contracts) aren't changes to the app's code.
    if (isVisualEditorFile(path)) return;
    const until = this.ownWrites.get(absolute);
    if (until !== undefined && until > Date.now()) return;
    this.ownWrites.delete(absolute);
    const set = this.changed.get(root) ?? new Set<string>();
    // A file that came and went (a tool saving through a temporary file, like sed -i): not a change to the code.
    const born = this.born.get(absolute);
    if (how === 'deleted' && born !== undefined && Date.now() - born < CAME_AND_WENT_MS) {
      this.born.delete(absolute);
      if (set.delete(path)) this.fire();
      return;
    }
    if (how === 'created' && !set.has(path)) this.born.set(absolute, Date.now());
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

/** Files that are Visual Editor's: .visual-editor/ (fakes, contracts…). */
export function isVisualEditorFile(path: string): boolean {
  return /(^|[\\/])\.visual-editor[\\/]/.test(path);
}

/**
 * The mark on each card: a change not decided yet (waiting for an OK, for its test cases to run, or held back) wins
 * over a change outside review.
 */
export function cardMarks(items: Item[], proposals: Proposal[], changed: ReadonlySet<string>): Record<string, Mark> {
  const waiting = proposals.filter((p) => p.status === 'proposed' || p.status === 'awaiting-checks' || p.status === 'held-back');
  const proposedPaths = new Set(waiting.flatMap((p) => p.changes.map((c) => c.path)));
  const proposedIds = new Set(waiting.flatMap((p) => p.items ?? []));
  const marks: Record<string, Mark> = {};
  for (const item of items) {
    // Its own file, and the others that belong to it (a previewable folder's switcher, variants, data…).
    const paths = [item.source?.path, ...(item.preview?.files ?? [])].filter((p): p is string => !!p);
    if (proposedIds.has(item.id) || paths.some((p) => proposedPaths.has(p))) marks[item.id] = 'proposed';
    else if (paths.some((p) => changed.has(p))) marks[item.id] = 'changed';
  }
  return marks;
}
