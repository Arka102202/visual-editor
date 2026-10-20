// The proxies of the open projects: one per project, started when first needed (with the project's dev server behind
// it), its calls written to Visual Editor's output, and everything stopped when Visual Editor closes. Also each
// project's fakes and contracts (read again when their files change).

import * as vscode from 'vscode';
import { existsSync, readFileSync } from 'node:fs';
import { request as httpRequest, Agent as HttpAgent } from 'node:http';
import { request as httpsRequest, Agent as HttpsAgent } from 'node:https';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { DevServer, get } from './devServer';
import { AppProxy, type Recorded } from './proxy';
import { Fakes, FAKES_DIR, type FakeEndpoint, type Scenarios } from './fakes';
import { mapIn, original, type SourceMap } from './sourceMap';
import { Contracts, CONTRACTS_FILE, type ContractRef } from '../contracts/contracts';
import { endpointId } from './fakePaths';

export class AppProxies implements vscode.Disposable {
  private readonly running = new Map<string, { dev: DevServer; proxy: AppProxy }>();
  private readonly fakes = new Map<string, { fakes: Fakes; watcher: vscode.FileSystemWatcher }>();
  private readonly contracts = new Map<string, { contracts: Contracts; ready: Promise<void>; watcher: vscode.FileSystemWatcher }>();
  /** Headers the proxy adds to calls (by project), kept in VS Code's secret storage: never in the project's files. */
  private readonly headers = new Map<string, Record<string, string>>();
  private readonly callListeners = new Set<(root: string, r: Recorded) => void>();
  private readonly fakeListeners = new Set<(root: string) => void>();

