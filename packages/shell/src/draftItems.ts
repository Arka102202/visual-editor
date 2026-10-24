// A project's cards as a draft would leave it: every plugin that detected the project reads the draft's files over
// the real ones (marked as a draft's reading, so nothing is kept from it), e.g. so the Playground can show a design
// the draft adds. No VS Code APIs.

import type { Item, ProjectInfo, SourceFile } from '@visual-editor/contract';
import { draftView, type Draft } from './drafts';
import type { ProjectState } from './projectIndex';

export async function draftItems(state: ProjectState, draft: Pick<Draft, 'id' | 'changes'>, read: (path: string) => Promise<string | undefined>): Promise<{ project: ProjectInfo; items: Item[] }> {
  const view = draftView(state.project.files, draft, read);
  const project: ProjectInfo = { ...state.project, files: view.files, draft: draft.id };
  const items: Item[] = [];
  for (const { plugin } of state.detected) {
    for (const reader of plugin.readers ?? []) {
      const files: SourceFile[] = [];
      for (const path of view.files.filter((f) => reader.wants(f))) {
        const text = await view.read(path);
        if (text !== undefined) files.push({ path, text });
      }
      items.push(...(await reader.read(files, project)).items);
    }
  }
  return { project, items };
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
