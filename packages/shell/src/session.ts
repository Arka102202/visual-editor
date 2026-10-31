// Design sessions: a tab in the middle that follows one draft live while the developer and Claude (in the developer's
// own Claude Code chat) work on it. It shows the draft running in its own app (a card's Playground: every design in
// every state, or one state at a screen size), "What you asked", the versions to go back to, and Done (the draft goes
// to Review the one way, with all its checks) or Discard. Visual Editor has no chat of its own.

import * as vscode from 'vscode';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Item } from '@visual-editor/contract';
import { cardsTouched, draftItems } from './draftItems';
import { DRAFTS_DIR, DraftStore, type Draft } from './drafts';
import { bypassProof, failedChecks, whyFailed } from './proposals';
import { asItIs, planView, type PlanEdits } from './hub/checkPlan';
import { PLAN_STEP, WAITING } from './hub/tools';
import type { ClosedSession, SessionNote } from './hub/claudeLock';
import type { ProjectState } from './projectIndex';
import type { Proposal } from './proposals';
import type { FromSession, SessionCard, SessionView, ToSession } from './sessionMessages';
import { webviewPage } from './webviewPage';

/** A kind of session, as started: the plugin's kind, its brief for what was chosen, and the choices. */
export interface StartKind {
  id: string;
  title: string;
  brief: string;
  name?: string;
  page?: string;
  design?: string;
}

/** The session Claude works in for a project (with its kind's brief), and the others open. */
export interface OpenSessions {
  draft: string;
  title: string;
  brief?: string;
  others?: { draft: string; title: string }[];
  /** Its version now was held back by its checks: why. */
  held?: string;
}

export interface SessionHost {
  project(root: string): ProjectState | undefined;
  read(root: string, path: string): Promise<string | undefined>;
  /** The draft's own app (started, or the running one updated to this version); its address. */
  openApp(root: string, draft: Draft, previewPage: (itemId: string) => string | undefined): Promise<string>;
  /** Sends the draft to Review the one way (its checks, the logic check); a string says why it wasn't sent. */
  /** Done: the draft's test cases are written (in the background), for the developer to run. */
  plan(root: string, id: string): void;
  /** Runs the draft's test cases as the developer left them; a string says why they can't run now. */
  run(root: string, id: string, edits: PlanEdits): string | undefined;
  openReview(proposal: string): void;
  /** Marks a proposal as being changed in a session (its draft), or not any more. */
  markProposal(root: string, proposal: string, draft: string | undefined): void;
  /** Whether Claude Code is told about open sessions by itself (connected, with Visual Editor's hooks in the folder). */
  claudeTold?(root: string): boolean;
}

interface Tab {
  root: string;
  id: string;
  panel: vscode.WebviewPanel;
  ready: boolean;
  /** The version the app shows now. */
  revision?: number;
  app?: string;
  progress?: string;
  error?: string;
  status: SessionView['status'];
  /** The cards it shows (kept between updates). */
  cards: Item[];
  /** Show the test cases' window again with the next update (Done pressed again). */
  showPlan?: boolean;
  /** Updates run one after another (saves can come quickly). */
  queue: Promise<void>;
}

/** Where the open session is noted for Claude Code's check (claudeGuard.ts reads it with each of the developer's messages). */
export const SESSION_NOTE = `${DRAFTS_DIR}/.session`;

export class Sessions implements vscode.Disposable {
  private readonly tabs = new Map<string, Tab>();
  /** The session last looked at, by project: the one Claude works in. */
  private readonly latest = new Map<string, string>();
  private readonly subscriptions: vscode.Disposable[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly host: SessionHost,
  ) {}

