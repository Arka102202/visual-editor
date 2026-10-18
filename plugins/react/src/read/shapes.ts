// Data shapes from how the code uses the data: what each API reply must look like, worked out without types. It
// follows each request (fetch, axios and its instances, React Query, SWR, API helper functions, custom hooks) to the
// variable that holds the reply, then collects how that variable is used: fields read, lists mapped, numbers
// formatted. `orders.map(o => o.total.toFixed(2))` means the reply is a list of objects with a number `total`.
// Pure: source text in, shapes out (no VS Code, no files), so it can be tested.

import type * as t from '@babel/types';
import { parseSource, walk, type SourceFile } from './ast';

/** What a value looks like, as far as the code shows. */
export interface Shape {
  kind?: 'string' | 'number' | 'boolean' | 'array' | 'object';
  fields?: Record<string, Shape>;
  item?: Shape;
}

/** An example reply for requests whose address (or React Query key) contains `match`. */
export interface ReplyShape {
  match: string;
  /** GET for addresses; QUERY for React Query keys. */
  method: string;
  shape: Shape;
}

type N = t.Node;

/** Where a value comes from: a request's reply (at a path inside it), the raw fetch response, or an axios response. */
interface Source {
  match: string;
  method: string;
  /** 'response': fetch's Response (needs .json()); 'axios': the reply is at .data; 'query': React Query result (reply at .data); 'body': the reply itself. */
  as: 'response' | 'axios' | 'query' | 'body';
  /** Where this value sits inside the reply. */
  at: string[];
}

const HTTP_VERBS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'request']);
const ITERATE = new Set(['map', 'filter', 'find', 'forEach', 'some', 'every', 'flatMap', 'findIndex', 'findLast', 'sort', 'toSorted']);
const SAME_LIST = new Set(['slice', 'filter', 'sort', 'toSorted', 'reverse', 'toReversed', 'concat', 'flat']);
const NUMBER_METHODS = new Set(['toFixed', 'toPrecision', 'toExponential']);
const STRING_METHODS = new Set(['toUpperCase', 'toLowerCase', 'trim', 'split', 'startsWith', 'endsWith', 'replace', 'replaceAll', 'padStart', 'padEnd', 'charAt', 'localeCompare', 'trimStart', 'trimEnd']);
const QUERY_HOOKS = new Set(['useQuery', 'useSuspenseQuery', 'useInfiniteQuery', 'useSWR', 'useSWRImmutable']);

const isFn = (n: N | null | undefined): n is t.ArrowFunctionExpression | t.FunctionExpression | t.FunctionDeclaration =>
  !!n && (n.type === 'ArrowFunctionExpression' || n.type === 'FunctionExpression' || n.type === 'FunctionDeclaration');
const propName = (m: t.MemberExpression | t.OptionalMemberExpression): string | undefined =>
  !m.computed && m.property.type === 'Identifier' ? m.property.name : m.property.type === 'StringLiteral' ? m.property.value : undefined;
const isMember = (n: N): n is t.MemberExpression | t.OptionalMemberExpression => n.type === 'MemberExpression' || n.type === 'OptionalMemberExpression';
const isCall = (n: N): n is t.CallExpression | t.OptionalCallExpression => n.type === 'CallExpression' || n.type === 'OptionalCallExpression';

/** The fixed start of an address: '/api/orders/' for `/api/orders/${id}` or '/api/orders/' + id. */
function addressOf(e: N | undefined): string | undefined {
  if (!e) return undefined;
  if (e.type === 'StringLiteral') return e.value;
  if (e.type === 'TemplateLiteral') return e.quasis[0]?.value.cooked ?? undefined;
  if (e.type === 'BinaryExpression' && e.operator === '+') return addressOf(e.left);
  return undefined;
}

