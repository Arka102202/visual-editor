// The React plugin's tools for assistants (Claude Code calls them through the shell's hub), and its know-how: which
// components can be previewed, everything about one for a job, and the variant rules checked on a draft.

import type { Item, PluginSkill, PluginTool, SourceFile, ToolContext } from '@visual-editor/contract';
import { componentId, wantsFile } from './cards';
import type { FeComponent, FeModel } from './read/model';
import type { VariantFolder } from './read/variants';
import { readingWorker } from './workerClient';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { TypeCheck } from './types/typeCheck';
import VARIANT_RULES from '../../../docs/variants.md';

/** Components and pages Preview can show (docs/variants.md), with their designs; and the ones it can't yet. */
export const previewableTool: PluginTool = {
  name: 'previewable',
  title: 'Components that can be previewed',
  summary: 'Lists which components and pages you can see in Preview, with their designs, and which ones can’t be previewed yet.',
  description:
    'Which components and pages can be shown in Preview and the Playground: their designs (the one in use), fixed-data states, situations and what breaks the rules. Also lists the ones that cannot be previewed yet. Use before making something previewable or adding a design.',
  input: {
    search: { type: 'string', description: 'Part of a name or file path', optional: true },
  },
  run: ({ search }, { items }) => previewableText(items, typeof search === 'string' ? search : undefined),
};

/** How many not-yet-previewable names to list (the rest are counted). */
const MAX_OTHERS = 60;

