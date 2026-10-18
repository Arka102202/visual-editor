// Review: every change waits here for the developer's OK. Proposals come from the project's .visual-editor/proposals/
// folder; the Review tab shows what would change and why; Approve applies all of it (or none), Send back and Reject
// keep a note, and an applied change can be undone. The map marks the cards a waiting proposal would change.

import * as vscode from 'vscode';
import { webviewPage } from './webviewPage';
import { join } from 'node:path';
import type { Disposable } from '@visual-editor/contract';
import type { OutsideChanges } from './changes';
import type { CurrentProject } from './currentProject';
import type { ProjectMemory } from './memoryView';
import { counts, hunks } from './diff';
import { apply, conflicts, newId, ProposalStore, undo, undoConflicts, type Files, type Proposal } from './proposals';
import type { ProjectIndex } from './projectIndex';
import type { FromReview, ReviewItem, ToReview } from './reviewMessages';

export class Review implements vscode.Disposable {
  private readonly stores = new Map<string, ProposalStore>();
  private readonly cache = new Map<string, Proposal[]>();
  private readonly listeners = new Set<() => void>();
  private panel: vscode.WebviewPanel | undefined;
  private ready = false;
  private selected: string | undefined;
  private readonly subscriptions: vscode.Disposable[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly index: ProjectIndex,
    private readonly current: CurrentProject,
    private readonly changes: OutsideChanges,
    private readonly memory: ProjectMemory,
  ) {
    // Reading proposals when the projects are known; new ones that arrive later are announced.
    this.subscriptions.push(
      index.onChange(() => this.loadNewProjects()),
      current.onChange(() => void this.send()),
    );
  }

  /** Proposals in a project, newest first. */
  proposals(root: string): Proposal[] {
    return this.cache.get(root) ?? [];
  }

  /** Waiting proposals across all projects. */
  waiting(): number {
    let n = 0;
    for (const list of this.cache.values()) n += list.filter((p) => p.status === 'proposed').length;
    return n;
  }

  /** Called whenever proposals come, go or change status. */
  onChange(fn: () => void): Disposable {
    this.listeners.add(fn);
    return { dispose: () => this.listeners.delete(fn) };
  }

  /** A proposal file was added, changed or removed (absolute path). */
  proposalFileChanged(path: string) {
    const root = [...this.stores.keys()].find((r) => path.startsWith(this.stores.get(r)!.dir));
    if (root) this.reload(root, true);
  }

