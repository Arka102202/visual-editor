// The reading worker: reads a React project (and, when asked, what previews need) off VS Code's own thread, so a big
// project never freezes the editor. It keeps parsed files between reads, so after a save only changed files are
// parsed again. Started and spoken to by workerClient.ts.

import { parentPort } from 'node:worker_threads';
import type { SourceFile } from '@visual-editor/contract';
import { readModel, toMaps } from './cards';
import { computeExtras } from './preview/extras';

type Ask = { id: number; type: 'read' | 'extras'; files: SourceFile[] };

parentPort?.on('message', (m: Ask) => {
  try {
    if (m.type === 'read') {
      const model = readModel(m.files);
      parentPort!.postMessage({ id: m.id, ok: { model, result: toMaps(model) } });
    } else {
      parentPort!.postMessage({ id: m.id, ok: computeExtras(m.files) });
    }
  } catch (e) {
    parentPort!.postMessage({ id: m.id, error: e instanceof Error ? e.message : String(e) });
  }
});
