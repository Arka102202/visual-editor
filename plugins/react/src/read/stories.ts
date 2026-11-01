// Story view: what happens when someone does something on a component, step by step, read from the code. Each action
// on its elements (a click, typing, a submit) is followed through its handler: functions it runs (in the component,
// in a hook it uses, in a module it imports), state it sets, questions it asks, stores, saved data, requests to a
// server, pages it opens. A function the component was given (a prop) ends its own story there; a component that
// gives it (its parent, or a previewable folder's data part) carries the story on. Pure: files in, stories out.

import type * as t from '@babel/types';
import type { Story, StoryStep } from '@visual-editor/contract';
import { line as line0, parseSource, sliceText, walk } from './ast';
import { resolveImport, type Alias } from './resolve';
import type { VariantFolder } from './variants';

type N = t.Node;
export type Fn = t.ArrowFunctionExpression | t.FunctionExpression | t.FunctionDeclaration | t.ObjectMethod;

export interface StoryContext {
  /** A project file's text (undefined: not there). */
  read(path: string): string | undefined;
  files: Set<string>;
  aliases: Alias[];
  /** The project's previewable folders (a chooser's actions are its design's, its handlers its data part's). */
  folders: VariantFolder[];
  /** A component's card id, by its file and name, when it's on the map. */
  cardOf(path: string, name: string): string | undefined;
}

export interface FileCtx {
  path: string;
  text: string;
  ast: t.File;
  /** Each imported name: the file (or `pkg:<name>`) and the name it has there ('default', '*' or its own). */
  imports: Map<string, { from: string; imported: string }>;
}

export interface Scope {
  file: FileCtx;
  /** The component or hook the code is in (for the card it belongs to). */
  owner: string;
  card?: string;
  locals: Map<string, Fn>;
  setters: Map<string, string>;
  hookVals: Map<string, { hook: string; key?: string }>;
  props: Set<string>;
  propsObj?: string;
  navigate: Set<string>;
  mutations: Map<string, Fn | undefined>;
  stores: Map<string, { store: string; key: string }>;
}

/** How deep functions are followed, and how many steps a story keeps. */
const MAX_DEPTH = 6;
const MAX_STEPS = 40;

const VERBS: Record<string, string> = {
  onClick: 'Click',
  onDoubleClick: 'Double-click',
  onContextMenu: 'Right-click',
  onSubmit: 'Submit',
  onChange: 'Change',
  onInput: 'Type in',
  onKeyDown: 'Press a key in',
  onKeyUp: 'Press a key in',
  onKeyPress: 'Press a key in',
  onBlur: 'Leave',
  onFocus: 'Go into',
  onMouseEnter: 'Point at',
  onMouseLeave: 'Move off',
  onPointerDown: 'Press on',
  onDrop: 'Drop on',
  onDragStart: 'Drag',
};
/** What an element without words is, in words. */
const TAG_WORDS: Record<string, string> = { div: 'an area', section: 'an area', span: 'some text', p: 'some text', img: 'an image', svg: 'an icon', button: 'a button', a: 'a link', li: 'a list row', tr: 'a table row', td: 'a table cell', input: 'a box', textarea: 'a text box', select: 'a list', form: 'the form', label: 'a label' };
const HTTP = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'request']);
const DATA_WORDS: Record<string, string> = { add: 'Adds to', put: 'Saves into', bulkAdd: 'Adds to', bulkPut: 'Saves into', update: 'Updates', delete: 'Deletes from', bulkDelete: 'Deletes from', clear: 'Clears', insert: 'Adds to', upsert: 'Saves into', remove: 'Deletes from', set: 'Saves into', create: 'Adds to', save: 'Saves into' };

export class StoryReader {
  private readonly parsed = new Map<string, FileCtx | null>();
  private readonly cache = new Map<string, Story[]>();

  constructor(protected readonly ctx: StoryContext) {}

  /** The stories of a component (its file and name), its children's carried on through it. */
  storiesOf(path: string, name: string, depth = 0): Story[] {
    const key = `${path}#${name}`;
    const had = this.cache.get(key);
    if (had) return had;
    this.cache.set(key, []);
    const folder = this.ctx.folders.find((f) => f.files.chooser === path);
    const out = folder ? this.folderStories(folder, name, depth) : this.componentStories(path, name, depth);
    this.cache.set(key, out);
    return out;
  }

