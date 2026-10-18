// The "Projects" list in Visual Editor's side panel: each project found, which plugins it suits (and why), and how
// many cards they found. Until the map is drawn, this is where the developer sees what the shell understood.

import * as vscode from 'vscode';
import type { CurrentProject } from './currentProject';
import type { ProjectIndex, ProjectState } from './projectIndex';

type Node =
  | { kind: 'project'; state: ProjectState }
  | { kind: 'plugin'; state: ProjectState; plugin: ProjectState['detected'][number] }
  | { kind: 'problem'; text: string; tooltip: string }
  | { kind: 'note'; text: string; tooltip?: string };

export class ProjectsView implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly offs: { dispose(): void }[];

  constructor(
    private readonly index: ProjectIndex,
    private readonly current: CurrentProject,
  ) {
    this.offs = [index.onChange(() => this.emitter.fire()), current.onChange(() => this.emitter.fire())];
  }

  getChildren(node?: Node): Node[] {
    if (!node) {
      const states = this.index.snapshot();
      return states.length ? states.map((state) => ({ kind: 'project', state })) : [{ kind: 'note', text: 'Open a folder to see its projects' }];
    }
    if (node.kind !== 'project') return [];
    const { state } = node;
    const children: Node[] = state.detected.map((plugin) => ({ kind: 'plugin', state, plugin }));
    if (!children.length) children.push({ kind: 'note', text: 'No plugin for this project yet', tooltip: 'Add a plugin for its stack (React, Express, SQL…).' });
    for (const p of state.problems) children.push({ kind: 'problem', text: `${p.plugin}: ${p.reader} failed`, tooltip: p.message });
    if (state.project.truncated) children.push({ kind: 'note', text: 'Very large: some files were left out' });
    return children;
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === 'note') {
      const item = new vscode.TreeItem(node.text);
      item.tooltip = node.tooltip;
      return item;
    }
    if (node.kind === 'problem') {
      const item = new vscode.TreeItem(node.text);
      item.tooltip = node.tooltip;
      item.iconPath = new vscode.ThemeIcon('warning');
      return item;
    }
    if (node.kind === 'plugin') {
      const n = node.state.cards[node.plugin.plugin.id] ?? 0;
      const item = new vscode.TreeItem(node.plugin.plugin.name);
      item.description = `${n} card${n === 1 ? '' : 's'}`;
      item.tooltip = node.plugin.reason;
      item.iconPath = new vscode.ThemeIcon('extensions');
      return item;
    }
    const { project, items, links } = node.state;
    const item = new vscode.TreeItem(project.name, vscode.TreeItemCollapsibleState.Expanded);
    const shown = this.index.snapshot().length > 1 && this.current.get()?.project.root === project.root;
    item.description = [project.group && project.group !== project.name ? `in ${project.group}` : '', `${project.files.length} files`, shown ? 'on the map' : ''].filter(Boolean).join(' · ');
    item.tooltip = `${project.root}\n${items.length} cards · ${links.length} lines\nClick to show it on the map`;
    item.iconPath = new vscode.ThemeIcon(shown ? 'eye' : project.group ? 'repo' : 'folder');
    item.command = { command: 'visualEditor.chooseProject', title: 'Show on the map', arguments: [project.root] };
    return item;
  }

  dispose() {
    for (const off of this.offs) off.dispose();
    this.emitter.dispose();
  }
}
