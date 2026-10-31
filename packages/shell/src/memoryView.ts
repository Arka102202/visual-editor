// Memory inside VS Code: keeps each project's entries at hand, records reviewed changes, and shows the "Memory" list in
// the side panel (rules, decisions, recent changes) for the project on the map.

import * as vscode from 'vscode';
import type { Disposable } from '@visual-editor/contract';
import type { CurrentProject } from './currentProject';
import { changeEntry, MemoryStore, type EntryKind, type MemoryEntry, type Outcome } from './memory';
import type { ProjectIndex } from './projectIndex';
import type { Proposal } from './proposals';
import type { Draft } from './drafts';
import { PLAN_STEP, WAITING } from './hub/tools';

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

/** A design session, as the Memory section lists it: unfinished ones to work on again, finished ones as history. */
export interface SessionRow {
  id: string;
  title: string;
  /** Where it stands, in words (finished: how it ended). */
  state: 'being worked on' | 'no changes yet' | 'writing its test cases' | 'test cases waiting for you' | 'checks running' | 'held back' | 'sent to Review' | 'discarded';
  updatedAt: string;
  /** Finished: what became of its proposal (applied, rejected…), when known. */
  outcome?: string;
}

/** How many finished sessions History shows before "Show older". */
export const HISTORY_SHOWN = 20;
/** History this big gets a hint to clean it up. */
export const HISTORY_BIG = { sessions: 50, bytes: 100 * 1024 * 1024 };

const finished = (r: SessionRow) => r.state === 'sent to Review' || r.state === 'discarded';

type Node =
  | { kind: 'sessions'; rows: SessionRow[]; history: SessionRow[] }
  | { kind: 'history'; rows: SessionRow[] }
  | { kind: 'older'; count: number }
  | { kind: 'session'; row: SessionRow }
  | { kind: 'group'; group: 'rule' | 'decision' | 'change'; entries: MemoryEntry[]; waiting: Proposal[] }
  | { kind: 'entry'; entry: MemoryEntry }
  | { kind: 'waiting'; proposal: Proposal }
  | { kind: 'note'; text: string };

/** Each outcome's icon and colour (the theme's own chart colours): waiting yellow, applied green, rejected red… */
const LOOKS: Record<Outcome | 'waiting', { icon: string; colour?: string }> = {
  waiting: { icon: 'clock', colour: 'charts.yellow' },
  applied: { icon: 'check', colour: 'charts.green' },
  rejected: { icon: 'close', colour: 'charts.red' },
  'sent-back': { icon: 'reply', colour: 'charts.orange' },
  undone: { icon: 'discard', colour: 'disabledForeground' },
};
const icon = (look: { icon: string; colour?: string }) => new vscode.ThemeIcon(look.icon, look.colour ? new vscode.ThemeColor(look.colour) : undefined);

const GROUPS = {
  rule: { title: 'Rules', empty: 'No rules yet', icon: 'law' },
  decision: { title: 'Decisions', empty: 'No decisions yet', icon: 'milestone' },
  change: { title: 'Recent changes', empty: 'Reviewed changes appear here', icon: 'history' },
} as const;

/** Where a session's draft stands: its checks (for this version), or being worked on. */
export function sessionState(d: Draft): SessionRow['state'] {
  if (d.status === 'submitted') return 'sent to Review';
  if (d.status === 'discarded') return 'discarded';
  const c = d.check?.revision === d.revision ? d.check : undefined;
  if (!c) return d.changes.length ? 'being worked on' : 'no changes yet';
  if (c.step === PLAN_STEP || c.step === 'starting') return 'writing its test cases';
  if (c.step === WAITING) return 'test cases waiting for you';
  if (c.step === 'done') return c.held ? 'held back' : 'being worked on';
  return 'checks running';
}

/** Each session state's icon: needs you (yellow), held back (red), running (turning)… */
const SESSION_LOOKS: Record<SessionRow['state'], { icon: string; colour?: string }> = {
  'being worked on': { icon: 'edit' },
  'no changes yet': { icon: 'circle-outline', colour: 'disabledForeground' },
  'writing its test cases': { icon: 'sync~spin' },
  'test cases waiting for you': { icon: 'beaker', colour: 'charts.yellow' },
  'checks running': { icon: 'sync~spin' },
  'held back': { icon: 'warning', colour: 'charts.red' },
  'sent to Review': { icon: 'pass', colour: 'charts.green' },
  discarded: { icon: 'circle-slash', colour: 'disabledForeground' },
};

const OUTCOME_WORDS: Record<Outcome, string> = { applied: 'applied', 'sent-back': 'sent back', rejected: 'rejected', undone: 'undone' };

