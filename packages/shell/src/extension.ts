// The Visual Editor shell inside VS Code: holds the plugins, and (as Step 1 grows) the project index, the maps, review,
// memory and the assistant hub. Plugins find it through its exported API (see @visual-editor/contract).

import * as vscode from 'vscode';
import { CONTRACT_VERSION, type Item, type Plugin, type ShellApi } from '@visual-editor/contract';
import { PluginRegistry } from './registry';
import { PluginsView } from './pluginsView';
import { ProjectIndex } from './projectIndex';
import { ProjectsView } from './projectsView';
import { findWorkspace, isIgnoredPath, isProjectFile } from './projects';
import { basename, join, relative, sep } from 'node:path';
import { mkdirSync } from 'node:fs';
import { CurrentProject } from './currentProject';
import { MapPanel } from './mapPanel';
import { AppProxies } from './proxy/appProxies';
import { OutsideChanges } from './changes';
import { Review } from './review';
import { ProjectSetups } from './projectSetup';
import { askEntry, MemoryView, ProjectMemory } from './memoryView';
import type { MemoryEntry } from './memory';
import { claudeCommand, Hub, run } from './hub/hub';
import { askClaude, otherState, runCases, runLogicCheck, type LogicCase, type LogicVerdict, type RunPlaces } from './hub/logicCheck';
import { runTester } from './hub/tester';
import { planPrompt, readPlan } from './hub/checkPlan';
import { glance, runCase, startUrl, type RunSpec } from './caseRunner';
import { DRAFTS_DIR, DraftStore, type Draft } from './drafts';
import { Sessions } from './session';
import { failedChecks } from './proposals';
import { JobStore, finished } from './jobs';
import { cardsTouched, draftItems } from './draftItems';
import { DraftApps } from './proxy/draftApps';
import { comparePictures, takePicture } from './pictures';
import { ClaudeAgents } from './hub/claudeAgents';
import { AssistantsView, chooseAssistant } from './hub/assistantsView';
import { AgentsView } from './hub/agentsView';
import { AgentRuns, type RunWay } from './hub/agentRuns';
import { vscodeFiles } from './vscodeFiles';

