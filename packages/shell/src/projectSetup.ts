// What plugins keep in place in a project (React: Visual Editor's helper and the short name it's imported by): written
// as soon as a project is detected, once per session, so a newer extension's files arrive on its first start. The
// developer chose this to happen without review; a notice says what was written. A file that changed since the plugin
// read it is left alone.

import * as vscode from 'vscode';
import { dirname, join } from 'node:path';
import type { OutsideChanges } from './changes';
import type { ProjectIndex } from './projectIndex';
import { vscodeFiles } from './vscodeFiles';

export class ProjectSetups implements vscode.Disposable {
  private readonly done = new Set<string>();
  private readonly subscriptions: vscode.Disposable[] = [];

  constructor(
    private readonly index: ProjectIndex,
    private readonly changes: OutsideChanges,
    private readonly log: vscode.OutputChannel,
  ) {
    const off = index.onChange(() => void this.runNew());
    this.subscriptions.push({ dispose: () => off.dispose() });
  }

  /** Sets up every project not set up yet this session. */
  async runNew() {
    for (const s of this.index.snapshot()) {
      if (this.done.has(s.project.root) || !s.detected.length) continue;
      this.done.add(s.project.root);
      await this.run(s.project.root);
    }
  }

  /** Sets up one project now (also from Preview's Update button). */
  async run(root: string, quietWhenNothing = true) {
    const state = this.index.snapshot().find((s) => s.project.root === root);
    if (!state) return;
    const files = vscodeFiles(root, this.changes);
    for (const { plugin } of state.detected) {
      let setup;
      try {
        setup = plugin.setup?.(state.project);
      } catch (e) {
        this.log.appendLine(`${plugin.name}: setting up ${state.project.name} failed: ${e instanceof Error ? e.message : String(e)}`);
        continue;
      }
      if (!setup) {
        if (!quietWhenNothing && plugin.setup) void vscode.window.showInformationMessage(`${plugin.name}: everything Visual Editor needs is in place.`);
        continue;
      }
      const written: string[] = [];
      for (const c of setup.changes) {
        const now = (await files.read(c.path)) ?? null;
        if (now !== c.before) {
          this.log.appendLine(`${plugin.name}: left ${c.path} alone (it changed while being set up).`);
          continue;
        }
        if (c.before === null) await vscode.workspace.fs.createDirectory(vscode.Uri.file(dirname(join(root, c.path))));
        await files.write(c.path, c.after);
        written.push(c.path);
      }
      if (written.length && setup.said) {
        this.log.appendLine(`${state.project.name}: ${setup.said}`);
        const pick = await vscode.window.showInformationMessage(setup.said, 'Show');
        if (pick) await vscode.window.showTextDocument(vscode.Uri.file(join(root, written[0])));
      }
      for (const p of setup.problems ?? []) void vscode.window.showWarningMessage(`${plugin.name}: ${p}`);
    }
  }

  dispose() {
    for (const s of this.subscriptions) s.dispose();
  }
}
