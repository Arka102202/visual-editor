// Impact: what depends on a component, near and far, each with why. Directly: who renders it (and what they pass), its
// own parts (a previewable folder's), the page it is. Further away: the pages it's seen on (through its parents), and
// what shares its data (the same store, API call, saved data or hook). For one prop: every place that passes it, the
// ones that don't, and the ones that can't be told (a spread {...props}). Read from the model and the code: no Claude.

import type * as t from '@babel/types';
import type { Impact, ImpactPlace } from '@visual-editor/contract';
import { line as line0, parseSource, sliceText, walk } from './ast';
import type { FeModel } from './model';

/** React's own hooks (and Visual Editor's): not "shared" with anything. */
const BUILT_IN = /^use(State|Effect|LayoutEffect|Memo|Callback|Ref|Context|Reducer|Id|Transition|DeferredValue|SyncExternalStore|ImperativeHandle|InsertionEffect|Optimistic|ActionState|FormStatus|VariantKey)$/;
const DATA_WORDS: Record<string, string> = { store: 'store', api: 'API call', query: 'query', db: 'saved data', context: 'context' };
/** How many shared-data places are listed, at most. */
const MAX_SHARED = 12;

export interface ImpactContext {
  model: FeModel;
  read(path: string): string | undefined;
  /** A component's card id (from its model id), when it's on the map. */
  cardOf(componentId: string): string | undefined;
}

/** What one place passes the component: its attributes as written, and whether it spreads more in. */
interface Passed {
  attrs: Map<string, string>;
  spread: boolean;
}

