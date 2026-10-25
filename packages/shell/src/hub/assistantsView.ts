// The "Assistants" list in the side panel, and the dropdown behind the plug button: each assistant that can work
// with Visual Editor, whether it's connected, and a button to connect or disconnect it.

import * as vscode from 'vscode';
import type { Disposable } from '@visual-editor/contract';
import type { Assistant, Hub } from './hub';

const STATE_WORDS: Record<Assistant['state'], string> = {
  on: 'connected',
  off: 'not connected',
  old: 'old address: connect again',
};

export class AssistantsView implements vscode.TreeDataProvider<Assistant>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly off: Disposable;

  constructor(private readonly hub: Hub) {
    this.off = hub.onChange(() => this.emitter.fire());
  }

  getChildren(): Assistant[] {
    return this.hub.assistants();
  }

  getTreeItem(a: Assistant): vscode.TreeItem {
    const item = new vscode.TreeItem(a.name);
    // Talking to the hub right now means connected, however it was set up.
    item.description = `${a.talking ? 'connected · working now' : STATE_WORDS[a.state]}${a.state === 'on' && a.agents === 'off' ? ' · agents not added' : ''}${a.state !== 'off' && !a.reviewOnly ? ' · edits files directly' : ''}`;
    item.iconPath = new vscode.ThemeIcon(a.state === 'on' || a.talking ? 'pass-filled' : a.state === 'old' ? 'warning' : 'circle-large-outline');
    item.tooltip =
      a.state !== 'on' ? `Connect ${a.name} so it can read the map, rules and memory, use Visual Editor’s agents, and propose changes into Review.`
      : a.agents === 'off' ? `${a.name} can read the map, rules and memory, and propose changes into Review. Visual Editor’s agents aren’t added to it yet.`
      : `${a.name} can read the map, rules and memory, use Visual Editor’s agents, and propose changes into Review.`;
    if (a.state !== 'off') item.tooltip += a.reviewOnly ? ' It changes the project’s files only through Review.' : ' Review only is off: it can also change files directly, without Review.';
    // The row's buttons (connect or disconnect, add agents) come from the menus, by this value.
    // (…-locked: changes only through Review; …-open: it can edit files directly.)
    item.contextValue = a.state === 'on' ? `${a.agents === 'off' ? 'assistant-on-noagents' : 'assistant-on'}-${a.reviewOnly ? 'locked' : 'open'}` : 'assistant-off';
    item.command = { command: a.state === 'on' ? 'visualEditor.disconnectAssistant' : 'visualEditor.connectAssistant', title: '', arguments: [a] };
    return item;
  }

  dispose() {
    this.off.dispose();
    this.emitter.dispose();
  }
}

/** The plug button's dropdown: every assistant with its state; choosing one connects or disconnects it. */
export async function chooseAssistant(hub: Hub) {
  const all = hub.assistants();
  const pick = await vscode.window.showQuickPick(
    [
      ...all.map((a) => ({
        label: `$(${a.state === 'on' ? 'pass-filled' : 'plug'}) ${a.name}`,
        description: STATE_WORDS[a.state],
        detail: a.state === 'on' ? 'Choose to disconnect' : 'Choose to connect',
        command: a.state === 'on' ? 'visualEditor.disconnectAssistant' : 'visualEditor.connectAssistant',
        assistant: a,
      })),
      // Connected before Visual Editor had agents: add them.
      ...all.filter((a) => a.state === 'on' && a.agents === 'off').map((a) => ({ label: '$(hubot) Add Visual Editor’s agents', description: a.name, detail: 'Its agents and know-how, for this folder', command: 'visualEditor.addAgents', assistant: a })),
    ],
    { title: 'Assistants', placeHolder: 'Connect an assistant to Visual Editor' },
  );
  if (!pick) return;
  await vscode.commands.executeCommand(pick.command, pick.assistant);
}
