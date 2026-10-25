// A draft's app: the project's own Vite with the draft's files served in place of the real ones (draftServer.ts, its
// own process with a memory limit), behind a proxy that serves Preview's pages for the draft's cards. One at a time,
// started when a draft is to be seen, and stopped after a few minutes unused. Nothing is copied; nothing on disk
// changes. No VS Code APIs.

import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Draft } from '../drafts';
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
}

export class DraftApps {
  private current: Running | undefined;
  private starting: Promise<string> | undefined;
  private idle: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly options: DraftAppsOptions) {}

  /**
   * The address of a draft's app (started now unless it's the one running), whose Preview pages are `previewPage`'s.
   * Throws, in words, when it can't be started (not a Vite project, Vite missing, it stopped…).
   */
  async open(root: string, draft: Pick<Draft, 'id' | 'revision' | 'changes'>, previewPage: (itemId: string) => string | undefined): Promise<string> {
    // One server per draft: a newer version of the same draft is swapped in place (about a second), not restarted.
    const key = `${root}#${draft.id}`;
    if (this.current?.key === key) {
      const running = this.current;
      running.previewPage = previewPage;
      this.touch();
      if (running.revision !== draft.revision) await this.update(running, draft);
      return running.origin;
    }
    await this.starting?.catch(() => undefined);
    if (this.current?.key === key) return this.open(root, draft, previewPage);
    this.starting = this.start(key, root, draft, previewPage).finally(() => (this.starting = undefined));
    return this.starting;
  }

  private async start(key: string, root: string, draft: Pick<Draft, 'id' | 'revision' | 'changes'>, previewPage: (itemId: string) => string | undefined): Promise<string> {
    await this.stop();
    const plan = devPlan(root);
    if ('unsupported' in plan) throw new Error(plan.unsupported);
    if (plan.kind !== 'Vite') throw new Error(`Seeing a draft needs a Vite project; this one runs ${plan.kind}.`);
    const dir = join(tmpdir(), 'visual-editor-drafts', createHash('sha256').update(root).digest('hex').slice(0, 12));
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
    const running: Running = { key, revision: draft.revision, updated: new Map(), child, proxy: undefined as unknown as AppProxy, origin: '', previewPage };
    child.stdout?.on('data', (d: Buffer) => {
      for (const m of String(d).matchAll(/UPDATED (\d+)/g)) {
        running.updated.get(Number(m[1]))?.();
        running.updated.delete(Number(m[1]));
      }
    });
    running.proxy = new AppProxy(async () => app, { ...this.options.proxyOptions?.(root), previewPage: (id) => running.previewPage(id) });
    running.origin = await running.proxy.start(5700);
    child.on('exit', (code) => {
      if (this.current !== running) return;
      this.options.log(`The draft's app stopped (exit code ${code}).`);
      void running.proxy.stop();
      this.current = undefined;
    });
    this.current = running;
    this.options.log(`Draft ${draft.id} (version ${draft.revision}) is running at ${running.origin} (its own Vite, the draft's files on top).`);
    this.touch();
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

  /** Keeps it running a while longer. */
  touch() {
    clearTimeout(this.idle);
    this.idle = setTimeout(() => void this.stop(), this.options.idleMs ?? 180_000);
  }

  async stop() {
    clearTimeout(this.idle);
    const r = this.current;
    this.current = undefined;
    if (!r) return;
    r.child.kill();
    await r.proxy.stop();
  }

  dispose() {
    void this.stop();
  }
}
