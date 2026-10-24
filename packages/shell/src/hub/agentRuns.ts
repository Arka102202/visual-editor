// Running an agent from a button: Visual Editor starts the job itself, then runs Claude Code on it, either quietly in
// the background (with a cost limit, a progress line from what Claude does, Stop, and a notice when it's done) or in a
// terminal tab, where the developer watches and can talk to it. Either way it is the same job as from chat (the
// agent's skill, worker then checker), and only a passing change reaches Review.

import * as vscode from 'vscode';
import { spawn, type ChildProcess } from 'node:child_process';
import type { PluginAgent } from '@visual-editor/contract';
import { finished, newJob, type Job, JobStore } from '../jobs';
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

interface Running {
  job: string;
  root: string;
  child?: ChildProcess;
  terminal?: vscode.Terminal;
  progress: string;
}

export class AgentRuns implements vscode.Disposable {
  private readonly runs = new Map<string, Running>();
  private readonly listeners = new Set<() => void>();

  constructor(private readonly log: vscode.OutputChannel) {}

  /** What a running job is doing now, in words (background runs). */
  progress(job: string): string | undefined {
    return this.runs.get(job)?.progress;
  }

  onChange(fn: () => void): vscode.Disposable {
    this.listeners.add(fn);
    return { dispose: () => this.listeners.delete(fn) };
  }

  /** Starts an agent on a request: the job first (so it shows and can be stopped at once), then Claude Code on it. */
  start(root: string, agent: PluginAgent, request: string, way: RunWay, maxCostUsd: number): Job {
    const job = newJob(agent, request, way === 'background' ? 'a button (in the background)' : 'a button (in a terminal)', newId());
    new JobStore(root).save(job);
    const prompt = promptFor(agent, job, way);
    const run: Running = { job: job.id, root, progress: 'starting Claude Code' };
    this.runs.set(job.id, run);
    if (way === 'terminal') this.inTerminal(run, agent, prompt);
    else this.inBackground(run, agent, prompt, maxCostUsd);
    this.fire();
    return job;
  }

  /** Stops a run: the job is marked stopped (every step then says to stop), and a background run's process ends. */
  stop(root: string, id: string) {
    const store = new JobStore(root);
    const j = store.list().find((x) => x.id === id);
    if (j && !finished(j)) store.save({ ...j, status: 'stopped', history: [...j.history, { at: new Date().toISOString(), who: 'developer', what: 'Stopped.' }] });
    const run = this.runs.get(id);
    run?.child?.kill();
    if (run) run.progress = 'stopped';
    this.fire();
  }

  private inTerminal(run: Running, agent: PluginAgent, prompt: string) {
    const terminal = vscode.window.createTerminal({ name: `${agent.title} (Visual Editor)`, cwd: run.root, iconPath: new vscode.ThemeIcon('hubot') });
    run.terminal = terminal;
    run.progress = 'in a terminal';
    terminal.show();
    // Interactive: the developer watches, and can answer or add to it. (The request comes first, and each tool list is
    // one comma-separated value: a list given as separate words would swallow the request as one more tool.)
    // (One line, so the terminal shows it as one command.)
    terminal.sendText(`${claudeCommand()} ${quote(prompt.replace(/\s*\n\s*/g, ' '))} --allowedTools ${quote(ALLOWED.join(','))} --disallowedTools ${quote(DISALLOWED.join(','))}`);
  }

  private inBackground(run: Running, agent: PluginAgent, prompt: string, maxCostUsd: number) {
    // A dollar limit only when one is set (it matters to those paying per use; a subscription has its own allowance).
    const args = ['-p', '--output-format', 'stream-json', '--verbose', ...(maxCostUsd > 0 ? ['--max-budget-usd', String(maxCostUsd)] : []), '--allowedTools', ALLOWED.join(','), '--disallowedTools', DISALLOWED.join(',')];
    // The developer's login shell, so `claude` is found as in their own terminal; the request goes in on stdin.
    const child = spawn(process.env.SHELL || '/bin/zsh', ['-lc', `${claudeCommand()} ${args.map(quote).join(' ')}`], { cwd: run.root, env: { ...process.env, FORCE_COLOR: '0' } });
    run.child = child;
    child.stdin.end(prompt);
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
          const m = JSON.parse(line) as { type: string; subtype?: string; apiKeySource?: string; message?: { content?: { type: string; name?: string; input?: Record<string, unknown> }[] }; total_cost_usd?: number; result?: string; is_error?: boolean };
          if (m.type === 'system' && m.subtype === 'init') paysPerUse = !!m.apiKeySource && m.apiKeySource !== 'none';
          if (m.type === 'result') result = { cost: m.total_cost_usd, text: m.result, error: m.is_error };
          for (const c of m.message?.content ?? []) if (c.type === 'tool_use' && c.name) this.step(run, c.name, c.input);
        } catch {
          // not a message
        }
      }
    });
    let errors = '';
    child.stderr.on('data', (d: Buffer) => (errors += d.toString('utf8')));
    child.on('close', (code) => {
      this.runs.delete(run.job);
      const job = new JobStore(run.root).list().find((j) => j.id === run.job);
      // The run ended without finishing its job (out of money, an error, killed): the job says so.
      if (job && !finished(job)) {
        const why = run.progress === 'stopped' ? 'Stopped.' : code === 0 ? 'Claude Code finished without finishing the job.' : `Claude Code stopped (${(errors || result.text || `exit code ${code}`).trim().slice(0, 300)}).`;
        new JobStore(run.root).save({ ...job, status: run.progress === 'stopped' ? 'stopped' : 'failed', history: [...job.history, { at: new Date().toISOString(), who: 'Visual Editor', what: why }] });
      }
      this.log.appendLine(`${agent.title}: the background run ended${result.cost !== undefined ? ` (${paysPerUse ? 'cost' : 'at pay-per-use prices it would cost'} $${result.cost.toFixed(2)})` : ''}.`);
      this.fire();
      void this.tell(run.root, run.job, agent, paysPerUse ? result.cost : undefined);
    });
  }

  /** The progress line, from the tool Claude (or its worker or checker) is using now. */
  private step(run: Running, name: string, input?: Record<string, unknown>) {
    const short = name.replace(/^mcp__.*?__/, '');
    const role = typeof input?.subagent_type === 'string' ? input.subagent_type : '';
    const text = name === 'Agent' || name === 'Task' ? (/checker/.test(role) ? 'the checker is checking the draft' : /worker/.test(role) ? 'the worker is making the draft' : 'starting a helper') : STEPS[short];
    if (!text) return;
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
      void vscode.window.showWarningMessage(`${agent.title} ${job.status === 'stopped' ? 'was stopped' : `didn't finish (${job.status})`}${spent}. ${last.slice(0, 200)}`);
    }
  }

  private fire() {
    for (const fn of this.listeners) fn();
  }

  dispose() {
    for (const run of this.runs.values()) run.child?.kill();
    this.runs.clear();
  }
}

/** What Claude Code is asked: carry on the job Visual Editor started, with the agent's skill. */
function promptFor(agent: PluginAgent, job: Job, way: RunWay): string {
  return `Run Visual Editor's "${agent.title}" agent on the developer's request below. Visual Editor already started the job: ${job.id}.
Don't call job_start. Use the visual-editor:${agent.name} skill from its step 2, with job id ${job.id}, and follow job_status until the job is finished.

Request: ${job.request}

${way === 'background' ? 'Nobody is watching: work without asking questions.' : 'The developer is watching here and may add to the request.'} At the end, say in a few lines what happened.`;
}

/** A word for the shell, quoted. */
const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
