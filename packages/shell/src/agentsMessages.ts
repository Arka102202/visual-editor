// What the shell and the Agents section say to each other. Shared by both sides, so they can't drift apart.

/** One thing an assistant gets from Visual Editor: an agent (does a job), a skill (know-how it reads) or a tool. */
export interface AgentsEntry {
  kind: 'agent' | 'skill' | 'tool';
  title: string;
  /** What it does, in very simple words, for the developer. */
  summary: string;
  /** What Claude Code calls it. */
  claudeName: string;
  /** An agent's latest job: working now (it can be stopped), or how it ended. */
  job?: { id: string; status: string; round: number; rounds: number; request: string; running: boolean };
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
export type FromAgents = { type: 'ready' } | { type: 'connect' } | { type: 'addAgents' } | { type: 'stop'; job: string };
