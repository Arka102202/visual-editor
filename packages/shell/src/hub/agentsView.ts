// The "Agents" section in Visual Editor's side panel (a small page: agentsPanel/main.ts): what each plugin gives
// assistants, as coloured badges (Agent, Skill, Tool) with a pop-over in plain words, whether Claude Code has them for
// this folder, and each agent's jobs: each at work (or waiting its turn) its own row with Watch and Stop, then how the
// last ones ended (a stopped one with Resume).

import * as vscode from 'vscode';
import type { Disposable, Plugin, PluginAgent } from '@visual-editor/contract';
import type { AgentsEntry, FromAgents, JobResult, LiveJob, ToAgents } from '../agentsMessages';
import type { Evidence, Proposal } from '../proposals';

/** How many of an agent's finished jobs the section shows. */
const RECENT = 3;
const IN_REVIEW: Record<Proposal['status'], string> = { 'awaiting-checks': 'its checks wait for you in Review', proposed: 'waiting for you in Review', applied: 'approved', rejected: 'rejected', 'sent-back': 'sent back', undone: 'approved, then undone', 'held-back': 'held back by a check' };
import type { PluginRegistry } from '../registry';
import { webviewPage } from '../webviewPage';
import type { Hub } from './hub';
import { finished, resumable, type Job } from '../jobs';
import { HUB_TOOLS } from '../registry';

/** Visual Editor's own tools, in plain words (title, what it does), as the section lists them. */
const HUB_TOOL_WORDS: Record<string, [string, string]> = {
  overview: ['The project at a glance', 'What the project is: its plugins, maps, how many cards, and its rules.'],
  list_cards: ['Find cards on the map', 'Finds components, pages and API calls on the map by name.'],
  card: ['Everything about one card', 'One card: what it takes, what uses it, what it uses, its notes.'],
  follow_field: ['Where a value comes from and is shown', 'Follows a value a component is given (project.name): where it starts, how it gets there, and every place it’s shown.'],
  impact: ['What changing a card affects', 'Who uses a component and what they pass, the pages it’s seen on, what shares its data; for one prop, every place that passes it.'],
  memory: ['Rules, decisions and notes', 'Reads the project’s rules, decisions and notes, so Claude follows them.'],
  remember: ['Remember something', 'Adds a rule, decision or note to Memory, signed by Claude.'],
  propose_change: ['Propose a change', 'Sends a change to Review: its test cases are written, you run them, and nothing changes until you approve.'],
  proposal_status: ['Where a change stands', 'Whether a change is waiting, being checked, held back (and why), approved or sent back.'],
  save_draft: ['Save a draft', 'Keeps a change apart as a draft (in a session, or for an agent), without touching your files.'],
  read_draft: ['Read a draft', 'Shows a draft’s files and its proof.'],
  submit_draft: ['Send a draft on', 'Sends a finished draft to have its test cases written, then to Review.'],
  start_session: ['Open a design session', 'Opens a design session tab (a kind: new design, new page…) for shaping a change with you.'],
  continue_proposal: ['Continue a change in a session', 'Opens a waiting proposal in a session; when you’re done, it goes back into the same proposal.'],
  open_session: ['Open a closed session again', 'Opens a session whose tab you closed, only after you said yes.'],
  add_evidence: ['Add proof', 'Adds a note to a draft’s proof, shown in Review next to the change.'],
  draft_pictures: ['Pictures of a draft', 'Draws a draft’s components in the Playground, for Claude to look at.'],
  compare_app: ['Does the app look the same', 'Pictures an app page with and without a draft, and compares them.'],
  job_start: ['Start an agent’s job', 'Starts a job for an agent (its rounds, time limit and Stop are kept by Visual Editor).'],
  job_status: ['A job’s next step', 'Says what an agent’s job should do next.'],
  job_hand_in: ['Hand in the work', 'The worker hands its draft to the checker.'],
  job_verdict: ['The checker’s verdict', 'The checker passes the work (on to its test cases and Review) or sends it back with reasons.'],
};

