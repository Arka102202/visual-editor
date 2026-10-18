// File access through VS Code, for applying proposals and for assistants reading files: open files are read as the
// developer sees them (unsaved edits included) and edited in place, so editor undo works too.

import * as vscode from 'vscode';
import { join } from 'node:path';
import type { OutsideChanges } from './changes';
import type { Files } from './proposals';

export function vscodeFiles(root: string, changes: OutsideChanges): Files {
  const uri = (path: string) => vscode.Uri.file(join(root, path));
  const exists = async (u: vscode.Uri) => {
    try {
      await vscode.workspace.fs.stat(u);
      return true;
    } catch {
      return false;
    }
  };
  return {
    read: async (path) => {
      const u = uri(path);
      const open = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === u.fsPath);
      if (open) return open.getText();
      try {
        return new TextDecoder().decode(await vscode.workspace.fs.readFile(u));
      } catch {
        return undefined;
      }
    },
    write: async (path, text) => {
      const u = uri(path);
      changes.expectWrite(u.fsPath);
      if (!(await exists(u))) {
        await vscode.workspace.fs.writeFile(u, new TextEncoder().encode(text));
        return;
      }
      const doc = await vscode.workspace.openTextDocument(u);
      const edit = new vscode.WorkspaceEdit();
      edit.replace(u, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), text);
      if (!(await vscode.workspace.applyEdit(edit))) throw new Error(`Couldn't change ${path}.`);
      if (!(await doc.save())) throw new Error(`Couldn't save ${path}.`);
    },
    remove: async (path) => {
      const u = uri(path);
      changes.expectWrite(u.fsPath);
      await vscode.workspace.fs.delete(u, { useTrash: true });
    },
  };
}
