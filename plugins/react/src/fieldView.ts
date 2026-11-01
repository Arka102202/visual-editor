// Follow a field for the React plugin: a component card's fields, and where one comes from and is shown
// (read/fields.ts), with the project's aliases, previewable folders and where each component is used (the model).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FieldTrail, Item, ProjectInfo } from '@visual-editor/contract';
import { componentId, CONFIG } from './cards';
import { FieldReader } from './read/fields';
import { loadAliases } from './read/resolve';
import { knownModel } from './tools';

export function fieldsFor(item: Item, project: ProjectInfo, field?: string): FieldTrail | undefined {
  const m = /^react:component:(.+)#([^#]+)$/.exec(item.id);
  const model = knownModel(project.root);
  if (!m || !model) return undefined;
  const read = (p: string) => {
    try {
      return readFileSync(join(project.root, p), 'utf8');
    } catch {
      return undefined;
    }
  };
  const byId = new Map(model.components.map((c) => [c.id, c]));
  const reader = new FieldReader({
    read,
    files: new Set(project.files),
    aliases: loadAliases(project.files.filter((f) => CONFIG.test(f)).flatMap((path) => (read(path) === undefined ? [] : [{ path, text: read(path)! }]))),
    folders: model.variantFolders ?? [],
    cardOf: (path, name) => (byId.has(`${path}#${name}`) ? componentId({ id: `${path}#${name}` }) : undefined),
    usedBy: (path, name) =>
      (byId.get(`${path}#${name}`)?.usedBy ?? []).map((u) => {
        const from = u.from ? byId.get(u.from) : undefined;
        return { path: u.path, line: u.line, ...(from ? { from: { path: from.path, name: from.name } } : {}) };
      }),
  });
  if (!field) return { field: '', fields: reader.fieldsOf(m[1], m[2]), comesFrom: [], shown: [] };
  return reader.follow(m[1], m[2], field);
}