  constructor(
    private readonly log: vscode.OutputChannel,
    private readonly secrets?: vscode.SecretStorage,
    /** Plugins' page scripts for a project (their Preview panels'): key ("react/app") → code. */
    private readonly pageScripts?: (root: string) => { key: string; code: string }[],
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
      const fakes = new Fakes(root, () => this.contracts.get(root)?.contracts);
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

  /**
   * A project's contracts, read when first asked for and again when a contract file (or contracts.json) changes, or
   * the proxy starts (a backend that serves its contract may be running now).
   */
  async contractsOf(root: string): Promise<Contracts> {
    let entry = this.contracts.get(root);
    if (!entry) {
      const contracts = new Contracts(root, (url) => this.fetchText(root, url));
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(root), '**/*.{json,yaml,yml,har,graphql,gql,graphqls,ts,tsx,mts,cts}'));
      let timer: ReturnType<typeof setTimeout> | undefined;
      const changed = (uri: vscode.Uri) => {
        const rel = relative(root, uri.fsPath);
        if (rel.startsWith('node_modules') || !(rel === CONTRACTS_FILE || contracts.list.some((c) => c.source === rel) || /^(openapi|swagger)|\.postman_collection\.json$|\.har$|\.schema\.json$|\.(graphql|gql|graphqls)$/i.test(rel.split(/[\\/]/).pop() ?? ''))) return;
        clearTimeout(timer);
        timer = setTimeout(() => void this.reloadContracts(root), 300);
      };
      watcher.onDidChange(changed);
      watcher.onDidCreate(changed);
      watcher.onDidDelete(changed);
      entry = { contracts, ready: contracts.load(), watcher };
      this.contracts.set(root, entry);
    }
    await entry.ready;
    return entry.contracts;
  }

  async reloadContracts(root: string) {
    const entry = this.contracts.get(root);
    if (!entry) return void (await this.contractsOf(root));
    entry.ready = entry.contracts.load();
    await entry.ready;
    const errors = entry.contracts.list.filter((c) => c.error);
    for (const c of errors) this.log.appendLine(`Contract ${c.source}: ${c.error}`);
    for (const l of this.fakeListeners) l(root);
  }

  async addContract(root: string, source: string) {
    (await this.contractsOf(root)).add(source);
    await this.reloadContracts(root);
  }

  async removeContract(root: string, source: string) {
    (await this.contractsOf(root)).remove(source);
    await this.reloadContracts(root);
  }

  async mapType(root: string, operation: string, type: string | undefined) {
    (await this.contractsOf(root)).mapType(operation, type);
    await this.reloadContracts(root);
  }

  async openContract(root: string, source: string) {
    if (/^https?:\/\//.test(source)) return void vscode.env.openExternal(vscode.Uri.parse(source));
    const file = isAbsolute(source) ? source : join(root, source);
    if (existsSync(file)) await vscode.window.showTextDocument(vscode.Uri.file(file), { viewColumn: vscode.ViewColumn.Beside });
  }

  /** An example answer from the contract (to look at before faking with it). */
  async contractExample(root: string, ref: ContractRef): Promise<{ status?: number; body?: unknown; error?: string }> {
    const contracts = await this.contractsOf(root);
    const hit = ref.operation ? contracts.byId(ref.operation) : undefined;
    if (hit?.contract.graphql) return { error: 'GraphQL answers are made for each query: fake it, and each call gets one shaped by what it asks for.' };
    const made = contracts.answer(ref, { method: hit?.operation.method ?? 'GET', path: hit?.operation.path ?? '/' });
    return made ?? { error: 'The contract has nothing to answer it with.' };
  }

  /**
   * Fakes operations from the contract: a case for each ("contract", or "contract 404" for another status) on its
   * endpoint (made when there's none: at the address the app was seen calling it at, else the app's own), used now.
   */
  async fakeFromContract(root: string, operations: string[], status?: string) {
    const contracts = await this.contractsOf(root);
    const fakes = this.fakesOf(root);
    const seen = this.callsOf(root);
    for (const id of operations) {
      const hit = contracts.byId(id);
      if (!hit) continue;
      const { method, path } = hit.operation;
      const name = status && !/^2/.test(status) ? `contract ${status}` : 'contract';
      const existing = fakes.endpoints.find((e) => e.method.toUpperCase() === method && e.path === path);
      const call = seen.find((c) => c.method === method && /^https?:\/\//.test(c.url) && contracts.find(method, new URL(c.url).pathname)?.operation.id === id);
      const origin = existing?.origin ?? (call ? new URL(call.url).origin : undefined);
      const endpoint: FakeEndpoint = existing ?? { id: endpointId(method, path, origin), method, path, ...(origin ? { origin } : {}), use: 'pass', cases: {} };
      fakes.save({ ...endpoint, use: name, cases: { ...endpoint.cases, [name]: { contract: { operation: id, ...(status ? { status } : {}) } } } });
    }
    for (const l of this.fakeListeners) l(root);
  }

  /** Reads an address a contract is served at (one starting with / is on the app's dev server: its backend). */
  private async fetchText(root: string, url: string): Promise<string | undefined> {
    let target: URL;
    if (url.startsWith('/')) {
      const dev = this.running.get(root)?.dev.origin;
      if (!dev) return undefined;
      target = new URL(url, dev);
    } else target = new URL(url);
    const headers = { accept: 'application/json, application/yaml, text/yaml, */*', ...(this.headers.get(root) ?? {}) };
    const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
    return new Promise((resolve, reject) => {
      const req = send(target, { headers, agent: target.protocol === 'https:' ? new HttpsAgent() : new HttpAgent(), timeout: 5000, ...(target.protocol === 'https:' && /^(localhost|127\.)/.test(target.hostname) ? { rejectUnauthorized: false } : {}) }, (res) => {
        const parts: Buffer[] = [];
        res.on('data', (c: Buffer) => parts.push(c));
        res.on('end', () => resolve((res.statusCode ?? 500) < 400 ? Buffer.concat(parts).toString('utf8') : undefined));
        res.on('error', reject);
      });
      req.on('timeout', () => req.destroy(new Error('no answer in 5 seconds')));
      req.on('error', reject);
      req.end();
    });
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
      const proxy = new AppProxy(() => dev.ensure(), { fakes: () => this.fakesOf(root), headers: () => this.headers.get(root) ?? {}, contracts: () => this.contracts.get(root)?.contracts, pageScripts: () => this.pageScripts?.(root) ?? [] });
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
    // Contracts the backend serves can be read now.
    if (this.contracts.has(root)) void this.reloadContracts(root);
    else void this.contractsOf(root);
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
    this.log.appendLine(`  ${r.kind === 'page' ? 'page' : 'call'} ${r.method} ${r.url} → ${r.error ? `failed: ${r.error}` : r.status} · ${r.ms} ms${r.faked ? ` · fake "${r.faked.case}"` : ''}${r.contract?.issues.length ? ` · ${r.contract.issues.length} difference${r.contract.issues.length === 1 ? '' : 's'} from the contract` : ''}`);
  }

  dispose() {
    for (const { dev, proxy } of this.running.values()) {
      void proxy.stop();
      void dev.stop();
    }
    this.running.clear();
    for (const { watcher } of this.fakes.values()) watcher.dispose();
    this.fakes.clear();
    for (const { watcher } of this.contracts.values()) watcher.dispose();
    this.contracts.clear();
  }
}
