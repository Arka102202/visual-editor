// The Visual Editor shell inside VS Code: holds the plugins, and (as Step 1 grows) the project index, the maps, review,
// memory and the assistant hub. Plugins find it through its exported API (see @visual-editor/contract).

import * as vscode from 'vscode';
import { CONTRACT_VERSION, type Plugin, type ShellApi } from '@visual-editor/contract';
import { PluginRegistry } from './registry';
import { PluginsView } from './pluginsView';
import { ProjectIndex } from './projectIndex';
import { ProjectsView } from './projectsView';
import { findWorkspace, isIgnoredPath, isProjectFile } from './projects';
import { basename, relative, sep } from 'node:path';
import { CurrentProject } from './currentProject';
import { MapPanel } from './mapPanel';
import { OutsideChanges } from './changes';
import { Review } from './review';
import { askEntry, MemoryView, ProjectMemory } from './memoryView';
import type { MemoryEntry } from './memory';
import { Hub } from './hub/hub';
import { AssistantsView, chooseAssistant } from './hub/assistantsView';
import { vscodeFiles } from './vscodeFiles';
import { PreviewServer } from './previewServer';
import { PreviewPanel, type PreviewTarget } from './previewPanel';

export function activate(context: vscode.ExtensionContext): ShellApi {
  const registry = new PluginRegistry();
  const log = vscode.window.createOutputChannel('Visual Editor');

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
  const review = new Review(context.extensionUri, index, current, changes, memory);
  const projectsView = new ProjectsView(index, current, review);
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
  const onFile = (addedOrRemoved: boolean) => (uri: vscode.Uri) => {
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
    if (owner) changes.note(owner, relative(owner, uri.fsPath).split(sep).join('/'), uri.fsPath);
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
    watcher.onDidCreate(onFile(true)),
    watcher.onDidDelete(onFile(true)),
    watcher.onDidChange(onFile(false)),
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
  const map = new MapPanel(context.extensionUri, index, current, review, changes, memory);
  context.subscriptions.push(
    map,
    vscode.commands.registerCommand('visualEditor.openMap', () => map.show()),
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

  // The preview frame: how a card looks, drawn by its plugin; Before and After for proposals.
  const previewServer = new PreviewServer();
  const preview = new PreviewPanel(context.extensionUri, index, review, changes, previewServer, current);
  const openPreview = (target: PreviewTarget) => void preview.show(target);
  map.openPreview = openPreview;
  review.openPreview = openPreview;
  context.subscriptions.push(
    preview,
    { dispose: () => void previewServer.stop() },
    vscode.commands.registerCommand('visualEditor.preview', (item?: string) => {
      const root = current.get()?.project.root;
      if (root && typeof item === 'string') openPreview({ root, item });
    }),
  );

  // The assistant hub: Claude Code reads the map, rules and memory, and proposes changes into Review.
  const hub = new Hub(context, {
    projects: () => index.snapshot(),
    current: () => current.get(),
    whenReady: (ms) => Promise.race([index.idle(), new Promise<void>((r) => setTimeout(r, ms))]),
    proposals: (root) => review.proposals(root),
    memory: (root) => memory.entries(root),
    readFile: (root, path) => vscodeFiles(root, changes).read(path),
    propose: (root, p) => review.receiveProposal(root, p),
    remember: (root, e) => memory.update(root, e),
  }, log);
  void hub.start();
  const assistantsView = new AssistantsView(hub);
  context.subscriptions.push(
    hub,
    assistantsView,
    vscode.window.registerTreeDataProvider('visualEditor.assistants', assistantsView),
    hub.onChange(updateStatus),
    vscode.commands.registerCommand('visualEditor.chooseAssistant', () => chooseAssistant(hub)),
    vscode.commands.registerCommand('visualEditor.connectAssistant', () => hub.connectClaudeCode()),
    vscode.commands.registerCommand('visualEditor.disconnectAssistant', async () => {
      const pick = await vscode.window.showWarningMessage('Disconnect Claude Code from Visual Editor for this folder?', { modal: true }, 'Disconnect');
      if (pick) await hub.disconnectClaudeCode();
    }),
    vscode.commands.registerCommand('visualEditor.connectClaudeCode', () => hub.connectClaudeCode()),
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
  if (process.env.VISUAL_EDITOR_TEST === '1') return Object.assign(api, { _test: { index, current, review, memory, changes, map, hub, preview } });
  return api;
}

export function deactivate() {}
