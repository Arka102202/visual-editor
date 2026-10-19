// The React plugin for Visual Editor: registers with the shell, which then reads React projects with it.

import * as vscode from 'vscode';
import { SHELL_EXTENSION_ID, type ShellApi } from '@visual-editor/contract';
import { previews, reactPlugin } from './plugin';
import { forgetRecordings } from './preview/recordings';
import { readingWorker } from './workerClient';

const LIVE_KEY = (root: string) => `visualEditor.react.live:${root}`;
const TOKEN_KEY = (root: string) => `visualEditor.react.devToken:${root}`;

export async function activate(context: vscode.ExtensionContext) {
  const shell = vscode.extensions.getExtension<ShellApi>(SHELL_EXTENSION_ID);
  if (!shell) {
    void vscode.window.showWarningMessage('The React plugin needs Visual Editor. Install it, then reload the window.');
    return;
  }
  // Previews run the project's dev server (its own code): only in folders the developer trusts.
  previews.trusted = () => vscode.workspace.isTrusted;
  // The live backend situation calls the developer's real dev backend: asked once per project, remembered.
  previews.allowLive = async (root) => {
    if (context.workspaceState.get<boolean>(LIVE_KEY(root))) return true;
    const pick = await vscode.window.showWarningMessage(
      'Let previews call your real dev backend?',
      {
        modal: true,
        detail:
          'In the "live backend" situation, previews send their requests to your own dev backend (the one your dev setup uses) and keep the data replies on this computer (.visual-editor/preview, never committed), so "normal" can show real data later. Logins, cookies and tokens are never written to files. You can forget the recordings any time: Command Palette → "Visual Editor: Forget Recorded Replies and Token".',
      },
      'Allow',
    );
    if (pick !== 'Allow') return false;
    await context.workspaceState.update(LIVE_KEY(root), true);
    return true;
  };
  previews.token = async (root) => context.secrets.get(TOKEN_KEY(root));

  context.subscriptions.push(
    vscode.commands.registerCommand('visualEditor.react.setDevToken', async () => {
      const root = await pickRoot();
      if (!root) return;
      const token = await vscode.window.showInputBox({
        title: 'Dev login token for previews',
        prompt: 'Added as "Authorization: Bearer …" only to requests that stay on this computer, in the live backend situation. Kept in VS Code\'s secret storage. Leave empty to remove it.',
        password: true,
        ignoreFocusOut: true,
      });
      if (token === undefined) return;
      if (token.trim()) await context.secrets.store(TOKEN_KEY(root), token.trim());
      else await context.secrets.delete(TOKEN_KEY(root));
      void vscode.window.showInformationMessage(token.trim() ? 'Dev token kept. Choose "live backend" in a preview to use it.' : 'Dev token removed.');
    }),
    vscode.commands.registerCommand('visualEditor.react.forgetLive', async () => {
      const root = await pickRoot();
      if (!root) return;
      forgetRecordings(root);
      await context.secrets.delete(TOKEN_KEY(root));
      await context.workspaceState.update(LIVE_KEY(root), undefined);
      void vscode.window.showInformationMessage('Recorded replies, the dev token and the permission to call your backend are forgotten for this project. (A login made inside a preview ends when its cookie expires or you log out there.)');
    }),
  );

  /** The React project these commands are for: the only one, or the one the developer picks. */
  async function pickRoot(): Promise<string | undefined> {
    const roots = previews.roots();
    if (!roots.length) return void vscode.window.showInformationMessage('No React project is open.');
    if (roots.length === 1) return roots[0];
    const pick = await vscode.window.showQuickPick(roots.map((root) => ({ label: vscode.workspace.asRelativePath(root) || root, root })), { placeHolder: 'Which React project?' });
    return pick?.root;
  }

  const api = await shell.activate();
  context.subscriptions.push(api.register(reactPlugin));
  // The VS Code test reaches inside; never switched on otherwise.
  if (process.env.VISUAL_EDITOR_TEST === '1') return { previews };
  return undefined;
}

/** The dev servers Visual Editor started for previews stop with it. */
export function deactivate() {
  readingWorker.stop();
  return previews.stopAll();
}
