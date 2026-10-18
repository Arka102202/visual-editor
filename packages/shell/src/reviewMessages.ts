// What the shell and the review page say to each other. Shared by both sides, so they can't drift apart.

import type { Hunk } from './diff';
import type { Proposal } from './proposals';

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
  /** Cards it touches that can be previewed (Before and After). */
  previews: { id: string; label: string }[];
}

/** Shell → review page. */
export type ToReview = {
  type: 'show';
  project?: string;
  items: ReviewItem[];
  selected?: string;
  /** Proposal files that couldn't be read, with the reason. */
  problems: { file: string; message: string }[];
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
  | { type: 'preview'; id: string; item: string }
  | { type: 'open'; path: string; line?: number };