/** Keeps only the part that identifies the request: the path, without host, query or trailing dynamic part. */
function matchOf(address: string): string | undefined {
  const path = address.replace(/^https?:\/\/[^/]+/, '').split('?')[0];
  return path.length > 1 || path === '/' ? path : undefined;
}

function methodOf(options: N | undefined): string {
  if (options?.type !== 'ObjectExpression') return 'GET';
  for (const p of options.properties) {
    if (p.type === 'ObjectProperty' && p.key.type === 'Identifier' && p.key.name === 'method' && p.value.type === 'StringLiteral') return p.value.value.toUpperCase();
  }
  return 'GET';
}

class Scope {
  readonly values = new Map<string, Source>();
  constructor(readonly parent?: Scope) {}
  get(name: string): Source | undefined {
    return this.values.get(name) ?? this.parent?.get(name);
  }
}

export class ShapeReader {
  /** API helpers: `api.getOrders` / `getOrders` → what calling them gives. */
  private readonly helpers = new Map<string, Source>();
  /** Custom hooks: `useProduct` → what each returned name holds. */
  private readonly hooks = new Map<string, Map<string, Source>>();
  /** Components by name (capitalised functions), to follow data passed down as props. */
  private readonly components = new Map<string, t.Function>();
  /** The shapes found so far, by match. */
  private readonly replies = new Map<string, ReplyShape>();

  /** Reads all files. Helpers and hooks first, so components that use them are understood. */
  read(files: SourceFile[]): ReplyShape[] {
    const asts = files.map((f) => parseSource(f)).filter((a): a is t.File => !!a);
    // Twice: a hook may use a helper defined in a file read later.
    for (let pass = 0; pass < 2; pass++) for (const ast of asts) this.index(ast);
    for (const ast of asts) this.collect(ast);
    return [...this.replies.values()].sort((a, b) => b.match.length - a.match.length);
  }

  // ---------------------------------------------------------------------------
  // What values are: requests, responses, replies
  // ---------------------------------------------------------------------------

  /** What an expression gives, when it's (part of) a request's reply. */
  private valueOf(e: N | null | undefined, scope: Scope): Source | undefined {
    if (!e) return undefined;
    switch (e.type) {
      case 'AwaitExpression':
        return this.valueOf(e.argument, scope);
      case 'Identifier':
        return scope.get(e.name);
      case 'ParenthesizedExpression':
      case 'TSAsExpression':
      case 'TSNonNullExpression':
        return this.valueOf(e.expression, scope);
      case 'LogicalExpression':
        return this.valueOf(e.left, scope) ?? this.valueOf(e.right, scope);
      case 'MemberExpression':
      case 'OptionalMemberExpression': {
        const base = this.valueOf(e.object, scope);
        const name = propName(e);
        if (!base || !name) return undefined;
        if ((base.as === 'axios' || base.as === 'query') && name === 'data') return { ...base, as: 'body' };
        if (base.as === 'body') return { ...base, at: [...base.at, name] };
        return undefined;
      }
      case 'CallExpression':
      case 'OptionalCallExpression':
        return this.callValue(e, scope);
      default:
        return undefined;
    }
  }

