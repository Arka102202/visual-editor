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
import type { Shape } from '../read/shapes';
import { loadTypeScript, mergeShapes, TypeView } from '../read/types';
import { fitToType, operationShape, type GraphqlRead } from '../read/graphql';
import { exampleOf, replyRules, type ReplyRule } from './replies';
import { CALLBACK } from './harness';
import { appProviders, appShellChain, noProviders, noShell, routeElementModule, shellChain, standInsModule, type AppShell, type ShellStep } from './providers';
import { record, withRecordings } from './recordings';
import { storeSeeds, type StoreSeed } from './stores';
import { savedSeeds, type SavedSeed } from './saved';
import type { Extras } from './extras';
import { readingWorker } from '../workerClient';
import { exportsName, importsOf, INNER_EXPORT, locator, rehome, withInnerExport } from './copies';
import { loadAliases, resolveImport, type Alias } from '../read/resolve';
import { choiceFor, variantsOf, versionsOf } from '../playground/playground';
import { nodeLookups } from './flow';

/** Situations every component can be shown in. "live backend" calls the developer's real dev backend. */
export const LIVE = 'live backend';
export const SITUATIONS = ['normal', 'loading', 'empty', 'error', 'long text', 'logged out', 'session expired', LIVE];
const SITUATION_IDS: Record<string, string> = { 'long text': 'long', 'logged out': 'loggedOut', 'session expired': 'expired', [LIVE]: 'live' };
/** Above this many files, a preview types only the files its component reaches (and up to this many of them). */
const BIG_PROJECT = 1500;
const SCOPE_FILES = 400;
/** Fields whose values change what a person may see: each value the types allow becomes a situation ("role: admin"). */
const ACCESS_FIELD = /^(role|roles|plan|tier|subscription|accessLevel|access|level|membership)$/;
/** Storage keys that hold a login (a token, a session), found in the code: set when logged in, cleared when not. */
const AUTH_KEY = /token|auth|session|jwt|credential/i;

interface Known {
  model: FeModel;
  /** The files read (code and settings), for working out what previews need when the first one opens. */
  files: SourceFile[];
  /** What previews need beyond the components (data shapes, stores, saved data, GraphQL), once worked out. */
  extras?: Extras;
  extrasLoading?: Promise<Extras>;
  /**
   * Example replies (types first, then usage) and the values of access fields (role, plan…) the types allow, each
   * offered as a situation: worked out when first needed, per scope (a big project types only what a card reaches).
   */
  rules: Map<string, { rules: ReplyRule[]; choices: Map<string, (string | number)[]> }>;
  /** Each file's imports (project files), for a card's scope in a big project. */
  imports?: Map<string, string[]>;
  /** Storage keys the code reads that hold a login. */
  authKeys: string[];
  /** File texts, to read the TypeScript types of props for example values. */
  texts: Map<string, string>;
  /** Example state for the app's stores, and example values for the data it saves (worked out when first needed). */
  seeds?: StoreSeed[];
  savedSeeds?: SavedSeed[];
  /** Import aliases (`@/…`), from the project's tsconfig and Vite config. */
  aliases: Alias[];
}

export class ReactPreviews {
  private readonly known = new Map<string, Known>();
  private readonly servers = new Map<string, DevServer>();
  /** Each project's TypeScript view (null: the project has no TypeScript with the compiler interface). */
  private readonly types = new Map<string, TypeView | null>();
  /** For tests: the TypeScript to use when the project has none of its own. */
  fallbackTypeScript: ReturnType<typeof loadTypeScript> = undefined;

  /** The project's types, built on first use; undefined when it has no TypeScript (usage-based shapes then). */
  typesOf(root: string): TypeView | undefined {
    if (!this.types.has(root)) {
      const ts = loadTypeScript(root) ?? this.fallbackTypeScript;
      this.types.set(root, ts ? new TypeView(ts, root) : null);
    }
    return this.types.get(root) ?? undefined;
  }

  /**
   * Example replies: each reply's TypeScript type where it has one, merged with what the code uses. In a big project
   * only replies read in the files a card reaches (`scope`) are typed; the rest go by how the code uses them.
   */
  private rulesFor(root: string, known: Known, scope?: Set<string>): ReplyRule[] {
    return this.rulesAndChoices(root, known, scope).rules;
  }

