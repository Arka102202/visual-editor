// Running an agent from a button: Visual Editor starts the job itself, then runs Claude Code on it, either quietly in
// the background (with a cost limit, a progress line from what Claude does, Stop, and a notice when it's done) or in a
// terminal tab, where the developer watches and can talk to it. Either way it is the same job as from chat (the
// agent's skill, worker then checker), and only a passing change reaches Review. At most MAX_RUNNING run at once (every
// agent's together); the others wait their turn. A stopped job resumes where it was, in the Claude conversation it
// stopped in when that's kept.

import * as vscode from 'vscode';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { PluginAgent } from '@visual-editor/contract';
import { finished, newJob, resumable, resumed, started, stopped, type Job, JobStore } from '../jobs';
import { newId } from '../proposals';
import { claudeCommand } from './hub';
import { SERVER_NAME } from './tools';

export type RunWay = 'background' | 'terminal';

/** The tools a run may use without asking: Visual Editor's, reading, and running the agent's worker and checker. */
const ALLOWED = [`mcp__${SERVER_NAME}`, 'Read', 'Grep', 'Glob', 'Skill', 'Agent', 'Task'];
/** Never: changes reach the developer only through Review. */
const DISALLOWED = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash'];

/** What a step looks like in the progress line, by the tool Claude uses (the hub's without their prefix). */
const STEPS: Record<string, string> = {
  job_start: 'starting the job',
  job_status: 'reading where the job is',
  variant_brief: 'reading about the component',
  previewable: 'looking at what can be previewed',
  save_draft: 'saving the draft',
  read_draft: 'reading the draft',
  check_variant_files: 'checking the preview setup',
  draft_pictures: 'taking a picture of the Playground',
  add_evidence: 'adding proof',
  job_hand_in: 'handing the draft to the checker',
  job_verdict: 'giving the verdict',
  Read: 'reading files',
  Grep: 'searching the code',
  Glob: 'looking for files',
  Skill: 'reading its instructions',
};

/** How many jobs run at once, every agent's together (each is a Claude Code run): the others wait their turn. */
export const MAX_RUNNING = 2;

interface Running {
  job: string;
  root: string;
  agent: PluginAgent;
  way: RunWay;
  maxCostUsd: number;
  /** Waiting its turn: nothing runs for it yet. */
  waiting?: boolean;
  /** Carrying on a stopped job. */
  resume?: boolean;
  child?: ChildProcess;
  terminal?: vscode.Terminal;
  progress: string;
}

export class AgentRuns implements vscode.Disposable {
  /** Each job looked after here (working, or waiting its turn), in the order they came. */
  private readonly runs = new Map<string, Running>();
  private readonly listeners = new Set<() => void>();
  private readonly off: vscode.Disposable;
  private disposed = false;

  constructor(
    private readonly log: vscode.OutputChannel,
    /** What background runs do, step by step, and what Claude says (the developer opens it to watch). */
    private readonly watchLog: vscode.OutputChannel,
  ) {
    // A terminal run's terminal closed: its run is over (the job stops where it was, if it hadn't finished).
    this.off = vscode.window.onDidCloseTerminal((t) => {
      for (const run of [...this.runs.values()]) if (run.terminal === t) this.ended(run, 'Stopped: its terminal was closed.');
    });
  }

  /** Shows a running job as it works: its terminal, or the log of background runs. */
  watch(job: string) {
    const run = this.runs.get(job);
    if (run?.terminal) run.terminal.show();
    else this.watchLog.show(true);
  }

  /** What a job run from a button is doing now, in words (or its place in the line). */
  progress(job: string): string | undefined {
    const run = this.runs.get(job);
    if (!run?.waiting) return run?.progress;
    const place = [...this.runs.values()].filter((r) => r.waiting).indexOf(run) + 1;
    return `waiting its turn (${place === 1 ? 'next' : `${place}${place === 2 ? 'nd' : place === 3 ? 'rd' : 'th'} in line`}): at most ${MAX_RUNNING} jobs run at once`;
  }

  /** Whether a job is looked after here: working, or waiting its turn. */
  has(job: string): boolean {
    return this.runs.has(job);
  }

  onChange(fn: () => void): vscode.Disposable {
    this.listeners.add(fn);
    return { dispose: () => this.listeners.delete(fn) };
  }

  /** Jobs at work now (not waiting their turn). */
  private working(): Running[] {
    return [...this.runs.values()].filter((r) => !r.waiting);
  }

