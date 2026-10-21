// The React plugin for Visual Editor: registers with the shell, which then reads React projects with it.

import * as vscode from 'vscode';
import { SHELL_EXTENSION_ID, type ShellApi } from '@visual-editor/contract';
import { reactPlugin } from './plugin';
import { appPanel, builtScripts } from './previewPanel';
import { readingWorker } from './workerClient';

export async function activate(context: vscode.ExtensionContext) {
  const shell = vscode.extensions.getExtension<ShellApi>(SHELL_EXTENSION_ID);
  if (!shell) {
    void vscode.window.showWarningMessage('The React plugin needs Visual Editor. Install it, then reload the window.');
    return;
  }
  const api = await shell.activate();
  // The App panel in the Webview (its scripts are built next to this file).
  const scripts = builtScripts(__dirname);
  context.subscriptions.push(api.register({ ...reactPlugin, ...(scripts ? { previewPanels: [appPanel(scripts)] } : {}) }));
}

/** The reading worker stops with the extension. */
export function deactivate() {
  readingWorker.stop();
}
