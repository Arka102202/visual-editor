// React previews for the shell's preview frame: real components, drawn by the project's own Vite dev server (found
// or started), with example props, in a chosen situation and theme. No VS Code APIs, so it can be tested.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Item, Previewer, PreviewOutput, PreviewRequest, SourceFile } from '@visual-editor/contract';
import type { FeComponent, FeModel } from '../read/model';
import { DevServer, devPlan } from './devServer';
import { appSetup, exampleProps, PREVIEW_DIR, previewHtml, previewTsx } from './harness';
import { situationsModule } from './situations';
import { findDexie, seedFor, typesFrom } from './dexie';

/** Situations every component can be shown in (the page's names in brackets when they differ). */
export const SITUATIONS = ['normal', 'loading', 'empty', 'error', 'long text'];
const SITUATION_IDS: Record<string, string> = { 'long text': 'long' };

interface Known {
  model: FeModel;
  /** File texts, to read the TypeScript types of props for example values. */
  texts: Map<string, string>;
}

export class ReactPreviews {
  private readonly known = new Map<string, Known>();
  private readonly servers = new Map<string, DevServer>();
  /** Whether the folder is trusted in VS Code (set by the extension): previews run the project's own code. */
  trusted: () => boolean = () => true;

  /** What the reader found in a project, kept for previews. */
  remember(root: string, model: FeModel, files: SourceFile[]) {
    this.known.set(root, { model, texts: new Map(files.map((f) => [f.path, f.text])) });
  }

  /** The component a card shows: a component card, or the page a route card opens. */
  componentFor(root: string, item: Item): FeComponent | undefined {
    const model = this.known.get(root)?.model;
    if (!model) return undefined;
    if (item.id.startsWith('react:component:')) return model.components.find((c) => `react:component:${c.id}` === item.id);
    if (item.id.startsWith('react:route:')) {
      const route = model.routes.find((r) => `react:route:${r.path}` === item.id);
      return route?.target ? model.components.find((c) => c.id === route.target) : undefined;
    }
    return undefined;
  }

  /** Stops the dev servers Visual Editor started. */
  async stopAll() {
    await Promise.all([...this.servers.values()].map((s) => s.stop()));
  }

  readonly previewer: Previewer = {
    id: 'react',
    wants: (item) => item.id.startsWith('react:component:') || item.id.startsWith('react:route:'),
    situations: () => SITUATIONS,
    render: (request) => this.render(request),
  };

  private async render(req: PreviewRequest): Promise<PreviewOutput> {
    const root = req.project.root;
    const c = this.componentFor(root, req.item);
    if (!c) throw new Error('This card has no component to show on its own.');
    // A proposal's version of the file can't be drawn by the dev server yet (it serves the files on disk).
    const shown = await req.read(c.path);
    const onDisk = readText(join(root, c.path));
    if (shown !== onDisk) throw new Error('Drawing a proposed version of a component comes with the Playground, in the next React piece. For now, compare the code in Review.');
    const plan = devPlan(root);
    if ('unsupported' in plan) throw new Error(plan.unsupported);
    if (!this.trusted()) throw new Error("Previews start this project's dev server, which runs its code. Trust this folder first: Command Palette → \"Workspaces: Manage Workspace Trust\".");

    writeHarness(root);
    const known = this.known.get(root)!;
    const types = typesFrom(known.texts);
    const route = known.model.routes.find((r) => r.target === c.id)?.path;
    // Stand-ins: example rows for the app's browser database (Dexie), matching the page's address.
    const dexie = findDexie(known.texts);
    const seed = dexie ? seedFor(dexie, route, types) : undefined;
    const key = createHash('sha256').update(`${c.path}#${c.name}`).digest('hex').slice(0, 16);
    writeIfChanged(join(root, PREVIEW_DIR, 'cards', `${key}.json`), JSON.stringify({ path: c.path, export: c.name, props: exampleProps(c, types), ...(route ? { route } : {}), ...(seed ? { seed } : {}) }, null, 2));

    let server = this.servers.get(root);
    if (!server) {
      server = new DevServer(root);
      this.servers.set(root, server);
    }
    const base = await server.ensure();
    const situation = SITUATION_IDS[req.situation] ?? req.situation;
    return { url: `${base}/${PREVIEW_DIR}/index.html?c=${key}&s=${encodeURIComponent(situation)}&theme=${req.theme}&w=${req.width}&t=${Date.now()}` };
  }
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

/** Writes a file only when its text changed, so the dev server doesn't reload previews for nothing. */
function writeIfChanged(path: string, text: string) {
  if (readText(path) === text) return;
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
}

/** The preview page and its helpers, kept up to date with the app's setup. Never committed (its own .gitignore). */
export function writeHarness(root: string) {
  const dir = join(root, PREVIEW_DIR);
  const setup = appSetup(root);
  writeIfChanged(join(dir, '.gitignore'), '# Visual Editor previews: made on this computer, never committed.\n*\n');
  writeIfChanged(join(dir, 'index.html'), previewHtml(setup.index));
  writeIfChanged(join(dir, 'preview.tsx'), previewTsx(setup));
  writeIfChanged(join(dir, 'situations.js'), situationsModule());
  if (!existsSync(join(dir, 'cards'))) mkdirSync(join(dir, 'cards'), { recursive: true });
}