  /**
   * Starts an agent on a request: the job first (so it shows and can be stopped at once), then Claude Code on it; or,
   * when MAX_RUNNING are at work already, it waits its turn.
   */
  start(root: string, agent: PluginAgent, request: string, way: RunWay, maxCostUsd: number, card?: string): Job {
    const wait = this.working().length >= MAX_RUNNING;
    const job: Job = { ...newJob(agent, request, way === 'background' ? 'a button (in the background)' : 'a button (in a terminal)', newId()), way, ...(card ? { card } : {}), ...(wait ? { status: 'waiting' as const } : {}) };
    new JobStore(root).save(job);
    this.add({ job: job.id, root, agent, way, maxCostUsd, progress: 'starting Claude Code', ...(wait ? { waiting: true } : {}) }, job);
    return job;
  }

  /** Resumes a stopped job where it was, in its own Claude conversation when that's kept; or it waits its turn. */
  resume(root: string, agent: PluginAgent, j: Job, way: RunWay, maxCostUsd: number): Job {
    const wait = this.working().length >= MAX_RUNNING;
    const job = resumed(j, wait);
    new JobStore(root).save(job);
    this.add({ job: job.id, root, agent, way: j.way ?? way, maxCostUsd, progress: 'starting Claude Code', resume: true, ...(wait ? { waiting: true } : {}) }, job);
    return job;
  }

  private add(run: Running, job: Job) {
    this.runs.set(job.id, run);
    if (!run.waiting) this.launch(run, job);
    this.fire();
  }

  /** Claude Code on the job: a new conversation with its own id (to resume it later by), or the one it stopped in. */
  private launch(run: Running, job: Job) {
    run.waiting = false;
    run.progress = 'starting Claude Code';
    const carryOn = run.resume && job.session && sessionKept(run.root, job.session) ? job.session : undefined;
    const session = carryOn ?? randomUUID();
    if (session !== job.session) new JobStore(run.root).save({ ...job, session });
    const prompt = run.resume ? resumePrompt(run.agent, job, run.way, !!carryOn) : promptFor(run.agent, job, run.way);
    const flags = carryOn ? ['--resume', carryOn] : ['--session-id', session];
    if (run.way === 'terminal') this.inTerminal(run, run.agent, prompt, flags);
    else this.inBackground(run, run.agent, prompt, flags, run.maxCostUsd);
  }

  /** Jobs waiting their turn start while there's room (oldest first). */
  private next() {
    while (!this.disposed && this.working().length < MAX_RUNNING) {
      const run = [...this.runs.values()].find((r) => r.waiting);
      if (!run) break;
      const store = new JobStore(run.root);
      const j = store.list().find((x) => x.id === run.job);
      if (!j || j.status !== 'waiting') {
        this.runs.delete(run.job);
        continue;
      }
      const job = started(j);
      store.save(job);
      this.launch(run, job);
    }
    this.fire();
  }

  /** A run is over: its place goes to the next one waiting; a job it left unfinished stops where it was (`why`). */
  private ended(run: Running, why?: string) {
    // (Its job was resumed while this run was still ending: the new run has it, and this one's place is free now.)
    if (this.runs.get(run.job) !== run) return void this.next();
    this.runs.delete(run.job);
    const store = new JobStore(run.root);
    const job = store.list().find((j) => j.id === run.job);
    if (job && !finished(job) && why) store.save(stopped(job, why, 'Visual Editor'));
    this.next();
  }

  /** A job changed (the hub saved it): a terminal run whose job finished has given up its place. */
  jobChanged(job: Job) {
    const run = this.runs.get(job.id);
    if (run && !run.child && !run.waiting && finished(job)) this.ended(run);
  }

  /** Jobs left working by a run that's gone (VS Code closed while they ran): stopped where they were, to resume. */
  tidy(root: string, jobs: Job[]): Job[] {
    return jobs.map((j) => {
      if (!j.way || finished(j) || this.runs.has(j.id)) return j;
      const s = stopped(j, 'Stopped: VS Code was closed while it ran. Resume carries on from here.', 'Visual Editor');
      new JobStore(root).save(s);
      return s;
    });
  }

  /** Stops a job: marked stopped where it was (every step then says to stop); its run ends, and the next one starts. */
  stop(root: string, id: string) {
    const store = new JobStore(root);
    const j = store.list().find((x) => x.id === id);
    if (j && !finished(j)) store.save(stopped(j, 'Stopped.', 'developer'));
    const run = this.runs.get(id);
    if (run) {
      run.progress = 'stopped';
      // (A background run ends when its process does; a terminal's Claude is interrupted, its terminal kept to read.)
      if (run.child) run.child.kill();
      else {
        run.terminal?.sendText('\x03', false);
        this.ended(run);
      }
    }
    this.fire();
  }

