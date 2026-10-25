// A draft's app: the project's own Vite with the draft's files served in place of the real ones (draftServer.ts, its
// own process with a memory limit), behind a proxy that serves Preview's pages for the draft's cards. One per draft, at
// its own address, a few at a time (memory): opening another stops the one unused longest, never one that checks are
// using (held). Each stops after a few minutes unused. Nothing is copied; nothing on disk changes. No VS Code APIs.

import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decideFake, type RunFake } from '../caseRunner';
import type { Draft } from '../drafts';
import type { Fakes } from './fakes';
import { devPlan, freePort } from './devServer';
import { AppProxy } from './proxy';

type ProxyOptions = ConstructorParameters<typeof AppProxy>[1];

export interface DraftAppsOptions {
  /** dist/draftServer.js */
  script: string;
  /** How to run Node: VS Code's own (its program, with ELECTRON_RUN_AS_NODE) or the one in tests. */
  node: { command: string; env: Record<string, string> };
  log(line: string): void;
  /** What the proxy does for a project besides Preview's pages (fakes, headers…). */
  proxyOptions?(root: string): ProxyOptions;
  memoryMb?: number;
  idleMs?: number;
  /** How many can run at once (3 unless said). */
  max?: number;
}

interface Running {
  key: string;
  /** The draft version it serves now. */
  revision: number;
  /** Waiting for the server to say it has a version in place. */
  updated: Map<number, () => void>;
  child: ChildProcess;
  proxy: AppProxy;
  origin: string;
  previewPage: (itemId: string) => string | undefined;
  /** A case being run: its fake answers, over the project's own. */
  runFakes?: RunFake[];
  /** When it was last used (the one unused longest is stopped first). */
  usedAt: number;
  /** Checks using it now: it isn't stopped or swapped while they do. */
  holds: number;
  idle?: ReturnType<typeof setTimeout>;
}

export class DraftApps {
  private readonly running = new Map<string, Running>();
  private readonly starting = new Map<string, Promise<string>>();

  constructor(private readonly options: DraftAppsOptions) {}

  /**
   * The address of a draft's app (started now unless it's running), whose Preview pages are `previewPage`'s. Throws,
   * in words, when it can't be started (not a Vite project, Vite missing, it stopped…).
   */
  async open(root: string, draft: Pick<Draft, 'id' | 'revision' | 'changes'>, previewPage: (itemId: string) => string | undefined): Promise<string> {
    // One server per draft: a newer version of the same draft is swapped in place (about a second), not restarted.
    const key = `${root}#${draft.id}`;
    const r = this.running.get(key);
    if (r) {
      r.previewPage = previewPage;
      this.touchOne(r);
      if (r.revision !== draft.revision) await this.update(r, draft);
      return r.origin;
    }
    const pending = this.starting.get(key);
    if (pending) {
      await pending;
      return this.open(root, draft, previewPage);
    }
    const started = this.start(key, root, draft, previewPage).finally(() => this.starting.delete(key));
    this.starting.set(key, started);
    return started;
  }

  /** The drafts whose apps are running now, for a project. */
  runningFor(root: string): string[] {
    return [...this.running.keys()].filter((k) => k.startsWith(`${root}#`)).map((k) => k.slice(root.length + 1)).sort();
  }

  /** Checks are using a draft's app: it isn't stopped (nor swapped for another) until they let go. Returns letting go. */
  hold(root: string, draftId: string): () => void {
    const r = this.running.get(`${root}#${draftId}`);
    if (!r) return () => {};
    r.holds++;
    let done = false;
    return () => {
      if (done) return;
      done = true;
      r.holds--;
      this.touchOne(r);
    };
  }

  /** Room for one more: the one unused longest goes, unless checks are using it. */
  private async makeRoom(key: string) {
    const max = this.options.max ?? 3;
    // (The others starting count; this one, being started, doesn't.)
    const others = () => [...this.starting.keys()].filter((k) => k !== key).length;
    while (this.running.size + others() >= max) {
      const oldest = [...this.running.values()].filter((r) => !r.holds).sort((a, b) => a.usedAt - b.usedAt)[0];
      if (!oldest) return;
      await this.stopOne(oldest);
    }
  }

