// Review: every change waits here for the developer's OK. Proposals come from the project's .visual-editor/proposals/
// folder; the Review tab shows what would change and why; Approve applies all of it (or none), Send back and Reject
// keep a note, and an applied change can be undone. The map marks the cards a waiting proposal would change.

import * as vscode from 'vscode';
import { DraftStore } from './drafts';
import { PLAN_STEP, WAITING } from './hub/tools';
import type { PlanChoice } from './ui/planWindow';
import { asItIs, planView } from './hub/checkPlan';
import { webviewPage } from './webviewPage';
import { vscodeFiles } from './vscodeFiles';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cardsTouched } from './draftItems';
import { importersOf, touch } from './importers';
import { logicText, type LogicVerdict } from './hub/logicCheck';
import type { Disposable, Item } from '@visual-editor/contract';
import type { OutsideChanges } from './changes';
import type { CurrentProject } from './currentProject';
import type { ProjectMemory } from './memoryView';
import { counts, hunks } from './diff';
import { apply, conflicts, newId, ProposalStore, undo, undoConflicts, type Evidence, type Files, type Proposal, overruleProof, bypassProof, failedChecks, whyFailed, needsYou } from './proposals';
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
  /** Each project's app, for proposals that show how they look. */
  private readonly apps = new Map<string, NonNullable<ToReview['app']>>();
  /** Pictures shown live, by proposal and card ("<proposal> <card>"). */
  private readonly lives = new Map<string, { url?: string; progress?: string; error?: string }>();
  /** Shows a card's Playground running with a proposal's changes on top (its own app), and gives its address. */
  private openSession: ((root: string, p: Proposal) => void) | undefined;
  private draftsTimer: ReturnType<typeof setTimeout> | undefined;
  private replan: ((root: string, draft: string) => void) | undefined;
  /** A change whose test cases' window opens with the next showing. */
  private planFor: string | undefined;
  private runPlan: ((root: string, draft: string, choice: PlanChoice) => string | undefined) | undefined;
  /** A held-back change whose bypass window opens with the next showing. */
  private bypassFor: string | undefined;
  private live: ((root: string, p: Proposal, card: string) => Promise<string>) | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly index: ProjectIndex,
    private readonly current: CurrentProject,
    private readonly changes: OutsideChanges,
    private readonly memory: ProjectMemory,
    /** Starts a project's app (its dev server, through the proxy) and gives its address. */
    private readonly appFor?: (root: string, progress: (text: string) => void) => Promise<string>,
  ) {
    // Reading proposals when the projects are known; new ones that arrive later are announced.
    this.subscriptions.push(
      index.onChange(() => this.loadNewProjects()),
      current.onChange(() => void this.send()),
    );
  }

  /** The developer's own cases being checked, by proposal: how it's going, or why it couldn't. */
  private readonly checking = new Map<string, { progress?: string; error?: string }>();
  /** Runs the logic check on a change with the developer's cases (set by the extension). */
  private logic: ((root: string, p: Proposal, cases: string[], means?: string[]) => Promise<LogicVerdict | string>) | undefined;

  /** Continues a proposal in a design session (or shows the session changing it now). */
  setSessions(open: (root: string, p: Proposal) => void) {
    this.openSession = open;
  }

  /**
   * The developer overrules a broken case of the logic check (it expected the wrong thing). A held-back change with
   * nothing else broken then goes to Review as an ordinary proposal, with the overruling in its proof.
   */
  private async overrule(root: string, p: Proposal, index: number) {
    const logic = p.evidence?.find((e) => e.logic)?.logic;
    const c = logic?.cases[index];
    if (!c || c.ok) return;
    const note = await vscode.window.showInputBox({ title: `Overrule: ${c.case}`, prompt: 'Why is this case wrong? (kept in the proof, for whoever looks at it later)', ignoreFocusOut: true });
    if (!note?.trim()) return;
    const revision = p.evidence!.find((e) => e.logic)!.revision;
    const evidence = overruleProof(p.evidence!, revision, [index], note.trim());
    const store = this.store(root);
    const clear = evidence.filter((e) => e.revision === revision).every((e) => e.passed !== false);
    if (p.status === 'held-back' && clear) {
      store.save({ ...p, evidence, status: 'proposed', history: [...p.history, { at: new Date().toISOString(), status: 'proposed', note: `You overruled the logic check: ${c.case} (${note.trim()})` }] });
      // Its draft went to Review this way: it isn't sent again.
      const drafts = new DraftStore(root);
      const d = drafts.list().find((x) => `held-${x.id}` === p.id);
      if (d) drafts.save({ ...d, status: 'submitted', proposal: p.id, evidence: overruleProof(d.evidence, revision, [index], note.trim()) });
      void vscode.window.showInformationMessage(`“${p.title}” is now waiting in Review (you overruled the case).`);
    } else store.save({ ...p, evidence });
    this.reload(root, false);
  }

  /** Runs a change's test cases as the developer left them (its draft); a string says why it can't now. */
  setChecks(run: (root: string, draft: string, choice: PlanChoice) => string | undefined) {
    this.runPlan = run;
  }

  /** A project's drafts changed (a check moving on, test cases written): Review shows where they are now. */
  draftsChanged(root: string) {
    if (this.current.get()?.project.root !== root) return;
    clearTimeout(this.draftsTimer);
    this.draftsTimer = setTimeout(() => void this.send(), 300);
  }

  /** Has new test cases written for a change's draft. */
  setReplan(replan: (root: string, draft: string) => void) {
    this.replan = replan;
  }

  /** Shows a change waiting for its checks with the window of its test cases open. */
  askPlan(root: string, id: string) {
    this.current.choose(root);
    this.planFor = id;
    this.show(id);
  }

  /** Shows a held-back change in Review with the window to bypass its failed checks open. */
  askBypass(root: string, id: string) {
    this.current.choose(root);
    this.bypassFor = id;
    this.show(id);
  }

  /**
   * The developer lets a held-back change go with some failed checks bypassed (their reason kept in its proof and its
   * history). With nothing else failing it goes to Review as an ordinary proposal; its draft isn't sent again.
   */
  private bypass(root: string, p: Proposal, titles: string[], reason: string) {
    if (p.status !== 'held-back' || !p.evidence?.length) return;
    const revision = Math.max(...p.evidence.map((e) => e.revision));
    const evidence = bypassProof(p.evidence, revision, titles, reason);
    const store = this.store(root);
    const now = new Date().toISOString();
    if (failedChecks(evidence, revision).length) {
      store.save({ ...p, evidence });
    } else {
      store.save({ ...p, evidence, status: 'proposed', history: [...p.history, { at: now, status: 'proposed', note: `Sent to Review by you, with ${titles.length === 1 ? 'a check' : 'checks'} bypassed: ${titles.join('; ')}. Why: ${reason}` }] });
      const drafts = new DraftStore(root);
      const d = drafts.list().find((x) => `held-${x.id}` === p.id);
      if (d) drafts.save({ ...d, status: 'submitted', proposal: p.id, evidence: bypassProof(d.evidence, revision, titles, reason) });
      void vscode.window.showInformationMessage(`“${p.title}” is now waiting in Review, marked as sent with ${titles.length} check${titles.length === 1 ? '' : 's'} bypassed.`);
    }
    this.reload(root, false);
  }

  /** Whether a held-back change's test cases can run again as they are, or are running now (the step). */
  private rerunOf(root: string, id: string): NonNullable<ReviewItem['rerun']> {
    const d = new DraftStore(root).list().find((x) => `held-${x.id}` === id);
    const ready = !!d && d.status === 'draft' && d.plan?.revision === d.revision;
    const step = d?.check?.revision === d?.revision ? d?.check?.step : undefined;
    const running = step && step !== 'done' && step !== WAITING && step !== PLAN_STEP ? step : undefined;
    const p = d?.plan;
    const view = ready && p ? planView(p) : undefined;
    return { can: ready && !running, ...(running ? { running, ...(d?.check?.items ? { items: d.check.items } : {}) } : {}), ...(view ? { view } : {}) };
  }

  /** Where a change waiting for its checks is: its test cases being written, ready (to show), or running. */
  private planOf(root: string, id: string): NonNullable<ReviewItem['plan']> {
    const d = new DraftStore(root).list().find((x) => `held-${x.id}` === id);
    const c = d?.check;
    if (!d || !c || c.step === PLAN_STEP || c.step === 'starting') return { state: 'writing' };
    // (Ended: what's left to show is its result, not a run.)
    if (c.step === 'done' && d.plan) return { state: 'ready', view: planView(d.plan) };
    if (c.step === WAITING && d.plan) {
      const p = d.plan;
      return { state: 'ready', view: planView(p) };
    }
    return { state: 'running', step: c.step, ...(c.items ? { items: c.items } : {}) };
  }

  /** Marks a proposal as being changed in a design session (that session's draft), or not any more. */
  setSessionOf(root: string, id: string, draft: string | undefined) {
    const store = this.store(root);
    const p = store.get(id);
    if (!p) return;
    const { session: _session, ...rest } = p;
    store.save(draft ? { ...rest, session: draft } : rest);
    this.reload(root, false);
  }

  setLogic(logic: (root: string, p: Proposal, cases: string[], means?: string[]) => Promise<LogicVerdict | string>) {
    this.logic = logic;
  }

  /** How pictures in a proposal's proof are shown live (set once the draft apps exist). */
  setLive(live: (root: string, p: Proposal, card: string) => Promise<string>) {
    this.live = live;
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

  /** What needs the developer in every project: to approve, test cases to run, held back. */
  needsYou(): ReturnType<typeof needsYou> {
    return needsYou([...this.cache.values()].flat());
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
      // (and the projects' folders: pictures kept as proof with drafts)
      localResourceRoots: [dist, ...(vscode.workspace.workspaceFolders ?? []).map((f) => f.uri)],
    });
    panel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'media', 'icon.svg');
    // Proposals that show how they look frame the app (its dev server, through the proxy); pictures in their proof are
    // the projects' files.
    panel.webview.html = webviewPage(panel.webview, vscode.Uri.joinPath(dist, 'review.js'), 'Review', `frame-src http://127.0.0.1:* http://localhost:*; img-src ${panel.webview.cspSource};`);
    panel.webview.onDidReceiveMessage((m: FromReview) => void this.receive(m), undefined, this.subscriptions);
    panel.onDidDispose(() => {
      this.panel = undefined;
      this.ready = false;
    });
    this.panel = panel;
  }

  /**
   * What of a proposal can be tried live: the previewable cards whose files it changes (a design, the static part, a
   * new file in the card's folder…), and the ones running now.
   */
  private liveParts(p: Proposal, items: Item[]): Pick<ReviewItem, 'cards' | 'live'> {
    if (!this.live) return {};
    const cards = cardsTouched(items, p.changes.map((c) => c.path)).map((i) => ({ id: i.id, label: i.label }));
    const ids = new Set([...cards.map((c) => c.id), ...(p.evidence ?? []).flatMap((e) => (e.card ? [e.card] : []))]);
    const live = Object.fromEntries([...ids].filter((id) => this.lives.has(`${p.id} ${id}`)).map((id) => [id, this.lives.get(`${p.id} ${id}`)!]));
    return { ...(cards.length ? { cards } : {}), ...(Object.keys(live).length ? { live } : {}) };
  }

  /**
   * A picture in a proposal's proof, live: the card's Playground running with the proposal's changes on top (while it
   * waits) or as the files are now (once applied), in its own app; or back to the picture.
   */
  private async showLive(root: string, id: string, card: string, on: boolean) {
    const key = `${id} ${card}`;
    const p = this.store(root).get(id);
    if (!on || !p || !this.live) {
      this.lives.delete(key);
      return this.send();
    }
    this.lives.set(key, { progress: 'Starting it with these changes on top (nothing changes in your files)…' });
    void this.send();
    try {
      this.lives.set(key, { url: await this.live(root, p, card) });
    } catch (e) {
      this.lives.set(key, { error: e instanceof Error ? e.message : String(e) });
    }
    void this.send();
  }

  /**
   * Files added or removed: the files that import them are touched, so a running dev server reads them again (else it
   * may keep importing what was removed, and the page goes blank).
   */
  private wakeImporters(root: string, p: Proposal) {
    const moved = p.changes.filter((c) => c.before === null || c.after === null).map((c) => c.path);
    if (!moved.length) return;
    const state = this.index.snapshot().find((s) => s.project.root === root);
    const code = (state?.project.files ?? []).filter((f) => /\.(m?[jt]sx?|vue|svelte)$/.test(f) && !moved.includes(f));
    const files = code.flatMap((path) => {
      try {
        return [{ path, text: readFileSync(join(root, path), 'utf8') }];
      } catch {
        return [];
      }
    });
    const importers = importersOf(moved, files).map((f) => join(root, f));
    for (const f of importers) this.changes.expectWrite(f);
    touch(importers);
  }

  /**
   * The developer's own cases: the logic checker tries each against what the change means, and the results join the
   * change's proof. The cases stay with the change (when it's sent back, the assistant must make them pass).
   */
  private async checkCases(root: string, id: string, cases: string[]) {
    const store = this.store(root);
    const p = store.get(id);
    if (!p || !this.logic) return;
    const at = p.evidence?.findIndex((e) => e.logic) ?? -1;
    const old = at >= 0 ? p.evidence![at] : undefined;
    this.checking.set(id, { progress: `Checking ${cases.length} case${cases.length === 1 ? '' : 's'} with the logic checker…` });
    void this.send();
    const verdict = await this.logic(root, p, cases, old?.logic ? old.logic.means : undefined);
    if (typeof verdict === 'string') {
      this.checking.set(id, { error: verdict });
      return void this.send();
    }
    this.checking.delete(id);
    // Your cases replace earlier results for the same case; the rest of the report stays.
    const mine = verdict.cases.map((c) => ({ ...c, by: 'developer' as const }));
    const kept = (old?.logic?.cases ?? []).filter((c) => !mine.some((m) => m.case === c.case) && !(c.by === 'developer' && cases.includes(c.case)));
    const logic = { means: old?.logic?.means.length ? old.logic.means : verdict.means, looksOnly: old?.logic?.looksOnly ?? verdict.looksOnly, cases: [...kept, ...mine], fixes: [...(old?.logic?.fixes ?? []), ...verdict.fixes] };
    const passed = logic.cases.every((c) => c.ok);
    const asked = p.asked ?? [p.title];
    const evidence: Evidence = { kind: 'check', title: old?.title ?? 'Logic check: does exactly what was asked', text: logicText(asked, logic), passed, by: 'Visual Editor (logic checker)', at: new Date().toISOString(), revision: old?.revision ?? 1, logic };
    const next: Proposal = { ...p, cases: [...new Set([...(p.cases ?? []), ...cases])], evidence: at >= 0 ? p.evidence!.map((e, i) => (i === at ? evidence : e)) : [...(p.evidence ?? []), evidence] };
    store.save(next);
    this.reload(root, false);
    const broke = mine.filter((c) => !c.ok);
    void vscode.window.showInformationMessage(broke.length ? `${broke.length} of your ${mine.length} case${mine.length === 1 ? '' : 's'} broke: see them in the proof. Send it back to have them fixed.` : `All ${mine.length} of your case${mine.length === 1 ? '' : 's'} held.`);
  }

  /** A proposal from the assistant hub: saved, shown in Review, and announced. */
  receiveProposal(root: string, p: Proposal) {
    this.store(root).save(p);
    this.reload(root, true);
  }

  /**
   * A proposal made in the editor itself (e.g. "Use this design"): saved and shown in Review at once. The same one
   * already waiting is shown instead of a second.
   */
  proposeHere(root: string, p: Proposal) {
    const same = this.proposals(root).find((x) => x.status === 'proposed' && x.title === p.title && JSON.stringify(x.changes) === JSON.stringify(p.changes));
    if (!same) {
      this.store(root).save(p);
      this.reload(root, false);
    }
    this.current.choose(root);
    this.show((same ?? p).id);
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
    if (m.type === 'app') return this.startApp(root);
    if (m.type === 'open') {
      const line = Math.max(0, (m.line ?? 1) - 1);
      await vscode.window.showTextDocument(vscode.Uri.file(join(root, m.path)), { selection: new vscode.Range(line, 0, line, 0), viewColumn: vscode.ViewColumn.Beside });
      return;
    }
    this.selected = m.id;
    if (m.type === 'select') return this.send();
    if (m.type === 'live' || m.type === 'unlive') return this.showLive(root, m.id, m.card, m.type === 'live');
    if (m.type === 'cases') return this.checkCases(root, m.id, m.cases);
    const store = this.store(root);
    const p = store.get(m.id);
    if (!p) return;
    if (m.type === 'session') return this.openSession?.(root, p);
    if (m.type === 'overrule') return this.overrule(root, p, m.index);
    if (m.type === 'bypass') return this.bypass(root, p, m.titles, m.reason);
    if (m.type === 'replan') {
      const d = new DraftStore(root).list().find((x) => `held-${x.id}` === p.id);
      if (!d || d.status !== 'draft') return;
      // New test cases are written; the change waits under "Checks to approve", and their window opens when ready.
      this.replan?.(root, d.id);
      return this.reload(root, false);
    }
    if (m.type === 'rerun') {
      const d = new DraftStore(root).list().find((x) => `held-${x.id}` === p.id);
      if (!d?.plan || d.plan.revision !== d.revision) {
        void vscode.window.showInformationMessage('Its test cases were written before this version (or before test cases existed): ask Claude in your chat to send it again, for new ones.');
        return;
      }
      const why = this.runPlan?.(root, d.id, asItIs(d.plan));
      if (why) void vscode.window.showWarningMessage(why);
      return this.reload(root, false);
    }
    if (m.type === 'runPlan') {
      const why = this.runPlan?.(root, p.id.replace(/^held-/, ''), m.choice);
      if (why) void vscode.window.showWarningMessage(why);
      return this.reload(root, false);
    }
    // Being changed in a design session: nothing is decided on it until the session is done (or discarded).
    if (p.session && m.type !== 'undo') {
      void vscode.window.showInformationMessage(`“${p.title}” is being changed in a design session. Press Done there to bring the changes back here (or Discard to keep it as it was), then decide.`);
      return;
    }
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
          this.wakeImporters(root, p);
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
          this.wakeImporters(root, latest);
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
        ...(p.asked?.length ? { asked: p.asked } : {}),
        ...(p.session ? { inSession: true } : {}),
        ...(p.status === 'awaiting-checks' ? { plan: this.planOf(root!, p.id) } : {}),
        ...(p.status === 'held-back' ? { rerun: this.rerunOf(root!, p.id) } : {}),
        ...(p.status === 'held-back' && p.evidence?.length
          ? { failed: failedChecks(p.evidence, Math.max(...p.evidence.map((e) => e.revision))).map((e) => ({ title: e.title, why: whyFailed(e) })) }
          : {}),
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
        ...(p.look ? { look: p.look } : {}),
        ...(p.evidence ? { evidence: p.evidence.map((e) => (e.image && root && this.panel ? { ...e, src: this.panel.webview.asWebviewUri(vscode.Uri.file(join(root, e.image))).toString() } : e)) } : {}),
        ...this.liveParts(p, state?.items ?? []),
        ...(this.checking.has(p.id) ? { checking: this.checking.get(p.id) } : {}),
      });
    }
    if (!this.selected || !items.some((i) => i.id === this.selected)) this.selected = (items.find((i) => i.status === 'proposed') ?? items[0])?.id;
    // A proposal that shows how it looks needs the app: started the first time one is shown.
    if (root && items.find((i) => i.id === this.selected)?.look && !this.apps.has(root)) void this.startApp(root);
    const message: ToReview = { type: 'show', project: state?.project.name, items, selected: this.selected, problems: root ? this.store(root).problems : [], app: root ? this.apps.get(root) : undefined, ...(this.bypassFor ? { askBypass: this.bypassFor } : {}) };
    this.bypassFor = undefined;
    if (this.planFor) {
      (message as ToReview).askPlan = this.planFor;
      this.planFor = undefined;
    }
    this.panel.title = `Review${state ? ` · ${state.project.name}` : ''}`;
    void this.panel.webview.postMessage(message);
  }

  /** Starts the project's app (or finds it running), saying how it goes. */
  private async startApp(root: string) {
    if (!this.appFor) return void this.apps.set(root, { error: 'The app can’t be run from here.' });
    this.apps.set(root, { progress: 'Starting the app’s dev server…' });
    void this.send();
    try {
      const url = await this.appFor(root, (text) => {
        if (!text) return;
        this.apps.set(root, { progress: `Starting the app’s dev server… ${text}` });
        void this.send();
      });
      this.apps.set(root, { url: url.replace(/\/$/, '') });
    } catch (e) {
      this.apps.set(root, { error: e instanceof Error ? e.message : String(e) });
    }
    void this.send();
  }

  private files(root: string): Files {
    return vscodeFiles(root, this.changes);
  }
}
