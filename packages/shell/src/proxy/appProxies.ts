// The proxies of the open projects: one per project, started when first needed (with the project's dev server behind
// it), its calls written to Visual Editor's output, and everything stopped when Visual Editor closes.

import * as vscode from 'vscode';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { DevServer, get } from './devServer';
import { AppProxy, type Recorded } from './proxy';
import { Fakes, FAKES_DIR, type FakeEndpoint, type Scenarios } from './fakes';
import { mapIn, original, type SourceMap } from './sourceMap';

export class AppProxies implements vscode.Disposable {
  private readonly running = new Map<string, { dev: DevServer; proxy: AppProxy }>();
  private readonly fakes = new Map<string, { fakes: Fakes; watcher: vscode.FileSystemWatcher }>();
  /** Headers the proxy adds to calls (by project), kept in VS Code's secret storage: never in the project's files. */
  private readonly headers = new Map<string, Record<string, string>>();
  private readonly callListeners = new Set<(root: string, r: Recorded) => void>();
  private readonly fakeListeners = new Set<(root: string) => void>();

  constructor(
    private readonly log: vscode.OutputChannel,
    private readonly secrets?: vscode.SecretStorage,
  ) {}

  /** Each call (or page) a project's app makes, as it's recorded. */
  onCall(listener: (root: string, r: Recorded) => void): vscode.Disposable {
    this.callListeners.add(listener);
    return { dispose: () => this.callListeners.delete(listener) };
  }

  /** A project's fakes changed (from Visual Editor, or its files were edited). */
  onFakes(listener: (root: string) => void): vscode.Disposable {
    this.fakeListeners.add(listener);
    return { dispose: () => this.fakeListeners.delete(listener) };
  }

