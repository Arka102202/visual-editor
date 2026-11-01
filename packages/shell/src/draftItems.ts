// A project's cards as a draft would leave it: every plugin that detected the project reads the draft's files over
// the real ones (marked as a draft's reading, so nothing is kept from it), e.g. so the Playground can show a design
// the draft adds. No VS Code APIs.

import { createHash } from 'node:crypto';
import type { Item, Link, ProjectInfo, SourceFile } from '@visual-editor/contract';
import { draftView, type Draft } from './drafts';
import type { ProjectState } from './projectIndex';

export interface DraftCards {
  project: ProjectInfo;
  items: Item[];
  links: Link[];
}

/**
 * Readings kept: a big project takes seconds to read, and a draft's checks ask for it again and again. Per project as it
 * is (a file that changes makes a new project object, so its readings go) and per draft content; a few each.
 */
const kept = new WeakMap<object, Map<string, Promise<DraftCards>>>();
const KEPT = 4;

export function draftItems(state: ProjectState, draft: Pick<Draft, 'id' | 'changes'>, read: (path: string) => Promise<string | undefined>): Promise<DraftCards> {
  const hash = createHash('sha1');
  for (const c of draft.changes) hash.update(`${c.path}\0${c.after ?? '\u0001gone'}\0`);
  const key = `${draft.id}#${hash.digest('hex')}#${state.detected.map(({ plugin }) => `${plugin.id}@${plugin.version}`).join(',')}`;
  let byDraft = kept.get(state.project);
  if (!byDraft) kept.set(state.project, (byDraft = new Map()));
  const had = byDraft.get(key);
  if (had) return had;
  const reading = readDraft(state, draft, read);
  byDraft.set(key, reading);
  if (byDraft.size > KEPT) byDraft.delete(byDraft.keys().next().value!);
  // (A reading that failed is tried again next time.)
  reading.catch(() => byDraft.delete(key));
  return reading;
}

async function readDraft(state: ProjectState, draft: Pick<Draft, 'id' | 'changes'>, read: (path: string) => Promise<string | undefined>): Promise<DraftCards> {
  const view = draftView(state.project.files, draft, read);
  const project: ProjectInfo = { ...state.project, files: view.files, draft: draft.id };
  const items: Item[] = [];
  const links: Link[] = [];
  for (const { plugin } of state.detected) {
    for (const reader of plugin.readers ?? []) {
      const files: SourceFile[] = [];
      for (const path of view.files.filter((f) => reader.wants(f))) {
        const text = await view.read(path);
        if (text !== undefined) files.push({ path, text });
      }
      const found = await reader.read(files, project);
      items.push(...found.items);
      links.push(...(found.links ?? []));
    }
  }
  return { project, items, links };
}

/**
 * The cards that can be previewed which these paths change: a file of theirs (a design, the static part, the data…) or
 * a new file in their folder.
 */
export function cardsTouched(items: Item[], paths: string[]): Item[] {
  const dir = (path: string) => path.slice(0, path.lastIndexOf('/') + 1);
  return items.filter((i) => {
    if (!i.preview || !i.source) return false;
    const own = [i.source.path, ...(i.preview.files ?? []), ...i.preview.variants.map((v) => v.path)];
    return paths.some((path) => own.includes(path) || dir(path) === dir(i.source!.path));
  });
}