  /** A previewable folder: its design in use's actions, carried on by its data part (its real handlers). */
  private folderStories(folder: VariantFolder, name: string, depth: number): Story[] {
    const inUse = folder.variants.find((v) => v.id === folder.selected) ?? folder.variants[0];
    if (!inUse) return [];
    const design = this.file(inUse.path);
    const designFn = design && findFunction(design.ast, 'default');
    if (!design || !designFn) return [];
    const card = this.ctx.cardOf(folder.files.chooser!, name);
    const stories = this.actionStories(design, designFn, `${name} (${inUse.name} design)`, card, depth);
    const data = folder.files.data ? this.file(folder.files.data) : undefined;
    const dataFn = data && findFunction(data.ast, 'default');
    if (!data || !dataFn) return stories;
    const dataScope = this.scope(dataFn, data, `${name}'s data part`, card);
    // The design's View props come from the data part's switcher element.
    return stories.map((s) =>
      this.carry(s, (prop) => {
        const attr = jsxAttribute(dataFn, prop, (tag) => data.imports.get(tag.split('.')[0])?.from === folder.files.switcher);
        if (!attr) return undefined;
        return [{ kind: 'run', text: `${name}'s real data part handles ${prop}`, at: at(data, attr.loc), ...(card ? { card } : {}) }, ...this.handler(attr.value, dataScope, 1, new Set())];
      }),
    );
  }

  /** A plain component: the actions on its elements, and its children's stories carried on through it. */
  private componentStories(path: string, name: string, depth: number): Story[] {
    const file = this.file(path);
    const fn = file && findFunction(file.ast, name);
    if (!file || !fn) return [];
    return this.actionStories(file, fn, name, this.ctx.cardOf(path, name), depth);
  }

  private actionStories(file: FileCtx, fn: Fn, name: string, card: string | undefined, depth: number): Story[] {
    const scope = this.scope(fn, file, name, card);
    const out: Story[] = [];
    walk(fn.body, (n) => {
      if (n.type !== 'JSXElement') return;
      const tag = jsxName(n.openingElement.name);
      const child = this.childComponent(tag, file);
      for (const a of n.openingElement.attributes) {
        if (a.type !== 'JSXAttribute' || a.name.type !== 'JSXIdentifier' || !/^on[A-Z]/.test(a.name.name)) continue;
        if (a.value?.type !== 'JSXExpressionContainer' || a.value.expression.type === 'JSXEmptyExpression') continue;
        const event = a.name.name;
        const expr = a.value.expression;
        if (child) {
          // A component of the project: its own stories that call this prop go on here.
          if (depth >= 3) continue;
          for (const cs of this.storiesOf(child.path, child.name, depth + 1)) {
            const i = cs.steps.findIndex((s) => s.kind === 'prop' && s.prop === event);
            if (i < 0) continue;
            const given: StoryStep = { kind: 'run', text: `${child.name} calls ${event}, which ${name.replace(/ \(.*\)$/, '')} gives it`, at: at(file, a), ...(card ? { card } : {}) };
            out.push({ ...cs, id: `${cs.id}>${file.path}:${line0(a) + 1}`, title: cs.title.includes(' on ') ? cs.title : `${cs.title} on ${child.name}`, steps: cap([...cs.steps.slice(0, i), given, ...this.handler(expr, scope, 1, new Set())]) });
          }
          continue;
        }
        const verb = VERBS[event] ?? `On ${event.slice(2)}:`;
        const label = labelOf(n, file.text, (e) => this.constant(e, file)) ?? TAG_WORDS[tag] ?? tag;
        const title = `${verb === 'Change' && /^(input|textarea)$/.test(tag) ? 'Type in' : verb === 'Change' && tag === 'select' ? 'Choose in' : verb} ${label}`;
        const first: StoryStep = { kind: 'action', text: `You ${title.charAt(0).toLowerCase()}${title.slice(1)}`, at: at(file, n), ...(card ? { card } : {}) };
        const steps = this.handler(expr, scope, 1, new Set());
        // (A handler that does nothing to tell, like only stopping the click going further, isn't a story.)
        if (steps.length) out.push({ id: `${file.path}:${line0(n) + 1}:${event}`, title, at: at(file, n), steps: cap([first, ...steps]) });
      }
    });
    return dedupe(out);
  }

  /** A story whose last step calls a prop: carried on by `next` (undefined: it stays the prop's). */
  private carry(s: Story, next: (prop: string) => StoryStep[] | undefined): Story {
    const i = s.steps.map((x) => x.kind).lastIndexOf('prop');
    const prop = i >= 0 ? s.steps[i].prop : undefined;
    const more = prop ? next(prop) : undefined;
    return more ? { ...s, steps: cap([...s.steps.slice(0, i), ...more, ...s.steps.slice(i + 1)]) } : s;
  }

