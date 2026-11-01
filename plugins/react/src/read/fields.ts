// Follow a field: where a value a component is given comes from, and every place it's shown. Upwards: who passes it
// (its parents, a previewable folder's data part), what that is (an item of a list it goes through, a local value,
// state and what sets it, a hook's value, a store, saved data, a server's answer, a constant) until where it starts.
// Downwards: each place the component (its designs, for a previewable one) shows it (as text, as an attribute, for
// its look), passes it to a child (followed into the child), or uses it in code. Read from the code: no Claude.

import type * as t from '@babel/types';
import type { FieldStep, FieldTrail } from '@visual-editor/contract';
import { line as line0, sliceText } from './ast';
import { at, findFunction, jsxName, memberChain, propertyValue, returned, StoryReader, strip, type FileCtx, type Fn, type Scope, type StoryContext } from './stories';

type N = t.Node;

export interface FieldContext extends StoryContext {
  /** Where a component is used: the file and line (from 0) of its element, and the component it's in. */
  usedBy(path: string, name: string): { path: string; line: number; from?: { path: string; name: string } }[];
}

/** What a component's code is: where it lives, its function and what it has in scope, and its name on the map. */
interface Place {
  file: FileCtx;
  fn: Fn;
  scope: Scope;
  label: string;
  card?: string;
  /** The component (for who gives it what): its file and name. */
  comp: { path: string; name: string };
}

const SHOWN_ATTRS = /^(title|alt|aria-label|placeholder|value|defaultValue|label|src|href|children|content|name)$/;
const LOOK_ATTRS = /^(className|style|color|variant|size|tone|accent\w*|bg\w*)$/;
const METHODS = /^(charAt|charCodeAt|slice|substring|substr|toUpperCase|toLowerCase|trim|split|map|filter|find|forEach|reduce|some|every|length|toString|toFixed|toLocaleString|join|includes|indexOf|startsWith|endsWith|replace|concat|at|keys|values|entries)$/;
const LIST_OPS = /^(filter|sort|slice|reverse|toSorted|toReversed|concat|flat|map)$/;
const MAX_DEPTH = 12;
const MAX_STEPS = 60;

export class FieldReader extends StoryReader {
  constructor(private readonly fctx: FieldContext) {
    super(fctx);
  }

  /** The fields one can follow on a component: its props, then the parts of them its code reads (project.name). */
  fieldsOf(path: string, name: string): string[] {
    const out: string[] = [];
    for (const p of this.places(path, name, 'props')) {
      for (const prop of propNames(p.fn)) {
        if (!out.includes(prop)) out.push(prop);
        for (const chain of this.chainsOf(p, prop)) if (chain.length > 1) out.push(chain.slice(0, 2).join('.'));
      }
    }
    // A previewable folder's designs read the View, which its data part fills from its props.
    const folder = this.folderOf(path);
    if (folder?.files.data) {
      const data = this.places(path, name, 'props')[0];
      for (const design of this.designs(folder.files.chooser!, name)) {
        for (const [view, from] of this.viewMap(data)) for (const chain of this.chainsOf(design, view)) if (chain.length > 1) out.push([...from, chain[1]].join('.'));
      }
    }
    // (Not a value's own methods: project.name.charAt is project.name.)
    return [...new Set(out.filter((f) => !METHODS.test(f.split('.').pop()!)))];
  }

  follow(path: string, name: string, field: string): FieldTrail {
    const [head, ...sub] = field.split('.');
    const label = this.placeLabel(path, name);
    const card = this.cardFor(path, name);
    const comesFrom: FieldStep[] = [];
    const ways = this.givenWays({ path, name }, head, sub, 0, new Set());
    ways.forEach((way, i) => {
      if (ways.length > 1) comesFrom.push({ kind: 'branch', text: `Way ${i + 1} of ${ways.length}` });
      comesFrom.push(...way, { kind: 'here', text: `${label} gets it as ${field}`, ...(card ? { card } : {}) });
    });
    if (!ways.length) comesFrom.push({ kind: 'unsure', text: `Nothing in the project gives ${label} its ${head} (or it couldn't be found)` }, { kind: 'here', text: `${label} gets it as ${field}`, ...(card ? { card } : {}) });
    const shown = this.shownIn(path, name, [head, ...sub], 0, new Set());
    return { field, fields: this.fieldsOf(path, name), comesFrom: comesFrom.slice(0, MAX_STEPS), shown: shown.slice(0, MAX_STEPS) };
  }