  /** A project's fakes (read from .visual-editor/api/, and read again whenever those files change). */
  fakesOf(root: string): Fakes {
    let entry = this.fakes.get(root);
    if (!entry) {
      const fakes = new Fakes(root);
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(root), `${FAKES_DIR}/*.json`));
      const reload = () => {
        fakes.load();
        for (const l of this.fakeListeners) l(root);
      };
      watcher.onDidChange(reload);
      watcher.onDidCreate(reload);
      watcher.onDidDelete(reload);
      entry = { fakes, watcher };
      this.fakes.set(root, entry);
    }
    return entry.fakes;
  }

  saveFake(root: string, endpoint: FakeEndpoint) {
    this.fakesOf(root).save(endpoint);
    for (const l of this.fakeListeners) l(root);
  }

  removeFake(root: string, id: string) {
    this.fakesOf(root).remove(id);
    for (const l of this.fakeListeners) l(root);
  }

  /** The case an endpoint uses ("pass": the real backend). */
  useCase(root: string, id: string, use: string) {
    const e = this.fakesOf(root).endpoints.find((x) => x.id === id);
    if (e) this.saveFake(root, { ...e, use });
  }

  saveScenarios(root: string, scenarios: Scenarios) {
    this.fakesOf(root).saveScenarios(scenarios);
    for (const l of this.fakeListeners) l(root);
  }

  async openFake(root: string, id: string) {
    await vscode.window.showTextDocument(vscode.Uri.file(join(root, FAKES_DIR, `${id}.json`)), { viewColumn: vscode.ViewColumn.Beside });
  }

  /** The headers the proxy adds for a project (read from the secret storage once). */
  async headersOf(root: string): Promise<Record<string, string>> {
    if (!this.headers.has(root)) {
      let saved: Record<string, string> = {};
      try {
        saved = JSON.parse((await this.secrets?.get(`visualEditor.proxyHeaders:${root}`)) ?? '{}');
      } catch {
        saved = {};
      }
      this.headers.set(root, saved);
    }
    return this.headers.get(root)!;
  }

  /** Changes the headers: a value sets one, null removes it. */
  async setHeaders(root: string, change: Record<string, string | null>) {
    const next = { ...(await this.headersOf(root)) };
    for (const [k, v] of Object.entries(change)) {
      if (v === null) delete next[k];
      else if (k.trim()) next[k.trim()] = v;
    }
    this.headers.set(root, next);
    await this.secrets?.store(`visualEditor.proxyHeaders:${root}`, JSON.stringify(next));
    for (const l of this.fakeListeners) l(root);
  }

  /** A project's proxy (started now if it isn't running), with its dev server behind it; returns the app's address. */
  async open(root: string, progress?: (text: string) => void): Promise<string> {
    await this.headersOf(root);
    let entry = this.running.get(root);
    if (!entry) {
      const dev = new DevServer(root);
      const proxy = new AppProxy(() => dev.ensure(), { fakes: () => this.fakesOf(root), headers: () => this.headers.get(root) ?? {} });
      proxy.onRecord((r) => {
        this.write(r);
        for (const l of this.callListeners) l(root, r);
      });
      entry = { dev, proxy };
      this.running.set(root, entry);
    }
    // The dev server first, so a problem with it shows now (not as a broken page).
    await entry.dev.ensure((text) => progress?.(text.trim().split('\n').pop() ?? ''));
    const origin = await entry.proxy.start();
    this.log.appendLine(`App proxy for ${root}: ${origin} → dev server ${entry.dev.origin}${entry.dev.startedByUs ? ' (started by Visual Editor)' : ''}`);
    return origin;
  }

  /** The calls a project's app made so far (the latest last). */
  callsOf(root: string): Recorded[] {
    return this.running.get(root)?.proxy.records.filter((r) => r.kind !== 'file').slice(-300) ?? [];
  }

  /** A project's running proxy, if any. */
  get(root: string): AppProxy | undefined {
    return this.running.get(root)?.proxy;
  }

  /**
   * Opens the developer's own file for a place in the code the browser runs (a console message's), through the dev
   * server's source map: /src/App.tsx line 40 of the served code is App.tsx line 37 as written.
   */
  async openSource(root: string, url: string, line: number, column: number) {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return;
    }
    const served = decodeURIComponent(u.pathname);
    // Vite serves files outside the project's folder as /@fs/<their full path>; the rest from the folder.
    let file = served.startsWith('/@fs/') ? served.slice(4) : join(root, served);
    let at = { line, column };
    const dev = this.running.get(root)?.dev.origin;
    if (dev) {
      try {
        const code = await get(`${dev}${u.pathname}${u.search}`, 4000);
        let { map, url: mapUrl } = code ? mapIn(code.body) : {};
        if (!map && mapUrl) {
          const r = await get(new URL(mapUrl, `${dev}${u.pathname}`).href, 4000);
          map = r ? (JSON.parse(r.body) as SourceMap) : undefined;
        }
        const o = map ? original(map, line, column) : undefined;
        if (o) {
          const source = o.source.replace(/^webpack:\/\/[^/]*\//, '').replace(/\?.*$/, '');
          const candidates = [source, join(root, source), join(root, dirname(served), source), join(root, source.replace(/^\//, ''))];
          const found = candidates.find((c) => isAbsolute(c) && existsSync(c));
          if (found) {
            file = found;
            at = { line: o.line, column: o.column };
          }
        }
      } catch {
        // No map: the place as the browser has it.
      }
    }
    if (!existsSync(file)) return void vscode.window.showInformationMessage(`That came from ${served}, which isn't a file in the project.`);
    const position = new vscode.Position(Math.max(0, at.line - 1), Math.max(0, at.column - 1));
    await vscode.window.showTextDocument(vscode.Uri.file(file), { selection: new vscode.Range(position, position), viewColumn: vscode.ViewColumn.Beside });
  }

  /**
   * Opens the stylesheet a CSS rule comes from, at that rule (found by its selector; a rule a tool made, like
   * Tailwind's, opens the file it comes from at the top).
   */
  async openRule(root: string, source: string, selector: string) {
    let file = source.replace(/\?.*$/, '');
    if (/^https?:\/\//.test(file)) file = decodeURIComponent(new URL(file).pathname);
    if (file.startsWith('/@fs/')) file = file.slice(4);
    if (!(isAbsolute(file) && existsSync(file))) file = join(root, file);
    if (!existsSync(file)) return void vscode.window.showInformationMessage(`That rule comes from ${source}, which isn't a file in the project.`);
    let line = 0;
    try {
      const lines = readFileSync(file, 'utf8').split('\n');
      const first = selector.split(',')[0].trim();
      const squash = (s: string) => s.replace(/\s+/g, '');
      const at = lines.findIndex((l) => l.includes(first) || (squash(first).length > 2 && squash(l).includes(squash(first))));
      if (at >= 0) line = at;
    } catch {
      // Opened at the top.
    }
    const position = new vscode.Position(line, 0);
    await vscode.window.showTextDocument(vscode.Uri.file(file), { selection: new vscode.Range(position, position), viewColumn: vscode.ViewColumn.Beside });
  }

  /** Calls the page made (not every file it loaded), one line each. */
  private write(r: Recorded) {
    if (r.kind === 'file') return;
    this.log.appendLine(`  ${r.kind === 'page' ? 'page' : 'call'} ${r.method} ${r.url} → ${r.error ? `failed: ${r.error}` : r.status} · ${r.ms} ms${r.faked ? ` · fake "${r.faked.case}"` : ''}`);
  }

  dispose() {
    for (const { dev, proxy } of this.running.values()) {
      void proxy.stop();
      void dev.stop();
    }
    this.running.clear();
    for (const { watcher } of this.fakes.values()) watcher.dispose();
    this.fakes.clear();
  }
}