  /** The steps of a handler: a function (its body), or a name or call standing for one. */
  private handler(expr: t.Expression | N, scope: Scope, depth: number, seen: Set<N>): StoryStep[] {
    const e = strip(expr as t.Expression);
    if (e.type === 'ArrowFunctionExpression' || e.type === 'FunctionExpression') return this.body(e, scope, depth, seen);
    if (e.type === 'Identifier') return this.callName(e.name, [], scope, at(scope.file, e), depth, seen);
    if (e.type === 'MemberExpression' || e.type === 'OptionalMemberExpression') return this.callMember(e as t.MemberExpression, [], scope, at(scope.file, e), depth, seen);
    if (e.type === 'CallExpression') return this.call(e, scope, depth, seen);
    return [];
  }

  /** Each call in a function's body, in order, as steps. */
  private body(fn: Fn, scope: Scope, depth: number, seen: Set<N>): StoryStep[] {
    if (seen.has(fn) || depth > MAX_DEPTH) return [];
    seen.add(fn);
    const out: StoryStep[] = [];
    const inner = new Set<N>();
    walk(fn.body, (n) => {
      if ((n.type === 'CallExpression' || n.type === 'OptionalCallExpression') && !inner.has(n)) {
        const steps = this.call(n as t.CallExpression, scope, depth, seen);
        out.push(...steps);
        // (What a step is given isn't a step of its own: navigate(toEditor(id)) is one.)
        if (steps.length) for (const a of (n as t.CallExpression).arguments) walk(a, (m) => (m.type === 'CallExpression' || m.type === 'OptionalCallExpression') && inner.add(m));
      }
      // (A call's callee chain isn't a call of its own: `a.b().c()` is one step.)
      if (n.type === 'CallExpression' || n.type === 'OptionalCallExpression') walk((n as t.CallExpression).callee, (m) => m !== n && (m.type === 'CallExpression' || m.type === 'OptionalCallExpression') && inner.add(m));
    });
    return out;
  }

  private call(c: t.CallExpression, scope: Scope, depth: number, seen: Set<N>): StoryStep[] {
    const callee = strip(c.callee as t.Expression);
    const where = at(scope.file, c);
    if (callee.type === 'Identifier') return this.callName(callee.name, c.arguments, scope, where, depth, seen);
    if (callee.type === 'MemberExpression' || callee.type === 'OptionalMemberExpression') return this.callMember(callee as t.MemberExpression, c.arguments, scope, where, depth, seen);
    return [];
  }

  private callName(name: string, args: t.CallExpression['arguments'], scope: Scope, where: { path: string; line: number }, depth: number, seen: Set<N>): StoryStep[] {
    const step = (kind: StoryStep['kind'], text: string, more: Partial<StoryStep> = {}): StoryStep => ({ kind, text, at: where, depth, ...(scope.card ? { card: scope.card } : {}), ...more });
    const arg = (i = 0) => (args[i] ? argText(args[i], scope.file.text) : '');
    if (name === 'confirm') return [step('ask', `Asks ${arg() ? `“${unquote(arg())}”` : 'a yes or no question'} and goes on only on yes`)];
    if (name === 'alert') return [step('message', `Shows a message${arg() ? `: “${unquote(arg())}”` : ''}`)];
    if (name === 'fetch') return [step('api', `Sends ${fetchMethod(args[1], scope.file.text)} ${unquote(arg()) || 'a request'}`)];
    const state = scope.setters.get(name);
    if (state) return [step('state', `Sets ${state}${arg() && arg().length <= 40 ? ` to ${arg()}` : ''}`)];
    if (scope.navigate.has(name)) return [step('navigate', `Opens ${unquote(arg()) || 'another page'}`)];
    if (scope.props.has(name)) return [step('prop', `Calls ${name}, which it was given (what it does is up to the component using it)`, { prop: name })];
    const local = scope.locals.get(name);
    if (local) return [step('run', `Runs ${name}`), ...this.body(local, scope, depth + 1, seen)];
    const fromHook = scope.hookVals.get(name);
    if (fromHook) return [step('run', `Runs ${fromHook.key ?? name} from ${fromHook.hook}`), ...this.followHook(fromHook.hook, fromHook.key ?? name, scope, depth + 1, seen)];
    const store = scope.stores.get(name);
    if (store) return [step('store', `Runs ${store.key} in ${store.store}`)];
    if (scope.mutations.has(name)) return this.mutation(name, scope, where, depth, seen);
    const imp = scope.file.imports.get(name);
    if (imp?.from.startsWith('pkg:')) return /toast/i.test(name) || /toast/i.test(imp.from) ? [step('message', `Shows a notice${arg() ? `: ${unquote(arg())}` : ''}`)] : [];
    if (imp) {
      const target = this.file(imp.from);
      const fn = target && findFunction(target.ast, imp.imported === 'default' ? 'default' : imp.imported);
      if (target && fn) return [step('run', `Runs ${name} (${imp.from})`), ...this.body(fn, this.scope(fn, target, name, this.ctx.cardOf(target.path, name)), depth + 1, seen)];
    }
    return [];
  }

