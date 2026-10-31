// What the shell and the clean-up window say to each other. Shared by both sides, so they can't drift apart.

/** A session the clean-up helper suggests deleting, with why. */
export interface CleanupRow {
  id: string;
  title: string;
  /** Where it stands or how it ended, and when it last changed, in words. */
  state: string;
  why: string;
}

/** Shell → clean-up window. */
export type ToCleanup = { type: 'show'; rows: CleanupRow[] };

/** Clean-up window → shell. */
export type FromCleanup = { type: 'ready' } | { type: 'delete'; ids: string[] } | { type: 'open'; id: string } | { type: 'close' };
