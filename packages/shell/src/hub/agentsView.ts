// The "Agents" section in Visual Editor's side panel (a small page: agentsPanel/main.ts): what each plugin gives
// assistants, as coloured badges (Agent, Skill, Tool) with a pop-over in plain words, whether Claude Code has them for
// this folder, and each agent's job (working now, with Stop, or how the last one ended).

import * as vscode from 'vscode';
import type { Disposable } from '@visual-editor/contract';
import type { AgentsEntry, FromAgents, JobResult, ToAgents } from '../agentsMessages';
import type { Evidence, Proposal } from '../proposals';

/** How many of an agent's finished jobs the section shows. */
const RECENT = 3;
const IN_REVIEW: Record<Proposal['status'], string> = { proposed: 'waiting for you in Review', applied: 'approved', rejected: 'rejected', 'sent-back': 'sent back', undone: 'approved, then undone' };
import type { PluginRegistry } from '../registry';
import { webviewPage } from '../webviewPage';
import type { Hub } from './hub';
import { finished, type Job } from '../jobs';

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
    /** Shows a running job as it works (its log or terminal), and a proposal in Review. */
    private readonly actions: { watch(job: string): void; review(proposal: string): void } = { watch: () => {}, review: () => {} },
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
        items: [{ kind: 'skill', name: 'visual-editor', title: 'How to use the map', summary: 'Claude reads this first: look things up on Visual Editor’s map instead of searching files, follow your project’s rules, and send every change to Review.', claudeName: 'visual-editor:visual-editor' }],
      },
    ];
    for (const p of this.registry.list()) {
      const items: AgentsEntry[] = [
        ...(p.agents ?? []).map((a): AgentsEntry => {
          const job = jobs.find((j) => j.agent === a.name);
          const progress = job && this.progress(job.id);
          const recent = jobs.filter((j) => j.agent === a.name && finished(j)).slice(0, RECENT).map((j) => this.result(j));
          return {
            kind: 'agent',
            name: a.name,
            title: a.title,
            summary: a.summary ?? a.description,
            claudeName: `visual-editor:${a.name}`,
            ...(job ? { job: { id: job.id, status: job.status, round: job.round, rounds: job.rounds, request: job.request, running: !finished(job), by: job.by, ...(progress ? { progress } : {}) } } : {}),
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
