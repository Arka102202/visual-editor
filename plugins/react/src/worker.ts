// The reading worker: reads a React project off VS Code's own thread, so a big project never freezes the editor. It
// keeps parsed files between reads, so after a save only changed files are parsed again. Started and spoken to by
// workerClient.ts.

import { parentPort } from 'node:worker_threads';
import type { SourceFile } from '@visual-editor/contract';
import { readModel, toMaps } from './cards';

parentPort?.on('message', (m: { id: number; files: SourceFile[] }) => {
  try {
    const model = readModel(m.files);
    parentPort!.postMessage({ id: m.id, ok: { model, result: toMaps(model) } });
  } catch (e) {
    parentPort!.postMessage({ id: m.id, error: e instanceof Error ? e.message : String(e) });
  }
});
