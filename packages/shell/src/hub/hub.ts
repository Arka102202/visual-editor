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
import { startHttpHost, type HttpHost } from './http';
import { createHubServer, friendlyClient, SERVER_NAME, type HubHost } from './tools';

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
  ) {
    // Connected or disconnected some other way (a terminal, Claude Code's /mcp): the list follows.
    watchFile(claudeConfig(), { interval: 2000 }, () => this.fire());
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
    return [{ id: 'claude', name: 'Claude Code', state: this.claudeState(), talking: this.connected().includes('Claude Code') }];
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
      this.fire();
      void vscode.window.showInformationMessage(
        'Claude Code is connected to Visual Editor for this folder. Start a new Claude Code session (or run /mcp), then ask in words, e.g. "give me an overview of this project". Its changes arrive in Review.',
      );
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
    for (const name of [...this.clients]) if (friendlyClient(name) === 'Claude Code') this.clients.delete(name);
    this.fire();
    void vscode.window.showInformationMessage('Claude Code is disconnected from Visual Editor for this folder. Start a new Claude Code session for it to take effect.');
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
function run(command: string, cwd: string): Promise<{ ok: boolean; notFound: boolean; output: string }> {
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
