// The React plugin for Visual Editor: registers with the shell, which then reads React projects with it.

import * as vscode from 'vscode';
import { SHELL_EXTENSION_ID, type ShellApi } from '@visual-editor/contract';
import { previews, reactPlugin } from './plugin';

export async function activate(context: vscode.ExtensionContext) {
  const shell = vscode.extensions.getExtension<ShellApi>(SHELL_EXTENSION_ID);
  if (!shell) {
    void vscode.window.showWarningMessage('The React plugin needs Visual Editor. Install it, then reload the window.');
    return;
  }
  // Previews run the project's dev server (its own code): only in folders the developer trusts.
  previews.trusted = () => vscode.workspace.isTrusted;
  const api = await shell.activate();
  context.subscriptions.push(api.register(reactPlugin));
}

/** The dev servers Visual Editor started for previews stop with it. */
export function deactivate() {
  return previews.stopAll();
}