  private callMember(m: t.MemberExpression, args: t.CallExpression['arguments'], scope: Scope, where: { path: string; line: number }, depth: number, seen: Set<N>): StoryStep[] {
    const step = (kind: StoryStep['kind'], text: string, more: Partial<StoryStep> = {}): StoryStep => ({ kind, text, at: where, depth, ...(scope.card ? { card: scope.card } : {}), ...more });
    const prop = m.property.type === 'Identifier' ? m.property.name : m.property.type === 'StringLiteral' ? m.property.value : '';
    const chain = memberChain(m);
    const root = chain[0];
    const arg = (i = 0) => (args[i] ? argText(args[i], scope.file.text) : '');
    if (!prop || !root) return [];
    if (/^(preventDefault|stopPropagation|persist)$/.test(prop)) return [];
    if (root === 'window' && prop === 'confirm') return this.callName('confirm', args, scope, where, depth, seen);
    if (root === 'window' && prop === 'alert') return this.callName('alert', args, scope, where, depth, seen);
    if (root === scope.propsObj && chain.length === 2) return [step('prop', `Calls ${prop}, which it was given (what it does is up to the component using it)`, { prop })];
    if (scope.navigate.has(root) && /^(push|replace|navigate)$/.test(prop)) return [step('navigate', `Opens ${unquote(arg()) || 'another page'}`)];
    if (scope.mutations.has(root) && /^mutate(Async)?$/.test(prop)) return this.mutation(root, scope, where, depth, seen);
    const hv = scope.hookVals.get(root);
    if (hv?.hook === 'useQueryClient' && /^(invalidateQueries|refetchQueries|resetQueries)$/.test(prop)) return [step('reload', `Loads ${arg() ? `${arg()} ` : ''}again`)];
    if (hv && chain.length === 2) return [step('run', `Runs ${prop} from ${hv.hook}`), ...this.followHook(hv.hook, prop, scope, depth + 1, seen)];
    if ((root === 'localStorage' || root === 'sessionStorage') && /^(setItem|removeItem|clear)$/.test(prop)) return [step('data', `${prop === 'setItem' ? 'Saves' : 'Removes'} ${arg() ? `${arg()} ` : ''}in the browser's storage`)];
    // A store's action from outside a component: useXStore.getState().action().
    if (chain.includes('getState')) return [step('store', `Runs ${prop} in ${root}`)];
    if (HTTP.has(prop) && chain.length === 2 && args.length) return [step('api', `Sends ${prop === 'request' ? 'a request to' : prop.toUpperCase()} ${unquote(arg())}`)];
    if (DATA_WORDS[prop] && chain.length >= 3) return [step('data', `${DATA_WORDS[prop]} saved data (${chain.slice(0, 2).join('.')})`)];
    // An imported module's function: api.deleteProject(…), or a namespace import.
    const imp = scope.file.imports.get(root);
    if (imp && !imp.from.startsWith('pkg:') && chain.length === 2) {
      const target = this.file(imp.from);
      const fn = target && (imp.imported === '*' ? findFunction(target.ast, prop) : objectMethod(target.ast, imp.imported === 'default' ? 'default' : imp.imported, prop));
      if (target && fn) return [step('run', `Runs ${root}.${prop} (${imp.from})`), ...this.body(fn, this.scope(fn, target, `${root}.${prop}`, undefined), depth + 1, seen)];
    }
    return [];
  }

  /** A react-query mutation: what its mutationFn does. */
  private mutation(name: string, scope: Scope, where: { path: string; line: number }, depth: number, seen: Set<N>): StoryStep[] {
    const fn = scope.mutations.get(name);
    return [{ kind: 'run', text: `Runs ${name}`, at: where, depth, ...(scope.card ? { card: scope.card } : {}) }, ...(fn ? this.body(fn, scope, depth + 1, seen) : [])];
  }

  /** What a hook gives under `key`, followed into the hook. */
  private followHook(hook: string, key: string, scope: Scope, depth: number, seen: Set<N>): StoryStep[] {
    const imp = scope.file.imports.get(hook);
    const file = imp ? (imp.from.startsWith('pkg:') ? undefined : this.file(imp.from)) : scope.file;
    const fn = file && findFunction(file.ast, imp && imp.imported !== hook && imp.imported !== 'default' ? imp.imported : hook === 'default' ? 'default' : (imp?.imported === 'default' ? 'default' : hook));
    if (!file || !fn) return [];
    const inner = this.scope(fn, file, hook, scope.card);
    const ret = returned(fn);
    const value = ret ? propertyValue(ret, key) : undefined;
    if (!value) return [];
    // (One of the hook's own functions: its steps follow straight on, not "Runs it" a second time.)
    const own = value.type === 'Identifier' ? inner.locals.get(value.name) : undefined;
    if (own) return this.body(own, inner, depth, seen);
    return this.handler(value, inner, depth, seen);
  }

