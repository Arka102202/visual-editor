// The "Agents" list in Visual Editor's side panel: what each plugin gives assistants (agents, skills, tools), with
// what each does on hover, and whether Claude Code has them for this folder. (Running, progress and results come with
// the Agents panel, plan step 2.7.)

import * as vscode from 'vscode';
import type { Disposable, Plugin, PluginAgent, PluginSkill, PluginTool } from '@visual-editor/contract';
import type { PluginRegistry } from '../registry';
import type { Hub } from './hub';

type Node =
  | { kind: 'status'; text: string; tip: string; command?: string; icon: string }
  | { kind: 'shell' }
  | { kind: 'plugin'; plugin: Plugin }
  | { kind: 'agent'; agent: PluginAgent }
  | { kind: 'skill'; skill: PluginSkill }
  | { kind: 'tool'; tool: PluginTool };

export class AgentsView implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly off: Disposable[];

  constructor(
    private readonly registry: PluginRegistry,
    private readonly hub: Hub,
  ) {
    this.off = [registry.onChange(() => this.emitter.fire()), hub.onChange(() => this.emitter.fire())];
  }

  getChildren(node?: Node): Node[] {
    if (!node) {
      const plugins = this.registry.list().filter((p) => p.agents?.length || p.skills?.length || p.tools?.length);
      return [...this.status(), { kind: 'shell' }, ...plugins.map((plugin) => ({ kind: 'plugin', plugin }) as const)];
    }
    if (node.kind !== 'plugin') return [];
    const p = node.plugin;
    return [
      ...(p.agents ?? []).map((agent) => ({ kind: 'agent', agent }) as const),
      ...(p.skills ?? []).map((skill) => ({ kind: 'skill', skill }) as const),
      ...(p.tools ?? []).map((tool) => ({ kind: 'tool', tool }) as const),
    ];
  }

  /** Whether Claude Code can use them here, with what to do when it can't. */
  private status(): Node[] {
    const claude = this.hub.assistants().find((a) => a.id === 'claude');
    if (!claude || claude.state !== 'on')
      return [{ kind: 'status', text: 'Claude Code isn’t connected', tip: 'Connect Claude Code to use these: its agents and know-how come with it.', command: 'visualEditor.connectAssistant', icon: 'plug' }];
    if (claude.agents === 'off')
      return [{ kind: 'status', text: 'Not added to Claude Code yet', tip: 'Claude Code is connected, but Visual Editor’s agents and know-how aren’t added to it for this folder. Click to add them.', command: 'visualEditor.addAgents', icon: 'add' }];
    return [];
  }

  getTreeItem(node: Node): vscode.TreeItem {
    switch (node.kind) {
      case 'status': {
        const item = new vscode.TreeItem(node.text);
        item.tooltip = node.tip;
        item.iconPath = new vscode.ThemeIcon(node.icon);
        if (node.command) item.command = { command: node.command, title: '' };
        return item;
      }
      case 'shell': {
        const item = new vscode.TreeItem('Visual Editor');
        item.description = 'how to use the map';
        item.tooltip = 'Know-how every assistant gets: use the map tools before searching files, follow the project’s rules, and change code only through Review.';
        item.iconPath = new vscode.ThemeIcon('book');
        return item;
      }
      case 'plugin': {
        const p = node.plugin;
        const item = new vscode.TreeItem(p.name, vscode.TreeItemCollapsibleState.Expanded);
        item.description = [count(p.agents, 'agent'), count(p.skills, 'skill'), count(p.tools, 'tool')].filter(Boolean).join(' · ');
        item.tooltip = `What the ${p.name} plugin gives assistants.`;
        item.iconPath = new vscode.ThemeIcon('extensions');
        return item;
      }
      case 'agent': {
        const a = node.agent;
        const item = new vscode.TreeItem(a.title);
        item.description = 'agent';
        const rounds = a.rounds ?? 3;
        item.tooltip = new vscode.MarkdownString(
          `**${a.title}**\n\n${a.description}\n\nA worker makes the change; a checker proves it or sends it back (at most ${rounds === 1 ? 'once' : `${rounds} times`}). In Claude Code: \`visual-editor:${a.name}\`.`,
        );
        item.iconPath = new vscode.ThemeIcon('hubot');
        return item;
      }
      case 'skill': {
        const item = new vscode.TreeItem(node.skill.name);
        item.description = 'know-how';
        item.tooltip = `${node.skill.description}\n\nIn Claude Code: visual-editor:${node.skill.name}`;
        item.iconPath = new vscode.ThemeIcon('book');
        return item;
      }
      case 'tool': {
        const item = new vscode.TreeItem(node.tool.title);
        item.description = 'tool';
        item.tooltip = `${node.tool.description}\n\nClaude calls it as ${node.tool.name}.`;
        item.iconPath = new vscode.ThemeIcon('tools');
        return item;
      }
    }
  }

  dispose() {
    for (const d of this.off) d.dispose();
    this.emitter.dispose();
  }
}

function count(list: unknown[] | undefined, word: string): string {
  return list?.length ? `${list.length} ${word}${list.length === 1 ? '' : 's'}` : '';
}
