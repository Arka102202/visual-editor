// What the shell and the review page say to each other. Shared by both sides, so they can't drift apart.

import type { Hunk } from './diff';
import type { Evidence, Proposal } from './proposals';

export interface ReviewFile {
  path: string;
  kind: 'new' | 'changed' | 'removed';
  added: number;
  removed: number;
  hunks: Hunk[];
}

export interface ReviewItem {
  id: string;
  title: string;
  why?: string;
  by: Proposal['by'];
  createdAt: string;
  status: Proposal['status'];
  history: Proposal['history'];
  files: ReviewFile[];
  /** Why it can't be applied (or undone) as it stands. */
  conflicts: string[];
  /** A page at the app's address showing how it looks, before and after. */
  look?: string;
  /** Its proof, when it came from a draft (empty: nothing was checked); a picture's `src` is its address in the page. */
  evidence?: (Evidence & { src?: string })[];
  /** Cards that can be shown in the Playground whose files it changes (each can be tried live). */
  cards?: { id: string; label: string }[];
  /** Its pictures shown live (the Playground running, by card id): starting, running at `url`, or why not. */
  live?: Record<string, { url?: string; progress?: string; error?: string }>;
}

/** Shell → review page. */
export type ToReview = {
  type: 'show';
  project?: string;
  items: ReviewItem[];
  selected?: string;
  /** Proposal files that couldn't be read, with the reason. */
  problems: { file: string; message: string }[];
  /** The app (its dev server, through the proxy), for proposals that show how they look. */
  app?: { url?: string; progress?: string; error?: string };
};

/** Review page → shell. */
export type FromReview =
  | { type: 'ready' }
  /** Make an example proposal, to try review. */
  | { type: 'try' }
  | { type: 'select'; id: string }
  | { type: 'approve'; id: string }
  | { type: 'sendBack'; id: string }
  | { type: 'reject'; id: string }
  | { type: 'undo'; id: string }
  | { type: 'open'; path: string; line?: number }
  /** Start the app again, to show how a proposal looks. */
  | { type: 'app' }
  /** Show a picture in its proof live (the card's Playground, running), or the picture again. */
  | { type: 'live'; id: string; card: string }
  | { type: 'unlive'; id: string; card: string };