  /** Starts a design session: a new draft (nothing changed yet), about a card if one is given, shown in its tab. */
  start(root: string, card?: Item, asked?: string, kind?: StartKind): Draft {
    const now = new Date().toISOString();
    const id = `${now.replace(/\D/g, '').slice(0, 14)}-${Math.random().toString(36).slice(2, 7)}`;
    const about = card?.label ?? kind?.name ?? kind?.page;
    const draft: Draft = {
      id,
      title: kind ? `${kind.title}${about ? `: ${about}` : ''}` : card ? `Design session: ${card.label}` : 'Design session',
      why: '',
      by: { kind: 'assistant', name: 'Design session' },
      createdAt: now,
      updatedAt: now,
      status: 'draft',
      changes: [],
      ...(card ? { items: [card.id] } : {}),
      asked: asked ? [asked] : [],
      revision: 1,
      evidence: [],
      session: {
        ...(card ? { card: card.id } : {}),
        openedAt: now,
        ...(kind ? { kind: { id: kind.id, title: kind.title, brief: kind.brief } } : {}),
        ...(kind?.name ? { name: kind.name } : {}),
        ...(kind?.page ? { page: kind.page } : {}),
        ...(kind?.design ? { design: kind.design } : {}),
      },
    };
    new DraftStore(root).save(draft);
    this.open(root, id);
    return draft;
  }

  /**
   * Continues a proposal in a design session: a draft that starts with its changes and what was asked; Done puts the
   * result back into the same proposal. A proposal already in a session shows that session.
   */
  continueProposal(root: string, p: Proposal) {
    const store = new DraftStore(root);
    const open = p.session ? store.list().find((d) => d.id === p.session && d.status === 'draft') : undefined;
    if (open) return this.open(root, open.id);
    const now = new Date().toISOString();
    const id = `${now.replace(/\D/g, '').slice(0, 14)}-${Math.random().toString(36).slice(2, 7)}`;
    store.save({
      id,
      title: p.title,
      why: p.why ?? '',
      by: { kind: 'assistant', name: 'Design session' },
      createdAt: now,
      updatedAt: now,
      status: 'draft',
      changes: p.changes,
      ...(p.items ? { items: p.items } : {}),
      asked: p.asked?.length ? p.asked : [p.title],
      ...(p.cases?.length ? { cases: p.cases } : {}),
      revision: 1,
      evidence: [],
      session: { proposal: p.id, openedAt: now },
    });
    this.host.markProposal(root, p.id, id);
    this.open(root, id);
  }