  // -------------------------------------------------------------------------
  // Upwards: who gives it, and what that is.

  /** Each way a component's prop comes to it, from where it starts (each way: its steps, first to last). */
  private givenWays(comp: { path: string; name: string }, prop: string, sub: string[], depth: number, seen: Set<string>): FieldStep[][] {
    const key = `${comp.path}#${comp.name}#${prop}`;
    if (depth > MAX_DEPTH || seen.has(key)) return [];
    seen.add(key);
    const ways: FieldStep[][] = [];
    for (const g of this.giversOf(comp, prop)) {
      const passes: FieldStep = { kind: 'step', text: `${g.place.label} passes it as ${prop}: ${prop}=${sliceText(g.place.file.text, g.value)}`, at: at(g.place.file, g.value), ...(g.place.card ? { card: g.place.card } : {}) };
      // (Each way keeps its own path: two ways can go through the same place; only a way going round is stopped.)
      const before = this.resolve(g.value, g.place, sub, depth + 1, new Set(seen));
      for (const way of before.length ? before : [[]]) ways.push([...way, passes]);
    }
    return ways;
  }

  /** Who gives a component a prop: its parents' elements, or (a previewable folder's parts) its data part. */
  private giversOf(comp: { path: string; name: string }, prop: string): { place: Place; value: t.Expression }[] {
    const folder = this.folderOf(comp.path);
    // A design of a previewable folder: its View comes from the data part's switcher element.
    if (folder && folder.variants.some((v) => v.path === comp.path) && folder.files.data) {
      const data = this.placeOf(folder.files.data, 'default');
      const attr = data && this.attrOn(data, prop, (tag) => data.file.imports.get(tag)?.from === folder.files.switcher);
      return data && attr ? [{ place: data, value: attr }] : [];
    }
    // A data part, or the chooser: its props are the chooser's, which its parents give.
    const target = folder?.files.chooser && (comp.path === folder.files.data || comp.path === folder.files.chooser) ? { path: folder.files.chooser, name: folder.name } : comp;
    const out: { place: Place; value: t.Expression }[] = [];
    for (const u of this.fctx.usedBy(target.path, target.name)) {
      if (!u.from) continue;
      const place = this.placeOf(u.from.path, u.from.name);
      const file = this.file(u.path);
      if (!place || !file) continue;
      const el = elementAt(file.ast, u.line, target.name);
      const a = el?.attributes.find((x): x is t.JSXAttribute => x.type === 'JSXAttribute' && x.name.type === 'JSXIdentifier' && x.name.name === prop);
      if (a?.value?.type === 'JSXExpressionContainer' && a.value.expression.type !== 'JSXEmptyExpression') out.push({ place, value: a.value.expression });
      else if (a?.value?.type === 'StringLiteral') out.push({ place, value: a.value });
    }
    return out;
  }