export class MemoryView implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly offs: Disposable[];
  /** Proposals waiting for review (from Review, given once it exists). */
  private waiting: ((root: string) => Proposal[]) | undefined;
  /** Design sessions, unfinished and finished (given once sessions exist). */
  private sessions: ((root: string) => SessionRow[]) | undefined;
  /** Sessions the clean-up helper suggests deleting (by project: id → why), and projects it's reading now. */
  private readonly suggestions = new Map<string, Map<string, string>>();
  private readonly cleaning = new Set<string>();
  /** History shown whole ("Show older"), by project. */
  private readonly allHistory = new Set<string>();
  /** How big the drafts folder is (by project), worked out at most once a minute. */
  private sizeOf: ((root: string) => number) | undefined;

  constructor(
    private readonly memory: ProjectMemory,
    private readonly current: CurrentProject,
  ) {
    this.offs = [memory.onChange(() => this.emitter.fire()), current.onChange(() => this.emitter.fire())];
  }

  /** Shows waiting proposals at the top of Recent changes (they come and go with Review). */
  setWaiting(list: (root: string) => Proposal[], onChange: (fn: () => void) => Disposable) {
    this.waiting = list;
    this.offs.push(onChange(() => this.emitter.fire()));
    this.emitter.fire();
  }

  /** Lists the design sessions before Recent changes (each opens again with a click); `size`: their room on disk. */
  setSessions(list: (root: string) => SessionRow[], size?: (root: string) => number) {
    this.sessions = list;
    this.sizeOf = size;
    this.emitter.fire();
  }

  /** The clean-up helper's suggestions for a project (undefined: none), and whether it's reading now. */
  setSuggestions(root: string, which: Map<string, string> | undefined) {
    if (which?.size) this.suggestions.set(root, which);
    else this.suggestions.delete(root);
    this.emitter.fire();
  }
  suggested(root: string): Map<string, string> {
    return this.suggestions.get(root) ?? new Map();
  }
  setCleaning(root: string, on: boolean) {
    if (on) this.cleaning.add(root);
    else this.cleaning.delete(root);
    this.emitter.fire();
  }

  /** History shows every finished session, not only the last ones. */
  showOlder() {
    const root = this.current.get()?.project.root;
    if (root) this.allHistory.add(root);
    this.emitter.fire();
  }

  /** Something about the sessions changed (a draft saved, removed…). */
  refresh() {
    this.emitter.fire();
  }

  getChildren(node?: Node): Node[] {
    const root = this.current.get()?.project.root;
    if (!root) return [{ kind: 'note', text: 'Open a folder to see its memory' }];
    if (!node) {
      const all = this.memory.entries(root);
      const groups = (['rule', 'decision', 'change'] as const).map((group): Node => ({
        kind: 'group',
        group,
        entries: all.filter((e) => e.kind === group).slice(0, group === 'change' ? RECENT : undefined),
        // Everything that needs the developer: to approve, test cases to run, held back.
        waiting: group === 'change' ? (this.waiting?.(root) ?? []).filter((p) => p.status === 'proposed' || p.status === 'awaiting-checks' || p.status === 'held-back') : [],
      }));
      // Sessions before Recent changes: what's still open to work on.
      if (!this.sessions) return groups;
      const sessions = this.sessions(root);
      return [groups[0], groups[1], { kind: 'sessions', rows: sessions.filter((r) => !finished(r)), history: sessions.filter(finished) }, groups[2]];
    }
    if (node.kind === 'sessions') {
      const rows: Node[] = node.rows.map((row) => ({ kind: 'session' as const, row }));
      if (!rows.length) rows.push({ kind: 'note', text: 'No unfinished sessions' });
      return node.history.length ? [...rows, { kind: 'history', rows: node.history }] : rows;
    }
    if (node.kind === 'history') {
      const all = this.allHistory.has(root);
      const shown = all ? node.rows : node.rows.slice(0, HISTORY_SHOWN);
      return [...shown.map((row) => ({ kind: 'session' as const, row })), ...(shown.length < node.rows.length ? [{ kind: 'older' as const, count: node.rows.length - shown.length }] : [])];
    }
    if (node.kind !== 'group') return [];
    const children: Node[] = [...node.waiting.map((proposal) => ({ kind: 'waiting' as const, proposal })), ...node.entries.map((entry) => ({ kind: 'entry' as const, entry }))];
    return children.length ? children : [{ kind: 'note', text: GROUPS[node.group].empty }];
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === 'note') {
      const item = new vscode.TreeItem(node.text);
      item.contextValue = 'none';
      return item;
    }
    const root = this.current.get()?.project.root ?? '';
    const suggested = this.suggested(root);
    if (node.kind === 'sessions') {
      const item = new vscode.TreeItem('Sessions', node.rows.length || suggested.size ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
      const needYou = node.rows.filter((r) => r.state === 'test cases waiting for you' || r.state === 'held back').length;
      const bytes = this.sizeOf?.(root) ?? 0;
      const big = node.history.length > HISTORY_BIG.sessions || bytes > HISTORY_BIG.bytes;
      item.description = this.cleaning.has(root)
        ? 'clean-up: reading them…'
        : suggested.size
          ? `${suggested.size} suggested to delete`
          : [needYou ? `${needYou} need you` : '', node.rows.length ? `${node.rows.length} open` : '', big ? 'history is getting big: try Clean up' : ''].filter(Boolean).join(' · ');
      item.iconPath = new vscode.ThemeIcon('paintcan');
      item.tooltip = `Design sessions: the unfinished ones (click one to work in it again), then History (finished: sent to Review or discarded, to look at). ✕ deletes one for good; ✨ suggests which to delete.${bytes ? ` They take ${(bytes / 1024 / 1024).toFixed(1)} MB.` : ''}`;
      item.contextValue = suggested.size ? 'sessions-suggested' : 'sessions';
      return item;
    }
    if (node.kind === 'history') {
      const item = new vscode.TreeItem('History', node.rows.some((r) => suggested.has(r.id)) ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
      item.description = String(node.rows.length);
      item.iconPath = new vscode.ThemeIcon('history');
      item.tooltip = 'Finished sessions, newest first: sent to Review or discarded. Click one to look at what was asked and done.';
      item.contextValue = 'sessions-history';
      return item;
    }
    if (node.kind === 'older') {
      const item = new vscode.TreeItem(`Show ${node.count} older`);
      item.iconPath = new vscode.ThemeIcon('ellipsis');
      item.command = { command: 'visualEditor.showOlderSessions', title: 'Show older sessions' };
      item.contextValue = 'none';
      return item;
    }
    if (node.kind === 'session') {
      const r = node.row;
      const why = suggested.get(r.id);
      const item = new vscode.TreeItem(r.title.replace(/^Design session: /, ''));
      const state = r.outcome ? `${r.state} · ${r.outcome}` : r.state;
      item.description = why ? `suggested to delete: ${why}` : `${state} · ${new Date(r.updatedAt).toLocaleDateString()}`;
      item.iconPath = why ? new vscode.ThemeIcon('trash', new vscode.ThemeColor('charts.red')) : icon(SESSION_LOOKS[r.state]);
      item.tooltip = new vscode.MarkdownString(
        [`**${r.title}**`, finished(r) ? `Finished: ${state}. Last changed ${new Date(r.updatedAt).toLocaleString()}.` : `It is ${r.state}. Last changed ${new Date(r.updatedAt).toLocaleString()}.`, why ? `Suggested to delete: ${why}` : '', finished(r) ? 'Click to look at it (what was asked, each version, how it ended).' : 'Click to open its tab and work in it again.', '✕ deletes it for good.'].filter(Boolean).join('\n\n'),
      );
      item.command = { command: 'visualEditor.openSession', title: 'Open the session', arguments: [r.id] };
      item.contextValue = why ? 'session-suggested' : 'session';
      return item;
    }
    if (node.kind === 'group') {
      const g = GROUPS[node.group];
      // Recent changes opens by itself when something is waiting for review.
      const open = node.group !== 'change' || node.waiting.length > 0;
      const item = new vscode.TreeItem(g.title, open ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
      item.description = node.waiting.length ? `${node.waiting.length} need${node.waiting.length === 1 ? 's' : ''} you · ${node.entries.length}` : node.entries.length ? String(node.entries.length) : '';
      item.iconPath = new vscode.ThemeIcon(g.icon);
      item.contextValue = `group-${node.group}`;
      return item;
    }
    if (node.kind === 'waiting') {
      const p = node.proposal;
      const item = new vscode.TreeItem(p.title);
      const how =
        p.status === 'awaiting-checks'
          ? { words: 'test cases waiting for you to run', look: { icon: 'beaker', colour: 'charts.purple' }, tip: 'Its test cases wait for you: look at them, change them if you like, and run them. Click to open it in Review.' }
          : p.status === 'held-back'
            ? { words: 'held back: fix, bypass or run again', look: { icon: 'warning', colour: 'charts.red' }, tip: 'A check held it back: fix it with Claude, bypass the check (with why), or run its checks again. Click to open it in Review.' }
            : { words: 'waiting for you', look: LOOKS.waiting, tip: 'Waiting for your review: click to open it in Review.' };
      item.description = `${how.words} · ${p.by.name} · ${new Date(p.createdAt).toLocaleDateString()}`;
      item.iconPath = icon(how.look);
      item.tooltip = new vscode.MarkdownString([`**${p.title}**`, p.why ?? '', how.tip].filter(Boolean).join('\n\n'));
      item.command = { command: 'visualEditor.openReview', title: 'Open in Review', arguments: [p.id] };
      item.contextValue = 'waiting';
      return item;
    }
    const e = node.entry;
    const item = new vscode.TreeItem(e.text);
    const when = new Date(e.at).toLocaleDateString();
    if (e.kind === 'change') {
      item.description = `${OUTCOME_WORDS[e.outcome ?? 'applied']} · ${e.by.name} · ${when}`;
      item.iconPath = icon(LOOKS[e.outcome ?? 'applied']);
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
