// The App panel (contract 8): a Preview panel showing what the running React app is made of. Its two scripts are
// built on their own (appPage: in the app's page; appPanel: in Visual Editor's window); this gives them to the shell,
// with the facts the panel needs from the project: which components are the developer's own, and which files export
// stores (Zustand, Redux).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Item, PreviewPanel, ProjectInfo } from '@visual-editor/contract';

const ICON = '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M12 12l8-4.5M12 12v9M12 12L4 7.5"/>';

/** Files that make a store: they import Zustand or Redux and create one. */
export function isStoreFile(text: string): boolean {
  return (/from\s+['"]zustand(\/[\w/]+)?['"]/.test(text) && /\bcreate(Store)?\s*[(<]/.test(text)) || (/from\s+['"](@reduxjs\/toolkit|redux)['"]/.test(text) && /\b(configureStore|createStore)\s*\(/.test(text));
}

/** The project's store files (relative paths), read from its source. */
export function storeFiles(project: ProjectInfo, read: (path: string) => string = (p) => readFileSync(join(project.root, p), 'utf8')): string[] {
  const out: string[] = [];
  for (const path of project.files) {
    if (!/\.(m?[jt]sx?)$/.test(path) || /(\.test|\.spec|\.stories|\.d)\.[jt]sx?$/.test(path) || /(^|\/)(node_modules|dist|build)\//.test(path)) continue;
    let text: string;
    try {
      text = read(path);
    } catch {
      continue;
    }
    if (text.length < 300_000 && isStoreFile(text)) out.push(path);
    if (out.length >= 60) break;
  }
  return out;
}

/** The panel, given its two built scripts. */
export function appPanel(scripts: { page: string; panel: string }): PreviewPanel {
  return {
    id: 'app',
    name: 'App: components, stores, route and storage of the running app',
    icon: ICON,
    page: scripts.page,
    panel: scripts.panel,
    facts: (project: ProjectInfo, items: Item[]) => ({
      components: [...new Set(items.filter((i) => i.map === 'components').map((i) => i.label))],
      stores: storeFiles(project),
    }),
  };
}

/** The built scripts next to the extension (dist/appPage.js, dist/appPanel.js); none in tests. */
export function builtScripts(dist: string): { page: string; panel: string } | undefined {
  try {
    // Served from elsewhere (the proxy, a blob): their source map links would lead nowhere.
    const read = (name: string) => readFileSync(join(dist, name), 'utf8').replace(/\n\/\/# sourceMappingURL=.*\s*$/, '\n');
    return { page: read('appPage.js'), panel: read('appPanel.js') };
  } catch {
    return undefined;
  }
}