  /** What a component or hook has in scope: its functions, state setters, hook values, props. */
  protected scope(fn: Fn, file: FileCtx, owner: string, card: string | undefined): Scope {
    const s: Scope = { file, owner, card, locals: new Map(), setters: new Map(), hookVals: new Map(), props: new Set(), navigate: new Set(), mutations: new Map(), stores: new Map() };
    const p = fn.params[0];
    if (p?.type === 'ObjectPattern') for (const n of patternNames(p)) s.props.add(n);
    else if (p?.type === 'Identifier') s.propsObj = p.name;
    const stmts = fn.body.type === 'BlockStatement' ? fn.body.body : [];
    for (const st of stmts) {
      if (st.type === 'FunctionDeclaration' && st.id) s.locals.set(st.id.name, st);
      if (st.type !== 'VariableDeclaration') continue;
      for (const d of st.declarations) {
        const init = d.init ? strip(d.init) : undefined;
        if (!init) continue;
        if (d.id.type === 'Identifier' && (init.type === 'ArrowFunctionExpression' || init.type === 'FunctionExpression')) {
          s.locals.set(d.id.name, init);
          continue;
        }
        if (init.type !== 'CallExpression' || init.callee.type !== 'Identifier') {
          // const { a } = props
          if (d.id.type === 'ObjectPattern' && init.type === 'Identifier' && init.name === s.propsObj) for (const n of patternNames(d.id)) s.props.add(n);
          continue;
        }
        const callee = init.callee.name;
        const first = init.arguments[0] ? strip(init.arguments[0] as t.Expression) : undefined;
        if (callee === 'useCallback' && d.id.type === 'Identifier' && first && (first.type === 'ArrowFunctionExpression' || first.type === 'FunctionExpression')) s.locals.set(d.id.name, first);
        else if ((callee === 'useState' || callee === 'useReducer') && d.id.type === 'ArrayPattern') {
          const [v, set] = d.id.elements;
          if (set?.type === 'Identifier') s.setters.set(set.name, v?.type === 'Identifier' ? v.name : 'its state');
        } else if ((callee === 'useNavigate' || callee === 'useRouter' || callee === 'useHistory') && d.id.type === 'Identifier') s.navigate.add(d.id.name);
        else if (callee === 'useMutation') {
          const fnArg = first && (first.type === 'ArrowFunctionExpression' || first.type === 'FunctionExpression') ? first : first?.type === 'ObjectExpression' ? (propertyValue(first, 'mutationFn') as Fn | undefined) : undefined;
          const ok = fnArg && (fnArg.type === 'ArrowFunctionExpression' || fnArg.type === 'FunctionExpression') ? fnArg : undefined;
          if (d.id.type === 'Identifier') s.mutations.set(d.id.name, ok);
          else if (d.id.type === 'ObjectPattern') for (const n of patternPairs(d.id)) if (/^mutate(Async)?$/.test(n.key)) s.mutations.set(n.local, ok);
        } else if (/^use\w*Store$/.test(callee)) {
          if (d.id.type === 'Identifier' && first && first.type === 'ArrowFunctionExpression' && first.body.type === 'MemberExpression' && first.body.property.type === 'Identifier') s.stores.set(d.id.name, { store: callee, key: first.body.property.name });
          else if (d.id.type === 'ObjectPattern') for (const n of patternPairs(d.id)) s.stores.set(n.local, { store: callee, key: n.key });
        } else if (/^use[A-Z]/.test(callee)) {
          if (d.id.type === 'ObjectPattern') for (const n of patternPairs(d.id)) s.hookVals.set(n.local, { hook: callee, key: n.key });
          else if (d.id.type === 'Identifier') s.hookVals.set(d.id.name, { hook: callee });
        }
      }
    }
    return s;
  }

  /** A project component an element's tag stands for, when it's one. */
  protected childComponent(tag: string, file: FileCtx): { path: string; name: string } | undefined {
    if (!/^[A-Z]/.test(tag) || tag.includes('.')) return undefined;
    // (One defined in the same file.)
    if (!file.imports.has(tag) && findFunction(file.ast, tag)) return { path: file.path, name: tag };
    const imp = file.imports.get(tag);
    if (!imp || imp.from.startsWith('pkg:') || !this.ctx.files.has(imp.from)) return undefined;
    const target = this.file(imp.from);
    if (!target) return undefined;
    // (A default import is the file's default component; its name, for its card.)
    const name = imp.imported === 'default' ? defaultName(target.ast) ?? tag : imp.imported;
    return { path: imp.from, name };
  }