  /** What an expression is, back to where its value starts: each way, its steps first to last. */
  private resolve(expr: t.Expression | N | undefined, place: Place, sub: string[], depth: number, seen: Set<string>): FieldStep[][] {
    if (!expr) return [];
    const e = strip(expr as t.Expression);
    const where = at(place.file, e);
    const card = place.card ? { card: place.card } : {};
    const step = (text: string): FieldStep => ({ kind: 'step', text, at: where, ...card });
    const origin = (text: string): FieldStep[][] => [[{ kind: 'origin', text, at: where, ...card }]];
    const tail = sub.length ? `.${sub.join('.')}` : '';
    if (depth > MAX_DEPTH) return origin('(it goes further: open the code)');
    // (Start and end: `list.filter(…)` starts where `list` does.)
    const k = `${place.file.path}:${e.start}:${e.end}`;
    if (seen.has(k)) return [];
    seen.add(k);

    if (e.type === 'MemberExpression' || e.type === 'OptionalMemberExpression') {
      const m = e as t.MemberExpression;
      const prop = m.property.type === 'Identifier' && !m.computed ? m.property.name : m.property.type === 'StringLiteral' ? m.property.value : undefined;
      return prop ? this.resolve(m.object, place, [prop, ...sub], depth, seen) : origin(`worked out in ${place.label}: ${sliceText(place.file.text, e)}`);
    }
    if (e.type === 'Identifier') {
      const n = e.name;
      if (seen.has(`self:${place.file.path}:${n}`)) return [];
      // An item of a list it goes through: list.map((n) => …).
      const list = listOf(place.fn, n, e);
      if (list) {
        const ways = this.resolve(list, place, [], depth + 1, seen);
        const goes = step(`${place.label} goes through ${sliceText(place.file.text, list)} one by one: each is ${n}${tail ? ` (it reads ${n}${tail})` : ''}`);
        return (ways.length ? ways : [[]]).map((w) => [...w, goes]);
      }
      if (place.scope.props.has(n)) return this.givenWays(place.comp, n, sub, depth + 1, seen);
      // State: what sets it.
      for (const [setter, state] of place.scope.setters) {
        if (state !== n) continue;
        const sets = setterCalls(place.fn, setter);
        const kept = step(`kept in ${place.label}'s state ${n}${sets.length ? `, set by ${sets.map((c) => sliceText(place.file.text, c)).slice(0, 2).join(' and ')}` : ''}`);
        const ways = sets.flatMap((c) => (c.arguments[0] ? this.resolve(c.arguments[0] as t.Expression, place, sub, depth + 1, new Set(seen)) : []));
        return (ways.length ? ways : [[]]).map((w) => [...w, kept]);
      }
      const hook = place.scope.hookVals.get(n);
      if (hook) {
        const inner = this.hookPlace(place, hook.hook);
        const ret = inner && returned(inner.fn);
        const value = ret ? propertyValue(ret, hook.key ?? n) : undefined;
        const gives = step(`${hook.hook} gives it as ${hook.key ?? n}`);
        const ways = inner && value ? this.resolve(value as t.Expression, inner, sub, depth + 1, seen) : [];
        return (ways.length ? ways : [[]]).map((w) => [...w, gives]);
      }
      const store = place.scope.stores.get(n);
      if (store) return origin(`the store ${store.store}: its ${store.key}${tail}`);
      // A value made in the component (a local, anywhere in its function).
      const local = declaredIn(place.fn, n);
      if (local) {
        if (local.init.type === 'ArrowFunctionExpression' || local.init.type === 'FunctionExpression') return origin(`a function made in ${place.label}`);
        const ways = this.resolve(local.key ? { type: 'MemberExpression', object: local.init, property: { type: 'Identifier', name: local.key }, computed: false } as t.MemberExpression : local.init, place, sub, depth + 1, seen);
        return ways;
      }
      const imp = place.file.imports.get(n);
      if (imp) return origin(imp.from.startsWith('pkg:') ? `${n} from ${imp.from.slice(4)}` : `a constant: ${n}${tail} (${imp.from})`);
      // What a function is given when it runs (renameProject(newName)).
      const fnName = paramOf(place.fn, n, e);
      if (fnName !== undefined) return origin(`what ${fnName || 'a function'} is given when it runs (${n}${tail})${fnName ? `: see who calls ${fnName}` : ''}`);
      return origin(`${n}${tail}, in ${place.label}`);
    }
    if (e.type === 'CallExpression' || e.type === 'OptionalCallExpression') {
      const data = dataRead(e as t.CallExpression, place.file.text);
      if (data) return origin(data);
      const callee = strip((e as t.CallExpression).callee as t.Expression);
      // A value kept between draws (useMemo): what it's made of.
      const arg0 = (e as t.CallExpression).arguments[0] as t.Expression | undefined;
      if (callee.type === 'Identifier' && /^use(Memo|DeferredValue)$/.test(callee.name) && arg0) {
        const inner = arg0.type === 'ArrowFunctionExpression' || arg0.type === 'FunctionExpression' ? returnedValue(arg0) : arg0;
        return this.resolve(inner, place, sub, depth + 1, seen);
      }
      // The same list reworked (filtered, sorted, cut…): where the list comes from.
      if (callee.type === 'MemberExpression' && callee.property.type === 'Identifier' && LIST_OPS.test(callee.property.name)) {
        const ops: string[] = [];
        let base: t.Expression = e;
        for (;;) {
          const b = strip(base);
          const c = b.type === 'CallExpression' ? strip(b.callee as t.Expression) : undefined;
          if (c?.type !== 'MemberExpression' || c.property.type !== 'Identifier' || !LIST_OPS.test(c.property.name)) break;
          ops.unshift(c.property.name);
          base = c.object as t.Expression;
        }
        const works = step(`${place.label} works it out from ${sliceText(place.file.text, strip(base)).slice(0, 40)} (${[...new Set(ops)].join(', ')})`);
        const ways = this.resolve(base, place, sub, depth + 1, seen);
        return (ways.length ? ways : [[]]).map((w) => [...w, works]);
      }
      // A local function's answer: what it returns.
      if (callee.type === 'Identifier') {
        const fn = place.scope.locals.get(callee.name);
        const back = fn ? returnedValue(fn) : undefined;
        if (back) return this.resolve(back, place, sub, depth + 1, seen).map((w) => [...w, step(`${callee.name}() gives it`)]);
      }
      return origin(`worked out in ${place.label}: ${sliceText(place.file.text, e)}`);
    }
    if (e.type === 'LogicalExpression') return this.resolve(e.left, place, sub, depth, seen);
    // An object made here, followed into the part read: { name: row.name } for .name is row.name.
    if (e.type === 'ObjectExpression' && sub.length) {
      const own = propertyValue(e, sub[0]);
      if (own && own.type !== 'ObjectMethod') return this.resolve(own as t.Expression, place, sub.slice(1), depth, seen);
      const spread = [...e.properties].reverse().find((p): p is t.SpreadElement => p.type === 'SpreadElement');
      if (spread) return this.resolve(spread.argument, place, sub, depth, seen);
    }
    // A state update (prev => …): what it gives.
    if ((e.type === 'ArrowFunctionExpression' || e.type === 'FunctionExpression') && depth > 0) {
      const back = returnedValue(e);
      // (Its `prev` is the state as it was: keeping it isn't a new way the value comes.)
      const prev = e.params[0]?.type === 'Identifier' ? e.params[0].name : undefined;
      if (prev) seen.add(`self:${place.file.path}:${prev}`);
      if (back) return this.resolve(back, place, sub, depth, seen);
    }
    // [...list]: the list itself.
    if (e.type === 'ArrayExpression' && e.elements.length === 1 && e.elements[0]?.type === 'SpreadElement') return this.resolve(e.elements[0].argument, place, sub, depth, seen);
    if (e.type === 'ConditionalExpression') return [...this.resolve(e.consequent, place, sub, depth, new Set(seen)), ...this.resolve(e.alternate, place, sub, depth, new Set(seen))];
    if (/Literal$/.test(e.type) || e.type === 'TemplateLiteral' || e.type === 'ObjectExpression' || e.type === 'ArrayExpression') return origin(`a fixed value in ${place.label}: ${sliceText(place.file.text, e)}`);
    return origin(`worked out in ${place.label}: ${sliceText(place.file.text, e)}`);
  }

