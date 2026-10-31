// What the shell and a design session's tab say to each other. Shared by both sides, so they can't drift apart.

import type { PlanChoice, PlanView } from './ui/planWindow';
import type { ProgressLine } from './ui/progress';

/** A card the session can show: its designs and states (for one state at a time). */
export interface SessionCard {
  id: string;
  label: string;
  designs: { id: string; name: string; inUse: boolean }[];
  states: string[];
}

export interface SessionView {
  id: string;
  title: string;
  /** The proposal it continues (Done puts the result back into it). */
  proposal?: string;
  /** Claude works in this session now (the one looked at last, or chosen with "Work here"). */
  current?: boolean;
  /** Claude is told about open sessions by itself (connected, with Visual Editor's hooks): no line to copy. */
  told?: boolean;
  /** Its kind ("New page"…), and the page it makes, if a page. */
  kind?: string;
  page?: string;
  /** What the developer asked for, in their words, oldest first. */
  asked: string[];
  /** The draft's version now, and the ones it can go back to (newest first). */
  revision: number;
  versions: { revision: number; at: string; files: number }[];
  /** The cards it can show (the session's own first, then any its changes touch). */
  cards: SessionCard[];
  /** The draft's app (its address), once running; or how starting it goes, or why it can't. */
  app?: string;
  progress?: string;
  error?: string;
  /** Where it stands: being worked on, being checked (Done), in Review, or held back (with why). */
  status: { kind: 'open' } | { kind: 'planning' } | { kind: 'ready' } | { kind: 'checking'; text: string } | { kind: 'sent'; proposal: string } | { kind: 'held'; text: string } | { kind: 'discarded'; at: string };
  /** Its test cases, when they're ready to run (the window opens by itself once per plan). */
  plan?: PlanView;
  /** While its checks run: each check and scenario, and where it is. */
  running?: ProgressLine[];
  /** When held back: the checks that failed (to fix, or bypass), and when that check ended (the window opens once per check). */
  failed?: { title: string; why: string }[];
  checkedAt?: string;
}

/** Shell → session tab. */
export type ToSession = { type: 'show'; session: SessionView };

/** Session tab → shell. */
export type FromSession =
  | { type: 'ready' }
  | { type: 'back'; revision: number }
  | { type: 'done' }
  | { type: 'discard' }
  /** Copy a line for the developer's Claude Code chat: which draft to work in, and how. */
  | { type: 'copyForClaude' }
  /** Checks failed and the developer lets it go anyway: those checks (by title) bypassed, with why. */
  | { type: 'bypass'; titles: string[]; reason: string }
  /** The developer ran the test cases, as they left them. */
  | { type: 'run'; choice: PlanChoice }
  | { type: 'openReview'; proposal: string }
  /** Make this the session Claude works in. */
  | { type: 'workHere' };