export function impactOf(componentId: string, ctx: ImpactContext, prop?: string): Impact | undefined {
  const { model } = ctx;
  const byId = new Map(model.components.map((c) => [c.id, c]));
  const comp = byId.get(componentId);
  if (!comp) return undefined;
  const folders = model.variantFolders ?? [];
  const folderOf = (path: string) => folders.find((f) => [...Object.values(f.files), ...f.variants.map((v) => v.path)].includes(path));
  const folder = folders.find((f) => f.files.chooser === comp.path);
  /** A component as the map shows it: a previewable folder's parts are its chooser's card. */
  const place = (id: string | undefined): { label: string; card?: string } => {
    const c = id ? byId.get(id) : undefined;
    if (!c) return { label: 'outside any component' };
    const f = folderOf(c.path);
    const chooser = f?.files.chooser ? model.components.find((x) => x.path === f.files.chooser && x.name === f.name) : undefined;
    if (f && chooser) {
      const v = f.variants.find((x) => x.path === c.path);
      const part = v ? `${v.name} design` : c.path === f.files.data ? 'data part' : c.path === f.files.static ? 'static part' : c.path === f.files.switcher ? 'switcher' : '';
      return { label: `${f.name}${part && c.path !== f.files.chooser ? ` (${part})` : ''}`, card: ctx.cardOf(chooser.id) };
    }
    return { label: c.name, card: ctx.cardOf(c.id) };
  };
  const passedAt = (path: string, line: number): Passed | undefined => {
    const text = ctx.read(path);
    const ast = text !== undefined ? parseSource({ path, text }) : undefined;
    if (!ast || text === undefined) return undefined;
    // The element on that line that is this component (others can share the line: <ul><Card /></ul>).
    const on: t.JSXOpeningElement[] = [];
    walk(ast, (n) => n.type === 'JSXOpeningElement' && line0(n) === line && on.push(n as t.JSXOpeningElement));
    const name = (n: t.JSXOpeningElement) => (n.name.type === 'JSXIdentifier' ? n.name.name : n.name.type === 'JSXMemberExpression' ? n.name.property.name : '');
    const el = on.find((n) => name(n) === comp.name) ?? on.find((n) => /^[A-Z]/.test(name(n))) ?? on[0];
    let found: Passed | undefined;
    walk(el ?? ast, (n) => {
      if (found || n !== el) return;
      const attrs = new Map<string, string>();
      let spread = false;
      for (const a of (n as t.JSXOpeningElement).attributes) {
        if (a.type === 'JSXSpreadAttribute') spread = true;
        else if (a.name.type === 'JSXIdentifier') attrs.set(a.name.name, a.value ? sliceText(text, a) : a.name.name);
      }
      found = { attrs, spread };
    });
    return found;
  };

  const direct: ImpactPlace[] = [];
  const further: ImpactPlace[] = [];
  const renders = comp.usedBy.filter((u) => u.how === 'renders');
  const at = (path: string, line: number) => ({ path, line: line + 1 });

  if (prop !== undefined) {
    // One prop: each place that renders it, and what it passes for that prop.
    let passing = 0;
    let missing = 0;
    let unsure = 0;
    for (const u of renders) {
      const p = place(u.from);
      const got = passedAt(u.path, u.line);
      const value = got?.attrs.get(prop);
      if (value !== undefined) {
        passing++;
        direct.push({ ...p, why: `passes ${value}`, at: at(u.path, u.line) });
      } else if (got?.spread) {
        unsure++;
        direct.push({ ...p, why: `passes {...} into it: can't tell if ${prop} is in there`, at: at(u.path, u.line), unsure: true });
      } else {
        missing++;
        direct.push({ ...p, why: `renders it without ${prop}`, at: at(u.path, u.line) });
      }
    }
    const info = comp.props.find((x) => x.name === prop);
    const sure = unsure ? ` (and ${unsure} that can't be told)` : '';
    const verdict = [
      `${prop} is passed in ${passing} place${passing === 1 ? '' : 's'}${missing ? `, left out in ${missing}` : ''}${sure}.`,
      passing ? `Renaming it: ${passing} place${passing === 1 ? '' : 's'} must change too. Removing it: ${passing === 1 ? 'that place passes' : 'they pass'} something nothing uses any more.` : `Removing it changes no other component.`,
      info && !info.optional ? (missing ? `It's required, yet ${missing} place${missing === 1 ? ' leaves' : 's leave'} it out: that's already a problem.` : 'It is required: a new place that renders it must pass it.') : missing ? `Making it required: ${missing} place${missing === 1 ? '' : 's'} would have to pass it.` : '',
    ].filter(Boolean).join(' ');
    return { props: comp.props.map((x) => x.name), prop, verdict, direct, further: [] };
  }

  // Directly: who uses it, and what they pass.
  for (const u of comp.usedBy) {
    const p = place(u.from);
    if (u.how === 'references') {
      direct.push({ ...p, why: 'passes it on without drawing it (for example as a page of a route)', at: at(u.path, u.line) });
      continue;
    }
    const got = passedAt(u.path, u.line);
    const names = got ? [...got.attrs.keys()].filter((n) => n !== 'key') : [];
    direct.push({ ...p, why: `renders it${names.length ? `, passing ${names.join(', ')}` : ', passing nothing'}${got?.spread ? ' and {...} more' : ''}`, at: at(u.path, u.line), ...(got?.spread ? { unsure: true } : {}) });
  }
  if (folder) direct.push({ label: `${folder.name}'s own parts`, why: `${folder.variants.length} design${folder.variants.length === 1 ? '' : 's'}${folder.files.data ? ', its data part' : ''}${folder.files.static ? ', its static part' : ''}${folder.files.mock ? ', its starting states' : ''}: a change to what it's given (its props) changes them too`, card: ctx.cardOf(comp.id) });
  if (comp.routes.length) direct.push({ label: comp.name, why: `is the page at ${comp.routes.join(', ')}`, card: ctx.cardOf(comp.id) });
  if (!direct.length) direct.push({ label: 'Nothing', why: 'renders it: no other component uses it (yet)' });

  // Further: the pages it's seen on, through its parents.
  const seen = new Set<string>([comp.id]);
  const queue: { id: string; via: string[] }[] = comp.usedBy.filter((u) => u.from).map((u) => ({ id: u.from!, via: [] }));
  const pages = new Map<string, ImpactPlace>();
  for (let i = 0; i < queue.length && i < 200; i++) {
    const { id, via } = queue[i];
    if (seen.has(id)) continue;
    seen.add(id);
    const c = byId.get(id);
    if (!c) continue;
    const p = place(id);
    if (c.routes.length && !pages.has(p.label)) pages.set(p.label, { ...p, why: `the page at ${c.routes.join(', ')}: it's seen there${via.length ? ` (through ${via.join(' → ')})` : ''}` });
    const f = folderOf(c.path);
    // (A design of a previewable folder is used through its chooser.)
    const up = f?.files.chooser && f.files.chooser !== c.path ? model.components.filter((x) => x.path === f.files.chooser) : [c];
    for (const x of up) {
      if (x.routes.length && !pages.has(place(x.id).label)) pages.set(place(x.id).label, { ...place(x.id), why: `the page at ${x.routes.join(', ')}: it's seen there${via.length ? ` (through ${via.join(' → ')})` : ''}` });
      for (const u of x.usedBy) if (u.from && !seen.has(u.from)) queue.push({ id: u.from, via: [...via, p.label] });
      seen.add(x.id);
    }
  }
  further.push(...pages.values());

  // Further: what shares its data (a previewable folder's: its data part's).
  const mine = [comp, ...(folder?.files.data ? model.components.filter((c) => c.path === folder.files.data) : [])];
  const others = model.components.filter((c) => !mine.includes(c) && !(folder && folderOf(c.path) === folder));
  const shared: ImpactPlace[] = [];
  const labels = new Set(mine.flatMap((c) => c.data.filter((d) => DATA_WORDS[d.kind]).map((d) => `${d.kind}\0${d.label}`)));
  for (const key of labels) {
    const [kind, label] = key.split('\0');
    for (const o of others) if (o.data.some((d) => d.kind === kind && d.label === label)) shared.push({ ...place(o.id), why: `uses the same ${DATA_WORDS[kind]}: ${label}` });
  }
  const hooks = new Set(mine.flatMap((c) => c.hooks.filter((h) => !BUILT_IN.test(h))));
  for (const h of hooks) for (const o of others) if (o.hooks.includes(h)) shared.push({ ...place(o.id), why: `uses the same hook: ${h}` });
  const unique = new Map(shared.map((s) => [`${s.label}|${s.why}`, s]));
  further.push(...[...unique.values()].slice(0, MAX_SHARED));
  if (unique.size > MAX_SHARED) further.push({ label: `…and ${unique.size - MAX_SHARED} more`, why: 'sharing its data' });

  return { props: comp.props.map((x) => x.name), direct, further };
}

