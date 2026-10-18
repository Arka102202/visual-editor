// The smallest Visual Editor plugin: it works with any folder and adds one card. It exists to prove the plugin
// contract end to end, and as an example for writing real plugins.

import * as vscode from 'vscode';
import { SHELL_EXTENSION_ID, type ShellApi } from '@visual-editor/contract';
import { helloPlugin } from './plugin';

export async function activate(context: vscode.ExtensionContext) {
  const shell = vscode.extensions.getExtension<ShellApi>(SHELL_EXTENSION_ID);
  if (!shell) {
    void vscode.window.showWarningMessage('The Hello plugin needs Visual Editor. Install it, then reload the window.');
    return;
  }
  const api = await shell.activate();
  context.subscriptions.push(api.register(helloPlugin));
}

export function deactivate() {}
