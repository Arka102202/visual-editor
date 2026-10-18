// The map: an editor tab that draws the shown project's cards and lines. It redraws when files or plugins change,
// and when another project is chosen.

import * as vscode from 'vscode';
import { webviewPage } from './webviewPage';
import { join } from 'node:path';
import { cardMarks, type OutsideChanges } from './changes';
import type { CurrentProject } from './currentProject';
import { layoutMap } from './layout';
import type { FromMap, ToMap } from './mapMessages';
import type { ProjectIndex } from './projectIndex';
import type { Review } from './review';

export class MapPanel {
  private panel: vscode.WebviewPanel | undefined;
  private ready = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly subscriptions: vscode.Disposable[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly index: ProjectIndex,
    private readonly current: CurrentProject,
    private readonly review: Review,
    private readonly changes: OutsideChanges,
  ) {
    this.subscriptions.push(
      index.onChange(() => this.update()),
      current.onChange(() => this.update()),
      review.onChange(() => this.update()),
      changes.onChange(() => this.update()),
    );
  }

  /** Opens the map, or brings it to the front. */
  show() {
    if (this.panel) {
      this.panel.reveal();
      return;
    }
    const dist = vscode.Uri.joinPath(this.extensionUri, 'dist');
    const panel = vscode.window.createWebviewPanel('visualEditor.map', 'Visual Editor', vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [dist],
    });
    panel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'media', 'icon.svg');
    panel.webview.html = webviewPage(panel.webview, vscode.Uri.joinPath(dist, 'map.js'), 'Visual Editor');
    panel.webview.onDidReceiveMessage((m: FromMap) => this.receive(m), undefined, this.subscriptions);
    panel.onDidDispose(() => {
      this.panel = undefined;
      this.ready = false;
    });
    this.panel = panel;
  }

  dispose() {
    if (this.timer) clearTimeout(this.timer);
    this.panel?.dispose();
    for (const s of this.subscriptions) s.dispose();
  }

  private receive(m: FromMap) {
    if (m.type === 'ready') {
      this.ready = true;
      this.send();
    } else if (m.type === 'choose') {
      this.current.choose(m.root);
    } else if (m.type === 'openReview') {
      this.review.show();
    } else if (m.type === 'clearChanged') {
      const root = this.current.get()?.project.root;
      if (root) this.changes.clear(root);
    } else if (m.type === 'open') {
      const root = this.current.get()?.project.root;
      if (!root) return;
      const line = Math.max(0, (m.line ?? 1) - 1);
      void vscode.window.showTextDocument(vscode.Uri.file(join(root, m.path)), {
        selection: new vscode.Range(line, 0, line, 0),
        viewColumn: vscode.ViewColumn.Beside,
      });
    }
  }

  /** Changes come in bursts; redraw once they settle. */
  private update() {
    if (!this.panel || !this.ready) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.send(), 80);
  }

  private send() {
    this.timer = undefined;
    if (!this.panel || !this.ready) return;
    const states = this.index.snapshot();
    const state = this.current.get();
    const maps = state?.detected.flatMap((d) => d.plugin.maps ?? []) ?? [];
    const proposals = state ? this.review.proposals(state.project.root) : [];
    const changed = state ? this.changes.get(state.project.root) : new Set<string>();
    const message: ToMap = {
      type: 'show',
      projects: states.map((s) => ({ root: s.project.root, name: s.project.name, group: s.project.group, cards: s.items.length })),
      current: state?.project.root,
      plugins: state?.detected.map((d) => d.plugin.name) ?? [],
      layout: layoutMap(state?.items ?? [], state?.links ?? [], maps),
      marks: cardMarks(state?.items ?? [], proposals, changed),
      proposed: proposals.filter((p) => p.status === 'proposed').length,
      changed: changed.size,
      empty: !state
        ? { title: 'Open a folder', detail: 'Visual Editor draws the projects in the folder you open.' }
        : !state.detected.length
          ? { title: 'No plugin for this project yet', detail: 'Plugins teach Visual Editor your stack and draw its cards: React, Express, SQL, MongoDB…' }
          : !state.items.length
            ? { title: 'Nothing to draw yet', detail: `${state.detected.map((d) => d.plugin.name).join(', ')} found nothing in this project so far.` }
            : undefined,
    };
    this.panel.title = state ? `Map · ${state.project.name}` : 'Visual Editor';
    void this.panel.webview.postMessage(message);
  }
}