export function activate(context: vscode.ExtensionContext): ShellApi {
  const registry = new PluginRegistry();
  const log = vscode.window.createOutputChannel('Visual Editor');
  // Each project's app through Visual Editor's proxy (its calls seen, and later faked).
  // Plugins' Preview panels add their page scripts to the pages of the projects they detected.
  const proxies = new AppProxies(log, context.secrets, (root) =>
    (index.snapshot().find((s) => s.project.root === root)?.detected ?? []).flatMap(({ plugin }) => (plugin.previewPanels ?? []).map((p) => ({ key: `${plugin.id}/${p.id}`, code: p.page }))),
    // Preview's page for a card: made by the plugin whose card it is.
    (root, id) => {
      const state = index.snapshot().find((s) => s.project.root === root);
      const item = state?.items.find((i) => i.id === id);
      const plugin = item && state?.detected.find(({ plugin: p }) => item.id.startsWith(`${p.id}:`))?.plugin;
      return item && plugin?.previewPage?.(item, state!.project);
    },
  );
  context.subscriptions.push(proxies);

  // The side panel: which plugins are installed, and any that couldn't be used.
  const pluginsView = new PluginsView(registry);
  context.subscriptions.push(log, vscode.window.registerTreeDataProvider('visualEditor.plugins', pluginsView), pluginsView);

  // The project index: the projects in the opened folders, and what each plugin found in them.
  const index = new ProjectIndex(registry);
  // With several projects, one is shown at a time; the choice is remembered for this workspace.
  const current = new CurrentProject(() => index.snapshot(), {
    get: () => context.workspaceState.get<string>('visualEditor.currentProject'),
    set: (root) => void context.workspaceState.update('visualEditor.currentProject', root),
  });
  // Review: changes wait here for the developer's OK; files changed any other way are marked on the map.
  const changes = new OutsideChanges();
  // Memory: why the project is the way it is (reviewed changes, rules, decisions, notes on cards).
  const memory = new ProjectMemory(index);
  const memoryView = new MemoryView(memory, current);
  // What plugins keep in place in each project (React: its helper), written as soon as the project is detected.
  const setups = new ProjectSetups(index, changes, log);
  context.subscriptions.push(setups);
  const review = new Review(context.extensionUri, index, current, changes, memory, (root, progress) => proxies.open(root, progress));
  const projectsView = new ProjectsView(index, current, review);
  // Recent changes shows what's waiting for review too (yellow), above what was applied, rejected, sent back.
  memoryView.setWaiting((root) => review.proposals(root), (fn) => review.onChange(fn));
  context.subscriptions.push(memoryView, vscode.window.registerTreeDataProvider('visualEditor.memory', memoryView));
  context.subscriptions.push(index, review, projectsView, vscode.window.registerTreeDataProvider('visualEditor.projects', projectsView));
  const folders = () => (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
  const scan = () => {
    const workspaces = folders().map(findWorkspace);
    const projects = workspaces.flatMap((w) => w.projects);
    log.appendLine(`Found ${projects.length} project${projects.length === 1 ? '' : 's'} (${workspaces.map((w) => `${basename(w.root)}: ${w.shape}`).join(', ') || 'no folder open'}).`);
    void index.setProjects(projects);
  };
  scan();

  // Files that change are collected for a moment, then handed over together (saves, git checkouts, formatters).
  const pending = new Set<string>();
  let rescan = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    timer = undefined;
    if (rescan) {
      rescan = false;
      pending.clear();
      scan();
      return;
    }
    const paths = [...pending];
    pending.clear();
    if (paths.length) void index.filesChanged(paths);
  };
  const onFile = (how: 'created' | 'changed' | 'deleted') => (uri: vscode.Uri) => {
    const addedOrRemoved = how !== 'changed';
    const root = folders().find((f) => uri.fsPath === f || uri.fsPath.startsWith(f + sep));
    if (!root || isIgnoredPath(relative(root, uri.fsPath))) return;
    // A project file added or removed changes which projects there are.
    if (addedOrRemoved && isProjectFile(basename(uri.fsPath))) rescan = true;
    if (basename(uri.fsPath) === 'pnpm-workspace.yaml') rescan = true;
    // A new file outside every project known so far may be loose code that makes a new project.
    if (addedOrRemoved && !index.snapshot().some((s) => uri.fsPath.startsWith(s.project.root + sep))) rescan = true;
    // Which project it's in (the deepest root), to mark its cards as changed outside review.
    const owner = index
      .snapshot()
      .map((s) => s.project.root)
      .filter((r) => uri.fsPath.startsWith(r + sep))
      .sort((a, b) => b.length - a.length)[0];
    if (owner) changes.note(owner, relative(owner, uri.fsPath).split(sep).join('/'), uri.fsPath, how);
    pending.add(uri.fsPath);
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, 300);
  };
  const watcher = vscode.workspace.createFileSystemWatcher('**/*');
  // Proposals arrive as files (from the assistant hub, agents, plugins); the main watcher leaves that folder out.
  const proposalWatcher = vscode.workspace.createFileSystemWatcher('**/.visual-editor/proposals/*.json');
  const onProposal = (uri: vscode.Uri) => review.proposalFileChanged(uri.fsPath);
  // Memory entries can also arrive from outside (a teammate's, through git; an assistant's).
  const memoryWatcher = vscode.workspace.createFileSystemWatcher('**/.visual-editor/memory/entries/*.json');
  const onMemory = (uri: vscode.Uri) => memory.fileChanged(uri.fsPath);
  context.subscriptions.push(
    watcher,
    proposalWatcher,
    proposalWatcher.onDidCreate(onProposal),
    proposalWatcher.onDidChange(onProposal),
    proposalWatcher.onDidDelete(onProposal),
    memoryWatcher,
    memoryWatcher.onDidCreate(onMemory),
    memoryWatcher.onDidChange(onMemory),
    memoryWatcher.onDidDelete(onMemory),
    watcher.onDidCreate(onFile('created')),
    watcher.onDidDelete(onFile('deleted')),
    watcher.onDidChange(onFile('changed')),
    vscode.workspace.onDidChangeWorkspaceFolders(scan),
    { dispose: () => timer && clearTimeout(timer) },
  );

  // One status bar button for everything.
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  const updateStatus = () => {
    const n = registry.list().length;
    const projects = index.snapshot().length;
    const shown = current.get();
    const waiting = review.waiting();
    status.text = `$(symbol-structure) Visual Editor${projects > 1 && shown ? ` · ${shown.project.name}` : ''}${n ? ` · ${n} plugin${n === 1 ? '' : 's'}` : ''}${waiting ? ` · ${waiting} proposed` : ''}`;
    // Waiting proposals come first: the button opens Review until they're handled.
    status.command = waiting ? 'visualEditor.openReview' : 'visualEditor.openMap';
    status.backgroundColor = waiting ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
    status.tooltip = `${waiting ? `${waiting} change${waiting === 1 ? '' : 's'} waiting for your OK: open Review` : 'Open the map'}${n ? `\nPlugins: ${registry.list().map((p) => p.name).join(', ')}` : '\nNo plugins yet: add one for your project (React, Express…)'}`;
  };
  updateStatus();
  status.show();
  context.subscriptions.push(
    status,
    registry.onChange(updateStatus),
    index.onChange(updateStatus),
    current.onChange(updateStatus),
    review.onChange(updateStatus),
    vscode.commands.registerCommand('visualEditor.showPlugins', () => vscode.commands.executeCommand('visualEditor.plugins.focus')),
  );

  // The map, and choosing which project it shows.
  const map = new MapPanel(context.extensionUri, index, current, review, changes, memory, context.globalState, proxies);
  context.subscriptions.push(
    map,
    vscode.commands.registerCommand('visualEditor.openMap', () => map.show()),
    vscode.commands.registerCommand('visualEditor.openWebview', () => map.webview()),
    vscode.commands.registerCommand('visualEditor.openApp', async () => {
      const root = current.get()?.project.root;
      if (!root) return void vscode.window.showInformationMessage('Open a folder with a project first.');
      try {
        const url = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Starting the app through Visual Editor' }, (p) =>
          proxies.open(root, (text) => p.report({ message: text })),
        );
        await vscode.env.openExternal(vscode.Uri.parse(url));
      } catch (e) {
        void vscode.window.showErrorMessage(`Couldn't start the app: ${e instanceof Error ? e.message : String(e)}`);
      }
    }),
    vscode.commands.registerCommand('visualEditor.setUpProject', (root?: string) => {
      const r = typeof root === 'string' ? root : current.get()?.project.root;
      if (r) void setups.run(r, false);
    }),
    vscode.commands.registerCommand('visualEditor.openReview', (proposal?: string) => review.show(typeof proposal === 'string' ? proposal : undefined)),
    vscode.commands.registerCommand('visualEditor.tryProposal', () => review.tryExample()),
    ...(['rule', 'decision'] as const).map((kind) =>
      vscode.commands.registerCommand(kind === 'rule' ? 'visualEditor.addRule' : 'visualEditor.addDecision', async () => {
        const root = current.get()?.project.root;
        if (!root) return void vscode.window.showInformationMessage('Open a folder first.');
        const answer = await askEntry(kind);
        if (answer) memory.add(root, kind, answer.text, { detail: answer.detail });
      }),
    ),
    vscode.commands.registerCommand('visualEditor.editMemory', async (node?: { entry?: MemoryEntry }) => {
      const root = current.get()?.project.root;
      const e = node?.entry;
      if (!root || !e || e.kind === 'change') return;
      const answer = await askEntry(e.kind, e);
      if (answer) memory.update(root, { ...e, text: answer.text, detail: answer.detail });
    }),
    vscode.commands.registerCommand('visualEditor.removeMemory', async (node?: { entry?: MemoryEntry }) => {
      const root = current.get()?.project.root;
      const e = node?.entry;
      if (!root || !e) return;
      const pick = await vscode.window.showWarningMessage(`Forget “${e.text}”?`, { modal: true }, 'Forget');
      if (pick) memory.remove(root, e.id);
    }),
    vscode.commands.registerCommand('visualEditor.chooseProject', async (root?: string) => {
      if (!root) {
        const shown = current.get()?.project.root;
        const pick = await vscode.window.showQuickPick(
          index.snapshot().map((s) => ({
            label: s.project.name,
            description: [s.project.group && s.project.group !== s.project.name ? `in ${s.project.group}` : '', `${s.items.length} cards`, s.project.root === shown ? '· shown' : ''].filter(Boolean).join(' '),
            detail: s.detected.length ? s.detected.map((d) => d.plugin.name).join(', ') : 'no plugin yet',
            root: s.project.root,
          })),
          { placeHolder: 'Which project should the map show?' },
        );
        root = pick?.root;
      }
      if (!root) return;
      current.choose(root);
      map.show();
    }),
  );

  // The assistant hub: Claude Code reads the map, rules and memory, and proposes changes into Review.
  // A draft's own app, for pictures of it: the project's Vite with the draft's files on top (one at a time).
  const draftApps = new DraftApps({
    script: context.asAbsolutePath('dist/draftServer.js'),
    node: { command: process.execPath, env: { ELECTRON_RUN_AS_NODE: '1' } },
    log: (line) => log.appendLine(line),
    proxyOptions: (root) => ({ fakes: () => proxies.fakesOf(root) }),
  });
  context.subscriptions.push(draftApps);
  // A change as the logic check sees it: its cards read as it leaves them, and where its cases can be run for real (the
  // Playgrounds of the cards it touches, and the app's pages).
  // (What each place showed when the test cases were written, by draft version: the scenarios run against the same.)
  const seenFor = new Map<string, NonNullable<Awaited<ReturnType<typeof changeSeen>>>>();
  const changeSeen = async (root: string, shown: { id: string; revision: number; changes: Draft['changes'] }) => {
    const state = index.snapshot().find((s) => s.project.root === root);
    if (!state) return undefined;
    const { project, items } = await draftItems(state, shown, (path) => vscodeFiles(root, changes).read(path));
    const touched = cardsTouched(items, shown.changes.map((c) => c.path));
    const places: RunPlaces = {
      cards: touched.slice(0, 4).map((i) => ({ id: i.id, name: i.label, designs: i.preview!.variants.map((v) => ({ id: v.id, name: v.name, inUse: v.inUse })), states: i.preview!.states })),
      pages: items.filter((i) => i.kind === 'route' && !/[:*]/.test(i.label)).map((i) => ({ path: i.label })).slice(0, 4),
    };
    const pageOf = (id: string) => {
      const it = items.find((i) => i.id === id);
      const plugin = it && state.detected.find(({ plugin: x }) => it.id.startsWith(`${x.id}:`))?.plugin;
      return it && plugin?.previewPage?.(it, project);
    };
    // What each place really shows now, with the change: each card in each of its states (each has its own fixed data),
    // and each page. So the checker names what's there, in the state it's there.
    const texts = new Map<string, Record<string, string>>();
    if (places.cards.length || places.pages.length) {
      try {
        const origin = await draftApps.open(root, shown, pageOf);
        const looks = places.cards.flatMap((c) => c.states.slice(0, 8).map((state) => ({ c, state, url: startUrl(origin, { where: 'playground', card: c.id, design: c.designs.find((d) => d.inUse)?.id, state, steps: [], expect: [] }) })));
        const pages = places.pages.map((x) => ({ x, url: startUrl(origin, { where: 'app', page: x.path, steps: [], expect: [] }) }));
        const release = draftApps.hold(root, shown.id);
        const shows = await glance([...looks.map((l) => l.url), ...pages.map((p) => p.url)]).finally(release);
        looks.forEach(({ c, state }, n) => {
          c.shows = { ...c.shows, [state]: shows[n].line };
          texts.set(c.id, { ...texts.get(c.id), [state]: shows[n].text });
        });
        pages.forEach(({ x }, n) => (x.shows = shows[looks.length + n].line));
        draftApps.touch();
      } catch (e) {
        log.appendLine(`The change's app couldn't be looked at before the logic check: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
      }
    }
    return { items, places, pageOf, texts };
  };
  // The cases the checker gave steps for, run in the change's own app (each with its fake answers, if any).
  // The scenarios run (and the tester) in the change's own app, which is held for them till they're done: nothing else
  // stops it, or swaps it for another version, meanwhile.
  const runInApp = async (root: string, asked: string[], shown: { id: string; revision: number; changes: Draft['changes'] }, seen: Parameters<typeof runInAppHeld>[3], v: LogicVerdict): Promise<LogicVerdict> => {
    let release = () => {};
    try {
      return await runInAppHeld(root, asked, shown, seen, v, (r) => (release = r));
    } finally {
      release();
    }
  };
  const runInAppHeld = async (root: string, asked: string[], shown: { id: string; revision: number; changes: Draft['changes'] }, seen: { items: Item[]; pageOf: (id: string) => string | undefined; texts: Map<string, Record<string, string>> }, v: LogicVerdict, held?: (release: () => void) => void): Promise<LogicVerdict> => {
    const runnable = v.cases.filter((c) => c.run).length;
    if (!runnable) return v;
    let origin: string;
    try {
      origin = await draftApps.open(root, shown, seen.pageOf);
      held?.(draftApps.hold(root, shown.id));
    } catch (e) {
      const why = e instanceof Error ? e.message.split('\n')[0] : String(e);
      log.appendLine(`Cases couldn't be run in the app: ${why}`);
      return { ...v, cases: v.cases.map((c) => (c.run ? { ...c, found: `${c.found} (couldn't be run: ${why})` } : c)) };
    }
    log.appendLine(`Running ${runnable} case(s) in the change's app…`);
    // A state is shown in one design: the one in use, unless the case says.
    const prepared = (spec: RunSpec): RunSpec => {
      const inUse = seen.items.find((i) => i.id === spec.card)?.preview?.variants.find((x) => x.inUse)?.id;
      return spec.where === 'playground' && !spec.design && inUse ? { ...spec, design: inUse } : spec;
    };
    // (What each run's page showed at the end, by its spec.)
    const afters = new Map<RunSpec, string>();
    const out = await runCases(v, async (spec) => {
      const run = prepared(spec);
      draftApps.fake(root, shown.id, run.api);
      try {
        const r = await runCase(startUrl(origin, run), run);
        // Text a case expected in one state that is only in another state's fixed data: the case mixed up the states
        // (the change shows it where its data has it), so it isn't counted against the change.
        const other = !r.ok && r.missing && run.card && run.state ? otherState(r.missing, run.state, seen.texts.get(run.card) ?? {}) : undefined;
        if (other) return { ok: false, ran: false, found: `it expected ${r.missing!.map((t) => `“${t}”`).join(', ')} in the “${run.state}” state, but that is in the “${other}” state's data, not this one's` };
        if (r.after) afters.set(spec, r.after);
        return r;
      } finally {
        draftApps.fake(root, shown.id, undefined);
        draftApps.touch();
      }
    });
    log.appendLine(`Run in the app: ${out.cases.filter((c) => c.how === 'run' && c.ok).length} worked, ${out.cases.filter((c) => c.how === 'run' && !c.ok).length} broke.`);
    // Where the reading says it works and the quick run says it broke (or couldn't try it), the tester tries it like a
    // person and judges it: pages are dynamic and requests can mean more than one thing, which matching text can't tell.
    const disputed = out.cases.flatMap((c, i) => (v.cases[i].ok && v.cases[i].run && c.run && (!c.ok || /\(couldn't be run: /.test(c.found)) ? [i] : []));
    if (!disputed.length) return out;
    const model = vscode.workspace.getConfiguration('visualEditor.tester').get<string>('model', 'haiku');
    log.appendLine(`The tester (${model}) tries ${disputed.length} scenario(s) the quick run and the reading disagree on…`);
    const dir = join(root, DRAFTS_DIR, shown.id);
    mkdirSync(dir, { recursive: true });
    // The app without the change, to tell what the change caused from what was so already.
    const real = await proxies.open(root).catch(() => undefined);
    const cases = [...out.cases];
    for (const i of disputed) {
      const c = cases[i];
      const run = prepared(c.run!);
      draftApps.fake(root, shown.id, run.api);
      try {
        const t = await runTester(claudeCommand(), root, model, asked, { case: c.case, expected: c.expected, run, found: c.found, url: startUrl(origin, run), ...(real ? { baseline: startUrl(real, run) } : {}) }, dir);
        if (typeof t === 'string') {
          log.appendLine(`The tester couldn't try “${c.case}”: ${t}`);
          continue;
        }
        // Wrong in the same way without the change: not the change's doing (it doesn't hold the change back).
        cases[i] = t.already ? { ...c, ok: true, how: 'run', found: `tried by the tester: not caused by this change (the app does the same without it). ${t.found}` } : { ...c, ok: t.ok, how: 'run', found: `tried by the tester: ${t.found}` };
        log.appendLine(`Tester: “${c.case}” ${t.ok ? 'works' : 'broke'}${t.cost !== undefined ? ` (at pay-per-use prices $${t.cost.toFixed(2)})` : ''}.`);
      } finally {
        draftApps.fake(root, shown.id, undefined);
        draftApps.touch();
      }
    }
    const cleared = disputed.filter((i) => cases[i].ok).map((i) => cases[i].case);
    const broke = cases.filter((c) => !c.ok && !c.overruled);
    const fixes = broke.length ? [...out.fixes.filter((f) => !cleared.some((name) => f.startsWith(`${name}: run in the app`))), ...disputed.filter((i) => !cases[i].ok && !out.fixes.some((f) => f.startsWith(`${cases[i].case}:`))).map((i) => `${cases[i].case}: ${cases[i].found}`)] : [];
    return { ...out, cases, fixes, passed: !broke.length };
  };
  // Review: the developer's own cases, tried by the logic checker on a change (against what it means, when known), and
  // run for real where they can be.
  review.setLogic(async (root, p, cases, means) => {
    const model = vscode.workspace.getConfiguration('visualEditor.logicCheck').get<string>('model', 'sonnet');
    // (Not applied yet, whether waiting, held back or waiting for its checks: shown with its changes.)
    const pending = p.status === 'proposed' || p.status === 'held-back' || p.status === 'awaiting-checks';
    const shown = { id: p.id, revision: pending ? 1 : 0, changes: pending ? p.changes : [] };
    const seen = await changeSeen(root, shown);
    const v = await runLogicCheck(claudeCommand(), root, p.asked ?? [p.title], p.changes, model, cases, means ? { means } : undefined, seen?.places);
    return typeof v === 'string' || !seen ? v : runInApp(root, p.asked ?? [p.title], shown, seen, v);
  });
  // Review shows a picture in a proposal's proof live: the card's Playground with the proposal's changes on top while
  // it waits (as the files are now, once applied), in the draft's own app.
  review.setLive(async (root, p, card) => {
    const state = index.snapshot().find((s) => s.project.root === root);
    if (!state) throw new Error('That project isn’t open.');
    // (Not applied yet, whether waiting, held back or waiting for its checks: shown with its changes.)
    const pending = p.status === 'proposed' || p.status === 'held-back' || p.status === 'awaiting-checks';
    const shown = { id: p.id, revision: pending ? 1 : 0, changes: pending ? p.changes : [] };
    const { project, items } = await draftItems(state, shown, (path) => vscodeFiles(root, changes).read(path));
    const item = items.find((i) => i.id === card);
    if (!item?.preview) throw new Error('This card can’t be shown in the Playground any more.');
    const plugin = state.detected.find(({ plugin: x }) => item.id.startsWith(`${x.id}:`))?.plugin;
    const app = await draftApps.open(root, shown, (id) => {
      const it = items.find((i) => i.id === id);
      return it && plugin?.previewPage?.(it, project);
    });
    return `${app}/__ve/preview?item=${encodeURIComponent(item.id)}`;
  });
  const hub = new Hub(context, {
    projects: () => index.snapshot(),
    current: () => current.get(),
    whenReady: (ms) => Promise.race([index.idle(), new Promise<void>((r) => setTimeout(r, ms))]),
    proposals: (root) => review.proposals(root),
    memory: (root) => memory.entries(root),
    readFile: (root, path) => vscodeFiles(root, changes).read(path),
    propose: (root, p) => review.receiveProposal(root, p),
    remember: (root, e) => memory.update(root, e),
    tools: () => registry.tools(),
    drafts: (root) => new DraftStore(root).list(),
    saveDraft: (root, d) => new DraftStore(root).save(d),
    jobs: (root) => new JobStore(root).list(),
    saveJob: (root, j) => {
      new JobStore(root).save(j);
      agentsView.refresh();
    },
    agents: () => registry.agents(),
    // Design sessions, for Claude in the developer's chat: the open one, opening one, continuing a proposal in one.
    session: (root) => sessions.current(root),
    startSession: (root, card, asked) => {
      const item = card ? index.snapshot().find((s) => s.project.root === root)?.items.find((i) => i.id === card) : undefined;
      return { draft: sessions.start(root, item, asked).id };
    },
    continueProposal: (root, id) => {
      const p = review.proposals(root).find((x) => x.id === id);
      if (!p) return `No proposal "${id}".`;
      if (!['proposed', 'sent-back', 'held-back'].includes(p.status)) return `Proposal ${id} is ${p.status}: only one that is waiting, sent back or held back can be changed.`;
      sessions.continueProposal(root, p);
      const draft = review.proposals(root).find((x) => x.id === id)?.session;
      return draft ? { draft } : 'The session couldn’t be opened.';
    },
    // A change Claude sent from the chat was held back: the developer sees which checks failed, and can bypass them.
    // (A session shows it in its tab; an agent's job sends it back to its worker by itself.)
    checked: (root, draft, result) => {
      if (typeof result !== 'string' || draft.session) return;
      if (new JobStore(root).list().some((j) => j.draft === draft.id && (j.status === 'working' || j.status === 'checking'))) return;
      const held = review.proposals(root).find((p) => p.id === `held-${draft.id}`);
      if (!held) return;
      const n = failedChecks(held.evidence ?? [], draft.revision).length;
      void vscode.window.showWarningMessage(`“${draft.title}” wasn’t sent to Review: ${n} check${n === 1 ? '' : 's'} failed.`, 'See and decide').then((pick) => pick && review.askBypass(root, held.id));
    },
    // The check planner: a separate Claude (the developer's own login) reads what was asked and the change, seeing what
    // each place really shows, and writes the test cases: which checks apply, and the scenarios.
    planChecks: async (root, draft, available) => {
      const model = vscode.workspace.getConfiguration('visualEditor.logicCheck').get<string>('model', 'sonnet');
      log.appendLine(`Writing the test cases (${model}) for “${draft.title}”…`);
      const seen = await changeSeen(root, draft);
      if (seen) seenFor.set(`${root}#${draft.id}#${draft.revision}`, seen);
      const r = await askClaude(claudeCommand(), root, model, planPrompt(draft.asked ?? [draft.title], draft.changes, available, seen?.places, draft.cases ?? []), 300_000, 'The check planner');
      if (typeof r === 'string') return r;
      const plan = readPlan(r.result, available, draft.revision);
      log.appendLine(typeof plan === 'string' ? `The test cases couldn't be written: ${plan}` : `Test cases for “${draft.title}”: ${plan.checks.filter((c) => c.use).length} checks, ${plan.cases.length} scenarios${r.cost !== undefined ? ` (at pay-per-use prices $${r.cost.toFixed(2)})` : ''}.`);
      return plan;
    },
    // The scenarios the developer approved: their own read in the code (one short run), then every one that can be
    // tried in the app is, with a second look where the run and the reading disagree.
    runPlannedCases: async (root, draft, plan) => {
      const model = vscode.workspace.getConfiguration('visualEditor.logicCheck').get<string>('model', 'sonnet');
      const asked = draft.asked ?? [draft.title];
      const seen = seenFor.get(`${root}#${draft.id}#${draft.revision}`) ?? (await changeSeen(root, draft));
      const used = plan.cases.filter((c) => c.use);
      const theirs = used.filter((c) => c.added);
      let read: LogicCase[] = [];
      let fixes = plan.fixes;
      if (theirs.length) {
        log.appendLine(`Reading ${theirs.length} scenario(s) of yours in the code…`);
        const v = await runLogicCheck(claudeCommand(), root, asked, draft.changes, model, theirs.map((c) => (c.expected ? `${c.case} (it should: ${c.expected})` : c.case)), { means: plan.means }, seen?.places);
        if (typeof v === 'string') return v;
        read = v.cases.map((c) => ({ ...c, by: 'developer' as const }));
        fixes = [...fixes, ...v.fixes];
      }
      const cases: LogicCase[] = [...used.filter((c) => !c.added).map(({ use: _u, skipped: _s, added: _a, ...c }) => c), ...read];
      const broke = cases.filter((c) => !c.ok);
      const v: LogicVerdict = { passed: !broke.length, looksOnly: plan.looksOnly, means: plan.means, cases, fixes: broke.length ? fixes : [] };
      return seen ? runInApp(root, asked, draft, seen, v) : v;
    },
    // A finished change's test cases are ready: the developer looks at them and runs them (a session shows them itself).
    planned: (root, draft) => {
      if (draft.session) return;
      void vscode.window.showInformationMessage(`The test cases for “${draft.title}” are ready: look at them, change them if you like, and run them.`, 'Look and run').then((pick) => pick && review.askPlan(root, `held-${draft.id}`));
    },
    // The previewable cards a draft changes, as it leaves them (a new design is part of its card).
    cardsTouched: async (root, draft) => {
      const state = index.snapshot().find((s) => s.project.root === root);
      if (!state) return [];
      const { items } = await draftItems(state, draft, (path) => vscodeFiles(root, changes).read(path));
      return cardsTouched(items, draft.changes.map((c) => c.path)).map((i) => i.id);
    },
    // A page of the app from the real files and from the draft's own app, pictured and compared.
    compareApp: async (root, draft, path) => {
      const real = await proxies.open(root);
      const state = index.snapshot().find((s) => s.project.root === root);
      const { project, items } = state ? await draftItems(state, draft, (p) => vscodeFiles(root, changes).read(p)) : { project: undefined, items: [] };
      const plugin = state?.detected[0]?.plugin;
      const drafted = await draftApps.open(root, draft, (id) => {
        const it = items.find((i) => i.id === id);
        return it && project && plugin?.previewPage?.(it, project);
      });
      const dir = join(root, DRAFTS_DIR, draft.id);
      const name = `app${path.replace(/[^\w]+/g, '-').replace(/-+$/, '') || '-home'}-v${draft.revision}`;
      const before = join(dir, `${name}-before.png`);
      const after = join(dir, `${name}-after.png`);
      const diff = join(dir, `${name}-difference.png`);
      const a = await takePicture(`${real}${path}`, before, { width: 1280, settleMs: 1500 });
      const b = await takePicture(`${drafted}${path}`, after, { width: 1280, settleMs: 1500 });
      draftApps.touch();
      const d = await comparePictures(before, after, diff);
      // (Errors the page already has without the draft aren't the draft's.)
      return { before, after, diff, ...d, problems: [...new Set(b.problems.filter((p) => !a.problems.includes(p)))] };
    },
    // A draft in the Playground: its cards read with the draft on top, drawn by the draft's own app, and pictured.
    pictures: async (root, draft, card) => {
      const state = index.snapshot().find((s) => s.project.root === root);
      if (!state) return 'That project isn’t open.';
      const { project, items } = await draftItems(state, draft, (path) => vscodeFiles(root, changes).read(path));
      const item = items.find((i) => i.id === card) ?? items.find((i) => i.label === card && i.preview);
      if (!item?.preview) return `${card} can’t be shown in the Playground as this draft leaves it: it isn’t previewable${item ? '' : ' (no card by that name)'}.`;
      const plugin = state.detected.find(({ plugin: p }) => item.id.startsWith(`${p.id}:`))?.plugin;
      const app = await draftApps.open(root, draft, (id) => {
        const it = items.find((i) => i.id === id);
        return it && plugin?.previewPage?.(it, project);
      });
      const image = join(root, DRAFTS_DIR, draft.id, `${item.label.replace(/[^\w.-]+/g, '-')}-v${draft.revision}.png`);
      const picture = await takePicture(`${app}/__ve/preview?item=${encodeURIComponent(item.id)}`, image);
      draftApps.touch();
      return { image, card: item.label, cardId: item.id, designs: item.preview.variants.map((v) => v.name), states: item.preview.states, ...picture };
    },
  }, log, new ClaudeAgents(context, () => ({ tools: registry.tools(), skills: registry.skills(), agents: registry.agents() }), run, log));
  void hub.start();
  // Design sessions: a tab that follows one draft live while Claude works on it in the developer's chat (session.ts).
  const sessions = new Sessions(context.extensionUri, {
    project: (root) => index.snapshot().find((s) => s.project.root === root),
    read: (root, path) => vscodeFiles(root, changes).read(path),
    openApp: (root, draft, page) => draftApps.open(root, draft, page),
    plan: (root, id) => void hub.planDraft(root, id),
    run: (root, id, edits) => {
      const r = hub.runChecks(root, id, edits);
      return typeof r === 'string' ? r : undefined;
    },
    openReview: (id) => review.show(id),
    markProposal: (root, id, draft) => review.setSessionOf(root, id, draft),
  });
  // Review: a proposal continued in a design session (its changes come back into it when the session is done).
  review.setSessions((root, p) => sessions.continueProposal(root, p));
  // Review: a change's test cases, run as the developer left them.
  // Review: new test cases for a change (the planner reads it again).
  review.setReplan((root, draft) => void hub.planDraft(root, draft));
  review.setChecks((root, draft, choice) => {
    const r = hub.runChecks(root, draft, choice);
    return typeof r === 'string' ? r : undefined;
  });
  const draftWatcher = vscode.workspace.createFileSystemWatcher('**/.visual-editor/drafts/*.json');
  const onDraft = (uri: vscode.Uri) => {
    const root = uri.fsPath.slice(0, uri.fsPath.lastIndexOf(`${sep}.visual-editor${sep}`));
    sessions.draftsChanged(root);
    review.draftsChanged(root);
  };
  context.subscriptions.push(sessions, draftWatcher, draftWatcher.onDidCreate(onDraft), draftWatcher.onDidChange(onDraft));
  // Plugins arrive one by one as their extensions start: once they've settled, the agents follow what they give.
  let agentsTimer: ReturnType<typeof setTimeout> | undefined;
  const refreshAgents = () => {
    clearTimeout(agentsTimer);
    agentsTimer = setTimeout(() => void hub.refreshAgents(), 3000);
  };
  refreshAgents();
  const assistantsView = new AssistantsView(hub);
  // Agents run from a button: in the background or in a terminal (agentRuns.ts).
  const agentsLog = vscode.window.createOutputChannel('Visual Editor: Agents');
  const agentRuns = new AgentRuns(log, agentsLog);
  context.subscriptions.push(agentsLog);
  const agentsView = new AgentsView(
    context.extensionUri,
    registry,
    hub,
    () => {
      const root = current.get()?.project.root;
      return root ? new JobStore(root).list() : [];
    },
    (id) => void vscode.commands.executeCommand('visualEditor.stopJob', { job: { id } }),
    (id) => agentRuns.progress(id),
    (id) => {
      const root = current.get()?.project.root;
      return root ? review.proposals(root).find((p) => p.id === id) : undefined;
    },
    { watch: (job) => agentRuns.watch(job), review: (proposal) => review.show(proposal) },
  );
  // (A proposal approved, sent back or rejected shows in its job's result too.)
  context.subscriptions.push(review.onChange(() => agentsView.refresh()));
  context.subscriptions.push(agentRuns, agentRuns.onChange(() => agentsView.refresh()));
  context.subscriptions.push(
    hub,
    assistantsView,
    vscode.window.registerTreeDataProvider('visualEditor.assistants', assistantsView),
    agentsView,
    vscode.window.registerWebviewViewProvider('visualEditor.agents', agentsView, { webviewOptions: { retainContextWhenHidden: true } }),
    current.onChange(() => agentsView.refresh()),
    hub.onChange(updateStatus),
    vscode.commands.registerCommand('visualEditor.chooseAssistant', () => chooseAssistant(hub)),
    vscode.commands.registerCommand('visualEditor.connectAssistant', () => hub.connectClaudeCode()),
    vscode.commands.registerCommand('visualEditor.disconnectAssistant', async () => {
      const pick = await vscode.window.showWarningMessage('Disconnect Claude Code from Visual Editor for this folder?', { modal: true }, 'Disconnect');
      if (pick) await hub.disconnectClaudeCode();
    }),
    vscode.commands.registerCommand('visualEditor.connectClaudeCode', () => hub.connectClaudeCode()),
    vscode.commands.registerCommand('visualEditor.addAgents', () => hub.addAgents()),
    // Review only, on or off (for every folder): the lock follows the setting.
    vscode.commands.registerCommand('visualEditor.reviewOnlyOn', () => vscode.workspace.getConfiguration('visualEditor.claude').update('reviewOnly', true, vscode.ConfigurationTarget.Global)),
    vscode.commands.registerCommand('visualEditor.reviewOnlyOff', async () => {
      const pick = await vscode.window.showWarningMessage('Let Claude Code edit this project’s files directly? Its changes then skip Review and its checks.', { modal: true }, 'Let it edit directly');
      if (pick) await vscode.workspace.getConfiguration('visualEditor.claude').update('reviewOnly', false, vscode.ConfigurationTarget.Global);
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('visualEditor.claude.reviewOnly')) return;
      hub.syncLock(true);
      void vscode.window.showInformationMessage(hub.reviewOnly ? 'Claude Code now changes files only through Review. Start a new Claude Code session for it to take effect.' : 'Claude Code can now edit files directly. Start a new Claude Code session for it to take effect.');
    }),
    vscode.commands.registerCommand('visualEditor.openAgents', () => agentsView.openPanel()),
    // A design session, about a component (from the Playground, or chosen here) or the whole app.
    vscode.commands.registerCommand('visualEditor.startSession', async (arg?: { card?: string }) => {
      const state = current.get();
      if (!state) return void vscode.window.showInformationMessage('Open a project on the map first.');
      let card = arg?.card ? state.items.find((i) => i.id === arg.card) : undefined;
      if (!arg?.card) {
        const pick = await vscode.window.showQuickPick(
          [{ label: '$(globe) The whole app', description: 'no one component', item: undefined }, ...state.items.filter((i) => i.preview).map((i) => ({ label: i.label, description: i.source?.path, item: i }))],
          { title: 'Start a design session', placeHolder: 'Which component is it about?' },
        );
        if (!pick) return;
        card = pick.item;
      }
      const draft = sessions.start(state.project.root, card);
      void vscode.window.showInformationMessage(`Design session started (draft ${draft.id}). Tell Claude in your Claude Code chat what you want; each change shows in the session by itself.`);
    }),
    vscode.commands.registerCommand('visualEditor.openSession', async () => {
      const root = current.get()?.project.root;
      if (!root) return;
      const open = new DraftStore(root).list().filter((d) => d.session && d.status === 'draft');
      if (!open.length) return void vscode.window.showInformationMessage('No design session is open in this project. Start one with “Start a design session”.');
      const pick = await vscode.window.showQuickPick(open.map((d) => ({ label: d.title, description: `version ${d.revision}`, id: d.id })), { title: 'Open a design session' });
      if (pick) sessions.open(root, pick.id);
    }),
    // Stop an agent's job: its next step is to stop (the worker and checker are told so by every job tool).
    vscode.commands.registerCommand('visualEditor.stopJob', async (node?: { job?: { id: string } }) => {
      const root = current.get()?.project.root;
      if (!root) return;
      const store = new JobStore(root);
      const running = store.list().filter((j) => !finished(j));
      const id = node?.job?.id ?? (running.length === 1 ? running[0].id : (await vscode.window.showQuickPick(running.map((j) => ({ label: j.title, description: `${j.status}, round ${j.round} of ${j.rounds}`, detail: j.request, id: j.id })), { placeHolder: 'Which job should stop?' }))?.id);
      const j = running.find((x) => x.id === id);
      if (!j) return void (running.length ? undefined : vscode.window.showInformationMessage('No agent is working right now.'));
      // (A run from a button also ends its process.)
      agentRuns.stop(root, j.id);
      agentsView.refresh();
      void vscode.window.showInformationMessage(`${j.title} is stopping: it stops at its next step.`);
    }),
    // Run an agent: which one, what it should do (in the developer's words), and where (the setting, or the button's).
    vscode.commands.registerCommand('visualEditor.runAgent', async (name?: string, way?: RunWay) => {
      const state = current.get();
      if (!state) return void vscode.window.showInformationMessage('Open a project first.');
      const mine = registry.agents().filter(({ plugin }) => state.detected.some((d) => d.plugin.id === plugin.id));
      if (!mine.length) return void vscode.window.showInformationMessage(`No agent works on ${state.project.name} yet.`);
      const chosen = name
        ? mine.find((a) => a.agent.name === name)
        : (await vscode.window.showQuickPick(mine.map((a) => ({ label: a.agent.title, detail: a.agent.summary ?? a.agent.description, a })), { placeHolder: 'Which agent?' }))?.a;
      if (!chosen) return;
      const agent = chosen.agent;
      const claude = hub.assistants().find((a) => a.id === 'claude');
      if (claude?.state !== 'on') {
        const pick = await vscode.window.showWarningMessage(`${agent.title} runs with Claude Code: connect it first.`, 'Connect Claude Code');
        if (pick) await hub.connectClaudeCode();
        return;
      }
      if (claude.agents === 'off') {
        const pick = await vscode.window.showWarningMessage(`Add Visual Editor’s agents to Claude Code first, so it knows ${agent.title}.`, 'Add agents');
        if (pick) await hub.addAgents();
        return;
      }
      const request = await vscode.window.showInputBox({
        title: `${agent.title}: what should it do?`,
        prompt: agent.summary ?? agent.description,
        placeHolder: agent.name === 'new-variant' ? 'e.g. ProjectCard: a big coloured initial with the name under it' : 'In your own words',
        ignoreFocusOut: true,
      });
      if (!request?.trim()) return;
      const config = vscode.workspace.getConfiguration('visualEditor.agents');
      const where = way ?? config.get<RunWay>('runIn', 'background');
      agentRuns.start(state.project.root, agent, request, where, config.get<number>('maxCostUsd', 0));
      agentsView.refresh();
      if (where === 'background') void vscode.window.showInformationMessage(`${agent.title} is working in the background: follow it in the Agents section (Stop is there too). The result comes to Review.`);
    }),
    registry.onChange(refreshAgents),
    { dispose: () => clearTimeout(agentsTimer) },
  );

  log.appendLine(`Visual Editor started (plugin contract ${CONTRACT_VERSION}).`);
  const api: ShellApi = {
    contract: CONTRACT_VERSION,
    register(plugin: Plugin) {
      try {
        const registration = registry.register(plugin);
        log.appendLine(`Plugin added: ${plugin.name} ${plugin.version}`);
        return registration;
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        log.appendLine(message);
        void vscode.window.showWarningMessage(message);
        throw e;
      }
    },
  };
  // The VS Code test (npm run test:vscode) reaches inside; never switched on otherwise.
  if (process.env.VISUAL_EDITOR_TEST === '1') return Object.assign(api, { _test: { index, current, review, memory, changes, map, hub, agentsView, sessions } });
  return api;
}

export function deactivate() {}