  /** A constant's text, when an expression names one (MESSAGES.project.newProjectButton → "New project"). */
  protected constant(e: t.Expression, file: FileCtx): string | undefined {
    if (e.type !== 'MemberExpression') return undefined;
    const chain = memberChain(e);
    const imp = file.imports.get(chain[0]);
    const source = imp ? (imp.from.startsWith('pkg:') ? undefined : this.file(imp.from)) : file;
    if (!source) return undefined;
    const name = imp && imp.imported !== 'default' && imp.imported !== '*' ? imp.imported : chain[0];
    let value: N | undefined;
    for (const st0 of source.ast.program.body) {
      const st = st0.type === 'ExportNamedDeclaration' && st0.declaration ? st0.declaration : st0;
      if (st.type === 'VariableDeclaration') for (const d of st.declarations) if (d.id.type === 'Identifier' && d.id.name === name && d.init) value = strip(d.init);
    }
    for (const key of chain.slice(1)) value = value?.type === 'ObjectExpression' ? (propertyValue(value, key) as N | undefined) : undefined;
    const v = value && (value.type === 'TSAsExpression' ? value.expression : value);
    return v?.type === 'StringLiteral' ? v.value : v?.type === 'TemplateLiteral' ? shownText(v, source.text) : undefined;
  }

  protected file(path: string): FileCtx | undefined {
    if (this.parsed.has(path)) return this.parsed.get(path) ?? undefined;
    const text = this.ctx.read(path);
    const ast = text !== undefined ? parseSource({ path, text }) : undefined;
    if (text === undefined || !ast) {
      this.parsed.set(path, null);
      return undefined;
    }
    const imports = new Map<string, { from: string; imported: string }>();
    for (const st of ast.program.body) {
      if (st.type !== 'ImportDeclaration' || st.importKind === 'type') continue;
      const from = resolveImport(st.source.value, path, this.ctx.aliases, this.ctx.files);
      for (const sp of st.specifiers) {
        const imported = sp.type === 'ImportDefaultSpecifier' ? 'default' : sp.type === 'ImportNamespaceSpecifier' ? '*' : sp.imported.type === 'Identifier' ? sp.imported.name : sp.imported.value;
        imports.set(sp.local.name, { from, imported });
      }
    }
    const f: FileCtx = { path, text, ast, imports };
    this.parsed.set(path, f);
    return f;
  }
}

// ---------------------------------------------------------------------------

export const at = (file: FileCtx, n: N) => ({ path: file.path, line: line0(n) + 1 });

const cap = (steps: StoryStep[]) => (steps.length > MAX_STEPS ? [...steps.slice(0, MAX_STEPS - 1), { ...steps[MAX_STEPS - 1], text: `${steps[MAX_STEPS - 1].text} (and more: open the code to see the rest)` }] : steps);

