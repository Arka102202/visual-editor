// What the shell and the Agents section say to each other. Shared by both sides, so they can't drift apart.

/** One thing an assistant gets from Visual Editor: an agent (does a job), a skill (know-how it reads) or a tool. */
export interface AgentsEntry {
  kind: 'agent' | 'skill' | 'tool';
  /** Its name (an agent's, to run it). */
  name: string;
  title: string;
  /** What it does, in very simple words, for the developer. */
  summary: string;
  /** What Claude Code calls it. */
  claudeName: string;
  /** An agent's latest job: working now (it can be stopped), or how it ended. */
  job?: { id: string; status: string; round: number; rounds: number; request: string; running: boolean; progress?: string; by: string };
  /** An agent's last jobs that ended, newest first, with what happened and the proof. */
  recent?: JobResult[];
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
  /** Run an agent from its button: in the background or in a terminal. */
  | { type: 'run'; agent: string; way: 'background' | 'terminal' }
  /** Watch a running job: its log (in the background) or its terminal. */
  | { type: 'watch'; job: string }
  /** Open a job's proposal in Review. */
  | { type: 'review'; proposal: string };
