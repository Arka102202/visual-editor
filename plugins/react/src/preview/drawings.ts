// Drawing components for the Preview window: the page and the root's static copies are written into the project,
// its own dev server is found (or started in the background, and stopped when Visual Editor closes), and the page's
// address is returned. The Preview window then posts the values into the page. No VS Code APIs, so it can be tested.

import type { Item, PreviewOutput, ProjectInfo } from '@visual-editor/contract';
import { COMPONENT_PREFIX } from '../cards';
import { readingWorker } from '../workerClient';
import { DevServer } from './devServer';
import { writePage } from './page';

export class ReactDrawings {
  private readonly servers = new Map<string, DevServer>();

  async render(item: Item, project: ProjectInfo): Promise<PreviewOutput> {
    const spec = await readingWorker.drawSpec(project.root, item.id.slice(COMPONENT_PREFIX.length));
    if (!spec) throw new Error(`Couldn’t find ${item.label} in the files read.`);
    const page = writePage(project.root, spec);
    let server = this.servers.get(project.root);
    if (!server) this.servers.set(project.root, (server = new DevServer(project.root)));
    return { url: `${await server.ensure()}${page}` };
  }

  /** Stops the dev servers Visual Editor started. */
  async stop() {
    await Promise.all([...this.servers.values()].map((s) => s.stop()));
    this.servers.clear();
  }
}
