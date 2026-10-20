// The reading worker: reads a React project off VS Code's own thread, so a big project never freezes the editor. It
// keeps parsed files between reads, so after a save only changed files are parsed again. It also keeps each
// project's last reading, to answer what a component needs to be drawn (its props, route, API replies…), which asks
// TypeScript and is slow enough to keep off VS Code's thread too. Started and spoken to by workerClient.ts.

import { parentPort } from 'node:worker_threads';
import type { SourceFile } from '@visual-editor/contract';
import { readModel, toMaps } from './cards';
import { PreviewReader } from './preview/reader';

/** Each project's last reading (by its folder), for previews. */
const projects = new Map<string, PreviewReader>();

type Ask =
  | { id: number; read: { files: SourceFile[]; root?: string } }
  | { id: number; needs: { root: string; component: string } }
  | { id: number; draw: { root: string; component: string } }
  | { id: number; keep: { root: string; component: string; need: string; value: unknown } };

parentPort?.on('message', (m: Ask) => {
  try {
    if ('read' in m) {
      const model = readModel(m.read.files);
      if (m.read.root) projects.set(m.read.root, new PreviewReader(model, m.read.files, m.read.root));
      parentPort!.postMessage({ id: m.id, ok: { model, result: toMaps(model) } });
    } else if ('needs' in m) {
      parentPort!.postMessage({ id: m.id, ok: projects.get(m.needs.root)?.needsOf(m.needs.component) ?? [] });
    } else if ('draw' in m) {
      parentPort!.postMessage({ id: m.id, ok: projects.get(m.draw.root)?.drawSpec(m.draw.component) ?? null });
    } else {
      projects.get(m.keep.root)?.keep(m.keep.component, m.keep.need, m.keep.value);
      parentPort!.postMessage({ id: m.id, ok: true });
    }
  } catch (e) {
    parentPort!.postMessage({ id: m.id, error: e instanceof Error ? e.message : String(e) });
  }
});