  // -------------------------------------------------------------------------
  // Downwards: where it's shown, set or passed on.

  private shownIn(path: string, name: string, field: string[], depth: number, seen: Set<string>): FieldStep[] {
    const key = `${path}#${name}#${field.join('.')}`;
    if (depth > 4 || seen.has(key)) return [];
    seen.add(key);
    const out: FieldStep[] = [];
    const folder = this.folderOf(path);
    if (folder?.files.data && folder.files.chooser === path) {
      // A previewable component: its data part puts it into the View; each design shows the View.
      const data = this.placeOf(folder.files.data, 'default');
      if (!data) return out;
      for (const [view, from] of this.viewMap(data)) {
        const rest = startsWith(field, from);
        if (!rest) continue;
        for (const design of this.designs(path, name)) out.push(...this.usesIn(design, [view, ...rest], depth, seen));
      }
      return out;
    }
    const place = this.placeOf(path, name);
    return place ? this.usesIn(place, field, depth, seen) : out;
  }

  /** Where a field (its name in this code, and the parts read) is shown, set, passed on or used in a component's code. */
  private usesIn(place: Place, field: string[], depth: number, seen: Set<string>): FieldStep[] {
    const out: FieldStep[] = [];
    const [name, ...want] = field;
    const card = place.card ? { card: place.card } : {};
    walkWithParents(place.fn.body, (n, parents) => {
      if (n.type !== 'Identifier' || n.name !== name || !isReference(n, parents[parents.length - 1])) return;
      // The whole chain read here: project.name.length.
      let top: N = n;
      const chain = [name];
      let i = parents.length - 1;
      while (i >= 0) {
        const p = parents[i];
        if ((p.type === 'MemberExpression' || p.type === 'OptionalMemberExpression') && (p as t.MemberExpression).object === top && !(p as t.MemberExpression).computed && (p as t.MemberExpression).property.type === 'Identifier') {
          chain.push(((p as t.MemberExpression).property as t.Identifier).name);
          top = p;
          i--;
        } else break;
      }
      // Another part of the value (project.id while following project.name): not this field.
      const common = Math.min(chain.length - 1, want.length);
      for (let j = 0; j < common; j++) if (chain[j + 1] !== want[j]) return;
      const rest = want.slice(chain.length - 1);
      const where = at(place.file, top);
      // What it's in: through calls and templates, up to an element or a statement.
      let through = '';
      for (let j = i; j >= 0; j--) {
        const p = parents[j];
        if (p.type === 'JSXExpressionContainer') {
          const holder = parents[j - 1];
          if (holder?.type === 'JSXAttribute') {
            const attr = holder.name.type === 'JSXIdentifier' ? holder.name.name : '';
            const el = parents[j - 2] as t.JSXOpeningElement | undefined;
            const tag = el?.type === 'JSXOpeningElement' ? jsxName(el.name) : '';
            const child = el && this.childComponent(tag, place.file);
            if (attr === 'key') return;
            if (child) {
              out.push({ kind: 'into', text: `${place.label} passes it to ${child.name} as ${attr}${through}`, at: where, ...card });
              // (The whole value, or the part followed: what's left of it in the child.)
              const childField = [attr, ...rest];
              if (rest.length || chain.length - 1 >= want.length) out.push(...this.shownIn(child.path, child.name, childField, depth + 1, seen).map((s) => ({ ...s, depth: (s.depth ?? 0) + 1 })));
            } else if (/^on[A-Z]/.test(attr)) out.push({ kind: 'used', text: `${place.label} uses it when someone ${attr.slice(2).toLowerCase()}s <${tag}>`, at: where, ...card });
            else if (LOOK_ATTRS.test(attr)) out.push({ kind: 'look', text: `${place.label} uses it for the look of <${tag}> (${attr})${through}`, at: where, ...card });
            else if (SHOWN_ATTRS.test(attr)) out.push({ kind: 'shown', text: `${place.label} shows it as the ${attr} of <${tag}>${through}`, at: where, ...card });
            else out.push({ kind: 'used', text: `${place.label} sets <${tag}>'s ${attr} with it${through}`, at: where, ...card });
            return;
          }
          const el = parents[j - 1];
          const tag = el?.type === 'JSXElement' ? jsxName(el.openingElement.name) : el?.type === 'JSXFragment' ? 'a fragment' : '';
          if (rest.length && chain.length - 1 < want.length) return;
          out.push({ kind: 'shown', text: `${place.label} shows it as text${tag ? ` in <${tag}>` : ''}${through}`, at: where, ...card });
          return;
        }
        if (p.type === 'CallExpression' && j < i + 1 && p.callee !== parents[j + 1]) {
          const callee = strip(p.callee as t.Expression);
          if (callee.type === 'Identifier' || callee.type === 'MemberExpression') {
            const name = sliceText(place.file.text, callee);
            through = ` (through ${name.length > 30 ? `${name.slice(0, 29)}…` : name}())`;
          }
        }
        if (/Statement$|Declaration$/.test(p.type) && p.type !== 'ExpressionStatement') break;
        if (p.type === 'ArrowFunctionExpression' || p.type === 'FunctionExpression') break;
      }
      const stmt = parents.slice(0, i + 1).reverse().find((p) => /Statement$|VariableDeclaration$/.test(p.type)) ?? top;
      out.push({ kind: 'used', text: `${place.label} uses it in code: ${sliceText(place.file.text, stmt).slice(0, 80)}`, at: where, ...card });
    });
    const seenText = new Set<string>();
    return out.filter((s) => {
      const k = `${s.at?.path}:${s.at?.line}:${s.text}`;
      if (seenText.has(k)) return false;
      seenText.add(k);
      return true;
    });
  }

