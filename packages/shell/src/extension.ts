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

export function activate(context: vscode.ExtensionContext): ShellApi {
  const registry = new PluginRegistry();
  const log = vscode.window.createOutputChannel('Visual Editor');

  // The side panel: which plugins are installed, and any that couldn't be used.
  const pluginsView = new PluginsView(registry);
  context.subscriptions.push(log, vscode.window.registerTreeDataProvider('visualEditor.plugins', pluginsView), pluginsView);

  // The project index: the projects in the opened folders, and what each plugin found in them.
  const index = new ProjectIndex(registry);
  const projectsView = new ProjectsView(index);
  context.subscriptions.push(index, projectsView, vscode.window.registerTreeDataProvider('visualEditor.projects', projectsView));
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
    pending.add(uri.fsPath);
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, 300);
  };
  const watcher = vscode.workspace.createFileSystemWatcher('**/*');
  context.subscriptions.push(
    watcher,
    watcher.onDidCreate(onFile(true)),
    watcher.onDidDelete(onFile(true)),
    watcher.onDidChange(onFile(false)),
    vscode.workspace.onDidChangeWorkspaceFolders(scan),
    { dispose: () => timer && clearTimeout(timer) },
  );

  // One status bar button for everything.
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  status.command = 'visualEditor.showPlugins';
  const updateStatus = () => {
    const n = registry.list().length;
    const projects = index.snapshot().length;
    status.text = `$(symbol-structure) Visual Editor${projects > 1 ? ` · ${projects} projects` : ''}${n ? ` · ${n} plugin${n === 1 ? '' : 's'}` : ''}`;
    status.tooltip = n ? `Plugins: ${registry.list().map((p) => p.name).join(', ')}` : 'No plugins yet: add one for your project (React, Express…)';
  };
  updateStatus();
  status.show();
  context.subscriptions.push(
    status,
    registry.onChange(updateStatus),
    index.onChange(updateStatus),
    vscode.commands.registerCommand('visualEditor.showPlugins', () => vscode.commands.executeCommand('visualEditor.plugins.focus')),
  );

  log.appendLine(`Visual Editor started (plugin contract ${CONTRACT_VERSION}).`);
  return {
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
}

export function deactivate() {}