  private callValue(c: t.CallExpression | t.OptionalCallExpression, scope: Scope): Source | undefined {
    const callee = c.callee;
    const [first, second] = c.arguments as N[];
    // fetch(url, options)
    if (callee.type === 'Identifier' && callee.name === 'fetch') {
      const match = matchOf(addressOf(first) ?? '');
      return match ? { match, method: methodOf(second), as: 'response', at: [] } : undefined;
    }
    if (isMember(callee)) {
      const name = propName(callee);
      const object = callee.object;
      // response.json()
      if (name === 'json') {
        const base = this.valueOf(object, scope);
        if (base?.as === 'response') return { ...base, as: 'body' };
      }
      // promise.then(cb): what the callback returns (and setters inside it are handled by `collect`).
      if (name === 'then' && first && isFn(first)) {
        const base = this.valueOf(object, scope);
        if (!base) return undefined;
        const inner = new Scope(scope);
        const p = first.params[0];
        if (p?.type === 'Identifier') inner.values.set(p.name, base);
        if (p?.type === 'ObjectPattern') this.bindPattern(p, base, inner);
        const body = first.body;
        if (body.type !== 'BlockStatement') return this.valueOf(body, inner);
        for (const s of body.body) if (s.type === 'ReturnStatement') return this.valueOf(s.argument, inner);
        return undefined;
      }
      if (name === 'then' && first?.type === 'Identifier') return undefined;
      // axios.get(url) / http.get(url) / api.post(url): any client with HTTP verbs and an address.
      if (name && HTTP_VERBS.has(name)) {
        const match = matchOf(addressOf(first) ?? '');
        if (match && (match.startsWith('/') || /^https?:/.test(addressOf(first) ?? ''))) return { match, method: name === 'request' ? 'GET' : name.toUpperCase(), as: 'axios', at: [] };
      }
      // api.getOrders()
      const key = object.type === 'Identifier' && name ? `${object.name}.${name}` : undefined;
      if (key && this.helpers.has(key)) return this.helpers.get(key);
    }
    // axios(url) / axios({ url })
    if (callee.type === 'Identifier' && callee.name === 'axios') {
      const address = addressOf(first) ?? (first?.type === 'ObjectExpression' ? addressOf(this.prop(first, 'url')) : undefined);
      const match = matchOf(address ?? '');
      return match ? { match, method: methodOf(first), as: 'axios', at: [] } : undefined;
    }
    // getOrders()
    if (callee.type === 'Identifier' && this.helpers.has(callee.name)) return this.helpers.get(callee.name);
    // useQuery / useSWR: the result's .data is the reply.
    if (callee.type === 'Identifier' && QUERY_HOOKS.has(callee.name)) return this.queryValue(callee.name, c, scope);
    return undefined;
  }

  private prop(o: t.ObjectExpression, key: string): N | undefined {
    for (const p of o.properties) {
      if (p.type === 'ObjectProperty' && ((p.key.type === 'Identifier' && p.key.name === key) || (p.key.type === 'StringLiteral' && p.key.value === key))) return p.value;
      if (p.type === 'ObjectMethod' && p.key.type === 'Identifier' && p.key.name === key) return p;
    }
    return undefined;
  }

  /** React Query / SWR: matched by the request its function makes, or else by its key. */
  private queryValue(hook: string, c: t.CallExpression | t.OptionalCallExpression, scope: Scope): Source | undefined {
    const [first, second] = c.arguments as N[];
    const options = first?.type === 'ObjectExpression' ? first : undefined;
    const key = options ? this.prop(options, 'queryKey') : first;
    const fn = options ? this.prop(options, 'queryFn') : second;
    if (fn && isFn(fn)) {
      const body = fn.body;
      const inner = new Scope(scope);
      const made = body.type === 'BlockStatement' ? body.body.map((s) => (s.type === 'ReturnStatement' ? this.valueOf(s.argument, inner) : undefined)).find(Boolean) : this.valueOf(body, inner);
      if (made?.as === 'body') return { ...made, as: 'query' };
      if (made?.as === 'axios') return { ...made, as: 'query' };
    }
    // SWR's key is usually the address itself.
    if (hook.startsWith('useSWR')) {
      const match = matchOf(addressOf(key) ?? '');
      if (match) return { match, method: 'GET', as: 'query', at: [] };
    }
    // React Query: its key's first part, as it appears in the key's text ("orders").
    const head = key?.type === 'ArrayExpression' ? key.elements[0] : key;
    if (head?.type === 'StringLiteral') return { match: JSON.stringify(head.value), method: 'QUERY', as: 'query', at: [] };
    return undefined;
  }