  /** Shows a session's tab (opened now, or brought to the front). */
  open(root: string, id: string) {
    const key = `${root}#${id}`;
    const had = this.tabs.get(key);
    if (had) {
      had.panel.reveal();
      return;
    }
    const draft = new DraftStore(root).list().find((d) => d.id === id);
    const dist = vscode.Uri.joinPath(this.extensionUri, 'dist');
    const panel = vscode.window.createWebviewPanel('visualEditor.session', `Session · ${(draft?.title ?? 'Design session').replace(/^Design session: /, '')}`, vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [dist],
    });
    panel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'media', 'icon.svg');
    // The draft runs in its own app (its dev server, through the proxy), shown in a frame.
    panel.webview.html = webviewPage(panel.webview, vscode.Uri.joinPath(dist, 'session.js'), 'Design session', 'frame-src http://127.0.0.1:* http://localhost:*;');
    const tab: Tab = { root, id, panel, ready: false, cards: [], queue: Promise.resolve(), status: draft?.status === 'submitted' && draft.proposal ? { kind: 'sent', proposal: draft.proposal } : draft?.status === 'discarded' ? { kind: 'discarded', at: draft.updatedAt } : { kind: 'open' } };
    panel.webview.onDidReceiveMessage((m: FromSession) => void this.receive(tab, m), undefined, this.subscriptions);
    panel.onDidDispose(() => {
      this.tabs.delete(key);
      if (this.latest.get(root) === id) this.latest.delete(root);
      this.note(root);
    });
    // The one looked at last is the one Claude works in.
    panel.onDidChangeViewState((e) => {
      if (e.webviewPanel.active) {
        this.latest.set(root, id);
        this.note(root);
      }
    });
    this.tabs.set(key, tab);
    this.latest.set(root, id);
    this.note(root);
  }

  /** The session Claude works in for a project: the open one looked at last (its draft and title). */
  current(root: string): OpenSessions | undefined {
    const id = this.latest.get(root) ?? [...this.tabs.values()].find((t) => t.root === root)?.id;
    if (!id || !this.tabs.has(`${root}#${id}`)) return undefined;
    const drafts = new DraftStore(root).list();
    const d = drafts.find((x) => x.id === id);
    if (!d || d.status !== 'draft') return undefined;
    // The other sessions open in this project, so Claude can tell which one a message is about.
    const others = [...this.tabs.values()].filter((t) => t.root === root && t.id !== id).flatMap((t) => {
      const o = drafts.find((x) => x.id === t.id && x.status === 'draft');
      return o ? [{ draft: o.id, title: o.title }] : [];
    });
    // Held back by its checks (this version): Claude is told what failed.
    const held = d.check?.step === 'done' && d.check.revision === d.revision ? d.check.held : undefined;
    return { draft: d.id, title: d.title, ...(d.session?.kind ? { brief: d.session.kind.brief } : {}), ...(others.length ? { others } : {}), ...(held ? { held } : {}) };
  }

  /** Makes a session the one Claude works in (its tab's "Work here"). */
  workIn(root: string, id: string) {
    this.latest.set(root, id);
    this.note(root);
  }

  /** Notes the current session for Claude Code's check (or that there's none). */
  private note(root: string) {
    // Every open session's tab shows whether Claude works in it.
    for (const t of this.tabs.values()) if (t.root === root) void this.send(t);
    this.writeNote(root);
  }

  /**
   * Notes for Claude Code's check which session is open in a tab (the one it works in) and which are left unfinished
   * with their tabs closed (only asked about). Also at startup: a note left from before a reload goes.
   */
  writeNote(root: string) {
    const file = join(root, SESSION_NOTE);
    const open = this.current(root);
    const closed = this.closed(root);
    try {
      if (open || closed.length) {
        mkdirSync(join(root, DRAFTS_DIR), { recursive: true });
        writeFileSync(file, JSON.stringify({ ...(open ? { open } : {}), ...(closed.length ? { closed } : {}) } satisfies SessionNote));
      } else rmSync(file, { force: true });
    } catch {
      // (Claude is told about the session through the hub's tools anyway.)
    }
  }

  /** Sessions left unfinished with their tabs closed: not worked in (Claude asks before opening one). */
  closed(root: string): ClosedSession[] {
    return new DraftStore(root)
      .list()
      .filter((d) => d.session && d.status === 'draft' && !this.tabs.has(`${root}#${d.id}`))
      .map((d) => ({ draft: d.id, title: d.title, ...(d.session?.page ? { page: d.session.page } : {}) }));
  }

  /** Whether a session's tab is open (only then is it worked in). */
  isOpen(root: string, id: string): boolean {
    return this.tabs.has(`${root}#${id}`);
  }

  /** Deletes a session for good (its tab closes; a proposal it continued is as it was). */
  remove(root: string, id: string) {
    const store = new DraftStore(root);
    const d = store.list().find((x) => x.id === id);
    this.tabs.get(`${root}#${id}`)?.panel.dispose();
    if (d?.status === 'draft' && d.session?.proposal) this.host.markProposal(root, d.session.proposal, undefined);
    store.remove(id);
    this.writeNote(root);
  }

  /** A session's tab, when it's open. */
  panel(root: string, id: string): vscode.WebviewPanel | undefined {
    return this.tabs.get(`${root}#${id}`)?.panel;
  }

  /** The open sessions (root and draft id). */
  list(): { root: string; id: string }[] {
    return [...this.tabs.values()].map(({ root, id }) => ({ root, id }));
  }

  /** A project's drafts changed (saved by Claude, an agent, going back…): its open sessions follow. */
  draftsChanged(root: string) {
    for (const tab of this.tabs.values()) if (tab.root === root) void this.refresh(tab);
    // (What Claude is told follows too: held back by its checks, or not any more.)
    this.writeNote(root);
  }

  private async receive(tab: Tab, m: FromSession): Promise<void> {
    if (m.type === 'ready') {
      tab.ready = true;
      return this.refresh(tab);
    }
    const store = new DraftStore(tab.root);
    const draft = store.list().find((d) => d.id === tab.id);
    if (m.type === 'openReview') return this.host.openReview(m.proposal);
    if (m.type === 'workHere') return this.workIn(tab.root, tab.id);
    if (!draft) return;
    if (m.type === 'back') {
      // Going back is a new version with that version's files (nothing is lost: the newer ones stay in the list).
      const version = store.versions(tab.id).find((v) => v.revision === m.revision);
      if (!version || draft.status !== 'draft') return;
      store.save({ ...draft, changes: version.changes, revision: draft.revision + 1, updatedAt: new Date().toISOString() });
      return this.refresh(tab);
    }
    if (m.type === 'discard') {
      const pick = await vscode.window.showWarningMessage(
        draft.session?.proposal ? `Discard this session? The proposal in Review stays as it was before the session.` : `Discard “${draft.title}”? It ends here: nothing in your files changes. It stays in Memory → Sessions (history), where you can look at it or delete it for good.`,
        { modal: true },
        'Discard',
      );
      if (!pick) return;
      // Kept for its history (Memory → Sessions), until deleted for good there.
      store.save({ ...draft, status: 'discarded', updatedAt: new Date().toISOString() });
      // A proposal it continued is as it was, and can be decided on again.
      if (draft.session?.proposal) this.host.markProposal(tab.root, draft.session.proposal, undefined);
      tab.panel.dispose();
      return;
    }
    if (m.type === 'copyForClaude') {
      await vscode.env.clipboard.writeText(
        `Work in my Visual Editor design session “${draft.title}”: draft ${draft.id}. Change it only with save_draft (draft: "${draft.id}"), adding what I ask as asked; don't submit it, I press Done in the session. Use draft_pictures to look at it.`,
      );
      void vscode.window.showInformationMessage('Copied. Paste it in your Claude Code chat, then say what you want.');
      return;
    }
    if (m.type === 'bypass') {
      // The developer lets it go with these checks failed (their reason kept in the proof), and its checks run again
      // as they were (what passed isn't run again).
      store.save({ ...draft, evidence: bypassProof(draft.evidence, draft.revision, m.titles, m.reason) });
      if (!draft.plan) return;
      const why = this.host.run(tab.root, tab.id, asItIs(draft.plan));
      if (why) void vscode.window.showWarningMessage(why);
      return this.refresh(tab);
    }
    if (m.type === 'done') {
      if (draft.status !== 'draft') return;
      if (!draft.changes.length) return void vscode.window.showInformationMessage('Nothing has changed in this session yet: ask Claude in your Claude Code chat for what you want first.');
      // Test cases already written for this version: the window shows them again.
      if (draft.plan?.revision === draft.revision && draft.check?.step === WAITING) return this.refresh(tab, true);
      this.host.plan(tab.root, tab.id);
      return this.refresh(tab);
    }
    if (m.type === 'run') {
      const why = this.host.run(tab.root, tab.id, m.choice);
      if (why) void vscode.window.showWarningMessage(why);
      return this.refresh(tab);
    }
  }

  /** Reads the draft again; a newer version is put in its app; the tab is told. */
  /** Claude Code connected or not: the tabs say whether there's a line to copy. */
  claudeChanged() {
    for (const tab of this.tabs.values()) void this.send(tab);
  }

  private refresh(tab: Tab, showPlan = false): Promise<void> {
    tab.queue = tab.queue.then(() => this.update(tab, showPlan)).catch(() => undefined);
    return tab.queue;
  }

  private async update(tab: Tab, showPlan = false) {
    const draft = new DraftStore(tab.root).list().find((d) => d.id === tab.id);
    const state = this.host.project(tab.root);
    if (!draft || !state) {
      tab.error = draft ? 'That project isn’t open.' : 'This session’s draft is gone.';
      return this.send(tab);
    }
    // Where its check is (from Done here, or "done" in the chat), for this version.
    const c = draft.check?.revision === draft.revision ? draft.check : undefined;
    if (draft.status === 'submitted' && draft.proposal) tab.status = { kind: 'sent', proposal: draft.proposal };
    else if (draft.status === 'discarded') tab.status = { kind: 'discarded', at: draft.updatedAt };
    else if (c?.held) tab.status = { kind: 'held', text: c.held };
    else if (c?.step === PLAN_STEP) tab.status = { kind: 'planning' };
    else if (c?.step === WAITING && draft.plan) tab.status = { kind: 'ready' };
    else if (c && !c.sent && c.step !== 'done') tab.status = { kind: 'checking', text: `Checking it: now ${c.step}…` };
    else tab.status = { kind: 'open' };
    tab.showPlan = showPlan;
    if (draft.status !== 'draft') this.note(tab.root);
    const { project, items } = await draftItems(state, draft, (path) => this.host.read(tab.root, path));
    const own = draft.session?.card ? items.filter((i) => i.id === draft.session?.card) : [];
    tab.cards = [...own, ...cardsTouched(items, draft.changes.map((c) => c.path)).filter((i) => !own.includes(i))].filter((i) => i.preview);
    const pageOf = (id: string) => {
      const it = items.find((i) => i.id === id);
      const plugin = it && state.detected.find(({ plugin: p }) => it.id.startsWith(`${p.id}:`))?.plugin;
      return it && plugin?.previewPage?.(it, project);
    };
    if (tab.revision !== draft.revision || !tab.app) {
      if (!tab.app) {
        tab.progress = 'Starting this session’s own copy of the app…';
        await this.send(tab, draft);
      }
      try {
        tab.app = await this.host.openApp(tab.root, draft, pageOf);
        tab.revision = draft.revision;
        tab.error = undefined;
      } catch (e) {
        tab.error = e instanceof Error ? e.message.split('\n')[0] : String(e);
      }
      tab.progress = undefined;
    }
    return this.send(tab, draft);
  }

  private async send(tab: Tab, draft = new DraftStore(tab.root).list().find((d) => d.id === tab.id)) {
    if (!tab.ready) return;
    const card = (i: Item): SessionCard => ({ id: i.id, label: i.label, designs: i.preview!.variants.map((v) => ({ id: v.id, name: v.name, inUse: v.inUse })), states: i.preview!.states });
    const session: SessionView = {
      id: tab.id,
      title: draft?.title ?? 'Design session',
      ...(draft?.session?.kind ? { kind: draft.session.kind.title } : {}),
      ...(draft?.session?.page ? { page: draft.session.page } : {}),
      current: this.current(tab.root)?.draft === tab.id,
      told: this.host.claudeTold?.(tab.root) ?? false,
      ...(draft?.session?.proposal ? { proposal: draft.session.proposal } : {}),
      asked: draft?.asked ?? [],
      revision: tab.revision ?? draft?.revision ?? 1,
      versions: draft ? new DraftStore(tab.root).versions(tab.id).map((v) => ({ revision: v.revision, at: v.at, files: v.changes.length })) : [],
      cards: tab.cards.map(card),
      ...(tab.app ? { app: tab.app } : {}),
      ...(tab.progress ? { progress: tab.progress } : {}),
      ...(tab.error ? { error: tab.error } : {}),
      status: tab.status,
      ...(tab.status.kind === 'held' && draft
        ? { failed: failedChecks(draft.evidence, draft.revision).map((e) => ({ title: e.title, why: whyFailed(e) })), checkedAt: draft.check?.at ?? '' }
        : {}),
      // Its test cases: ready to run, or (held back) to look at, change and run again.
      ...((tab.status.kind === 'ready' || tab.status.kind === 'held') && draft?.plan?.revision === draft?.revision && draft?.plan
        ? { plan: planView(draft.plan) }
        : {}),
      ...(tab.status.kind === 'checking' && draft?.check?.items ? { running: draft.check.items } : {}),
      ...(tab.status.kind === 'ready' ? { checkedAt: `${draft?.check?.at ?? ''}${tab.showPlan ? `#${Date.now()}` : ''}` } : {}),
    };
    await tab.panel.webview.postMessage({ type: 'show', session } satisfies ToSession);
  }

  dispose() {
    for (const t of this.tabs.values()) t.panel.dispose();
    for (const s of this.subscriptions) s.dispose();
  }
}
