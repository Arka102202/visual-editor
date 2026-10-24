// Puts Visual Editor's Claude Code plugin (claudePlugin.ts) where Claude Code can install it, and installs it for the
// open folder only: the files live in VS Code's storage for this extension, and the folder's own Claude Code settings
// (.claude/settings.local.json, which git ignores) say to use them. A new version is made whenever plugins change what
// they give assistants, and Claude Code is told to update to it.

import * as vscode from 'vscode';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CLAUDE_PLUGIN, claudePluginFiles, claudePluginKey, type ClaudeParts } from './claudePlugin';

/** The plugin's content key and version number, kept between restarts (one plugin for every project). */
const MADE_KEY = 'visualEditor.claudePlugin.made';
/** The version installed for this folder. */
const INSTALLED_KEY = 'visualEditor.claudePlugin.installed';
/** This folder was asked once whether to add the agents. */
const ASKED_KEY = 'visualEditor.claudePlugin.asked';

export type AgentsState = 'on' | 'off' | 'old';
export type Run = (command: string, cwd: string) => Promise<{ ok: boolean; notFound: boolean; output: string }>;

export class ClaudeAgents {
  /** Its marketplace's name in Claude Code: a test VS Code uses its own, so it never takes over the real one. */
  readonly marketplace = process.env.VISUAL_EDITOR_TEST === '1' ? 'visual-editor-test' : 'visual-editor';
  private version = '';

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly parts: () => ClaudeParts,
    private readonly run: Run,
    private readonly log: vscode.OutputChannel,
  ) {}

  /** Where the plugin's files are. */
  get dir(): string {
    return join(this.context.globalStorageUri.fsPath, 'claude-plugin');
  }

  /** What Claude Code calls it: plugin@marketplace. */
  get ref(): string {
    return `${CLAUDE_PLUGIN}@${this.marketplace}`;
  }

  /** Writes the plugin's files, as a new version when what plugins give has changed. */
  write(): string {
    const parts = this.parts();
    const key = claudePluginKey(parts);
    const made = this.context.globalState.get<{ key: string; n: number }>(MADE_KEY);
    // Numbered by when it was made (seconds), never by counting: Claude Code keeps every version it has seen and
    // reuses one by its number, so a count that starts again (another VS Code profile, a reset) would bring back old files.
    const n = made?.key === key ? made.n : Math.max(Math.floor(Date.now() / 1000), (made?.n ?? 0) + 1);
    const version = `1.0.${n}`;
    if (made?.key !== key) void this.context.globalState.update(MADE_KEY, { key, n });
    if (version !== this.version || made?.key !== key || !existsSync(join(this.dir, '.claude-plugin/marketplace.json'))) {
      rmSync(this.dir, { recursive: true, force: true });
      for (const [path, text] of Object.entries(claudePluginFiles(parts, version, this.marketplace))) {
        mkdirSync(dirname(join(this.dir, path)), { recursive: true });
        writeFileSync(join(this.dir, path), text);
      }
      this.log.appendLine(`Visual Editor's Claude Code plugin is at version ${version} (${parts.agents.length} agent(s), ${parts.skills.length} skill(s) from plugins).`);
    }
    this.version = version;
    return version;
  }

  /** Whether it's installed for the folder ('old': an earlier version). */
  state(folder: string): AgentsState {
    const settings = readJson(join(folder, '.claude', 'settings.local.json')) as { enabledPlugins?: Record<string, boolean> } | undefined;
    if (settings?.enabledPlugins?.[this.ref] !== true) return 'off';
    return this.version && this.context.workspaceState.get<string>(INSTALLED_KEY) !== this.version ? 'old' : 'on';
  }

  /** Installs it for the folder only. Undefined when it worked, else what went wrong. */
  async install(folder: string): Promise<string | undefined> {
    const version = this.write();
    const settings = readJson(join(folder, '.claude', 'settings.local.json')) as { extraKnownMarketplaces?: Record<string, { source?: { path?: string } }> } | undefined;
    if (settings?.extraKnownMarketplaces?.[this.marketplace]?.source?.path !== this.dir) {
      const added = await this.run(`claude plugin marketplace add ${quote(this.dir)} --scope local`, folder);
      if (!added.ok) return this.failed('add its marketplace', added.output);
    }
    const installed = await this.run(`claude plugin install ${this.ref} -s local`, folder);
    if (!installed.ok) return this.failed('install it', installed.output);
    await this.context.workspaceState.update(INSTALLED_KEY, version);
    return undefined;
  }

  /** Brings the folder's copy up to date, when it's installed and older. True when it was updated. */
  async update(folder: string): Promise<boolean> {
    this.write();
    if (this.state(folder) !== 'old') return false;
    const r = await this.run(`claude plugin update ${this.ref} -s local`, folder);
    if (!r.ok) {
      this.failed('update it', r.output);
      return false;
    }
    await this.context.workspaceState.update(INSTALLED_KEY, this.version);
    return true;
  }

  async uninstall(folder: string): Promise<string | undefined> {
    if (this.state(folder) === 'off') return undefined;
    const r = await this.run(`claude plugin uninstall ${this.ref} -s local`, folder);
    if (!r.ok) return this.failed('remove it', r.output);
    await this.context.workspaceState.update(INSTALLED_KEY, undefined);
    return undefined;
  }

  /** Asks once per folder (connected before agents existed) whether to add them. */
  shouldAsk(folder: string): boolean {
    return this.state(folder) === 'off' && !this.context.workspaceState.get<boolean>(ASKED_KEY);
  }

  async asked() {
    await this.context.workspaceState.update(ASKED_KEY, true);
  }

  private failed(what: string, output: string): string {
    const why = `Claude Code couldn't ${what}: ${output.slice(0, 300) || 'no reason given'}`;
    this.log.appendLine(why);
    return why;
  }
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

/** A path for the shell, quoted (VS Code's storage is under "Application Support" on macOS). */
const quote = (path: string) => `'${path.replace(/'/g, `'\\''`)}'`;