  private rulesAndChoices(root: string, known: Known, scope?: Set<string>): { rules: ReplyRule[]; choices: Map<string, (string | number)[]> } {
    const key = scope ? [...scope].sort().join('|') : '*';
    const cached = known.rules.get(key);
    if (cached) return cached;
    const x = known.extras;
    if (!x) return { rules: [], choices: new Map() };
    const view = this.typesOf(root);
    const keep = (out: { rules: ReplyRule[]; choices: Map<string, (string | number)[]> }) => {
      // A handful of scopes are kept (each card of a big project has its own).
      if (known.rules.size > 30) known.rules.delete(known.rules.keys().next().value!);
      known.rules.set(key, out);
      return out;
    };
    if (!view) return keep({ rules: [...x.replies, ...graphqlRules(x.graphql).rules], choices: new Map() });
    const inScope = (path: string) => !scope || scope.has(path);
    // Everything about to be asked about, read in one go.
    view.want([...x.bindings.filter((b) => inScope(b.path)).map((b) => b.path), ...x.stores.map((s) => s.path), ...x.saved.map((s) => s.path), ...x.graphql.uses.filter((u) => inScope(u.path)).map((u) => u.path)]);
    const typed = new Map<string, Shape>();
    for (const b of x.bindings) {
      if (!inScope(b.path)) continue;
      const type = view.typeAt(b.path, b.start);
      let shape = type ? view.shapeOf(type) : undefined;
      // A React Query result kept whole (const q = useQuery…): the reply is its .data.
      if (shape && b.query && shape.fields?.data && shape.fields?.isLoading) shape = shape.fields.data;
      if (!shape) continue;
      // The variable holds part of the reply (data.items): put it back in place.
      for (const part of [...b.at].reverse()) shape = { kind: 'object', fields: { [part]: shape } };
      const key = `${b.method} ${b.match}`;
      typed.set(key, mergeShapes(typed.get(key), shape));
    }
    const merged = x.used.map((u) => ({ ...u, shape: mergeShapes(typed.get(`${u.method} ${u.match}`), u.shape) }));
    // Typed replies the code doesn't read field by field still count (a "who am I" reply kept whole).
    for (const [key, shape] of typed) if (!merged.some((m) => `${m.method} ${m.match}` === key)) merged.push({ method: key.split(' ')[0], match: key.slice(key.indexOf(' ') + 1), shape });
    const graphql = graphqlRules(x.graphql, view, inScope);
    known.seeds ??= storeSeeds(x.stores, view);
    known.savedSeeds ??= savedSeeds(x.saved, view);
    const choices = new Map<string, (string | number)[]>();
    const shapes = [...merged.map((m) => m.shape), ...graphql.shapes, ...known.seeds.map((s) => s.shape), ...known.savedSeeds.map((s) => s.shape)];
    for (const shape of shapes) if (shape) collectChoices(shape, choices);
    return keep({ rules: [...replyRules(merged), ...graphql.rules], choices });
  }