  /** Opens the Review tab, or brings it to the front; optionally showing one proposal. */
  show(id?: string) {
    if (id) this.selected = id;
    if (this.panel) {
      this.panel.reveal();
      void this.send();
      return;
    }
    const dist = vscode.Uri.joinPath(this.extensionUri, 'dist');
    const panel = vscode.window.createWebviewPanel('visualEditor.review', 'Review', vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [dist],
    });
    panel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'media', 'icon.svg');
    panel.webview.html = webviewPage(panel.webview, vscode.Uri.joinPath(dist, 'review.js'), 'Review');
    panel.webview.onDidReceiveMessage((m: FromReview) => void this.receive(m), undefined, this.subscriptions);
    panel.onDidDispose(() => {
      this.panel = undefined;
      this.ready = false;
    });
    this.panel = panel;
  }

  /** Makes an example proposal in the shown project, to try review without an assistant. */
  async tryExample() {
    const state = this.current.get();
    if (!state) {
      void vscode.window.showInformationMessage('Open a folder first.');
      return;
    }
    const files = this.files(state.project.root);
    const before = (await files.read('README.md')) ?? null;
    const scripts = state.project.packageJson?.scripts ?? {};
    const run = scripts.dev ? 'npm run dev' : scripts.start ? 'npm start' : 'npm run build';
    const section = `## How to run\n\n\`\`\`\nnpm install\n${run}\n\`\`\`\n`;
    const after = before === null ? `# ${state.project.name}\n\n${section}` : `${before.replace(/\s*$/, '')}\n\n${section}`;
    const p: Proposal = {
      id: newId(),
      title: 'Add "How to run" to the README',
      why: 'New people on the project look for how to start it first. This is an example proposal, made to try Review.',
      by: { kind: 'developer', name: 'Try Review' },
      createdAt: new Date().toISOString(),
      status: 'proposed',
      changes: [{ path: 'README.md', before, after }],
      items: ['hello:card'],
      history: [{ at: new Date().toISOString(), status: 'proposed' }],
    };
    this.store(state.project.root).save(p);
    this.reload(state.project.root, false);
    this.show(p.id);
  }

  dispose() {
    this.panel?.dispose();
    for (const s of this.subscriptions) s.dispose();
    this.listeners.clear();
  }

  private store(root: string): ProposalStore {
    let s = this.stores.get(root);
    if (!s) {
      s = new ProposalStore(root);
      this.stores.set(root, s);
    }
    return s;
  }

  private loadNewProjects() {
    const roots = new Set(this.index.snapshot().map((s) => s.project.root));
    let changed = false;
    for (const root of roots) {
      if (this.cache.has(root)) continue;
      this.cache.set(root, this.store(root).list());
      changed = true;
    }
    for (const root of [...this.cache.keys()]) {
      if (!roots.has(root)) {
        this.cache.delete(root);
        this.stores.delete(root);
        changed = true;
      }
    }
    if (changed) this.fire();
  }

  private reload(root: string, announce: boolean) {
    const before = new Set(this.proposals(root).filter((p) => p.status === 'proposed').map((p) => p.id));
    const list = this.store(root).list();
    this.cache.set(root, list);
    this.fire();
    if (!announce) return;
    for (const p of list.filter((p) => p.status === 'proposed' && !before.has(p.id))) {
      void vscode.window.showInformationMessage(`New proposal: ${p.title} (by ${p.by.name})`, 'Review').then((pick) => {
        if (pick) {
          this.current.choose(root);
          this.show(p.id);
        }
      });
    }
  }

  private fire() {
    for (const fn of this.listeners) fn();
    void this.send();
  }

  private async receive(m: FromReview) {
    if (m.type === 'ready') {
      this.ready = true;
      return this.send();
    }
    if (m.type === 'try') return this.tryExample();
    const root = this.current.get()?.project.root;
    if (!root) return;
    if (m.type === 'open') {
      const line = Math.max(0, (m.line ?? 1) - 1);
      await vscode.window.showTextDocument(vscode.Uri.file(join(root, m.path)), { selection: new vscode.Range(line, 0, line, 0), viewColumn: vscode.ViewColumn.Beside });
      return;
    }
    this.selected = m.id;
    if (m.type === 'select') return this.send();
    const store = this.store(root);
    const p = store.get(m.id);
    if (!p) return;
    const files = this.files(root);
    try {
      if (m.type === 'approve') {
        if (p.status !== 'proposed') return;
        const why = await conflicts(p, files);
        if (why.length) {
          const pick = await vscode.window.showWarningMessage(`Can't apply "${p.title}" as it stands`, { modal: true, detail: why.join('\n') }, 'Send back');
          if (pick) {
            const note = `The files changed since it was proposed: ${why.join(' ')}`;
            store.mark(p, 'sent-back', note);
            this.memory.recordReview(root, p, 'sent-back', note);
          }
        } else {
          await apply(p, files);
          store.mark(p, 'applied');
          this.memory.recordReview(root, p, 'applied');
          void vscode.window.showInformationMessage(`Applied: ${p.title}`, 'Undo').then((pick) => pick && this.receive({ type: 'undo', id: p.id }));
        }
      } else if (m.type === 'undo') {
        const latest = store.get(p.id);
        if (latest?.status !== 'applied') return;
        const why = await undoConflicts(latest, files);
        if (why.length) {
          void vscode.window.showWarningMessage(`Can't undo "${p.title}": the files changed after it was applied.`, { modal: true, detail: why.join('\n') });
        } else {
          await undo(latest, files);
          store.mark(latest, 'undone');
          this.memory.recordReview(root, latest, 'undone');
        }
      } else if (m.type === 'sendBack' || m.type === 'reject') {
        if (p.status !== 'proposed') return;
        const note = await vscode.window.showInputBox({
          title: m.type === 'sendBack' ? `Send back: ${p.title}` : `Reject: ${p.title}`,
          prompt: m.type === 'sendBack' ? `What should change? ${p.by.name} gets this note.` : 'Why not? (optional, kept in the history)',
          ignoreFocusOut: true,
        });
        if (note === undefined) return;
        if (m.type === 'sendBack' && !note.trim()) {
          void vscode.window.showInformationMessage('Say what should change, so it can be done better.');
          return;
        }
        const outcome = m.type === 'sendBack' ? 'sent-back' : 'rejected';
        store.mark(p, outcome, note.trim() || undefined);
        this.memory.recordReview(root, p, outcome, note.trim() || undefined);
      }
    } catch (e) {
      void vscode.window.showErrorMessage(`${p.title}: ${e instanceof Error ? e.message : String(e)}`);
    }
    this.reload(root, false);
  }

  private async send() {
    if (!this.panel || !this.ready) return;
    const state = this.current.get();
    const root = state?.project.root;
    const list = root ? this.proposals(root) : [];
    const files = root ? this.files(root) : undefined;
    const items: ReviewItem[] = [];
    for (const p of list) {
      items.push({
        id: p.id,
        title: p.title,
        why: p.why,
        by: p.by,
        createdAt: p.createdAt,
        status: p.status,
        history: p.history,
        files: p.changes.map((c) => ({
          path: c.path,
          kind: c.before === null ? 'new' : c.after === null ? 'removed' : 'changed',
          ...counts(c.before, c.after),
          hunks: hunks(c.before, c.after),
        })),
        conflicts: files ? (p.status === 'proposed' ? await conflicts(p, files) : p.status === 'applied' ? await undoConflicts(p, files) : []) : [],
      });
    }
    if (!this.selected || !items.some((i) => i.id === this.selected)) this.selected = (items.find((i) => i.status === 'proposed') ?? items[0])?.id;
    const message: ToReview = { type: 'show', project: state?.project.name, items, selected: this.selected, problems: root ? this.store(root).problems : [] };
    this.panel.title = `Review${state ? ` · ${state.project.name}` : ''}`;
    void this.panel.webview.postMessage(message);
  }

  /** File access through VS Code: open files are read as shown and edited in place, so editor undo works too. */
  private files(root: string): Files {
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
        this.changes.expectWrite(u.fsPath);
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
        this.changes.expectWrite(u.fsPath);
        await vscode.workspace.fs.delete(u, { useTrash: true });
      },
    };
  }
}