  // -------------------------------------------------------------------------

  private folderOf(path: string) {
    return this.fctx.folders.find((f) => [...Object.values(f.files), ...f.variants.map((v) => v.path)].includes(path));
  }

  /** A previewable folder's designs (the one in use first), as places. */
  private designs(chooser: string, name: string): Place[] {
    const f = this.fctx.folders.find((x) => x.files.chooser === chooser);
    if (!f) return [];
    const vs = [...f.variants].sort((a, b) => (a.id === f.selected ? -1 : b.id === f.selected ? 1 : 0));
    return vs.flatMap((v) => {
      const p = this.placeOf(v.path, 'default');
      return p ? [{ ...p, label: `${name} (${v.name} design${v.id === f.selected ? '' : ', not in use'})` }] : [];
    });
  }

  /** What a data part puts into its View: each View field, and the prop (and parts) it's made from. */
  private viewMap(data: Place | undefined): [string, string[]][] {
    if (!data) return [];
    const folder = this.folderOf(data.file.path);
    const out: [string, string[]][] = [];
    const el = folder && this.elementOf(data, (tag) => data.file.imports.get(tag)?.from === folder.files.switcher);
    for (const a of el?.attributes ?? []) {
      if (a.type !== 'JSXAttribute' || a.name.type !== 'JSXIdentifier' || a.value?.type !== 'JSXExpressionContainer') continue;
      const v = a.value.expression.type !== 'JSXEmptyExpression' ? strip(a.value.expression) : undefined;
      const chain = v && (v.type === 'Identifier' || v.type === 'MemberExpression') ? memberChain(v) : [];
      if (chain.length && data.scope.props.has(chain[0])) out.push([a.name.name, chain]);
    }
    return out;
  }