  /**
   * The files a component reaches through its imports (itself included), in a big project; undefined in a project
   * small enough to type whole.
   */
  private scopeFor(known: Known, c: FeComponent): Set<string> | undefined {
    if (known.files.length <= BIG_PROJECT) return undefined;
    if (!known.imports) {
      const sources = new Set(known.files.map((f) => f.path));
      known.imports = new Map(
        known.files.map((f) => [f.path, [...f.text.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)].map((m) => resolveImport(m[1], f.path, known.aliases, sources)).filter((p) => !p.startsWith('pkg:'))]),
      );
    }
    const out = new Set<string>([c.path]);
    const queue = [c.path];
    while (queue.length && out.size < SCOPE_FILES) {
      for (const next of known.imports.get(queue.shift()!) ?? []) {
        if (!out.has(next)) {
          out.add(next);
          queue.push(next);
        }
      }
    }
    return out;
  }

  /** The situations for a card: the usual ones, plus one per role or plan value the types allow. */
  private situationsFor(item: Item): string[] {
    for (const [root, known] of this.known) {
      if (!known.model.components.some((c) => item.id === `react:component:${c.id}`) && !known.model.routes.some((r) => item.id === `react:route:${r.path}`)) continue;
      // What previews need is worked out the first time (off this thread); until then, the usual situations.
      if (!known.extras) {
        void this.extrasFor(known);
        return SITUATIONS;
      }
      const c = this.componentFor(root, item);
      const { choices } = this.rulesAndChoices(root, known, c ? this.scopeFor(known, c) : undefined);
      const extra = [...choices].flatMap(([field, values]) => values.map((v) => `${field}: ${v}`));
      return [...SITUATIONS.slice(0, -1), ...extra, LIVE];
    }
    return SITUATIONS;
  }

  /**
   * Example React Flow nodes for a component (or the hooks next to it) that looks a node up by an id it's given:
   * that id, with data of the type the code reads it as.
   */
  private async flowNodesFor(root: string, c: FeComponent, props: Record<string, unknown>, locate: ReturnType<typeof locator>, text: (path: string) => string | undefined): Promise<{ id: string; position: { x: number; y: number }; data: unknown; type?: string }[]> {
    const own = text(c.path);
    if (!own) return [];
    // Its own file, and the files it imports from its own folder (its hook, its helpers).
    const near = (await importsOf(c.path, own, locate)).filter((f) => f.startsWith(c.path.replace(/[^/]+$/, '')));
    const view = this.typesOf(root);
    const nodes: { id: string; position: { x: number; y: number }; data: unknown; type?: string }[] = [];
    for (const path of [c.path, ...near]) {
      const body = text(path);
      if (!body) continue;
      for (const lookup of nodeLookups(path, body)) {
        const id = typeof props[lookup.idFrom] === 'string' ? (props[lookup.idFrom] as string) : 'id-1042';
        if (nodes.some((n) => n.id === id)) continue;
        const type = view && lookup.dataAt !== undefined ? view.typeAt(path, lookup.dataAt) : undefined;
        const shape = type ? view!.shapeOf(type) : undefined;
        const data = shape ? exampleOf(shape, 'node') : {};
        if (data && typeof data === 'object' && 'id' in data) (data as Record<string, unknown>).id = id;
        const kind = data && typeof data === 'object' && typeof (data as { type?: unknown }).type === 'string' ? (data as { type: string }).type : undefined;
        nodes.push({ id, position: { x: 0, y: 0 }, data, ...(kind ? { type: kind } : {}) });
      }
    }
    return nodes;
  }

  /** What previews need beyond the components, worked out once per read (in the reading worker when there is one). */
  private extrasFor(known: Known): Promise<Extras> {
    known.extrasLoading ??= readingWorker.extras(known.files).then((x) => (known.extras = x));
    return known.extrasLoading;
  }

  /** Example props: from the component's props type when there is one, else from names. */
  private propsFor(root: string, c: FeComponent, types: ReturnType<typeof typesFrom>): Record<string, unknown> {
    const view = this.typesOf(root);
    const type = view?.propsOf(c.path, c.name);
    const shape = type ? view!.shapeOf(type) : undefined;
    if (!shape?.fields) return exampleProps(c, types);
    return Object.fromEntries(Object.entries(shape.fields).map(([name, s]) => [name, s.kind === 'function' ? { [CALLBACK]: name } : name === 'children' ? 'Example content' : exampleOf(s, name)]));
  }
  /** Whether the folder is trusted in VS Code (set by the extension): previews run the project's own code. */
  trusted: () => boolean = () => true;
  /** Whether previews may call the developer's real dev backend in this project (asks the first time). */
  allowLive: (root: string) => Promise<boolean> = async () => false;
  /** A dev login token for this project, when the developer gave one (kept in VS Code's secret storage). */
  token: (root: string) => Promise<string | undefined> = async () => undefined;

  /** What the reader found in a project, kept for previews. */
  remember(root: string, model: FeModel, files: SourceFile[]) {
    const texts = new Map(files.map((f) => [f.path, f.text]));
    this.known.set(root, { model, files, texts, rules: new Map(), authKeys: authKeysIn(texts), aliases: loadAliases(files.filter((f) => /(^|\/)(tsconfig[\w.-]*\.json|jsconfig\.json|(vite|webpack)\.config\.[cm]?[jt]s)$/.test(f.path))) });
    this.types.get(root)?.invalidate();
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
    situations: (item) => this.situationsFor(item),
    render: (request) => this.render(request),
    heard: (message, context) => this.heard(message, context.project.root),
    versions: (item, { project }) => {
      const known = this.known.get(project.root);
      const c = this.componentFor(project.root, item);
      return known && c ? versionsOf(project.root, c, known.model, known.texts, this.typesOf(project.root)) : [];
    },
    choose: (item, version, { project, read }) => {
      const known = this.known.get(project.root);
      const c = this.componentFor(project.root, item);
      if (!known || !c) throw new Error('This card has no component to change.');
      return choiceFor(c, known.model, version, read, project.root);
    },
  };

  /** A page in the "live backend" situation recorded a real reply: kept (data only) for "normal" to use. */
  private heard(message: Record<string, unknown>, root: string) {
    if (message.type !== 'recorded' || typeof message.address !== 'string') return;
    const known = this.known.get(root)?.extras?.replies.map((r) => r.match) ?? [];
    record(root, message.address, message.reply, known);
  }

  private async render(req: PreviewRequest): Promise<PreviewOutput> {
    const root = req.project.root;
    const c = this.componentFor(root, req.item);
    if (!c) throw new Error('This card has no component to show on its own.');
    const plan = devPlan(root);
    if ('unsupported' in plan) throw new Error(plan.unsupported);
    if (!this.trusted()) throw new Error("Previews start this project's dev server, which runs its code. Trust this folder first: Command Palette → \"Workspaces: Manage Workspace Trust\".");
    const live = req.situation === LIVE;
    if (live && !(await this.allowLive(root))) {
      throw new Error('The live backend situation is off for this project. Choose it again to allow previews to call your dev backend, or use the other situations (no backend needed).');
    }

    const shell = writeHarness(root, this.known.get(root));
    const known = this.known.get(root)!;
    await this.extrasFor(known);
    // The app component itself, when it has its own providers or router: drawn whole, with the preview's router.
    const isApp = (shell.steps ?? []).some((s) => c.path === s.path && (!s.name || c.name === s.name));
    // A modal, dialog or drawer is shown open (the store switch that opens it is set).
    const opens = /(Modal|Dialog|Drawer|Sheet|Popover|Popup|Lightbox)$/.test(c.name);
    // A React Flow edge only draws inside a diagram: shown between two nodes.
    const edge = /\b(BaseEdge|getBezierPath|getSmoothStepPath|getStraightPath|getSimpleBezierPath)\b/.test(known.texts.get(c.path) ?? '');
    // A React Flow node (it has connection points or a resizer): drawn inside a small diagram, sized like one.
    const flowNode = !edge && /\b(Handle|NodeResizer|NodeToolbar)\b/.test(known.texts.get(c.path) ?? '') && /['"](@xyflow\/react|reactflow)['"]/.test(known.texts.get(c.path) ?? '');
    const types = typesFrom(known.texts);
    const route = known.model.routes.find((r) => r.target === c.id)?.path;
    // The app's own login page, for logging in inside the preview when the backend asks for it.
    const login = known.model.routes.find((r) => /log-?in|sign-?in|auth/i.test(r.path))?.path;
    // Stand-ins: example rows for the app's browser database (Dexie), matching the page's address.
    const dexie = findDexie(known.texts);
    const seed = dexie ? seedFor(dexie, route, types) : undefined;
    // A proposal: the files it changes (the component's, and what it imports, two steps away) are drawn from copies,
    // as they'd be; the code itself isn't touched. Before and After are told apart by what they contain.
    const locate = locator((p) => req.read(p), known.aliases);
    const changed = new Map<string, string>();
    const seen = new Set<string>();
    const visit = async (p: string, depth: number) => {
      if (seen.has(p) || seen.size > 60) return;
      seen.add(p);
      const text = await req.read(p);
      if (text === undefined) return;
      if (text !== readText(join(root, p))) changed.set(p, text);
      if (depth < 2) for (const f of await importsOf(p, text, locate)) await visit(f, depth + 1);
    };
    await visit(c.path, 0);
    const tag = changed.size ? createHash('sha256').update([...changed].map(([p, t]) => `${p}\n${t}`).join('\0')).digest('hex').slice(0, 12) : '';
    const copyOf = (p: string) => (changed.has(p) ? `${PREVIEW_DIR}/proposed/${tag}/${p}` : undefined);
    for (const [p, text] of changed) writeIfChanged(join(root, copyOf(p)!), await rehome(p, text, copyOf(p)!, locate, copyOf));
    const key = createHash('sha256').update(`${c.path}#${c.name}#${tag}#${req.version ?? ''}`).digest('hex').slice(0, 16);
    // An inner component (not exported): shown from a copy of its file that exports it.
    let viewPath = copyOf(c.path) ?? c.path;
    let viewExport = c.name;
    const shown = changed.get(c.path) ?? known.texts.get(c.path) ?? readText(join(root, c.path)) ?? '';
    if (!exportsName(c.path, shown, c.name)) {
      if (c.parent) {
        const parent = known.model.components.find((x) => x.id === c.parent)?.name ?? 'another component';
        throw new Error(`${c.name} is made inside ${parent} (it uses what ${parent} has at that moment), so it can only be seen as part of ${parent}. Preview ${parent} instead.`);
      }
      viewPath = `${PREVIEW_DIR}/inner/${key}.tsx`;
      viewExport = INNER_EXPORT;
      writeIfChanged(join(root, viewPath), withInnerExport(await rehome(c.path, shown, viewPath, locate, copyOf), c.name));
    }
    // A version from the Playground: its export in the versions file, with the component's example props.
    if (req.version) {
      viewPath = variantsOf(root, c, known.model).path;
      viewExport = req.version;
    }
    // A page shown the way its route shows it (with its guard), when the route wraps it.
    const routeDef = known.model.routes.find((r) => r.target === c.id);
    const routeText = routeDef ? known.texts.get(routeDef.file) : undefined;
    // Its import of the page points at the proposed copy, when there is one.
    const pageCopy = copyOf(c.path);
    const replace: Record<string, string> = {};
    if (pageCopy && routeDef && routeText) {
      for (const spec of new Set([...routeText.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]))) if ((await locate(spec, routeDef.file)) === c.path) replace[spec] = pageCopy.replace(/\.[cm]?[jt]sx?$/, '');
    }
    // (A version is drawn on its own: the route's file imports the page by its own name, not the version's.)
    const element = routeDef && routeText && !req.version ? routeElementModule(routeDef.file, routeText, routeDef.line, PREVIEW_DIR, appSetup(root).providers.router, replace) : undefined;
    if (element) writeIfChanged(join(root, PREVIEW_DIR, 'routes', `${key}.tsx`), element);
    const props = this.propsFor(root, c, types);
    // A React Flow panel that shows "the selected node": the diagram gets an example node with that id first.
    const flowNodes = await this.flowNodesFor(root, c, props, locate, (p) => changed.get(p) ?? known.texts.get(p));
    writeIfChanged(join(root, PREVIEW_DIR, 'cards', `${key}.json`), JSON.stringify({ path: viewPath, export: viewExport, props, ...(flowNodes.length ? { flowNodes } : {}), ...(route ? { route } : {}), ...(seed ? { seed } : {}), requests: withRecordings(root, this.rulesFor(root, known, this.scopeFor(known, c))), ...(login ? { login } : {}), authKeys: known.authKeys, ...(element ? { element: `routes/${key}.tsx` } : {}), ...(isApp ? { app: true } : {}), ...(opens ? { opens: true } : {}), ...(edge ? { edge: true } : {}), ...(flowNode ? { node: true } : {}), stores: (known.seeds ?? []).map(({ shape: _s, ...seed }) => seed), saved: (known.savedSeeds ?? []).map(({ shape: _s, ...seed }) => seed) }, null, 2));

    let server = this.servers.get(root);
    if (!server) {
      server = new DevServer(root);
      this.servers.set(root, server);
    }
    const base = await server.ensure();
    const situation = SITUATION_IDS[req.situation] ?? (req.situation.includes(': ') ? req.situation.replace(': ', '=') : req.situation);
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

/**
 * The preview page and its helpers, kept up to date with the app's setup. Never committed (its own .gitignore).
 * Returns the app component's frame (its own providers), to know which card is the app itself.
 */
export function writeHarness(root: string, known?: Pick<Known, 'model' | 'texts'>): AppShell {
  const dir = join(root, PREVIEW_DIR);
  const setup = appSetup(root);
  // The app's own providers (from its entry), and stand-ins for the login providers among them.
  const entryText = setup.entry ? readText(join(root, setup.entry)) : undefined;
  const providers = setup.entry && entryText ? appProviders(setup.entry, entryText, PREVIEW_DIR) : noProviders();
  setup.appHasRouter = providers.hasRouter;
  writeIfChanged(join(dir, 'app-providers.tsx'), providers.module);
  // The app component's own providers (in App.tsx, around its routes).
  const appFile = providers.app ? withExtension(root, providers.app.from) : undefined;
  const appText = appFile ? readText(join(root, appFile)) : undefined;
  // It may hand over to another component that holds the routes (<AppRouter />): followed through the components it draws.
  const rendersOf = (step: ShellStep): { tag: string; step: ShellStep }[] => {
    const here = known?.model.components.filter((c) => c.path === step.path && !c.parent) ?? [];
    const comp = here.find((c) => c.name === step.name) ?? (step.name === 'default' ? (here.length === 1 ? here[0] : here.find((c) => c.name === 'App')) : undefined);
    return (comp?.renders ?? []).flatMap((r) => {
      const target = r.target ? known!.model.components.find((c) => c.id === r.target) : undefined;
      const text = target && (known!.texts.get(target.path) ?? readText(join(root, target.path)));
      return target && text ? [{ tag: r.tag, step: { path: target.path, text, name: target.name } }] : [];
    });
  };
  const chain = appFile && appText ? shellChain({ path: appFile, text: appText, name: providers.app!.export }, rendersOf) : undefined;
  const shell = chain ? appShellChain(chain, PREVIEW_DIR) : noShell();
  setup.shellHasRouter = shell.hasRouter;
  for (const [path, text] of Object.entries(shell.modules)) writeIfChanged(join(dir, path), text);
  writeIfChanged(join(dir, 'stand-ins.tsx'), standInsModule(providers.standIns));
  writeIfChanged(join(dir, '.gitignore'), '# Visual Editor previews: made on this computer, never committed.\n*\n');
  writeIfChanged(join(dir, 'index.html'), previewHtml(setup.index));
  writeIfChanged(join(dir, 'preview.tsx'), previewTsx(setup));
  writeIfChanged(join(dir, 'situations.js'), situationsModule());
  if (!existsSync(join(dir, 'cards'))) mkdirSync(join(dir, 'cards'), { recursive: true });
  return shell;
}

/** An import path's file (`src/App` → `src/App.tsx`, or its folder's index). */
function withExtension(root: string, from: string): string | undefined {
  for (const ext of ['', '.tsx', '.ts', '.jsx', '.js', '/index.tsx', '/index.ts', '/index.jsx', '/index.js']) {
    const p = from + ext;
    if (/\.[cm]?[jt]sx?$/.test(p) && existsSync(join(root, p))) return p;
  }
  return undefined;
}

/** GraphQL replies: each operation's { data: … }, with exactly the fields it asks for (kinds from types when known). */
function graphqlRules(read: GraphqlRead, view?: TypeView, inScope: (path: string) => boolean = () => true): { rules: ReplyRule[]; shapes: Shape[] } {
  const rules: ReplyRule[] = [];
  const shapes: Shape[] = [];
  for (const use of read.uses) {
    const op = read.operations.get(use.operation);
    if (!op || op.kind === 'subscription' || rules.some((g) => g.operation === op.name)) continue;
    let type = view && use.start !== undefined && inScope(use.path) ? view.typeAt(use.path, use.start) : undefined;
    if (type && use.member) type = view!.memberType(type, use.member);
    const shape = fitToType(type ? view!.shapeOf(type) : undefined, operationShape(op, read.fragments));
    rules.push({ match: '', operation: op.name, reply: { data: exampleOf(shape, 'data') } });
    shapes.push(shape);
  }
  return { rules, shapes };
}

/** Values the types allow for access fields (role, plan…), anywhere in a reply. */
function collectChoices(shape: Shape, out: Map<string, (string | number)[]>, depth = 0) {
  if (depth > 5) return;
  for (const [name, field] of Object.entries(shape.fields ?? {})) {
    if (ACCESS_FIELD.test(name) && field.values && field.values.length > 1 && field.values.length <= 8) out.set(name, field.values);
    collectChoices(field, out, depth + 1);
  }
  if (shape.item) collectChoices(shape.item, out, depth + 1);
}

/** Storage keys that hold a login: `localStorage.getItem('token')`, or a constant holding the key. */
function authKeysIn(texts: Map<string, string>): string[] {
  const keys = new Set<string>();
  for (const text of texts.values()) {
    if (!/(local|session)Storage/.test(text)) continue;
    const constants = new Map([...text.matchAll(/const\s+(\w+)\s*=\s*(['"`])([^'"`]+)\2/g)].map((m) => [m[1], m[3]]));
    for (const m of text.matchAll(/(?:local|session)Storage\.(?:getItem|setItem|removeItem)\(\s*(?:(['"`])([^'"`]+)\1|(\w+))/g)) {
      const key = m[2] ?? constants.get(m[3]);
      if (key && AUTH_KEY.test(key)) keys.add(key);
    }
  }
  return [...keys];
}
