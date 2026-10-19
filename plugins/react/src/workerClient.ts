// Reading through the worker thread (dist/worker.js next to the extension), or in this thread when there's no worker
// (tests). The worker has a memory limit: if a project is too big for it, it stops with a clear error instead of
// taking the computer's memory, and the next read starts a fresh one.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import type { ReadResult, SourceFile } from '@visual-editor/contract';
import { readModel, toMaps } from './cards';
import type { FeModel } from './read/model';
import { computeExtras, type Extras } from './preview/extras';

/** Most memory the reading worker may use. */
const WORKER_MEMORY_MB = 2048;

export class ReadingWorker {
  private worker: Worker | undefined;
  private next = 1;
  private readonly waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private readonly file = join(__dirname, 'worker.js');

  /** Whether there's a worker to use (in VS Code; not in tests). */
  get available(): boolean {
    return !process.env.VISUAL_EDITOR_NO_WORKER && existsSync(this.file) && __filename.endsWith('extension.js');
  }

  read(files: SourceFile[]): Promise<{ model: FeModel; result: ReadResult }> {
    if (!this.available) {
      const model = readModel(files);
      return Promise.resolve({ model, result: toMaps(model) });
    }
    return this.ask('read', files) as Promise<{ model: FeModel; result: ReadResult }>;
  }

  extras(files: SourceFile[]): Promise<Extras> {
    if (!this.available) return Promise.resolve(computeExtras(files));
    return this.ask('extras', files) as Promise<Extras>;
  }

  stop() {
    void this.worker?.terminate();
    this.worker = undefined;
  }

  private ask(type: 'read' | 'extras', files: SourceFile[]): Promise<unknown> {
    const worker = this.start();
    const id = this.next++;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      worker.postMessage({ id, type, files });
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