  /** `const { data, items: list } = value`: each name holds its part. */
  private bindPattern(p: t.ObjectPattern, base: Source, scope: Scope) {
    for (const prop of p.properties) {
      if (prop.type !== 'ObjectProperty' || prop.key.type !== 'Identifier') continue;
      const part = this.part(base, prop.key.name);
      const target = prop.value.type === 'AssignmentPattern' ? prop.value.left : prop.value;
      if (part && target.type === 'Identifier') scope.values.set(target.name, part);
      if (part && target.type === 'ObjectPattern') this.bindPattern(target, part, scope);
    }
  }

  private part(base: Source, name: string): Source | undefined {
    if ((base.as === 'axios' || base.as === 'query') && name === 'data') return { ...base, as: 'body' };
    if (base.as === 'body') return { ...base, at: [...base.at, name] };
    return undefined;
  }

  // ---------------------------------------------------------------------------
  // Pass 1: helpers and hooks
  // ---------------------------------------------------------------------------

  private index(ast: t.File) {
    walk(ast, (n) => {
      // export const api = { getOrders: () => fetch(...).then(r => r.json()) }
      if (n.type === 'VariableDeclarator' && n.id.type === 'Identifier' && n.init?.type === 'ObjectExpression') {
        for (const p of n.init.properties) {
          if (p.type !== 'ObjectProperty' && p.type !== 'ObjectMethod') continue;
          if (p.key.type !== 'Identifier') continue;
          const fn = p.type === 'ObjectMethod' ? p : isFn(p.value) ? p.value : undefined;
          const made = fn && this.returned(fn);
          if (made) this.helpers.set(`${n.id.name}.${p.key.name}`, made);
        }
      }
      // export function getOrders() / export const getOrders = () => …
      const named = n.type === 'FunctionDeclaration' && n.id ? { name: n.id.name, fn: n } : n.type === 'VariableDeclarator' && n.id.type === 'Identifier' && isFn(n.init) ? { name: n.id.name, fn: n.init } : undefined;
      if (!named) return;
      if (/^[A-Z]/.test(named.name)) this.components.set(named.name, named.fn);
      if (/^use[A-Z]/.test(named.name)) this.indexHook(named.name, named.fn);
      else {
        const made = this.returned(named.fn);
        if (made) this.helpers.set(named.name, made);
      }
    });
  }

  /** What a function returns, when it's a request's reply (or a response that leads to one). */
  private returned(fn: t.Function): Source | undefined {
    const scope = this.scopeFor(fn);
    if (fn.body.type !== 'BlockStatement') return this.valueOf(fn.body, scope);
    let found: Source | undefined;
    walk(fn.body, (n) => {
      if (!found && n.type === 'ReturnStatement') found = this.valueOf(n.argument, scope);
    });
    return found;
  }

  /** A custom hook: what each name it returns holds (`return { product, isLoading }`, or `return useQuery(…)`). */
  private indexHook(name: string, fn: t.Function) {
    const scope = this.scopeFor(fn);
    const out = new Map<string, Source>();
    const consider = (arg: N | null | undefined) => {
      if (!arg) return;
      if (arg.type === 'ObjectExpression') {
        for (const p of arg.properties) {
          if (p.type !== 'ObjectProperty' || p.key.type !== 'Identifier') continue;
          const v = this.valueOf(p.value, scope);
          if (v) out.set(p.key.name, v);
        }
      } else {
        const v = this.valueOf(arg, scope);
        if (v?.as === 'query') out.set('data', { ...v, as: 'body' });
        if (v?.as === 'body') out.set('', v);
      }
    };
    if (fn.body.type === 'BlockStatement') walk(fn.body, (n) => n.type === 'ReturnStatement' && consider(n.argument));
    else consider(fn.body);
    if (out.size) this.hooks.set(name, out);
  }

