// Impact for the React plugin: what depends on a component card (read/impact.ts), from the model the reader keeps and
// the files as they are on disk.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Impact, Item, ProjectInfo } from '@visual-editor/contract';
import { componentId } from './cards';
import { impactOf } from './read/impact';
import { knownModel } from './tools';

export function impactFor(item: Item, project: ProjectInfo, prop?: string): Impact | undefined {
  const m = /^react:component:(.+)$/.exec(item.id);
  const model = knownModel(project.root);
  if (!m || !model) return undefined;
  const known = new Set(model.components.map((c) => c.id));
  const read = (p: string) => {
    try {
      return readFileSync(join(project.root, p), 'utf8');
    } catch {
      return undefined;
    }
  };
  return impactOf(m[1], { model, read, cardOf: (id) => (known.has(id) ? componentId({ id }) : undefined) }, prop);
}
