// The Visual Editor shell inside VS Code: holds the plugins, and (as Step 1 grows) the project index, the maps, review,
// memory and the assistant hub. Plugins find it through its exported API (see @visual-editor/contract).

import * as vscode from 'vscode';
import { CONTRACT_VERSION, type Plugin, type ShellApi } from '@visual-editor/contract';
import { PluginRegistry } from './registry';
import { PluginsView } from './pluginsView';

export function activate(context: vscode.ExtensionContext): ShellApi {
  const registry = new PluginRegistry();
  const log = vscode.window.createOutputChannel('Visual Editor');

  // The side panel: which plugins are installed, and any that couldn't be used.
  const pluginsView = new PluginsView(registry);
  context.subscriptions.push(log, vscode.window.registerTreeDataProvider('visualEditor.plugins', pluginsView), pluginsView);

  // One status bar button for everything.
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  status.command = 'visualEditor.showPlugins';
  const updateStatus = () => {
    const n = registry.list().length;
    status.text = `$(symbol-structure) Visual Editor${n ? ` · ${n} plugin${n === 1 ? '' : 's'}` : ''}`;
    status.tooltip = n ? `Plugins: ${registry.list().map((p) => p.name).join(', ')}` : 'No plugins yet: add one for your project (React, Express…)';
  };
  updateStatus();
  status.show();
  context.subscriptions.push(
    status,
    registry.onChange(updateStatus),
    vscode.commands.registerCommand('visualEditor.showPlugins', () => vscode.commands.executeCommand('visualEditor.plugins.focus')),
  );

  log.appendLine(`Visual Editor started (plugin contract ${CONTRACT_VERSION}).`);
  return {
    contract: CONTRACT_VERSION,
    register(plugin: Plugin) {
      try {
        const registration = registry.register(plugin);
        log.appendLine(`Plugin added: ${plugin.name} ${plugin.version}`);
        return registration;
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        log.appendLine(message);
        void vscode.window.showWarningMessage(message);
        throw e;
      }
    },
  };
}

export function deactivate() {}
