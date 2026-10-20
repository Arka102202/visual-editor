// Reading through the worker thread (dist/worker.js next to the extension), or in this thread when there's no worker
// (tests). The worker has a memory limit: if a project is too big for it, it stops with a clear error instead of
// taking the computer's memory, and the next read starts a fresh one.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import type { Need, ReadResult, SourceFile } from '@visual-editor/contract';
import { readModel, toMaps } from './cards';
import { PreviewReader, type DrawSpec } from './preview/reader';
import type { FeModel } from './read/model';

/** Most memory the reading worker may use. */
const WORKER_MEMORY_MB = 2048;

export class ReadingWorker {
  private worker: Worker | undefined;
  private next = 1;
  private readonly waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private readonly file = join(__dirname, 'worker.js');
  /** Without a worker (tests): each project's last reading, for needs. */
  private readonly here = new Map<string, PreviewReader>();

  /** Whether there's a worker to use (in VS Code; not in tests). */
  get available(): boolean {
    return !process.env.VISUAL_EDITOR_NO_WORKER && existsSync(this.file) && __filename.endsWith('extension.js');
  }

  /** Reads a project's files (`root`: its folder, kept for needs). */
  read(files: SourceFile[], root?: string): Promise<{ model: FeModel; result: ReadResult }> {
    if (!this.available) {
      const model = readModel(files);
      if (root) this.here.set(root, new PreviewReader(model, files, root));
      return Promise.resolve({ model, result: toMaps(model) });
    }
    return this.ask({ read: { files, root } }) as Promise<{ model: FeModel; result: ReadResult }>;
  }

  /** What a component (its model id) needs to be drawn, from the project's last reading. */
  needs(root: string, component: string): Promise<Need[]> {
    if (!this.available) return Promise.resolve(this.here.get(root)?.needsOf(component) ?? []);
    return this.ask({ needs: { root, component } }) as Promise<Need[]>;
  }

  stop() {
    void this.worker?.terminate();
    this.worker = undefined;
  }

  /** How to draw a component (its import, route and context objects), from the project's last reading. */
  async drawSpec(root: string, component: string): Promise<DrawSpec | undefined> {
    if (!this.available) return this.here.get(root)?.drawSpec(component);
    return ((await this.ask({ draw: { root, component } })) as DrawSpec | null) ?? undefined;
  }

  /** Keeps the developer's own value for one of a component's needs, in its file's `.preview.json`. */
  async keep(root: string, component: string, need: string, value: unknown): Promise<void> {
    if (!this.available) return this.here.get(root)?.keep(component, need, value);
    await this.ask({ keep: { root, component, need, value } });
  }

  private ask(question: { read: { files: SourceFile[]; root?: string } } | { needs: { root: string; component: string } } | { draw: { root: string; component: string } } | { keep: { root: string; component: string; need: string; value: unknown } }): Promise<unknown> {
    const worker = this.start();
    const id = this.next++;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      worker.postMessage({ id, ...question });
    });
  }

  private start(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(this.file, { resourceLimits: { maxOldGenerationSizeMb: WORKER_MEMORY_MB } });
    worker.on('message', (m: { id: number; ok?: unknown; error?: string }) => {
      const w = this.waiting.get(m.id);
      if (!w) return;
      this.waiting.delete(m.id);
      if (m.error !== undefined) w.reject(new Error(m.error));
      else w.resolve(m.ok);
    });
    const fail = (why: string) => {
      for (const w of this.waiting.values()) w.reject(new Error(why));
      this.waiting.clear();
      if (this.worker === worker) this.worker = undefined;
    };
    worker.on('error', (e) => fail(/memory/i.test(e.message) ? `The project is too big to read within ${WORKER_MEMORY_MB} MB of memory.` : e.message));
    worker.on('exit', (code) => fail(`The reading worker stopped (code ${code}).`));
    worker.unref();
    this.worker = worker;
    return worker;
  }
}

export const readingWorker = new ReadingWorker();
