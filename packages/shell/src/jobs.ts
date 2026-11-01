// Jobs: an agent at work, kept by Visual Editor so its rules hold however it was started (chat, a button, a terminal).
// The worker makes a draft and hands it in; the checker proves it (the draft's proof for its current version must have
// passed) or sends it back with reasons; at most `rounds` rounds, within a time limit, and it can be stopped at any
// moment. A draft that passes goes to Review. Each job is a JSON file in the project's .visual-editor/jobs/ folder
// (kept out of git). Started from a button, it may wait its turn (only so many run at once); stopped, it can be resumed
// from where it was. No VS Code APIs here, so it can be tested on its own.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const JOBS_DIR = '.visual-editor/jobs';

export type JobStatus = 'waiting' | 'working' | 'checking' | 'passed' | 'failed' | 'stopped' | 'out of time';

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
  /** Started from a button: in the background or in a terminal (a run Visual Editor looks after). */
  way?: 'background' | 'terminal';
  /** The card it's for (its id), when it was started for one: only one job works on a card at a time. */
  card?: string;
  /** The Claude Code conversation running it (to resume it where it stopped). */
  session?: string;
  /** Stopped: where it was (the worker's turn or the checker's), to carry on from there when resumed. */
  stoppedAt?: 'working' | 'checking';
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

/** The job as it is now: one past its time limit is out of time (one waiting its turn hasn't started its clock). */
export function current(j: Job, now = new Date()): Job {
  if (finished(j) || j.status === 'waiting' || now.toISOString() < j.until) return j;
  return { ...stopped(j, 'Stopped: it ran out of time.', 'Visual Editor', now), status: 'out of time' };
}

/** Stopped in the middle (by the developer, or its run ended): it remembers where it was, to resume from there. */
export function stopped(j: Job, what: string, who: Job['history'][number]['who'], now = new Date()): Job {
  const at = j.status === 'checking' ? 'checking' : 'working';
  return { ...j, status: 'stopped', stoppedAt: at, history: [...j.history, { at: now.toISOString(), who, what }] };
}

/** It can be resumed: it was stopped or ran out of time before it finished its rounds. */
export const resumable = (j: Job) => j.status === 'stopped' || j.status === 'out of time';

/** Resumed: back where it was (the worker's turn or the checker's), with a new time limit; or waiting its turn. */
export function resumed(j: Job, wait: boolean, now = new Date()): Job {
  return {
    ...j,
    status: wait ? 'waiting' : j.stoppedAt ?? 'working',
    until: new Date(now.getTime() + JOB_MINUTES * 60_000).toISOString(),
    history: [...j.history, { at: now.toISOString(), who: 'developer', what: `Resumed${wait ? ': it waits its turn' : ''} (round ${j.round} of ${j.rounds}).` }],
  };
}

/** Its turn came: it starts working (or carries on where it was stopped), its clock starting now. */
export function started(j: Job, now = new Date()): Job {
  return { ...j, status: j.stoppedAt ?? 'working', until: new Date(now.getTime() + JOB_MINUTES * 60_000).toISOString(), history: [...j.history, { at: now.toISOString(), who: 'Visual Editor', what: 'Its turn came: it started.' }] };
}

/** What to do next, in words, for whoever runs the job (the chat, a button's run). */
export function nextStep(j: Job): string {
  switch (j.status) {
    case 'waiting':
      return 'It is waiting its turn (only so many jobs run at once): Visual Editor starts it when one ends. Do nothing for it now.';
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
      status: (['waiting', 'working', 'checking', 'passed', 'failed', 'stopped', 'out of time'] as const).find((s) => s === raw.status) ?? 'failed',
      round: typeof raw.round === 'number' ? raw.round : 1,
      rounds: typeof raw.rounds === 'number' ? raw.rounds : 3,
      startedAt: typeof raw.startedAt === 'string' ? raw.startedAt : '',
      until: typeof raw.until === 'string' ? raw.until : '',
      ...(typeof raw.draft === 'string' ? { draft: raw.draft } : {}),
      ...(typeof raw.proposal === 'string' ? { proposal: raw.proposal } : {}),
      history: Array.isArray(raw.history) ? raw.history : [],
      by: typeof raw.by === 'string' ? raw.by : 'Assistant',
      ...(raw.way === 'background' || raw.way === 'terminal' ? { way: raw.way } : {}),
      ...(typeof raw.card === 'string' ? { card: raw.card } : {}),
      ...(typeof raw.session === 'string' ? { session: raw.session } : {}),
      ...(raw.stoppedAt === 'working' || raw.stoppedAt === 'checking' ? { stoppedAt: raw.stoppedAt } : {}),
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
