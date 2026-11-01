// What the shell and the Agents section say to each other. Shared by both sides, so they can't drift apart.

/**
 * One thing Claude gets from Visual Editor: an agent (does a job), a skill (know-how it reads), a tool, or a helper
 * (Claude run by Visual Editor itself for one small job: the check planner, the tester, the clean-up helper).
 */
export interface AgentsEntry {
  kind: 'agent' | 'skill' | 'tool' | 'helper';
  /** Its name (an agent's, to run it). */
  name: string;
  title: string;
  /** What it does, in very simple words, for the developer. */
  summary: string;
  /** What Claude Code calls it. */
  claudeName: string;
  /** An agent's jobs at work now, or waiting their turn, newest first: each its own row (Watch, Stop). */
  jobs?: LiveJob[];
  /** Why it can't be started now, in plain words (the project needs setting up first). */
  blocked?: string;
  /** An agent with nothing to do in the project (what it makes is there already): why. Its buttons are off. */
  done?: string;
  /** An agent's last jobs that ended, newest first, with what happened and the proof. */
  recent?: JobResult[];
}

/** A job at work (or waiting its turn), as the Agents section shows it. */
export interface LiveJob {
  id: string;
  status: string;
  round: number;
  rounds: number;
  request: string;
  by: string;
  /** What it's doing now, in words (or its place in the line). */
  progress?: string;
}

/** A finished job, as the Agents section shows it. */
export interface JobResult {
  id: string;
  status: string;
  request: string;
  round: number;
  rounds: number;
  /** When it started. */
  at: string;
  by: string;
  /** What happened, oldest first (hand-ins, verdicts with reasons, stops). */
  steps: { who: string; what: string }[];
  /** The proposal it became, and its proof (✓ passed, ✗ didn't, • a note, ▣ a picture). */
  proposal?: string;
  /** What the developer did with it in Review, in words ("waiting for you", "approved"…). */
  inReview?: string;
  proof?: { mark: string; title: string }[];
  /** Stopped (or out of time) before it finished: it can be resumed where it was. */
  resumable?: boolean;
}

/** Shell → Agents section. */
export interface ToAgents {
  type: 'show';
  /** When Claude Code can't use them yet, and the one thing to do about it. */
  status?: { text: string; tip: string; action: 'connect' | 'addAgents' };
  /** Visual Editor's own first, then each plugin's. */
  groups: { name: string; items: AgentsEntry[] }[];
}

/** Agents section → shell. */
export type FromAgents =
  | { type: 'ready' }
  | { type: 'connect' }
  | { type: 'addAgents' }
  | { type: 'stop'; job: string }
  /** Carry on a stopped job where it was. */
  | { type: 'resume'; job: string }
  /** Run an agent from its button: in the background or in a terminal. */
  | { type: 'run'; agent: string; way: 'background' | 'terminal' }
  /** Watch a running job: its log (in the background) or its terminal. */
  | { type: 'watch'; job: string }
  /** Open a job's proposal in Review. */
  | { type: 'review'; proposal: string };
