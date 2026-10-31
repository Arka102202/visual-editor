// The assistant hub inside VS Code: runs the MCP server while VS Code is open, and connects Claude Code to it with one
// click. The port and the secret key stay the same between restarts, so Claude Code only connects once per project.
// The key is kept in VS Code's secret storage and in Claude Code's own settings for this folder, never in the project.

import * as vscode from 'vscode';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync, realpathSync, unwatchFile, watchFile } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Disposable } from '@visual-editor/contract';
import type { AgentsState, ClaudeAgents } from './claudeAgents';
import { GUARD_MARK, lock, locked, quote, unlock } from './claudeLock';
import { startHttpHost, type HttpHost } from './http';
import { createHubServer, draftFlow, friendlyClient, SERVER_NAME, type HubHost } from './tools';
import type { CheckPlan, PlanEdits } from './checkPlan';
import type { Proposal } from '../proposals';

const PORT_KEY = 'visualEditor.hub.port';
/** Claude Code's own settings, where it keeps which MCP servers each folder uses. */
const claudeConfig = () => join(process.env.CLAUDE_CONFIG_DIR ?? homedir(), '.claude.json');
/** Where `claude` is usually installed; VS Code started from the Dock doesn't always have these on its PATH. */
const CLAUDE_DIRS = [join(homedir(), '.local/bin'), join(homedir(), '.claude/local'), '/opt/homebrew/bin', '/usr/local/bin'];
const tokenKey = (folder: string) => `visualEditor.hub.token:${folder}`;

export type ClaudeState = 'on' | 'off' | 'old';

/** An assistant that can work with Visual Editor (Claude Code for now). */
export interface Assistant {
  id: 'claude';
  name: string;
  /** Saved in its settings for this folder ('old': at an earlier address). */
  state: ClaudeState;
  /** It talked to the hub since VS Code started. */
  talking: boolean;
  /** Visual Editor's agents and know-how (its Claude Code plugin) are installed for this folder. */
  agents: AgentsState;
  /** It changes the project's files only through Review (claudeLock.ts): locked in its settings for this folder. */
  reviewOnly: boolean;
}

