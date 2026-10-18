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
import { readShapes } from '../read/shapes';
import { replyRules, type ReplyRule } from './replies';
import { record, withRecordings } from './recordings';

/** Situations every component can be shown in. "live backend" calls the developer's real dev backend. */
export const LIVE = 'live backend';
export const SITUATIONS = ['normal', 'loading', 'empty', 'error', 'long text', LIVE];
const SITUATION_IDS: Record<string, string> = { 'long text': 'long', [LIVE]: 'live' };

interface Known {
  model: FeModel;
  /** Example replies for the requests the code makes, from how it uses them. */
  replies: ReplyRule[];
  /** File texts, to read the TypeScript types of props for example values. */
  texts: Map<string, string>;
}

export class ReactPreviews {
  private readonly known = new Map<string, Known>();
  private readonly servers = new Map<string, DevServer>();
  /** Whether the folder is trusted in VS Code (set by the extension): previews run the project's own code. */
  trusted: () => boolean = () => true;
  /** Whether previews may call the developer's real dev backend in this project (asks the first time). */
  allowLive: (root: string) => Promise<boolean> = async () => false;
  /** A dev login token for this project, when the developer gave one (kept in VS Code's secret storage). */
  token: (root: string) => Promise<string | undefined> = async () => undefined;

  /** What the reader found in a project, kept for previews. */
  remember(root: string, model: FeModel, files: SourceFile[]) {
    const code = files.filter((f) => /\.[cm]?[jt]sx?$/.test(f.path));
    this.known.set(root, { model, replies: replyRules(readShapes(code)), texts: new Map(files.map((f) => [f.path, f.text])) });
  }

  /** The React projects read so far (their folders). */
  roots(): string[] {
    return [...this.known.keys()];
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
    heard: (message, context) => this.heard(message, context.project.root),
  };

  /** A page in the "live backend" situation recorded a real reply: kept (data only) for "normal" to use. */
  private heard(message: Record<string, unknown>, root: string) {
    if (message.type !== 'recorded' || typeof message.address !== 'string') return;
    const known = this.known.get(root)?.replies.map((r) => r.match) ?? [];
    record(root, message.address, message.reply, known);
  }

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
    const live = req.situation === LIVE;
    if (live && !(await this.allowLive(root))) {
      throw new Error('The live backend situation is off for this project. Choose it again to allow previews to call your dev backend, or use the other situations (no backend needed).');
    }

    writeHarness(root);
    const known = this.known.get(root)!;
    const types = typesFrom(known.texts);
    const route = known.model.routes.find((r) => r.target === c.id)?.path;
    // The app's own login page, for logging in inside the preview when the backend asks for it.
    const login = known.model.routes.find((r) => /log-?in|sign-?in|auth/i.test(r.path))?.path;
    // Stand-ins: example rows for the app's browser database (Dexie), matching the page's address.
    const dexie = findDexie(known.texts);
    const seed = dexie ? seedFor(dexie, route, types) : undefined;
    const key = createHash('sha256').update(`${c.path}#${c.name}`).digest('hex').slice(0, 16);
    writeIfChanged(join(root, PREVIEW_DIR, 'cards', `${key}.json`), JSON.stringify({ path: c.path, export: c.name, props: exampleProps(c, types), ...(route ? { route } : {}), ...(seed ? { seed } : {}), requests: withRecordings(root, known.replies), ...(login ? { login } : {}) }, null, 2));

    let server = this.servers.get(root);
    if (!server) {
      server = new DevServer(root);
      this.servers.set(root, server);
    }
    const base = await server.ensure();
    const situation = SITUATION_IDS[req.situation] ?? req.situation;
    // A dev token travels in the address's #fragment: browsers never send that part to any server or log it.
    const token = live ? await this.token(root) : undefined;
    return { url: `${base}/${PREVIEW_DIR}/index.html?c=${key}&s=${encodeURIComponent(situation)}&theme=${req.theme}&w=${req.width}&t=${Date.now()}${token ? `#token=${encodeURIComponent(token)}` : ''}` };
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