function dedupe(stories: Story[]): Story[] {
  const seen = new Set<string>();
  return stories.filter((s) => {
    const key = `${s.title}|${s.steps.map((x) => x.text).join('|')}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function strip(e: t.Expression): t.Expression {
  let x: t.Expression = e;
  for (;;) {
    if (x.type === 'AwaitExpression') x = x.argument;
    else if (x.type === 'TSAsExpression' || x.type === 'TSNonNullExpression' || x.type === 'ParenthesizedExpression' || x.type === 'TSSatisfiesExpression' || x.type === 'TSTypeAssertion') x = (x as { expression: t.Expression }).expression;
    else break;
  }
  return x;
}

/** A function a file defines under a name ('default': its default export), unwrapping memo, forwardRef, useCallback. */
export function findFunction(ast: t.File, name: string): Fn | undefined {
  const unwrap = (e: N | null | undefined, depth = 0): Fn | undefined => {
    if (!e || depth > 3) return undefined;
    if (e.type === 'ArrowFunctionExpression' || e.type === 'FunctionExpression' || e.type === 'FunctionDeclaration') return e;
    if (e.type === 'CallExpression') return unwrap(e.arguments[0] as N, depth + 1);
    if (e.type === 'TSAsExpression' || e.type === 'ParenthesizedExpression') return unwrap(e.expression, depth + 1);
    return undefined;
  };
  let target = name;
  for (const st of ast.program.body) {
    if (st.type === 'ExportDefaultDeclaration' && name === 'default') {
      const d = st.declaration;
      if (d.type === 'Identifier') target = d.name;
      else {
        const f = unwrap(d);
        if (f) return f;
        if (d.type === 'FunctionDeclaration' && d.id) target = d.id.name;
      }
    }
  }
  for (const st0 of ast.program.body) {
    const st = (st0.type === 'ExportNamedDeclaration' || st0.type === 'ExportDefaultDeclaration') && st0.declaration ? st0.declaration : st0;
    if (st.type === 'FunctionDeclaration' && st.id?.name === target) return st;
    if (st.type === 'VariableDeclaration') for (const d of st.declarations) if (d.id.type === 'Identifier' && d.id.name === target) return unwrap(d.init);
  }
  return undefined;
}

/** The name a file's default export has (its component's name). */
export function defaultName(ast: t.File): string | undefined {
  for (const st of ast.program.body) {
    if (st.type !== 'ExportDefaultDeclaration') continue;
    const d = st.declaration;
    if (d.type === 'Identifier') return d.name;
    if (d.type === 'FunctionDeclaration' && d.id) return d.id.name;
  }
  return undefined;
}

/** A method of an object a file defines (`export const api = { deleteProject() {} }`). */
function objectMethod(ast: t.File, objName: string, key: string): Fn | undefined {
  for (const st0 of ast.program.body) {
    const st = (st0.type === 'ExportNamedDeclaration' || st0.type === 'ExportDefaultDeclaration') && st0.declaration ? st0.declaration : st0;
    if (st.type === 'ObjectExpression' && objName === 'default') return fnOf(propertyValue(st, key));
    if (st.type !== 'VariableDeclaration') continue;
    for (const d of st.declarations) if (d.id.type === 'Identifier' && d.id.name === objName && d.init?.type === 'ObjectExpression') return fnOf(propertyValue(d.init, key));
  }
  return undefined;
}

const fnOf = (n: N | undefined): Fn | undefined => (n && (n.type === 'ArrowFunctionExpression' || n.type === 'FunctionExpression' || n.type === 'ObjectMethod') ? n : undefined);

/** What a function returns at its top level (the last return of an object, or an arrow's object body). */
export function returned(fn: Fn): t.ObjectExpression | undefined {
  if (fn.body.type !== 'BlockStatement') {
    const b = strip(fn.body as t.Expression);
    return b.type === 'ObjectExpression' ? b : undefined;
  }
  let found: t.ObjectExpression | undefined;
  for (const st of fn.body.body) if (st.type === 'ReturnStatement' && st.argument && strip(st.argument).type === 'ObjectExpression') found = strip(st.argument) as t.ObjectExpression;
  return found;
}

/** The value under a key in an object literal (`{ key }` stands for the name `key`). */
export function propertyValue(o: t.ObjectExpression, key: string): t.Expression | Fn | undefined {
  for (const p of o.properties) {
    if (p.type === 'ObjectMethod' && p.key.type === 'Identifier' && p.key.name === key) return p;
    if (p.type !== 'ObjectProperty') continue;
    const k = p.key.type === 'Identifier' ? p.key.name : p.key.type === 'StringLiteral' ? p.key.value : undefined;
    if (k === key) return p.value as t.Expression;
  }
  return undefined;
}

/** The value of an attribute on the element (in a function) whose tag passes `isTag`. */
function jsxAttribute(fn: Fn, name: string, isTag: (tag: string) => boolean): { value: t.Expression; loc: N } | undefined {
  let found: { value: t.Expression; loc: N } | undefined;
  walk(fn.body, (n) => {
    if (found || n.type !== 'JSXOpeningElement' || !isTag(jsxName(n.name))) return;
    for (const a of n.attributes) {
      if (a.type === 'JSXAttribute' && a.name.type === 'JSXIdentifier' && a.name.name === name && a.value?.type === 'JSXExpressionContainer' && a.value.expression.type !== 'JSXEmptyExpression') found = { value: a.value.expression, loc: a };
    }
  });
  return found ? { ...found, value: found.value } : undefined;
}

export function jsxName(n: t.JSXOpeningElement['name']): string {
  if (n.type === 'JSXIdentifier') return n.name;
  if (n.type === 'JSXNamespacedName') return `${n.namespace.name}:${n.name.name}`;
  return `${jsxName(n.object as t.JSXOpeningElement['name'])}.${n.property.name}`;
}

/** What an element says: its text, or its aria-label, title, placeholder… (undefined: nothing to call it). */
function labelOf(el: t.JSXElement, text: string, constant: (e: t.Expression) => string | undefined): string | undefined {
  const shown = (e: t.Expression, text: string) => constant(e) ?? shownText(e, text);
  for (const a of el.openingElement.attributes) {
    if (a.type !== 'JSXAttribute' || a.name.type !== 'JSXIdentifier' || !/^(aria-label|title|label|placeholder|alt|name)$/.test(a.name.name)) continue;
    if (a.value?.type === 'StringLiteral') return `“${a.value.value}”`;
    if (a.value?.type === 'JSXExpressionContainer' && a.value.expression.type !== 'JSXEmptyExpression') return `“${shown(a.value.expression, text)}”`;
  }
  const words: { text: string; name: boolean }[] = [];
  // (Its children only: what it shows, not its attributes; a list's options aren't its name, nor are the buttons
  // inside an area.)
  if (/^(select|ul|ol|table)$/.test(jsxName(el.openingElement.name))) return undefined;
  let holdsActions = false;
  for (const child of el.children) walk(child, (n) => n.type === 'JSXAttribute' && n.name.type === 'JSXIdentifier' && /^on[A-Z]/.test(n.name.name) && (holdsActions = true));
  if (holdsActions) return undefined;
  for (const child of el.children) walk(child, (n) => {
    if (n.type === 'JSXText' && n.value.trim()) words.push({ text: n.value.trim(), name: false });
    // (What an expression shows: a string, a template's words, a constant's text; a plain name, as itself.)
    if (n.type === 'JSXExpressionContainer' && n.expression.type !== 'JSXEmptyExpression' && /^(StringLiteral|TemplateLiteral|MemberExpression|Identifier)$/.test(n.expression.type)) {
      const known = constant(n.expression);
      words.push(known !== undefined || n.expression.type === 'StringLiteral' || n.expression.type === 'TemplateLiteral' ? { text: known ?? shownText(n.expression, text), name: false } : { text: shownText(n.expression, text), name: true });
    }
  });
  // A name next to real words stands for what it holds ("Save …"); on its own, it's the best there is (opt.label).
  const hasWords = words.some((w) => !w.name);
  const said = words.map((w) => (w.name && hasWords ? '…' : w.text)).join(' ').replace(/\s+/g, ' ').replace(/(… )+…/g, '…').trim();
  return said ? `“${said.length > 40 ? `${said.slice(0, 39)}…` : said}”` : undefined;
}

/** What an expression shows, in words: a string as it is, a template with … for its holes, else its text. */
export function shownText(e: t.Expression, text: string): string {
  if (e.type === 'StringLiteral') return e.value;
  // (One of two: "Close chat / Open chat".)
  if (e.type === 'ConditionalExpression' && e.consequent.type === 'StringLiteral' && e.alternate.type === 'StringLiteral') return `${e.consequent.value} / ${e.alternate.value}`;
  if (e.type === 'TemplateLiteral') return e.quasis.map((q) => q.value.cooked ?? q.value.raw).join('…').trim() || '…';
  return sliceText(text, e).slice(0, 40);
}

export function memberChain(m: t.Expression): string[] {
  const out: string[] = [];
  let x: t.Expression = m;
  for (let i = 0; i < 8; i++) {
    x = strip(x);
    if (x.type === 'MemberExpression' || x.type === 'OptionalMemberExpression') {
      const mm = x as t.MemberExpression;
      out.unshift(mm.property.type === 'Identifier' ? mm.property.name : mm.property.type === 'StringLiteral' ? mm.property.value : '?');
      x = mm.object as t.Expression;
    } else if (x.type === 'CallExpression') {
      x = x.callee as t.Expression;
    } else {
      if (x.type === 'Identifier') out.unshift(x.name);
      else if (x.type === 'ThisExpression') out.unshift('this');
      break;
    }
  }
  return out;
}

function patternNames(p: t.ObjectPattern): string[] {
  return patternPairs(p).map((x) => x.local);
}

export function patternPairs(p: t.ObjectPattern): { key: string; local: string }[] {
  const out: { key: string; local: string }[] = [];
  for (const prop of p.properties) {
    if (prop.type !== 'ObjectProperty') continue;
    const key = prop.key.type === 'Identifier' ? prop.key.name : prop.key.type === 'StringLiteral' ? prop.key.value : undefined;
    const v = prop.value.type === 'AssignmentPattern' ? prop.value.left : prop.value;
    if (key && v.type === 'Identifier') out.push({ key, local: v.name });
  }
  return out;
}

export function argText(a: N, text: string): string {
  if (a.type === 'StringLiteral') return `"${a.value}"`;
  if (a.type === 'TemplateLiteral') return `"${sliceText(text, a).slice(1, -1)}"`;
  return sliceText(text, a);
}

const unquote = (s: string) => s.replace(/^"(.*)"$/, '$1');

function fetchMethod(opts: N | undefined, text: string): string {
  if (opts?.type !== 'ObjectExpression') return 'GET';
  const m = propertyValue(opts, 'method');
  return m?.type === 'StringLiteral' ? m.value.toUpperCase() : m ? sliceText(text, m) : 'GET';
}
