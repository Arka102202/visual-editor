// What the shell and the review page say to each other. Shared by both sides, so they can't drift apart.

import type { Hunk } from './diff';
import type { Evidence, Proposal } from './proposals';
import type { PlanChoice, PlanView } from './ui/planWindow';
import type { ProgressLine } from './ui/progress';

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
  /** What the developer asked for, in their words (the logic check held the change to it). */
  asked?: string[];
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
  /** The developer's own cases being checked now (or why they couldn't be). */
  checking?: { progress?: string; error?: string };
  /** Its pictures shown live (the Playground running, by card id): starting, running at `url`, or why not. */
  live?: Record<string, { url?: string; progress?: string; error?: string }>;
  /** It's being changed in a design session now. */
  inSession?: boolean;
  /** Held back: the checks that failed (to fix, or bypass). */
  failed?: { title: string; why: string }[];
  /** Held back: its test cases can be run again as they are (they were written for this version), or are running now. */
  rerun?: { can: boolean; running?: string; view?: PlanView; items?: ProgressLine[] };
  /** Waiting for its checks: its test cases being written, ready for the developer, or running (the step it's on). */
  plan?: { state: 'writing' | 'ready' | 'running'; step?: string; view?: PlanView; items?: ProgressLine[] };
  /** Applied or undone: the summaries of the cards it touched, being written (each card, and where it is). */
  summaries?: { items: ProgressLine[]; ended: boolean; error?: string };
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
  /** Open the window to bypass this held-back change's failed checks (its checks just ended). */
  askBypass?: string;
  /** Open the window with this change's test cases (they're ready). */
  askPlan?: string;
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
  | { type: 'unlive'; id: string; card: string }
  /** The developer's own cases, for the logic check to try on this change. */
  | { type: 'cases'; id: string; cases: string[] }
  /** Keep changing it in a design session (or open the one changing it now). */
  | { type: 'session'; id: string }
  /** The developer says this broken case (its place in the logic check's report) is wrong. */
  | { type: 'overrule'; id: string; index: number }
  /** The developer lets a held-back change go with these checks (by title) failed, with why. */
  | { type: 'bypass'; id: string; titles: string[]; reason: string }
  /** The developer ran a change's test cases, as they left them. */
  | { type: 'runPlan'; id: string; choice: PlanChoice }
  /** Run a held-back change's test cases again, as they are. */
  | { type: 'rerun'; id: string }
  /** Have new test cases written for a change (the planner), to look at and run. */
  | { type: 'replan'; id: string };