export function previewableText(items: Item[], search?: string): string {
  const q = search?.toLowerCase();
  const components = items.filter((i) => i.map === 'components' && (!q || i.label.toLowerCase().includes(q) || i.source?.path.toLowerCase().includes(q)));
  if (!components.length) return q ? `No component or page matches "${search}".` : 'This project has no components yet.';
  const ready = components.filter((i) => i.preview);
  const others = components.filter((i) => !i.preview);
  const out: string[] = [];
  out.push(ready.length ? `Can be previewed (${ready.length}):` : 'None can be previewed yet: each needs its folder in the variant shape (docs/variants.md).');
  for (const i of ready) {
    const p = i.preview!;
    out.push(`- ${i.label} (${i.kind}) · ${i.id}${i.source ? ` · ${i.source.path}` : ''}`);
    const name = (v: (typeof p.variants)[number]) =>
      `${v.name}${v.inUseFor?.length ? ` (in use for ${v.inUseFor.join(', ')})` : v.inUse ? ' (in use)' : ''}${v.for?.length ? ` [made for ${v.for.join(', ')}]` : ''}`;
    out.push(`  Designs: ${p.variants.map(name).join(', ')}`);
    if (p.states.length) out.push(`  States: ${p.states.join(', ')}`);
    if (p.situations) out.push(`  Situations (picked by the prop "${p.situations.prop}"): ${p.situations.names.join(', ')}`);
    for (const problem of p.problems ?? []) out.push(`  Problem: ${problem}`);
  }
  if (others.length) {
    const byKind = new Map<string, number>();
    for (const i of others) byKind.set(i.kind, (byKind.get(i.kind) ?? 0) + 1);
    out.push('', `Not previewable yet (${others.length}: ${[...byKind].map(([k, n]) => `${n} ${k}`).join(', ')}):`);
    out.push(...others.slice(0, MAX_OTHERS).map((i) => `- ${i.label} (${i.kind})${i.source ? ` · ${i.source.path}` : ''}`));
    if (others.length > MAX_OTHERS) out.push(`…and ${others.length - MAX_OTHERS} more (narrow it with search).`);
  }
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// The project read whole (the model), for briefs and checks
// ---------------------------------------------------------------------------

/** The last model the reader made, per project: today's project, read again only with a draft. */
const models = new Map<string, FeModel>();

/** The project's model as last read, if it was (Story view reads its folders and cards from it). */
export const knownModel = (root: string): FeModel | undefined => models.get(root);

export function rememberModel(root: string, model: FeModel) {
  models.set(root, model);
}

/** The project's model: today's (from the reader), or read again as a draft would leave it. */
async function modelOf(ctx: ToolContext): Promise<FeModel> {
  const known = models.get(ctx.project.root);
  if (known && !ctx.draft) return known;
  const files: SourceFile[] = [];
  for (const path of ctx.project.files.filter(wantsFile)) {
    const text = await ctx.read(path);
    if (text !== undefined) files.push({ path, text });
  }
  const { model } = await readingWorker.read(files);
  if (!ctx.draft) models.set(ctx.project.root, model);
  return model;
}

/** A component card by its id or its name. */
function findCard(items: Item[], card: string): Item | string {
  const all = items.filter((i) => i.map === 'components');
  const found = all.find((i) => i.id === card) ?? all.filter((i) => i.label === card);
  if (!Array.isArray(found)) return found;
  if (found.length === 1) return found[0];
  if (found.length > 1) return `Several components are called ${card}: ${found.map((i) => i.id).join(', ')}. Give the id.`;
  return `No component or page called "${card}". Use previewable or list_cards to find it.`;
}

/** The variant folder a component is the chooser of. */
const folderOf = (model: FeModel, c: FeComponent) => model.variantFolders?.find((f) => f.files.chooser === c.path && f.name === c.name);

const DATA_WORDS: Record<string, string> = { api: 'calls the API', query: 'loads', db: 'reads the database', store: 'reads the store', context: 'reads the context', router: 'uses the router' };

// ---------------------------------------------------------------------------
// variant_brief
// ---------------------------------------------------------------------------

export const variantBriefTool: PluginTool = {
  name: 'variant_brief',
  title: 'Everything about a component for a job',
  summary: 'Gathers everything about one component before Claude works on it: what it’s given, who uses it, what data it loads, and its designs.',
  description:
    'Everything needed to work on one component or page: its props, who uses it and what it draws, the data it uses (API, stores, context, router), and either its variant folder (files, designs, the one in use, states, situations, problems) or, when it is not previewable yet, the folder it would become. Call it before making something previewable or adding a design.',
  input: { card: { type: 'string', description: 'The component\'s card id or name, e.g. "ProjectCard"' } },
  run: async ({ card }, ctx) => {
    const item = findCard(ctx.items, String(card ?? ''));
    if (typeof item === 'string') return { problem: item };
    const model = await modelOf(ctx);
    const c = model.components.find((x) => componentId(x) === item.id);
    if (!c) return { problem: `${item.label} isn't in the project as ${ctx.draft ? 'the draft would leave it' : 'it is'}.` };
    return briefText(item, c, model, ctx);
  },
};

export function briefText(item: Item, c: FeComponent, model: FeModel, ctx: Pick<ToolContext, 'items' | 'links'>): string {
  const label = (id: string) => ctx.items.find((i) => i.id === id);
  const out = [`# ${c.name} (${item.kind}) · ${item.id}`, `File: ${c.path}:${c.line + 1}`];
  if (c.routes.length) out.push(`A page, shown at ${c.routes.join(', ')}.`);
  out.push(c.props.length ? `Props: ${c.props.map((p) => `${p.name}${p.optional ? '?' : ''}${p.type ? `: ${p.type}` : ''}${p.isCallback ? ' (callback)' : ''}`).join('; ')}${c.acceptsRest ? '; and more passed through ({...rest})' : ''}` : 'Props: none.');
  const users = ctx.links.filter((l) => l.to === item.id && (l.kind === 'renders' || l.kind === 'uses')).map((l) => label(l.from)).filter((i): i is Item => !!i);
  if (users.length) out.push(`Used by: ${users.map((u) => `${u.label} (${u.source?.path ?? u.id})`).join(', ')}`);
  const seen = seenAt(item.id, ctx);
  out.push(seen.length ? `Seen in the app at: ${seen.join(', ')} (compare_app on one of these shows whether a change keeps its look)` : 'Seen in the app at: no page found that shows it.');
  const draws = [...new Set(c.renders.map((r) => r.tag))];
  if (draws.length) out.push(`Draws: ${draws.join(', ')}`);
  if (c.data.length) out.push('Data it uses:', ...c.data.map((d) => `- ${DATA_WORDS[d.kind] ?? d.kind} ${d.label}${d.via ? ` (through ${d.via})` : ''}${d.trigger ? `, ${d.trigger === 'load' ? 'on load' : 'on a click'}` : ''} · ${d.path}:${d.line + 1}`));
  else out.push('Data it uses: none of its own.');

  const folder = folderOf(model, c);
  if (folder) out.push('', ...folderText(folder));
  else out.push('', ...plannedFolder(c, model));
  out.push('', 'The rules are in the visual-editor:variant-rules skill. Work in a draft (save_draft), then check it with check_variant_files (draft: its id).');
  return out.join('\n');
}

/** The app's addresses whose pages show a card: up the map's lines (who draws it) to the routes that show them. */
function seenAt(id: string, ctx: Pick<ToolContext, 'items' | 'links'>): string[] {
  const routes = new Set<string>();
  const done = new Set<string>([id]);
  let level = [id];
  for (let depth = 0; depth < 10 && level.length; depth++) {
    const next: string[] = [];
    for (const at of level) {
      for (const l of ctx.links) {
        if (l.to !== at) continue;
        if (l.kind === 'shows') routes.add(ctx.items.find((i) => i.id === l.from)?.label ?? l.from);
        else if ((l.kind === 'renders' || l.kind === 'uses') && !done.has(l.from)) {
          done.add(l.from);
          next.push(l.from);
        }
      }
    }
    level = next;
  }
  return [...routes].sort((a, b) => a.length - b.length || a.localeCompare(b)).slice(0, 8);
}

function folderText(f: VariantFolder): string[] {
  const base = (p?: string) => p?.split('/').pop();
  const out = [`Previewable (version ${f.version}${f.version === 1 ? ': fixed views, made before the static part' : ''}). Folder: ${f.dir || '.'}`];
  out.push(`Files: ${[['chooser', f.files.chooser], ['types', f.files.types], ['dynamic', f.files.data], ['static', f.files.static], ['starting data', f.files.mock], ['switcher', f.files.switcher]].map(([what, p]) => `${what} ${base(p) ?? '(missing)'}`).join(', ')}`);
  const inUse = (id: string) => (f.situations ? Object.entries(f.situations.inUse).filter(([, v]) => v === id).map(([s]) => s) : id === f.selected ? ['all'] : []);
  out.push('Designs:', ...f.variants.map((v) => `- ${v.name} (id ${v.id}) · ${base(v.path)}${inUse(v.id).length ? ` · in use${f.situations ? ` for ${inUse(v.id).join(', ')}` : ''}` : ''}${v.for?.length ? ` · made for ${v.for.join(', ')}` : ''}`));
  out.push(`States: ${f.states.join(', ') || 'none'}`);
  if (f.situations) out.push(`Situations, picked by the prop "${f.situations.prop}": ${f.situations.names.join(', ')}`);
  if (f.problems?.length) out.push('Problems:', ...f.problems.map((p) => `- ${p}`));
  else out.push('It follows the rules.');
  return out;
}

/** The folder a component that isn't previewable yet would become (docs/variants.md). */
function plannedFolder(c: FeComponent, model: FeModel): string[] {
  const parts = c.path.split('/');
  const file = parts.pop()!;
  const own = parts[parts.length - 1] === c.name;
  const dir = [...parts, ...(own ? [] : [c.name])].join('/');
  const n = c.name;
  const out = [`Not previewable yet. Made previewable, its folder ${own ? `(${dir}, where it is now)` : `would be ${dir}`}:`];
  out.push(
    `- ${dir}/index.tsx: the chooser; exports ${n} as ${file} does now, so nothing that imports it changes${!own || file !== 'index.tsx' ? ` (it replaces ${c.path})` : ''}`,
    `- ${dir}/${n}.types.ts: ${n}Props, ${n}Start, ${n}View`,
    `- ${dir}/${n}.data.tsx: the dynamic part${c.data.length ? `, with the data above (${c.data.map((d) => d.label).join(', ')})` : ' (it has no data of its own: it shapes what it is given)'}`,
    `- ${dir}/${n}.static.tsx: the static part, a working prototype with its data in memory`,
    `- ${dir}/${n}.mock.ts: starting data as named states (default, and the ones that matter: empty, long text…)`,
    `- ${dir}/${n}.switcher.tsx: which design is in use`,
    `- ${dir}/${n}.variant.tsx: today's look, as the first design (id "default"), looks only`,
  );
  const others = model.components.filter((x) => x.path === c.path && x.id !== c.id && !x.parent);
  if (others.length) out.push(`${c.path} also defines ${others.map((x) => x.name).join(', ')}: keep ${others.length === 1 ? 'it' : 'them'} working (in the design file if only it uses ${others.length === 1 ? 'it' : 'them'}, else in ${others.length === 1 ? 'its' : 'their'} own file).`);
  if (c.routes.length) out.push('It is a page: see "Pages" in the rules (its dynamic part reads the route; the static part starts from a state).');
  return out;
}

// ---------------------------------------------------------------------------
// check_variant_files
// ---------------------------------------------------------------------------

export const checkVariantFilesTool: PluginTool = {
  name: 'check_variant_files',
  title: 'Check the preview setup',
  summary: 'Checks that a component’s folder follows the rules for previewing, for example that a design doesn’t load data. Its answer is kept as proof.',
  description:
    'Checks variant folders against the rules (docs/variants.md): missing pieces, designs that use data, a static part that is not a prototype, what would ship to users, states missing what they need. With draft, checks the project as the draft would leave it: the folders it touches, and whether anything that imported a changed file can no longer find it. Ends with PASSED or PROBLEMS.',
  input: { card: { type: 'string', description: 'Only this component\'s folder (card id or name)', optional: true } },
  checks: true,
  run: async ({ card }, ctx) => {
    const model = await modelOf(ctx);
    const folders = model.variantFolders ?? [];
    let chosen: VariantFolder[];
    const out: string[] = [];
    if (typeof card === 'string' && card) {
      const item = findCard(ctx.items, card);
      const name = typeof item === 'string' ? card : item.label;
      const path = typeof item === 'string' ? undefined : item.source?.path;
      const dir = path?.split('/').slice(0, -1).join('/');
      chosen = folders.filter((f) => f.name === name && (!dir || f.dir === dir || f.dir === `${dir}/${name}` || f.files.chooser === path));
      if (!chosen.length) return `${name} has no variant folder${ctx.draft ? ' in the draft' : ''} (a folder is found by its ${name}.switcher.tsx).\nPROBLEMS`;
    } else if (ctx.draft) {
      const dirs = new Set(ctx.draft.changes.map((c) => c.path.split('/').slice(0, -1).join('/')));
      chosen = folders.filter((f) => dirs.has(f.dir));
      const loose = [...dirs].filter((d) => !chosen.some((f) => f.dir === d) && ctx.draft!.changes.some((c) => c.path.split('/').slice(0, -1).join('/') === d && /\.(variant|switcher|static|mock|data|types)\.[jt]sx?$/.test(c.path)));
      for (const d of loose) out.push(`✗ ${d}: has variant files but no Name.switcher.tsx, so it isn't a variant folder.`);
    } else chosen = folders;

    for (const f of chosen) {
      if (f.problems?.length) out.push(`✗ ${f.name} (${f.dir || '.'}): ${f.problems.length} problem${f.problems.length === 1 ? '' : 's'}`, ...f.problems.map((p) => `  - ${p}`));
      else out.push(`✓ ${f.name} (${f.dir || '.'}): follows the rules. Designs: ${f.variants.map((v) => v.name).join(', ')}; states: ${f.states.join(', ')}.`);
    }
    // With a draft: imports it would break (a component used somewhere that can no longer be found).
    if (ctx.draft) {
      const today = models.get(ctx.project.root);
      const lost = (m: FeModel) => new Set(m.components.flatMap((c) => c.issues.filter((i) => i.kind === 'unknown' && !/spread/.test(i.message)).map((i) => `${c.name} (${c.path}): ${i.message}`)));
      const before = today ? lost(today) : new Set<string>();
      const broken = [...lost(model)].filter((x) => !before.has(x));
      if (broken.length) out.push('✗ The draft breaks imports:', ...broken.map((b) => `  - ${b}`));
    }
    // Nothing it can say about: no verdict, so it isn't counted as passed (or failed).
    if (!out.length && ctx.draft && !ctx.draft.changes.some((c) => wantsFile(c.path))) return 'Nothing for this check: the draft changes no code.';
    if (!out.length) return ctx.draft ? 'The draft changes no variant folder, and breaks no import.\nPASSED' : 'There are no variant folders to check.\nPASSED';
    out.push(out.some((l) => l.startsWith('✗')) ? 'PROBLEMS' : 'PASSED');
    return out.join('\n');
  },
};

// ---------------------------------------------------------------------------
// check_types
// ---------------------------------------------------------------------------

export const checkTypesTool: PluginTool = {
  name: 'check_types',
  title: 'Check TypeScript',
  summary: 'Runs your project’s own TypeScript check on a change, with your settings, and reports only the problems the change would add.',
  description:
    'Runs the project\'s own TypeScript (its tsconfig, and the configs it refers to) on the project as a draft would leave it, and reports only the problems the draft adds (problems already in the project don\'t count against it). Ends with PASSED or PROBLEMS. Without a draft: how many problems the project has now.',
  checks: true,
  always: true,
  run: async (_input, ctx) => {
    if (!ctx.project.files.some((f) => /(^|\/)tsconfig(\.[\w-]+)?\.json$/.test(f))) return 'This project has no tsconfig.json: no TypeScript to check.';
    // A draft without code (a README…): no verdict either way.
    if (ctx.draft && !ctx.draft.changes.some((c) => /\.(tsx?|mts|cts|jsx?)$/.test(c.path))) return 'Nothing for TypeScript to check: the draft changes no code.';
    const files = Object.fromEntries((ctx.draft?.changes ?? []).map((c) => [c.path, c.after]));
    const r = await runTypeCheck(ctx.project.root, files);
    if (typeof r === 'string') return { problem: r };
    const where = r.configs.join(', ') || 'tsconfig.json';
    if (!ctx.draft) return `${r.before} TypeScript problem${r.before === 1 ? '' : 's'} in the project now (${where}).`;
    if (!r.added.length) return `No new TypeScript problems (checked with ${where}${r.before ? `; the project already has ${r.before}, not from this draft` : ''}).\nPASSED`;
    const shown = r.added.slice(0, 25).map((p) => `- ${p.file}${p.line ? `:${p.line}` : ''}: ${p.message} (TS${p.code})`);
    return [`${r.added.length} new TypeScript problem${r.added.length === 1 ? '' : 's'} from the draft (${where}):`, ...shown, ...(r.added.length > 25 ? [`…and ${r.added.length - 25} more.`] : []), 'PROBLEMS'].join('\n');
  },
};

/** The check in its own process (dist/typesCheck.js), with a memory limit and a time limit. */
function runTypeCheck(root: string, files: Record<string, string | null>): Promise<TypeCheck | string> {
  const script = [join(__dirname, 'typesCheck.js'), join(__dirname, '..', 'dist', 'typesCheck.js')].find((p) => existsSync(p));
  if (!script) return Promise.resolve('The TypeScript check is missing from the React plugin (reinstall it).');
  return new Promise((done) => {
    const child = spawn(process.execPath, ['--max-old-space-size=2048', script], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill();
      done('The TypeScript check took more than 3 minutes and was stopped.');
    }, 180_000);
    child.stdout.on('data', (d: Buffer) => (out += d));
    child.stderr.on('data', (d: Buffer) => (err += d));
    child.on('close', () => {
      clearTimeout(timer);
      try {
        const r = JSON.parse(out) as TypeCheck | { error: string };
        done('error' in r ? r.error : r);
      } catch {
        done(`The TypeScript check stopped: ${(err || out).trim().slice(0, 300) || 'no answer'}`);
      }
    });
    child.stdin.end(JSON.stringify({ root, files }));
  });
}

// ---------------------------------------------------------------------------
// Know-how
// ---------------------------------------------------------------------------

export const variantRulesSkill: PluginSkill = {
  name: 'variant-rules',
  title: 'How previewable components are built',
  summary: 'How a component’s folder is laid out so it can be previewed: designs show looks only, and its data lives in its own files.',
  description:
    'The rules for making a React component or page previewable (its variant folder: chooser, types, dynamic and static parts, starting data, switcher, designs, situations, pages). Use when making something previewable, adding or changing a design, or checking such work.',
  text: VARIANT_RULES,
};