  private inTerminal(run: Running, agent: PluginAgent, prompt: string, flags: string[]) {
    const terminal = vscode.window.createTerminal({ name: `${agent.title} (Visual Editor)`, cwd: run.root, iconPath: new vscode.ThemeIcon('hubot') });
    run.terminal = terminal;
    run.progress = 'in a terminal';
    terminal.show();
    // Interactive: the developer watches, and can answer or add to it. (The request comes first, and each tool list is
    // one comma-separated value: a list given as separate words would swallow the request as one more tool.)
    // (One line, so the terminal shows it as one command.)
    terminal.sendText(`${claudeCommand()} ${flags.map(quote).join(' ')} ${quote(prompt.replace(/\s*\n\s*/g, ' '))} --allowedTools ${quote(ALLOWED.join(','))} --disallowedTools ${quote(DISALLOWED.join(','))}`);
  }

  private inBackground(run: Running, agent: PluginAgent, prompt: string, flags: string[], maxCostUsd: number) {
    // A dollar limit only when one is set (it matters to those paying per use; a subscription has its own allowance).
    const args = ['-p', '--output-format', 'stream-json', '--verbose', ...flags, ...(maxCostUsd > 0 ? ['--max-budget-usd', String(maxCostUsd)] : []), '--allowedTools', ALLOWED.join(','), '--disallowedTools', DISALLOWED.join(',')];
    // The developer's login shell, so `claude` is found as in their own terminal; the request goes in on stdin.
    const child = spawn(process.env.SHELL || '/bin/zsh', ['-lc', `${claudeCommand()} ${args.map(quote).join(' ')}`], { cwd: run.root, env: { ...process.env, FORCE_COLOR: '0' } });
    run.child = child;
    child.stdin.end(prompt);
    this.watchLog.appendLine(`\n${new Date().toLocaleTimeString()}  ${agent.title} ${run.resume ? 'resumed' : 'started'} in the background: “${request(prompt)}”`);
    let buffer = '';
    let result: { cost?: number; text?: string; error?: boolean } = {};
    /** Paying per use (an API key), so the cost is real money and worth showing; "none" means a subscription. */
    let paysPerUse = false;
    child.stdout.on('data', (d: Buffer) => {
      buffer += d.toString('utf8');
      let end: number;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end).trim();
        buffer = buffer.slice(end + 1);
        if (!line) continue;
        try {
          const m = JSON.parse(line) as { type: string; subtype?: string; apiKeySource?: string; session_id?: string; message?: { content?: { type: string; name?: string; input?: Record<string, unknown> }[] }; total_cost_usd?: number; result?: string; is_error?: boolean };
          if (m.type === 'system' && m.subtype === 'init') {
            paysPerUse = !!m.apiKeySource && m.apiKeySource !== 'none';
            // (The conversation it really runs in, to resume it by: a resumed one may carry on under a new id.)
            if (m.session_id) this.keepSession(run, m.session_id);
          }
          if (m.type === 'result') result = { cost: m.total_cost_usd, text: m.result, error: m.is_error };
          for (const c of (m.message?.content ?? []) as { type: string; name?: string; text?: string; input?: Record<string, unknown> }[]) {
            if (c.type === 'tool_use' && c.name) this.step(run, c.name, c.input);
            else if (c.type === 'text' && c.text?.trim()) this.watchLog.appendLine(`${agent.title}: ${c.text.trim()}`);
          }
        } catch {
          // not a message
        }
      }
    });
    let errors = '';
    child.stderr.on('data', (d: Buffer) => (errors += d.toString('utf8')));
    child.on('close', (code) => {
      if (this.disposed) return;
      // (Resumed while this run was ending: the job is the new run's now.)
      if (this.runs.get(run.job) !== run) return void this.ended(run);
      const job = new JobStore(run.root).list().find((j) => j.id === run.job);
      // The run ended without finishing its job (out of money, an error, killed): it stops where it was, to resume.
      const why =
        job && !finished(job)
          ? `Stopped: ${code === 0 ? 'Claude Code finished without finishing the job' : `Claude Code stopped (${(errors || result.text || `exit code ${code}`).trim().slice(0, 300)})`}. Resume carries on from here.`
          : undefined;
      this.log.appendLine(`${agent.title}: the background run ended${result.cost !== undefined ? ` (${paysPerUse ? 'cost' : 'at pay-per-use prices it would cost'} $${result.cost.toFixed(2)})` : ''}.`);
      this.ended(run, why);
      void this.tell(run.root, run.job, agent, paysPerUse ? result.cost : undefined);
    });
  }

  private keepSession(run: Running, session: string) {
    const store = new JobStore(run.root);
    const j = store.list().find((x) => x.id === run.job);
    if (j && j.session !== session) store.save({ ...j, session });
  }

  /** The progress line, from the tool Claude (or its worker or checker) is using now. */
  private step(run: Running, name: string, input?: Record<string, unknown>) {
    const short = name.replace(/^mcp__.*?__/, '');
    const role = typeof input?.subagent_type === 'string' ? input.subagent_type : '';
    const text = name === 'Agent' || name === 'Task' ? (/checker/.test(role) ? 'the checker is checking the draft' : /worker/.test(role) ? 'the worker is making the draft' : 'starting a helper') : STEPS[short];
    if (!text) return;
    if (text !== run.progress) this.watchLog.appendLine(`${new Date().toLocaleTimeString()}  ↳ ${text}`);
    run.progress = text;
    this.fire();
  }

  /** When a background run ends: what came of it, with Review one click away. */
  private async tell(root: string, id: string, agent: PluginAgent, cost?: number) {
    const job = new JobStore(root).list().find((j) => j.id === id);
    if (!job) return;
    const spent = cost !== undefined ? ` (cost $${cost.toFixed(2)})` : '';
    if (job.status === 'passed') {
      const pick = await vscode.window.showInformationMessage(`${agent.title} finished: it passed in round ${job.round} and is waiting in Review${spent}.`, 'Open Review');
      if (pick) void vscode.commands.executeCommand('visualEditor.openReview');
    } else {
      const last = job.history[job.history.length - 1]?.what ?? '';
      // (Stopped by the developer: they know. Stopped any other way: it says why, and that it can be resumed.)
      if (job.status === 'stopped' && job.history.at(-1)?.who === 'developer') return;
      void vscode.window.showWarningMessage(`${agent.title} ${job.status === 'stopped' ? 'stopped' : `didn't finish (${job.status})`}${spent}. ${last.slice(0, 200)}${resumable(job) && !/Resume/.test(last) ? ' Resume carries on from there (in the Agents section).' : ''}`);
    }
  }

  private fire() {
    for (const fn of this.listeners) fn();
  }

  dispose() {
    this.disposed = true;
    // (VS Code is closing: each job at work stops where it was, to resume next time.)
    for (const run of this.runs.values()) {
      const store = new JobStore(run.root);
      const j = store.list().find((x) => x.id === run.job);
      if (j && !finished(j)) store.save(stopped(j, 'Stopped: VS Code was closed. Resume carries on from here.', 'Visual Editor'));
      run.child?.kill();
    }
    this.runs.clear();
    this.off.dispose();
  }
}

