// The "Plugins" list in Visual Editor's side panel: each installed plugin with what it adds, and plugins that
// couldn't be used, with the reason.

import * as vscode from 'vscode';
import type { Plugin } from '@visual-editor/contract';
import type { PluginProblem, PluginRegistry } from './registry';

type Node = { kind: 'plugin'; plugin: Plugin } | { kind: 'problem'; problem: PluginProblem } | { kind: 'empty' };

export class PluginsView implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly off: { dispose(): void };

  constructor(private readonly registry: PluginRegistry) {
    this.off = registry.onChange(() => this.emitter.fire());
  }

  getChildren(): Node[] {
    const plugins = this.registry.list().map((plugin) => ({ kind: 'plugin', plugin }) as const);
    const problems = this.registry.problems.map((problem) => ({ kind: 'problem', problem }) as const);
    return plugins.length || problems.length ? [...plugins, ...problems] : [{ kind: 'empty' }];
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === 'empty') {
      const item = new vscode.TreeItem('No plugins yet');
      item.description = 'add one for your project';
      item.tooltip = 'Plugins teach Visual Editor your stack: React, Express, SQL, MongoDB…';
      return item;
    }
    if (node.kind === 'problem') {
      const item = new vscode.TreeItem(node.problem.plugin);
      item.description = "can't be used";
      item.tooltip = node.problem.message;
      item.iconPath = new vscode.ThemeIcon('warning');
      return item;
    }
    const p = node.plugin;
    const item = new vscode.TreeItem(p.name);
    item.description = p.version;
    const adds = [
      p.maps?.length ? `maps: ${p.maps.map((m) => m.title).join(', ')}` : '',
      p.readers?.length ? `${p.readers.length} reader${p.readers.length === 1 ? '' : 's'}` : '',
    ].filter(Boolean);
    item.tooltip = [p.description, adds.join(' · ')].filter(Boolean).join('\n');
    item.iconPath = new vscode.ThemeIcon('extensions');
    return item;
  }

  dispose() {
    this.off.dispose();
    this.emitter.dispose();
  }
}
