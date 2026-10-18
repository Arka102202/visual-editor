// Memory inside VS Code: keeps each project's entries at hand, records reviewed changes, and shows the "Memory" list in
// the side panel (rules, decisions, recent changes) for the project on the map.

import * as vscode from 'vscode';
import type { Disposable } from '@visual-editor/contract';
import type { CurrentProject } from './currentProject';
import { changeEntry, MemoryStore, type EntryKind, type MemoryEntry, type Outcome } from './memory';
import type { ProjectIndex } from './projectIndex';
import type { Proposal } from './proposals';

/** How many recent changes the list shows. */
const RECENT = 30;

export class ProjectMemory {
  private readonly stores = new Map<string, MemoryStore>();
  private readonly cache = new Map<string, MemoryEntry[]>();
  private readonly listeners = new Set<() => void>();

  constructor(private readonly index: ProjectIndex) {}

  entries(root: string): MemoryEntry[] {
    let list = this.cache.get(root);
    if (!list) {
      list = this.store(root).list();
      this.cache.set(root, list);
    }
    return list;
  }

  /** Remembers what happened to a reviewed proposal. */
  recordReview(root: string, p: Proposal, outcome: Outcome, note?: string) {
    const paths = new Set(p.changes.map((c) => c.path));
    const touched = (this.index.snapshot().find((s) => s.project.root === root)?.items ?? []).filter((i) => i.source && paths.has(i.source.path)).map((i) => i.id);
    this.store(root).save(changeEntry(p, outcome, touched, note));
    this.reload(root);
  }

  add(root: string, kind: Exclude<EntryKind, 'change'>, text: string, about?: { detail?: string; paths?: string[]; items?: string[] }) {
    this.store(root).add(kind, text, about);
    this.reload(root);
  }

  update(root: string, e: MemoryEntry) {
    this.store(root).save(e);
    this.reload(root);
  }

  remove(root: string, id: string) {
    this.store(root).remove(id);
    this.reload(root);
  }

  /** An entry file was added, changed or removed (absolute path). */
  fileChanged(path: string) {
    for (const [root, store] of this.stores) if (path.startsWith(store.dir)) this.reload(root);
  }

  onChange(fn: () => void): Disposable {
    this.listeners.add(fn);
    return { dispose: () => this.listeners.delete(fn) };
  }

  private store(root: string): MemoryStore {
    let s = this.stores.get(root);
    if (!s) {
      s = new MemoryStore(root);
      this.stores.set(root, s);
    }
    return s;
  }

  private reload(root: string) {
    this.cache.set(root, this.store(root).list());
    for (const fn of this.listeners) fn();
  }
}

type Node = { kind: 'group'; group: 'rule' | 'decision' | 'change'; entries: MemoryEntry[] } | { kind: 'entry'; entry: MemoryEntry } | { kind: 'note'; text: string };

const GROUPS = {
  rule: { title: 'Rules', empty: 'No rules yet', icon: 'law' },
  decision: { title: 'Decisions', empty: 'No decisions yet', icon: 'milestone' },
  change: { title: 'Recent changes', empty: 'Reviewed changes appear here', icon: 'history' },
} as const;

const OUTCOME_WORDS: Record<Outcome, string> = { applied: 'applied', 'sent-back': 'sent back', rejected: 'rejected', undone: 'undone' };

export class MemoryView implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly offs: Disposable[];

  constructor(
    private readonly memory: ProjectMemory,
    private readonly current: CurrentProject,
  ) {
    this.offs = [memory.onChange(() => this.emitter.fire()), current.onChange(() => this.emitter.fire())];
  }

  getChildren(node?: Node): Node[] {
    const root = this.current.get()?.project.root;
    if (!root) return [{ kind: 'note', text: 'Open a folder to see its memory' }];
    if (!node) {
      const all = this.memory.entries(root);
      return (['rule', 'decision', 'change'] as const).map((group) => ({
        kind: 'group',
        group,
        entries: all.filter((e) => e.kind === group).slice(0, group === 'change' ? RECENT : undefined),
      }));
    }
    if (node.kind !== 'group') return [];
    return node.entries.length ? node.entries.map((entry) => ({ kind: 'entry', entry })) : [{ kind: 'note', text: GROUPS[node.group].empty }];
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === 'note') {
      const item = new vscode.TreeItem(node.text);
      item.contextValue = 'none';
      return item;
    }
    if (node.kind === 'group') {
      const g = GROUPS[node.group];
      const item = new vscode.TreeItem(g.title, node.group === 'change' ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.Expanded);
      item.description = node.entries.length ? String(node.entries.length) : '';
      item.iconPath = new vscode.ThemeIcon(g.icon);
      item.contextValue = `group-${node.group}`;
      return item;
    }
    const e = node.entry;
    const item = new vscode.TreeItem(e.text);
    const when = new Date(e.at).toLocaleDateString();
    if (e.kind === 'change') {
      item.description = `${OUTCOME_WORDS[e.outcome ?? 'applied']} · ${e.by.name} · ${when}`;
      item.iconPath = new vscode.ThemeIcon(e.outcome === 'applied' ? 'check' : e.outcome === 'undone' ? 'discard' : e.outcome === 'rejected' ? 'close' : 'reply');
      if (e.proposal) item.command = { command: 'visualEditor.openReview', title: 'Open in Review', arguments: [e.proposal] };
    } else {
      item.description = e.kind === 'note' ? 'note' : when;
      item.iconPath = new vscode.ThemeIcon(e.kind === 'rule' ? 'law' : e.kind === 'decision' ? 'milestone' : 'note');
      item.command = { command: 'visualEditor.editMemory', title: 'Edit', arguments: [{ kind: 'entry', entry: e }] };
    }
    item.tooltip = new vscode.MarkdownString(
      [`**${e.text}**`, e.detail, e.note ? `Your note: “${e.note}”` : '', e.paths?.length ? `Files: ${e.paths.join(', ')}` : '', `${e.by.name} · ${new Date(e.at).toLocaleString()}`].filter(Boolean).join('\n\n'),
    );
    item.contextValue = `entry-${e.kind}`;
    return item;
  }

  dispose() {
    for (const off of this.offs) off.dispose();
    this.emitter.dispose();
  }
}

/** Asks for a rule, decision or note (new, or editing one), in plain words. */
export async function askEntry(kind: Exclude<EntryKind, 'change'>, old?: MemoryEntry): Promise<{ text: string; detail?: string } | undefined> {
  const prompts = {
    rule: { title: 'A rule for this project', placeHolder: 'e.g. Use the theme colours, never fixed ones', detail: undefined },
    decision: { title: 'A decision', placeHolder: 'e.g. We keep server state in React Query', detail: 'Why? (optional)' },
    note: { title: 'A note', placeHolder: 'e.g. Keep this card simple: it shows on every page', detail: undefined },
  }[kind];
  const text = await vscode.window.showInputBox({ title: prompts.title, placeHolder: prompts.placeHolder, value: old?.text, ignoreFocusOut: true });
  if (!text?.trim()) return undefined;
  let detail: string | undefined;
  if (prompts.detail) {
    detail = await vscode.window.showInputBox({ title: prompts.title, prompt: prompts.detail, value: old?.detail, ignoreFocusOut: true });
    if (detail === undefined) return undefined;
  }
  return { text: text.trim(), ...(detail?.trim() ? { detail: detail.trim() } : {}) };
}