/** What Claude Code is asked: carry on the job Visual Editor started, with the agent's skill. */
function promptFor(agent: PluginAgent, job: Job, way: RunWay): string {
  return `Run Visual Editor's "${agent.title}" agent on the developer's request below. Visual Editor already started the job: ${job.id}.
Don't call job_start. Use the visual-editor:${agent.name} skill from its step 2, with job id ${job.id}, and follow job_status until the job is finished.

Request: ${job.request}

${way === 'background' ? 'Nobody is watching: work without asking questions.' : 'The developer is watching here and may add to the request.'} At the end, say in a few lines what happened.`;
}

/** What Claude Code is asked when a stopped job is resumed: in the conversation it stopped in, or a new one. */
function resumePrompt(agent: PluginAgent, job: Job, way: RunWay, sameConversation: boolean): string {
  const watching = way === 'background' ? 'Nobody is watching: work without asking questions.' : 'The developer is watching here and may add to the request.';
  if (sameConversation)
    return `The developer resumed this job (${job.id}): it was stopped, and now it carries on. What you were told about stopping no longer holds. Call job_status with job id ${job.id}: it says where the job is and what to do next. Carry on from where you were, and follow job_status until the job is finished.

Request: ${job.request}

${watching} At the end, say in a few lines what happened.`;
  return `Run Visual Editor's "${agent.title}" agent: carry on job ${job.id}, which was stopped and is now resumed (round ${job.round} of ${job.rounds}${job.draft ? `; its last draft is ${job.draft}` : ''}).
Don't call job_start. Call job_status with job id ${job.id} first: it says what happened so far and what to do next. Use the visual-editor:${agent.name} skill from its step 2 with that job id${job.draft ? ', building on its last draft (read_draft) instead of starting over' : ''}, and follow job_status until the job is finished.

Request: ${job.request}

${watching} At the end, say in a few lines what happened.`;
}

/** A Claude Code conversation kept on this computer (in the folder it ran in), so it can be resumed. */
export function sessionKept(root: string, id: string): boolean {
  const dir = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'projects');
  const folders = new Set([root]);
  try {
    folders.add(realpathSync(root));
  } catch {
    // (A folder that's gone: its own name only.)
  }
  // (Claude Code names each folder's conversations after its path, every other character a dash.)
  return [...folders].some((f) => existsSync(join(dir, f.replace(/[^a-zA-Z0-9]/g, '-'), `${id}.jsonl`)));
}

/** The developer's request, from the prompt. */
const request = (prompt: string) => /^Request: (.*)$/m.exec(prompt)?.[1] ?? '';

/** A word for the shell, quoted. */
const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
