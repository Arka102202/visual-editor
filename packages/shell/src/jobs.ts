// Jobs: an agent at work, kept by Visual Editor so its rules hold however it was started (chat, a button, a terminal).
// The worker makes a draft and hands it in; the checker proves it (the draft's proof for its current version must have
// passed) or sends it back with reasons; at most `rounds` rounds, within a time limit, and it can be stopped at any
// moment. A draft that passes goes to Review. Each job is a JSON file in the project's .visual-editor/jobs/ folder
// (kept out of git). No VS Code APIs here, so it can be tested on its own.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const JOBS_DIR = '.visual-editor/jobs';

export type JobStatus = 'working' | 'checking' | 'passed' | 'failed' | 'stopped' | 'out of time';

export interface Job {
  id: string;
  /** The agent doing it (a plugin agent's name) and its title. */
  agent: string;
  title: string;
  /** What the developer asked for, in their words. */
  request: string;
  status: JobStatus;
  /** Which round it's in (1 = the first try). */
  round: number;
  /** How many rounds it may take in all. */
  rounds: number;
  startedAt: string;
  /** When it must be done by (then it stops as "out of time"). */
  until: string;
  /** The draft the worker handed in last. */
  draft?: string;
  /** The proposal a passing draft became. */
  proposal?: string;
  /** What happened, oldest first: each hand-in, verdict, stop. */
  history: { at: string; who: 'worker' | 'checker' | 'developer' | 'Visual Editor'; what: string }[];
  /** Who started it ("Claude Code", "a button"…). */
  by: string;
}

/** How long an agent job may take. */
export const JOB_MINUTES = 20;

/** A new job for an agent (from chat, a button, a terminal), waiting for its worker. */
export function newJob(agent: { name: string; title: string; rounds?: number }, request: string, by: string, id: string, now = new Date()): Job {
  return {
    id,
    agent: agent.name,
    title: agent.title,
    request: request.trim(),
    status: 'working',
    round: 1,
    rounds: agent.rounds ?? 3,
    startedAt: now.toISOString(),
    until: new Date(now.getTime() + JOB_MINUTES * 60_000).toISOString(),
    history: [{ at: now.toISOString(), who: 'Visual Editor', what: `Started: ${request.trim()}` }],
    by,
  };
}

/** Finished: nothing more happens to it. */
export const finished = (j: Job) => j.status === 'passed' || j.status === 'failed' || j.status === 'stopped' || j.status === 'out of time';

/** The job as it is now: one past its time limit is out of time. */
export function current(j: Job, now = new Date()): Job {
  if (finished(j) || now.toISOString() < j.until) return j;
  return { ...j, status: 'out of time', history: [...j.history, { at: now.toISOString(), who: 'Visual Editor', what: 'Stopped: it ran out of time.' }] };
}

/** What to do next, in words, for whoever runs the job (the chat, a button's run). */
export function nextStep(j: Job): string {
  switch (j.status) {
    case 'working':
      return j.round === 1
        ? `Run the worker (round 1 of ${j.rounds}) with the request.`
        : `Run the worker again (round ${j.round} of ${j.rounds}) with the checker's reasons: ${lastReasons(j) ?? '(see the history)'}`;
    case 'checking':
      // (The checker passed it, and Visual Editor's checks are running on it before it goes to Review.)
      if (j.history.at(-1)?.who === 'Visual Editor' && j.history.at(-1)?.what.startsWith('Checking the pass')) return 'Visual Editor is checking the checker\'s pass before it goes to Review (about a minute or two). Call job_status again in a minute.';
      return `Run the checker on draft ${j.draft} (round ${j.round} of ${j.rounds}).`;
    case 'passed':
      return `Done: it passed and is waiting in Review as proposal ${j.proposal}. Tell the developer.`;
    case 'failed':
      return `It didn't pass in ${j.rounds} round${j.rounds === 1 ? '' : 's'}. Tell the developer what the checker found last: ${lastReasons(j) ?? '(see the history)'}`;
    case 'stopped':
      return 'The developer stopped it. Stop now, and say what was done so far.';
    case 'out of time':
      return 'It ran out of time. Stop now, and say what was done so far.';
  }
}

export function lastReasons(j: Job): string | undefined {
  // (The checker's, or Visual Editor's when its own checks stopped the checker's pass.)
  return [...j.history].reverse().find((h) => (h.who === 'checker' || h.who === 'Visual Editor') && h.what.startsWith('Sent back'))?.what.replace(/^Sent back:\s*/, '');
}

/** Reads a job file's contents (it may have been edited by hand). */
export function parseJob(text: string, fallbackId: string): Job | undefined {
  try {
    const raw = JSON.parse(text) as Partial<Job>;
    if (!raw || typeof raw.agent !== 'string' || typeof raw.request !== 'string' || typeof raw.status !== 'string') return undefined;
    return {
      id: typeof raw.id === 'string' && /^[\w-]+$/.test(raw.id) ? raw.id : fallbackId,
      agent: raw.agent,
      title: typeof raw.title === 'string' ? raw.title : raw.agent,
      request: raw.request,
      status: (['working', 'checking', 'passed', 'failed', 'stopped', 'out of time'] as const).find((s) => s === raw.status) ?? 'failed',
      round: typeof raw.round === 'number' ? raw.round : 1,
      rounds: typeof raw.rounds === 'number' ? raw.rounds : 3,
      startedAt: typeof raw.startedAt === 'string' ? raw.startedAt : '',
      until: typeof raw.until === 'string' ? raw.until : '',
      ...(typeof raw.draft === 'string' ? { draft: raw.draft } : {}),
      ...(typeof raw.proposal === 'string' ? { proposal: raw.proposal } : {}),
      history: Array.isArray(raw.history) ? raw.history : [],
      by: typeof raw.by === 'string' ? raw.by : 'Assistant',
    };
  } catch {
    return undefined;
  }
}

/** Jobs kept in one project. */
export class JobStore {
  readonly dir: string;

  constructor(readonly root: string) {
    this.dir = join(root, JOBS_DIR);
  }

  /** All jobs, newest first. */
  list(): Job[] {
    let names: string[] = [];
    try {
      names = readdirSync(this.dir).filter((n) => n.endsWith('.json'));
    } catch {
      return [];
    }
    const out: Job[] = [];
    for (const name of names) {
      try {
        const j = parseJob(readFileSync(join(this.dir, name), 'utf8'), name.slice(0, -5));
        if (j) out.push({ ...j, id: name.slice(0, -5) });
      } catch {
        // gone meanwhile
      }
    }
    return out.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  save(j: Job) {
    mkdirSync(this.dir, { recursive: true });
    // Jobs are this computer's work in progress, not shared: the folder keeps itself out of git.
    if (!existsSync(join(this.dir, '.gitignore'))) writeFileSync(join(this.dir, '.gitignore'), "# Visual Editor's agent jobs: work in progress, kept out of git.\n*\n");
    writeFileSync(join(this.dir, `${j.id}.json`), JSON.stringify(j, null, 2) + '\n');
  }
}
