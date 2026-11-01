// Story view for the React plugin: a component card's stories (read/stories.ts), read from its files as they are on
// disk, with the project's import aliases, its previewable folders and its cards (from the model the reader keeps).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Item, ProjectInfo, Story } from '@visual-editor/contract';
import { componentId, CONFIG } from './cards';
import { loadAliases } from './read/resolve';
import { StoryReader } from './read/stories';
import { knownModel } from './tools';

export function storiesFor(item: Item, project: ProjectInfo): Story[] {
  const m = /^react:component:(.+)#([^#]+)$/.exec(item.id);
  if (!m) return [];
  const model = knownModel(project.root);
  const read = (p: string) => {
    try {
      return readFileSync(join(project.root, p), 'utf8');
    } catch {
      return undefined;
    }
  };
  const configs = project.files.filter((f) => CONFIG.test(f)).flatMap((path) => {
    const text = read(path);
    return text === undefined ? [] : [{ path, text }];
  });
  const known = new Set((model?.components ?? []).map((c) => c.id));
  const reader = new StoryReader({
    read,
    files: new Set(project.files),
    aliases: loadAliases(configs),
    folders: model?.variantFolders ?? [],
    cardOf: (path, name) => (known.has(`${path}#${name}`) ? componentId({ id: `${path}#${name}` }) : undefined),
  });
  return reader.storiesOf(m[1], m[2]);
}