  /**
   * The values a function's own variables hold: `const res = await fetch(u)`, `const [x, setX] = useState()` with
   * `setX(reply)` (in a promise chain or after an await), `const { data } = useQuery(…)`, `const { product } = useProduct()`.
   */
  private scopeFor(fn: t.Function): Scope {
    const scope = new Scope();
    const setters = new Map<string, string>();
    // In source order, twice: a value set late may feed one read earlier in the text (effects run after render).
    for (let pass = 0; pass < 2; pass++) {
      walk(fn.body, (n) => {
        if (n.type === 'VariableDeclarator') {
          // const [orders, setOrders] = useState(...)
          if (n.id.type === 'ArrayPattern' && n.init && isCall(n.init) && n.init.callee.type === 'Identifier' && /^use(State|Reducer)$/.test(n.init.callee.name)) {
            const [v, s] = n.id.elements;
            if (v?.type === 'Identifier' && s?.type === 'Identifier') setters.set(s.name, v.name);
            return;
          }
          // const { product } = useProduct(id) / const x = useProduct()
          const hook = n.init && isCall(n.init) && n.init.callee.type === 'Identifier' ? this.hooks.get(n.init.callee.name) : undefined;
          if (hook) {
            if (n.id.type === 'ObjectPattern') {
              for (const p of n.id.properties) {
                if (p.type !== 'ObjectProperty' || p.key.type !== 'Identifier') continue;
                const target = p.value.type === 'AssignmentPattern' ? p.value.left : p.value;
                const v = hook.get(p.key.name);
                if (v && target.type === 'Identifier') scope.values.set(target.name, v);
              }
            } else if (n.id.type === 'Identifier' && hook.get('')) scope.values.set(n.id.name, hook.get('')!);
            return;
          }
          const v = this.valueOf(n.init, scope);
          if (!v) return;
          if (n.id.type === 'Identifier') scope.values.set(n.id.name, v);
          if (n.id.type === 'ObjectPattern') this.bindPattern(n.id, v, scope);
        }
        if (!isCall(n)) return;
        // setOrders(reply) in an await flow
        if (n.callee.type === 'Identifier' && setters.has(n.callee.name)) {
          const v = this.valueOf(n.arguments[0] as N, scope);
          if (v && v.as === 'body') scope.values.set(setters.get(n.callee.name)!, v);
        }
        // promise.then(setOrders) / promise.then((r) => setOrders(r.data))
        if (isMember(n.callee) && propName(n.callee) === 'then') {
          const base = this.valueOf(n.callee.object, scope);
          const cb = n.arguments[0] as N | undefined;
          if (!base || !cb) return;
          if (cb.type === 'Identifier' && setters.has(cb.name) && base.as === 'body') scope.values.set(setters.get(cb.name)!, base);
          if (isFn(cb)) {
            const inner = new Scope(scope);
            const p = cb.params[0];
            if (p?.type === 'Identifier') inner.values.set(p.name, base);
            if (p?.type === 'ObjectPattern') this.bindPattern(p, base, inner);
            walk(cb.body, (m) => {
              if (isCall(m) && m.callee.type === 'Identifier' && setters.has(m.callee.name)) {
                const v = this.valueOf(m.arguments[0] as N, inner);
                if (v && v.as === 'body') scope.values.set(setters.get(m.callee.name)!, v);
              }
            });
          }
        }
      });
    }
    return scope;
  }

  // ---------------------------------------------------------------------------
  // Pass 2: how the data is used, in every function
  // ---------------------------------------------------------------------------

  private collect(ast: t.File) {
    walk(ast, (n) => {
      if (!isFn(n) || n.body.type !== 'BlockStatement') return;
      const scope = this.scopeFor(n);
      for (const [name, source] of scope.values) {
        if (source.as === 'response') continue;
        // React Query / axios results hold the reply under .data.
        this.usesOf(n.body, new Map([[name, source.as === 'body' ? [] : ['data']]]), source);
      }
    });
  }

