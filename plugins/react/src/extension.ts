// The React plugin for Visual Editor: registers with the shell, which then reads React projects with it.

import * as vscode from 'vscode';
import { SHELL_EXTENSION_ID, type ShellApi } from '@visual-editor/contract';
import { drawings, reactPlugin } from './plugin';
import { readingWorker } from './workerClient';

export async function activate(context: vscode.ExtensionContext) {
  const shell = vscode.extensions.getExtension<ShellApi>(SHELL_EXTENSION_ID);
  if (!shell) {
    void vscode.window.showWarningMessage('The React plugin needs Visual Editor. Install it, then reload the window.');
    return;
  }
  const api = await shell.activate();
  context.subscriptions.push(api.register(reactPlugin));
}

/** The reading worker, and the dev servers Visual Editor started for previews, stop with the extension. */
export async function deactivate() {
  readingWorker.stop();
  await drawings.stop();
}