  /** Each chain a prop is read with in a component's code (project, project.name, …). */
  private chainsOf(place: Place, name: string): string[][] {
    const out: string[][] = [];
    walkWithParents(place.fn.body, (n, parents) => {
      if (n.type !== 'Identifier' || n.name !== name || !isReference(n, parents[parents.length - 1])) return;
      const chain = [name];
      let top: N = n;
      for (let i = parents.length - 1; i >= 0; i--) {
        const p = parents[i] as t.MemberExpression;
        if ((p.type === 'MemberExpression' || p.type === 'OptionalMemberExpression') && p.object === top && !p.computed && p.property.type === 'Identifier') {
          chain.push(p.property.name);
          top = p;
        } else break;
      }
      out.push(chain);
    });
    return out;
  }

  private placeOf(path: string, name: string): Place | undefined {
    const file = this.file(path);
    const fn = file && findFunction(file.ast, name);
    if (!file || !fn) return undefined;
    const label = this.placeLabel(path, name);
    const card = this.cardFor(path, name);
    return { file, fn, scope: this.scope(fn, file, label, card), label, card, comp: { path, name } };
  }

  /** The code whose props are a component's: a previewable folder's data part, else the component. */
  private places(path: string, name: string, _what: 'props'): Place[] {
    const folder = this.folderOf(path);
    const p = folder?.files.data && folder.files.chooser === path ? this.placeOf(folder.files.data, 'default') : this.placeOf(path, name);
    return p ? [p] : [];
  }

  private hookPlace(place: Place, hook: string): Place | undefined {
    const imp = place.file.imports.get(hook);
    const path = imp ? (imp.from.startsWith('pkg:') ? undefined : imp.from) : place.file.path;
    if (!path) return undefined;
    const file = this.file(path);
    const fn = file && findFunction(file.ast, imp && imp.imported !== 'default' ? imp.imported : hook);
    if (!file || !fn) return undefined;
    return { file, fn, scope: this.scope(fn, file, hook, place.card), label: hook, card: place.card, comp: { path, name: hook } };
  }

  private placeLabel(path: string, name: string): string {
    const f = this.folderOf(path);
    if (!f) return name;
    const v = f.variants.find((x) => x.path === path);
    if (v) return `${f.name} (${v.name} design)`;
    if (path === f.files.data) return `${f.name}'s data part`;
    if (path === f.files.static) return `${f.name}'s static part`;
    return f.name;
  }

  private cardFor(path: string, name: string): string | undefined {
    const f = this.folderOf(path);
    return f?.files.chooser ? this.fctx.cardOf(f.files.chooser, f.name) : this.fctx.cardOf(path, name);
  }

  private attrOn(place: Place, attr: string, isTag: (tag: string) => boolean): t.Expression | undefined {
    const el = this.elementOf(place, isTag);
    const a = el?.attributes.find((x): x is t.JSXAttribute => x.type === 'JSXAttribute' && x.name.type === 'JSXIdentifier' && x.name.name === attr);
    return a?.value?.type === 'JSXExpressionContainer' && a.value.expression.type !== 'JSXEmptyExpression' ? a.value.expression : undefined;
  }