  /**
   * Records every use of the given names (each holding a path in `source`'s reply) inside `body`. A name may be
   * "props.orders": the prop of a props object.
   */
  private usesOf(body: N, aliases: Map<string, string[]>, source: Source, depth = 0) {
    const roots = new Set(aliases.keys());
    // Repeated, so aliases made from aliases are followed (const items = data.items; items.map(i => i.title)).
    for (let pass = 0; pass < 3; pass++) {
      walk(body, (n) => {
        // const items = data.items / const { total, items } = data
        if (n.type === 'VariableDeclarator' && n.init) {
          const p = this.pathOf(n.init, aliases);
          if (!p) return;
          if (n.id.type === 'Identifier' && !roots.has(n.id.name)) aliases.set(n.id.name, p.path);
          if (n.id.type === 'ObjectPattern') this.patternUses(n.id, p.path, aliases, source);
        }
        // list.map((item) => …) / list.map(({ title }) => …)
        if (isCall(n) && isMember(n.callee)) {
          const method = propName(n.callee);
          const p = method && ITERATE.has(method) ? this.pathOf(n.callee.object, aliases) : undefined;
          const cb = n.arguments[0] as N | undefined;
          if (p && cb && isFn(cb)) {
            const param = cb.params[0];
            const item = [...p.path, '[]'];
            this.add(source, item, undefined);
            if (param?.type === 'Identifier') aliases.set(param.name, item);
            if (param?.type === 'ObjectPattern') this.patternUses(param, item, aliases, source);
          }
        }
      });
    }
    // Every chain rooted at an alias is a path in the reply; how it ends tells its kind. Method calls
    // (list.map(…), name.trim()) are not fields.
    const called = new Set<N>();
    walk(body, (n) => {
      if (isCall(n) && isMember(n.callee)) called.add(n.callee);
    });
    walk(body, (n) => {
      if (!isMember(n) || called.has(n)) return;
      // x.length: x is a list (text with .length is rarer, and string methods say so when it is).
      if (propName(n) === 'length') {
        const p = this.pathOf(n.object, aliases);
        if (p && p.path.length) this.add(source, [...p.path, '[]'], undefined);
        return;
      }
      const p = this.pathOf(n, aliases);
      if (!p || p.path.length === 0) return;
      this.add(source, p.path, undefined);
    });
    walk(body, (n) => {
      if (!isCall(n) || !isMember(n.callee)) return;
      const method = propName(n.callee);
      const p = this.pathOf(n.callee.object, aliases);
      if (!p || !method) return;
      if (NUMBER_METHODS.has(method)) this.add(source, p.path, 'number');
      else if (STRING_METHODS.has(method)) this.add(source, p.path, 'string');
      else if (ITERATE.has(method) || SAME_LIST.has(method)) this.add(source, [...p.path, '[]'], undefined);
    });
    // Data passed down: <OrderList orders={orders} /> — how OrderList uses `orders` is part of the shape too.
    if (depth >= 3) return;
    walk(body, (n) => {
      if (n.type !== 'JSXOpeningElement' || n.name.type !== 'JSXIdentifier') return;
      const child = this.components.get(n.name.name);
      if (!child || child.body.type !== 'BlockStatement' && child.body.type !== 'JSXElement' && child.body.type !== 'ParenthesizedExpression') return;
      for (const a of n.attributes) {
        if (a.type !== 'JSXAttribute' || a.name.type !== 'JSXIdentifier' || a.value?.type !== 'JSXExpressionContainer') continue;
        const p = a.value.expression.type === 'JSXEmptyExpression' ? undefined : this.pathOf(a.value.expression, aliases);
        if (!p) continue;
        this.followProp(child, a.name.name, p.path, source, depth + 1);
      }
    });
  }

