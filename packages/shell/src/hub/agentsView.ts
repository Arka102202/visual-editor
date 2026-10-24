// The "Agents" section in Visual Editor's side panel (a small page: agentsPanel/main.ts): what each plugin gives
// assistants, as coloured badges (Agent, Skill, Tool) with a pop-over in plain words, whether Claude Code has them for
// this folder, and each agent's job (working now, with Stop, or how the last one ended).

import * as vscode from 'vscode';
import type { Disposable } from '@visual-editor/contract';
import type { AgentsEntry, FromAgents, ToAgents } from '../agentsMessages';
import type { PluginRegistry } from '../registry';
import { webviewPage } from '../webviewPage';
import type { Hub } from './hub';
import { finished, type Job } from '../jobs';

export class AgentsView implements vscode.WebviewViewProvider, vscode.Disposable {
  private view: vscode.WebviewView | undefined;
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
  ) {
    this.off = [registry.onChange(() => this.refresh()), hub.onChange(() => this.refresh())];
  }

  resolveWebviewView(view: vscode.WebviewView) {
    this.view = view;
    const dist = vscode.Uri.joinPath(this.extensionUri, 'dist');
    view.webview.options = { enableScripts: true, localResourceRoots: [dist] };
    view.webview.html = webviewPage(view.webview, vscode.Uri.joinPath(dist, 'agentsPanel.js'), 'Agents');
    view.webview.onDidReceiveMessage((m: FromAgents) => {
      if (m.type === 'ready') this.refresh();
      else if (m.type === 'connect') void vscode.commands.executeCommand('visualEditor.connectAssistant');
      else if (m.type === 'addAgents') void vscode.commands.executeCommand('visualEditor.addAgents');
      else if (m.type === 'stop') this.stop(m.job);
      else if (m.type === 'run') void vscode.commands.executeCommand('visualEditor.runAgent', m.agent, m.way);
    });
    view.onDidChangeVisibility(() => view.visible && this.refresh());
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
          return {
            kind: 'agent',
            name: a.name,
            title: a.title,
            summary: a.summary ?? a.description,
            claudeName: `visual-editor:${a.name}`,
            ...(job ? { job: { id: job.id, status: job.status, round: job.round, rounds: job.rounds, request: job.request, running: !finished(job), by: job.by, ...(progress ? { progress } : {}) } } : {}),
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

  /** Something changed (plugins, the connection, a job): draw again. */
  refresh() {
    if (this.view?.visible) void this.view.webview.postMessage(this.state());
  }

  dispose() {
    for (const d of this.off) d.dispose();
  }
}