export class Hub implements vscode.Disposable {
  private http: HttpHost | undefined;
  private token = '';
  private readonly clients = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private problem: string | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly host: HubHost,
    private readonly log: vscode.OutputChannel,
    private readonly agents?: ClaudeAgents,
  ) {
    // Connected or disconnected some other way (a terminal, Claude Code's /mcp): the list follows.
    watchFile(claudeConfig(), { interval: 2000 }, () => {
      this.syncLock();
      this.fire();
    });
  }

  /** The "Review only" setting: Claude Code changes files only through Visual Editor (on unless turned off). */
  get reviewOnly(): boolean {
    return vscode.workspace.getConfiguration('visualEditor.claude').get<boolean>('reviewOnly', true);
  }

  /**
   * Puts the Review-only lock on a connected folder (again, so its check runs from this version of Visual Editor), or
   * takes it off when the setting is off or Claude Code isn't connected. `show`: the Assistants list follows.
   */
  syncLock(show = false) {
    const folder = this.folder;
    if (!folder) return;
    try {
      if (this.reviewOnly && this.claudeState() !== 'off') {
        const guard = `VE=${GUARD_MARK} ELECTRON_RUN_AS_NODE=1 ${quote(process.execPath)} ${quote(this.context.asAbsolutePath('dist/claudeGuard.js'))}`;
        lock(folder, guard);
      } else if (locked(folder)) unlock(folder);
    } catch (e) {
      this.log.appendLine(`The Review-only lock couldn't be ${this.reviewOnly ? 'set' : 'taken off'}: ${e instanceof Error ? e.message : e}`);
    }
    if (show) this.fire();
  }

  /** The folder Claude Code is connected for (its "project"): the first one open. */
  private get folder(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  get url(): string | undefined {
    return this.http?.url;
  }

  async start() {
    const folder = this.folder;
    if (!folder) return;
    this.token = (await this.context.secrets.get(tokenKey(folder))) ?? randomBytes(24).toString('hex');
    await this.context.secrets.store(tokenKey(folder), this.token);
    // A port picked once per project and kept, so Claude Code's saved connection keeps working.
    const preferred = this.context.workspaceState.get<number>(PORT_KEY) ?? 41000 + Math.floor(Math.random() * 8000);
    const version = String(this.context.extension.packageJSON.version ?? '0.0.0');
    try {
      this.http = await startHttpHost({
        port: preferred,
        token: this.token,
        makeServer: (client) => createHubServer(this.host, version, client ? friendlyClient(client) : 'Assistant'),
        onClient: (name) => {
          if (this.clients.has(name)) return;
          this.clients.add(name);
          this.log.appendLine(`${friendlyClient(name)} connected to the hub.`);
          this.fire();
        },
      });
      await this.context.workspaceState.update(PORT_KEY, this.http.port);
      this.log.appendLine(`Assistant hub listening on ${this.http.url}`);
      if (this.http.portChanged && this.claudeState() !== 'off') {
        this.problem = 'The usual port was busy, so a new one is used. Connect Claude Code again.';
        void vscode.window.showWarningMessage(`Visual Editor: ${this.problem}`, 'Connect Claude Code').then((pick) => pick && this.connectClaudeCode());
      }
    } catch (e) {
      this.problem = `The assistant hub couldn't start: ${e instanceof Error ? e.message : e}`;
      this.log.appendLine(this.problem);
    }
    this.syncLock();
    this.fire();
  }

  /** Whether Claude Code's own settings (~/.claude.json) have the hub for this folder, at the current address. */
  claudeState(): ClaudeState {
    const folder = this.folder;
    try {
      const config = JSON.parse(readFileSync(claudeConfig(), 'utf8')) as {
        projects?: Record<string, { mcpServers?: Record<string, { url?: string }> }>;
      };
      // Claude Code saves it under the folder's real path (links resolved).
      const keys = folder ? [folder, safeRealpath(folder)] : [];
      const entry = keys.map((k) => config.projects?.[k]?.mcpServers?.[SERVER_NAME]).find(Boolean);
      if (!entry) return 'off';
      return entry.url && this.http && entry.url !== this.http.url ? 'old' : 'on';
    } catch {
      return 'off';
    }
  }

  /** Every assistant that can connect, with its state. */
  assistants(): Assistant[] {
    const folder = this.folder;
    return [{ id: 'claude', name: 'Claude Code', state: this.claudeState(), talking: this.connected().includes('Claude Code'), agents: folder && this.agents ? this.agents.state(folder) : 'off', reviewOnly: !!folder && locked(folder) }];
  }

  /** Assistants that talked to the hub since VS Code started, by name. */
  connected(): string[] {
    return [...this.clients].map(friendlyClient);
  }

  /** Why the hub isn't working, when it isn't. */
  trouble(): string | undefined {
    return this.http ? undefined : this.problem;
  }

  /**
   * Adds the hub to Claude Code for this folder only ("local" scope): saved in the developer's own Claude Code
   * settings, never in the project, so the key isn't shared.
   */
  async connectClaudeCode() {
    const folder = this.folder;
    if (!folder) return void vscode.window.showInformationMessage('Open a folder first.');
    if (!this.http) return void vscode.window.showWarningMessage(this.problem ?? 'The assistant hub is not running.');
    await run(`claude mcp remove ${SERVER_NAME} -s local`, folder);
    const result = await run(this.addCommand(), folder);
    if (result.ok) {
      this.problem = undefined;
      // Its agents and know-how come with it, for this folder too.
      const agentsProblem = await this.agents?.install(folder);
      this.syncLock();
      this.fire();
      void vscode.window.showInformationMessage(
        `Claude Code is connected to Visual Editor for this folder${agentsProblem ? '' : ', with Visual Editor’s agents'}. Start a new Claude Code session (or run /mcp), then ask in words, e.g. "give me an overview of this project". ${this.reviewOnly ? 'It changes files only through Review.' : 'Its proposals arrive in Review.'}`,
      );
      if (agentsProblem) void vscode.window.showWarningMessage(`Visual Editor’s agents weren’t added: ${agentsProblem}`);
      return;
    }
    const pick = await vscode.window.showWarningMessage(
      result.notFound ? "Couldn't find Claude Code's `claude` command. If it's installed, run the setup in a terminal instead." : `Claude Code didn't accept the setup: ${result.output.slice(0, 300)}`,
      'Run in terminal',
      'Copy command',
    );
    if (pick === 'Run in terminal') {
      const terminal = vscode.window.createTerminal({ name: 'Visual Editor: connect Claude Code', cwd: folder });
      terminal.show();
      terminal.sendText(`claude mcp remove ${SERVER_NAME} -s local; ${this.addCommand()}`);
    }
    if (pick === 'Copy command') await vscode.env.clipboard.writeText(this.addCommand());
  }

  async disconnectClaudeCode() {
    const folder = this.folder;
    if (!folder) return;
    const result = await run(`claude mcp remove ${SERVER_NAME} -s local`, folder);
    if (!result.ok && this.claudeState() !== 'off') {
      void vscode.window.showWarningMessage(`Couldn't disconnect Claude Code. In a terminal here, run: claude mcp remove ${SERVER_NAME} -s local`);
      return;
    }
    await this.agents?.uninstall(folder);
    if (locked(folder)) unlock(folder);
    for (const name of [...this.clients]) if (friendlyClient(name) === 'Claude Code') this.clients.delete(name);
    this.fire();
    void vscode.window.showInformationMessage('Claude Code is disconnected from Visual Editor for this folder. Start a new Claude Code session for it to take effect.');
  }

  /** A finished draft (Done in a session): its test cases are written, in the background, for the developer to run. */
  planDraft(root: string, id: string): Promise<CheckPlan | string> {
    const s = this.host.projects().find((p) => p.project.root === root);
    if (!s) return Promise.resolve('That project isn’t open.');
    return draftFlow(this.host).requestChecks(s, id);
  }

  /**
   * The developer ran a draft's test cases (as they left them): they run in the background, and it goes to Review or
   * is held back. A string says why they can't run now; otherwise the promise of how it ends.
   */
  runChecks(root: string, id: string, edits: PlanEdits): string | { promise: Promise<{ proposal: Proposal } | string> } {
    const s = this.host.projects().find((p) => p.project.root === root);
    if (!s) return 'That project isn’t open.';
    return draftFlow(this.host).runChecks(s, id, edits, 'ask Claude to fix it, then run the checks again');
  }

  /** Adds Visual Editor's agents and know-how to Claude Code for this folder (connected before they existed). */
  async addAgents() {
    const folder = this.folder;
    if (!folder || !this.agents) return;
    const problem = await this.agents.install(folder);
    this.fire();
    if (problem) void vscode.window.showWarningMessage(`Visual Editor’s agents weren’t added: ${problem}`);
    else void vscode.window.showInformationMessage('Visual Editor’s agents are added to Claude Code for this folder. Start a new Claude Code session to use them.');
  }

  /**
   * When plugins change what they give assistants: a new version of the agents, which Claude Code updates to for this
   * folder; a folder connected before agents existed is asked once whether to add them.
   */
  async refreshAgents() {
    const folder = this.folder;
    if (!folder || !this.agents) return;
    if (await this.agents.update(folder)) {
      this.fire();
      void vscode.window.showInformationMessage('Visual Editor’s agents for Claude Code were updated. Start a new Claude Code session to use the new ones.');
    }
    if (this.claudeState() === 'on' && this.agents.shouldAsk(folder)) {
      await this.agents.asked();
      const pick = await vscode.window.showInformationMessage('Claude Code is connected to Visual Editor here. Add Visual Editor’s agents and know-how to it too?', 'Add agents');
      if (pick) await this.addAgents();
    }
  }

  onChange(fn: () => void): Disposable {
    this.listeners.add(fn);
    return { dispose: () => this.listeners.delete(fn) };
  }

  dispose() {
    unwatchFile(claudeConfig());
    void this.http?.close();
    this.listeners.clear();
  }

  private addCommand(): string {
    return `claude mcp add --transport http --scope local ${SERVER_NAME} ${this.http?.url ?? ''} --header 'Authorization: Bearer ${this.token}'`;
  }

  private fire() {
    for (const fn of this.listeners) fn();
  }
}

function safeRealpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** Runs a shell command in a folder; says whether it worked, and whether the command wasn't found at all. */
/** `claude`, found where it's usually installed even when VS Code's own PATH doesn't have it (for a shell command). */
export function claudeCommand(): string {
  // (The VS Code test can put a stand-in in its place, so running an agent costs nothing.)
  if (process.env.VISUAL_EDITOR_TEST === '1' && process.env.VISUAL_EDITOR_CLAUDE_BIN) return JSON.stringify(process.env.VISUAL_EDITOR_CLAUDE_BIN);
  return `PATH="${CLAUDE_DIRS.join(':')}:$PATH" claude`;
}

export function run(command: string, cwd: string): Promise<{ ok: boolean; notFound: boolean; output: string }> {
  return new Promise((resolve) => {
    // A login shell, so the developer's PATH (where `claude` lives) is used.
    const PATH = [...CLAUDE_DIRS, process.env.PATH ?? ''].join(':');
    const child = spawn(process.env.SHELL || '/bin/zsh', ['-lc', `export PATH="${PATH}"; ${command}`], { cwd, env: { ...process.env, PATH } });
    let output = '';
    child.stdout.on('data', (d) => (output += d));
    child.stderr.on('data', (d) => (output += d));
    child.on('error', () => resolve({ ok: false, notFound: true, output }));
    child.on('close', (code) => resolve({ ok: code === 0, notFound: code === 127, output: output.trim() }));
  });
}