  /** A child component's use of one of its props, which holds part of a reply. */
  private followProp(fn: t.Function, prop: string, path: string[], source: Source, depth: number) {
    const param = fn.params[0];
    if (param?.type === 'ObjectPattern') {
      // function OrderList({ orders }) …
      for (const p of param.properties) {
        if (p.type !== 'ObjectProperty' || p.key.type !== 'Identifier' || p.key.name !== prop) continue;
        const target = p.value.type === 'AssignmentPattern' ? p.value.left : p.value;
        if (target.type === 'Identifier') this.usesOf(fn.body, new Map([[target.name, path]]), source, depth);
      }
    } else if (param?.type === 'Identifier') {
      // function OrderList(props) … props.orders.map(…): "props.orders" holds the value.
      this.usesOf(fn.body, new Map([[`${param.name}.${prop}`, path]]), source, depth);
    }
  }

  private patternUses(p: t.ObjectPattern, at: string[], aliases: Map<string, string[]>, source: Source) {
    for (const prop of p.properties) {
      if (prop.type !== 'ObjectProperty' || prop.key.type !== 'Identifier') continue;
      const path = [...at, prop.key.name];
      this.add(source, path, undefined);
      const target = prop.value.type === 'AssignmentPattern' ? prop.value.left : prop.value;
      if (target.type === 'Identifier') aliases.set(target.name, path);
      if (target.type === 'ObjectPattern') this.patternUses(target, path, aliases, source);
    }
  }

  /** The path in the reply an expression reads, when it starts at a known alias. */
  private pathOf(e: N, aliases: Map<string, string[]>): { path: string[] } | undefined {
    if (e.type === 'Identifier') {
      const p = aliases.get(e.name);
      return p ? { path: p } : undefined;
    }
    if (e.type === 'TSNonNullExpression' || e.type === 'ParenthesizedExpression') return this.pathOf(e.expression, aliases);
    if (isMember(e)) {
      // props.orders, when the props object's prop holds a value.
      if (e.object.type === 'Identifier' && propName(e) && aliases.has(`${e.object.name}.${propName(e)}`)) return { path: aliases.get(`${e.object.name}.${propName(e)}`)! };
      const base = this.pathOf(e.object, aliases);
      if (!base) return undefined;
      const name = propName(e);
      if (name === 'length') return undefined;
      if (name) return { path: [...base.path, name] };
      return e.computed && (e.property.type === 'NumericLiteral' || e.property.type === 'Identifier') ? { path: [...base.path, '[]'] } : undefined;
    }
    // list.slice(0, 3) / list.filter(…) is still the list.
    if (isCall(e) && isMember(e.callee)) {
      const method = propName(e.callee);
      if (method && SAME_LIST.has(method)) return this.pathOf(e.callee.object, aliases);
      if (method === 'find' || method === 'findLast' || method === 'at') {
        const base = this.pathOf(e.callee.object, aliases);
        return base ? { path: [...base.path, '[]'] } : undefined;
      }
    }
    return undefined;
  }

  /** Adds a path (with its kind at the end, when known) to the reply's shape. */
  private add(source: Source, path: string[], kind: Shape['kind']) {
    const full = [...source.at, ...path];
    // React Query results: .data, .isLoading… only .data is the reply.
    if (full[0] === 'data' && source.as !== 'body' && source.as !== 'query') full.shift();
    const key = `${source.method} ${source.match}`;
    const reply = this.replies.get(key) ?? { match: source.match, method: source.method, shape: {} };
    this.replies.set(key, reply);
    let node = reply.shape;
    for (const part of full) {
      if (part === '[]') {
        node.kind = 'array';
        node = node.item ??= {};
      } else {
        if (node.kind !== 'array') node.kind = 'object';
        node.fields ??= {};
        node = node.fields[part] ??= {};
      }
    }
    if (kind && !node.fields && !node.item) node.kind = kind;
  }
}

/** The data shapes of a project's replies, from its files. */
export function readShapes(files: SourceFile[]): ReplyShape[] {
  return new ShapeReader().read(files);
}