  private async start(key: string, root: string, draft: Pick<Draft, 'id' | 'revision' | 'changes'>, previewPage: (itemId: string) => string | undefined): Promise<string> {
    await this.makeRoom(key);
    const plan = devPlan(root);
    if ('unsupported' in plan) throw new Error(plan.unsupported);
    if (plan.kind !== 'Vite') throw new Error(`Seeing a draft needs a Vite project; this one runs ${plan.kind}.`);
    // (Its own folder: its files, and Vite's cache, apart from the other drafts' apps.)
    const dir = join(tmpdir(), 'visual-editor-drafts', createHash('sha256').update(key).digest('hex').slice(0, 12));
    mkdirSync(dir, { recursive: true });
    const files = join(dir, 'files.json');
    writeFileSync(files, JSON.stringify(Object.fromEntries(draft.changes.map((c) => [c.path, c.after]))));
    const port = await freePort(5600);
    const { command, env } = this.options.node;
    const child = spawn(command, [`--max-old-space-size=${this.options.memoryMb ?? 1024}`, this.options.script, root, files, String(port), join(dir, 'vite')], {
      cwd: root,
      env: { ...process.env, ...env, FORCE_COLOR: '0' },
      // (Its input stays open while VS Code runs: when VS Code goes, even by crashing, it closes and the app stops.)
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let said = '';
    const app = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`The draft's app didn't start within 60 seconds.\n${said.slice(-1500)}`)), 60_000);
      const hear = (d: Buffer) => {
        said += String(d);
        const ready = /READY (\S+)/.exec(said);
        const error = /ERROR (.+)/.exec(said);
        if (ready || error) clearTimeout(timer);
        if (ready) resolve(ready[1]);
        else if (error) reject(new Error(error[1]));
      };
      child.stdout?.on('data', hear);
      child.stderr?.on('data', (d: Buffer) => (said += String(d)));
      child.on('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`The draft's app stopped (exit code ${code}).\n${said.slice(-1500)}`));
      });
    }).catch((e) => {
      child.kill();
      throw e;
    });
    const running: Running = { key, revision: draft.revision, updated: new Map(), child, proxy: undefined as unknown as AppProxy, origin: '', previewPage, usedAt: Date.now(), holds: 0 };
    child.stdout?.on('data', (d: Buffer) => {
      for (const m of String(d).matchAll(/UPDATED (\d+)/g)) {
        running.updated.get(Number(m[1]))?.();
        running.updated.delete(Number(m[1]));
      }
    });
    const options = this.options.proxyOptions?.(root) ?? {};
    // While a case runs, its own fakes answer first.
    const fakes = (): Fakes | undefined => {
      const own = options.fakes?.();
      const run = running.runFakes;
      if (!run?.length) return own;
      return { decide: (method: string, path: string, origin?: string, body?: string) => decideFake(run, method, path) ?? own?.decide(method, path, origin, body) ?? { kind: 'pass' } } as Fakes;
    };
    running.proxy = new AppProxy(async () => app, { ...options, fakes, previewPage: (id) => running.previewPage(id) });
    running.origin = await running.proxy.start(5700);
    child.on('exit', (code) => {
      if (this.running.get(key) !== running) return;
      this.options.log(`The draft's app stopped (exit code ${code}).`);
      clearTimeout(running.idle);
      void running.proxy.stop();
      this.running.delete(key);
    });
    this.running.set(key, running);
    this.options.log(`Draft ${draft.id} (version ${draft.revision}) is running at ${running.origin} (its own Vite, the draft's files on top).`);
    this.touchOne(running);
    return running.origin;
  }

  /** Swaps a newer version of the draft into the running server, and waits until it's in place (10 seconds at most). */
  private update(running: Running, draft: Pick<Draft, 'revision' | 'changes'>): Promise<void> {
    running.revision = draft.revision;
    const files = Object.fromEntries(draft.changes.map((c) => [c.path, c.after]));
    return new Promise((done) => {
      const timer = setTimeout(() => {
        running.updated.delete(draft.revision);
        this.options.log(`The draft's app didn't confirm version ${draft.revision} in time.`);
        done();
      }, 10_000);
      running.updated.set(draft.revision, () => {
        clearTimeout(timer);
        done();
      });
      running.child.stdin?.write(JSON.stringify({ revision: draft.revision, files }) + '\n');
    });
  }

  /** A case's fake answers on a draft's running app, until they're taken off (undefined). */
  fake(root: string, draftId: string, fakes: RunFake[] | undefined) {
    const r = this.running.get(`${root}#${draftId}`);
    if (r) r.runFakes = fakes;
  }

  /** Keeps them all running a while longer. */
  touch() {
    for (const r of this.running.values()) this.touchOne(r);
  }

  private touchOne(r: Running) {
    r.usedAt = Date.now();
    clearTimeout(r.idle);
    r.idle = setTimeout(() => (r.holds ? this.touchOne(r) : void this.stopOne(r)), this.options.idleMs ?? 180_000);
  }

  private async stopOne(r: Running) {
    clearTimeout(r.idle);
    if (this.running.get(r.key) === r) this.running.delete(r.key);
    r.child.kill();
    await r.proxy.stop();
  }

  async stop() {
    await Promise.all([...this.running.values()].map((r) => this.stopOne(r)));
  }

  dispose() {
    void this.stop();
  }
}
