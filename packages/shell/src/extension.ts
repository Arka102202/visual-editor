// The Visual Editor shell inside VS Code: holds the plugins, and (as Step 1 grows) the project index, the maps, review,
// memory and the assistant hub. Plugins find it through its exported API (see @visual-editor/contract).

import * as vscode from 'vscode';
import { CONTRACT_VERSION, type Plugin, type ShellApi } from '@visual-editor/contract';
import { PluginRegistry } from './registry';
import { PluginsView } from './pluginsView';
import { ProjectIndex } from './projectIndex';
import { ProjectsView } from './projectsView';
import { findWorkspace, isIgnoredPath, isProjectFile } from './projects';
import { basename, join, relative, sep } from 'node:path';
import { CurrentProject } from './currentProject';
import { MapPanel } from './mapPanel';
import { AppProxies } from './proxy/appProxies';
import { OutsideChanges } from './changes';
import { Review } from './review';
import { ProjectSetups } from './projectSetup';
import { askEntry, MemoryView, ProjectMemory } from './memoryView';
import type { MemoryEntry } from './memory';
import { Hub, run } from './hub/hub';
import { DRAFTS_DIR, DraftStore } from './drafts';
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
  // Review shows a picture in a proposal's proof live: the card's Playground with the proposal's changes on top while
  // it waits (as the files are now, once applied), in the draft's own app.
  review.setLive(async (root, p, card) => {
    const state = index.snapshot().find((s) => s.project.root === root);
    if (!state) throw new Error('That project isn’t open.');
    const shown = { id: p.id, revision: p.status === 'proposed' ? 1 : 0, changes: p.status === 'proposed' ? p.changes : [] };
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
    vscode.commands.registerCommand('visualEditor.openAgents', () => agentsView.openPanel()),
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
  if (process.env.VISUAL_EDITOR_TEST === '1') return Object.assign(api, { _test: { index, current, review, memory, changes, map, hub, agentsView } });
  return api;
}

export function deactivate() {}