  private elementOf(place: Place, isTag: (tag: string) => boolean): t.JSXOpeningElement | undefined {
    let found: t.JSXOpeningElement | undefined;
    walkWithParents(place.fn.body, (n) => {
      if (!found && n.type === 'JSXOpeningElement' && isTag(jsxName(n.name))) found = n;
    });
    return found;
  }
}

// ---------------------------------------------------------------------------

/** A function's props: the names it takes apart from its first parameter. */
function propNames(fn: Fn): string[] {
  const p = fn.params[0];
  if (p?.type !== 'ObjectPattern') return [];
  return p.properties.flatMap((x) => (x.type === 'ObjectProperty' && x.key.type === 'Identifier' ? [x.key.name] : []));
}

/** The element on a line (from 0) that is this component (others can share the line). */
function elementAt(ast: t.File, line: number, name: string): t.JSXOpeningElement | undefined {
  const on: t.JSXOpeningElement[] = [];
  walkWithParents(ast, (n) => n.type === 'JSXOpeningElement' && line0(n) === line && on.push(n));
  const nameOf = (n: t.JSXOpeningElement) => (n.name.type === 'JSXIdentifier' ? n.name.name : n.name.type === 'JSXMemberExpression' ? n.name.property.name : '');
  return on.find((n) => nameOf(n) === name) ?? on.find((n) => /^[A-Z]/.test(nameOf(n))) ?? on[0];
}

/** Visits every node with the nodes above it (nearest last). */
function walkWithParents(node: N, fn: (n: N, parents: N[]) => void, parents: N[] = []) {
  fn(node, parents);
  const next = [...parents, node];
  for (const key in node) {
    if (key === 'loc' || key === 'start' || key === 'end' || key === 'extra' || key === 'leadingComments' || key === 'trailingComments' || key === 'innerComments') continue;
    const v = (node as unknown as Record<string, unknown>)[key];
    if (Array.isArray(v)) {
      for (const c of v) if (c && typeof c === 'object' && typeof (c as N).type === 'string') walkWithParents(c as N, fn, next);
    } else if (v && typeof v === 'object' && typeof (v as N).type === 'string') walkWithParents(v as N, fn, next);
  }
}

/** Whether an identifier reads a value (not a property name, a key, or what's being declared). */
function isReference(n: t.Identifier, parent: N | undefined): boolean {
  if (!parent) return true;
  if ((parent.type === 'MemberExpression' || parent.type === 'OptionalMemberExpression') && parent.property === n && !parent.computed) return false;
  if ((parent.type === 'ObjectProperty' || parent.type === 'ObjectMethod') && parent.key === n && !parent.computed) return parent.type === 'ObjectProperty' && parent.shorthand;
  if (parent.type === 'VariableDeclarator' && parent.id === n) return false;
  if ((parent.type === 'FunctionDeclaration' || parent.type === 'ArrowFunctionExpression' || parent.type === 'FunctionExpression') && (parent.params as N[]).includes(n)) return false;
  if (parent.type === 'JSXAttribute' || parent.type === 'ImportSpecifier' || parent.type === 'ImportDefaultSpecifier') return false;
  return true;
}

/** The list an item comes from: `list.map((name) => …)` (or forEach, filter…) around `use`. */
function listOf(fn: Fn, name: string, use: N): t.Expression | undefined {
  let found: t.Expression | undefined;
  walkWithParents(fn.body, (n) => {
    if (found || n.type !== 'CallExpression' || n.callee.type !== 'MemberExpression' || n.callee.property.type !== 'Identifier' || !/^(map|forEach|filter|find|some|every|flatMap)$/.test(n.callee.property.name)) return;
    const cb = n.arguments[0];
    if (!cb || (cb.type !== 'ArrowFunctionExpression' && cb.type !== 'FunctionExpression')) return;
    const p = cb.params[0];
    if (p?.type !== 'Identifier' || p.name !== name) return;
    if ((use.start ?? 0) >= (cb.start ?? 0) && (use.end ?? 0) <= (cb.end ?? 0)) found = n.callee.object as t.Expression;
  });
  return found;
}