/** Claude run by Visual Editor itself, for one small job each. */
const HELPERS: { name: string; title: string; summary: string }[] = [
  { name: 'check-planner', title: 'Check planner', summary: 'When a change is finished, reads it and what you asked, and writes its test cases: which checks apply (and why), and scenarios that try to break it. You see them before anything runs.' },
  { name: 'tester', title: 'Tester', summary: 'Tries a disputed scenario in the app like a person (clicks, types, looks), and tries the app without the change too before blaming it.' },
  { name: 'clean-up', title: 'Clean-up helper', summary: 'From Memory → Sessions (✨): suggests which sessions to delete for good, each with why. It only marks them; you delete them with one click.' },
];

export class AgentsView implements vscode.WebviewViewProvider, vscode.Disposable {
  private view: vscode.WebviewView | undefined;
  /** The same page as a full tab, with room for every result. */
  private panel: vscode.WebviewPanel | undefined;
  private readonly off: Disposable[];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly registry: PluginRegistry,
    private readonly hub: Hub,
    /** The open project's agent jobs, newest first. */
    private readonly jobs: () => Job[] = () => [],
    /** Stops a job (it stops at its next step). */
    private readonly stop: (id: string) => void = () => {},
    /** What a job run from a button is doing now. */
    private readonly progress: (job: string) => string | undefined = () => undefined,
    /** The open project's proposal by id (a passed job's, for its proof). */
    private readonly proposal: (id: string) => Proposal | undefined = () => undefined,
    /** Shows a running job as it works (its log or terminal), a proposal in Review, and resumes a stopped job. */
    private readonly actions: { watch(job: string): void; review(proposal: string): void; resume?(job: string): void } = { watch: () => {}, review: () => {} },
    /** Why an agent can't be started now (its plugin's project needs setting up first). */
    private readonly blocked: (plugin: Plugin, agent: PluginAgent) => string | undefined = () => undefined,
    /** Why an agent has nothing to do in the open project (what it makes is there already). */
    private readonly done: (agent: PluginAgent) => string | undefined = () => undefined,
  ) {
    this.off = [registry.onChange(() => this.refresh()), hub.onChange(() => this.refresh())];
  }

  resolveWebviewView(view: vscode.WebviewView) {
    this.view = view;
    this.fill(view.webview);
    view.onDidChangeVisibility(() => view.visible && this.refresh());
  }

  /** Opens the Agents as a tab (or brings it to the front). */
  openPanel() {
    if (this.panel) return this.panel.reveal();
    const dist = vscode.Uri.joinPath(this.extensionUri, 'dist');
    const panel = vscode.window.createWebviewPanel('visualEditor.agentsPanel', 'Agents', vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [dist] });
    panel.iconPath = new vscode.ThemeIcon('hubot');
    this.fill(panel.webview);
    panel.onDidDispose(() => (this.panel = undefined));
    this.panel = panel;
  }

  /** The page and what it asks for (the same in the side panel and in a tab). */
  private fill(webview: vscode.Webview) {
    const dist = vscode.Uri.joinPath(this.extensionUri, 'dist');
    webview.options = { enableScripts: true, localResourceRoots: [dist] };
    webview.html = webviewPage(webview, vscode.Uri.joinPath(dist, 'agentsPanel.js'), 'Agents');
    webview.onDidReceiveMessage((m: FromAgents) => {
      if (m.type === 'ready') this.refresh();
      else if (m.type === 'connect') void vscode.commands.executeCommand('visualEditor.connectAssistant');
      else if (m.type === 'addAgents') void vscode.commands.executeCommand('visualEditor.addAgents');
      else if (m.type === 'stop') this.stop(m.job);
      else if (m.type === 'resume') this.actions.resume?.(m.job);
      else if (m.type === 'run') void vscode.commands.executeCommand('visualEditor.runAgent', m.agent, m.way);
      else if (m.type === 'watch') this.actions.watch(m.job);
      else if (m.type === 'review') this.actions.review(m.proposal);
    });
  }

  /** What the section shows. */
  state(): ToAgents {
    const jobs = this.jobs();
    const groups: ToAgents['groups'] = [
      {
        name: 'Visual Editor',
        items: [
          { kind: 'skill', name: 'visual-editor', title: 'How to use the map', summary: 'Claude reads this first: look things up on Visual Editor’s map instead of searching files, follow your project’s rules, and send every change to Review.', claudeName: 'visual-editor:visual-editor' },
          ...HELPERS.map((h): AgentsEntry => ({ kind: 'helper', ...h, claudeName: h.name })),
          ...HUB_TOOLS.map((name): AgentsEntry => ({ kind: 'tool', name, title: HUB_TOOL_WORDS[name]?.[0] ?? name, summary: HUB_TOOL_WORDS[name]?.[1] ?? '', claudeName: name })),
        ],
      },
    ];
    for (const p of this.registry.list()) {
      const items: AgentsEntry[] = [
        ...(p.agents ?? []).map((a): AgentsEntry => {
          const live = jobs.filter((j) => j.agent === a.name && !finished(j)).map((j): LiveJob => {
            const progress = this.progress(j.id);
            return { id: j.id, status: j.status, round: j.round, rounds: j.rounds, request: j.request, by: j.by, ...(progress ? { progress } : {}) };
          });
          const recent = jobs.filter((j) => j.agent === a.name && finished(j)).slice(0, RECENT).map((j) => this.result(j));
          const done = this.done(a);
          const blocked = done ? undefined : this.blocked(p, a);
          return {
            kind: 'agent',
            name: a.name,
            title: a.title,
            summary: a.summary ?? a.description,
            claudeName: `visual-editor:${a.name}`,
            ...(live.length ? { jobs: live } : {}),
            ...(blocked ? { blocked } : {}),
            ...(done ? { done } : {}),
            ...(recent.length ? { recent } : {}),
          };
        }),
        ...(p.skills ?? []).map((s): AgentsEntry => ({ kind: 'skill', name: s.name, title: s.title ?? s.name, summary: s.summary ?? s.description, claudeName: `visual-editor:${s.name}` })),
        ...(p.tools ?? []).map((t): AgentsEntry => ({ kind: 'tool', name: t.name, title: t.title, summary: t.summary ?? t.description, claudeName: t.name })),
      ];
      if (items.length) groups.push({ name: p.name, items });
    }
    const claude = this.hub.assistants().find((a) => a.id === 'claude');
    const status: ToAgents['status'] =
      !claude || claude.state !== 'on'
        ? { text: 'Claude Code isn’t connected, so it can’t use these yet.', tip: 'Connect Claude Code: its agents, skills and tools come with it', action: 'connect' }
        : claude.agents === 'off'
          ? { text: 'Claude Code is connected, but these aren’t added to it yet.', tip: 'Add Visual Editor’s agents and skills to Claude Code for this folder', action: 'addAgents' }
          : undefined;
    return { type: 'show', ...(status ? { status } : {}), groups };
  }

  /** A finished job as the section shows it: what happened, and its proposal's proof. */
  private result(j: Job): JobResult {
    const p = j.proposal ? this.proposal(j.proposal) : undefined;
    const mark = (e: Evidence) => (e.passed === true ? '✓' : e.passed === false ? '✗' : e.kind === 'picture' ? '▣' : '•');
    return {
      id: j.id,
      status: j.status,
      request: j.request,
      round: j.round,
      rounds: j.rounds,
      at: j.startedAt,
      by: j.by,
      steps: j.history.filter((h) => h.who !== 'Visual Editor' || !h.what.startsWith('Started')).map((h) => ({ who: h.who, what: h.what })),
      ...(j.proposal ? { proposal: j.proposal } : {}),
      ...(p ? { inReview: IN_REVIEW[p.status] } : {}),
      ...(p?.evidence ? { proof: p.evidence.map((e) => ({ mark: mark(e), title: e.title })) } : {}),
      ...(resumable(j) ? { resumable: true } : {}),
    };
  }

  /** Something changed (plugins, the connection, a job): draw again. */
  refresh() {
    const state = this.state();
    if (this.view?.visible) void this.view.webview.postMessage(state);
    if (this.panel) void this.panel.webview.postMessage(state);
  }

  dispose() {
    for (const d of this.off) d.dispose();
    this.panel?.dispose();
  }
}