/** The name of the function (inside `fn`) that has a parameter `name` around `use` ('' if it has none). */
function paramOf(fn: Fn, name: string, use: N): string | undefined {
  let found: string | undefined;
  walkWithParents(fn.body, (n, parents) => {
    if (found !== undefined || (n.type !== 'ArrowFunctionExpression' && n.type !== 'FunctionExpression' && n.type !== 'FunctionDeclaration')) return;
    if (!n.params.some((p) => p.type === 'Identifier' && p.name === name)) return;
    if ((use.start ?? 0) < (n.start ?? 0) || (use.end ?? 0) > (n.end ?? 0)) return;
    const holder = parents[parents.length - 1];
    const outer = parents[parents.length - 2];
    found =
      n.type === 'FunctionDeclaration' && n.id
        ? n.id.name
        : holder?.type === 'VariableDeclarator' && holder.id.type === 'Identifier'
          ? holder.id.name
          : holder?.type === 'CallExpression' && outer?.type === 'VariableDeclarator' && outer.id.type === 'Identifier'
            ? outer.id.name
            : '';
  });
  return found;
}

/** Where a name is made anywhere in a function: `const name = …`, or `const { key: name } = …`. */
function declaredIn(fn: Fn, name: string): { init: t.Expression; key?: string } | undefined {
  let found: { init: t.Expression; key?: string } | undefined;
  walkWithParents(fn.body, (n) => {
    if (found || n.type !== 'VariableDeclarator' || !n.init) return;
    if (n.id.type === 'Identifier' && n.id.name === name) found = { init: n.init };
    else if (n.id.type === 'ObjectPattern')
      for (const p of n.id.properties) if (p.type === 'ObjectProperty' && p.value.type === 'Identifier' && p.value.name === name && p.key.type === 'Identifier') found = { init: n.init, key: p.key.name };
  });
  return found;
}

/** The calls of a state's setter anywhere in a function. */
function setterCalls(fn: Fn, setter: string): t.CallExpression[] {
  const out: t.CallExpression[] = [];
  walkWithParents(fn.body, (n) => n.type === 'CallExpression' && n.callee.type === 'Identifier' && n.callee.name === setter && out.push(n));
  return out;
}

/** What a function gives back (an arrow's body, or its last return). */
function returnedValue(fn: Fn): t.Expression | undefined {
  if (fn.body.type !== 'BlockStatement') return fn.body as t.Expression;
  let back: t.Expression | undefined;
  for (const st of fn.body.body) if (st.type === 'ReturnStatement' && st.argument) back = st.argument;
  return back;
}

/** A read of saved data or a server, in words: "saved data (db.projects)", "the server: GET /api/x". */
function dataRead(c: t.CallExpression, text: string): string | undefined {
  const callee = strip(c.callee as t.Expression);
  if (callee.type === 'Identifier' && callee.name === 'fetch') return `the server's answer: ${sliceText(text, c.arguments[0] as N)}`;
  if (callee.type === 'Identifier' && /^use(Live)?Query$/.test(callee.name)) {
    const inner = c.arguments.find((a) => a.type === 'ArrowFunctionExpression' || a.type === 'FunctionExpression') as Fn | undefined;
    const body = inner && returnedValue(inner);
    const found = body && strip(body).type === 'CallExpression' ? dataRead(strip(body) as t.CallExpression, text) : undefined;
    return found ?? `a query: ${sliceText(text, c).slice(0, 60)}`;
  }
  if (callee.type !== 'MemberExpression') return undefined;
  const chain = memberChain(callee);
  const method = chain[chain.length - 1];
  if (chain.length >= 2 && /^(get|post|put|patch|delete|request)$/.test(method) && chain.length === 2 && /axios|http|api|client|ky/i.test(chain[0])) return `the server's answer: ${method.toUpperCase()} ${sliceText(text, c.arguments[0] as N)}`;
  if (chain.length >= 3 && /^(toArray|get|first|last|where|equals|filter|each|count|orderBy|reverse|sortBy|find|findOne|findMany|select)$/.test(method)) return `saved data (${chain.slice(0, 2).join('.')})`;
  if ((chain[0] === 'localStorage' || chain[0] === 'sessionStorage') && method === 'getItem') return `the browser's storage: ${sliceText(text, c.arguments[0] as N)}`;
  return undefined;
}

/** The parts of `field` past `from`, when `field` starts with it (undefined: it doesn't). */
function startsWith(field: string[], from: string[]): string[] | undefined {
  for (let i = 0; i < from.length; i++) if (field[i] !== from[i]) return i >= field.length ? [] : undefined;
  return field.slice(from.length);
}
