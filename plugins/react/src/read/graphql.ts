// GraphQL in React code (Apollo, urql, graphql-request): the operations the code sends (`gql` / `graphql` documents)
// and the data each one asks for. A query names every field it wants, so its reply's shape is exactly its selection
// (with fragments filled in); where the code types the result, the TypeScript type adds the kinds (lists, numbers,
// unions). Pure: no VS Code APIs.

import type * as t from '@babel/types';
import { forEachChild, parseSource } from './ast';
import type { Shape } from './shapes';

export interface Selection {
  /** The key in the reply (its alias, or its name). */
  key: string;
  /** Fields asked for inside it; undefined for a plain value. */
  fields?: Selection[];
  /** The type named by a fragment or inline fragment (`... on Order`), for __typename. */
  on?: string;
  /** Fragments spread here (filled in later, from any file). */
  spreads?: string[];
}

export interface Operation {
  name: string;
  kind: 'query' | 'mutation' | 'subscription';
  fields: Selection[];
  spreads: string[];
}

export interface GraphqlUse {
  operation: string;
  /** The file, and where a variable holding the result is written (its type gives exact kinds). */
  path: string;
  start?: number;
  /** The variable holds the whole result (`const r = useQuery(…)`): the data is its `data`. */
  member?: 'data';
}

export interface GraphqlRead {
  operations: Map<string, Operation>;
  fragments: Map<string, { on: string; fields: Selection[]; spreads: string[] }>;
  uses: GraphqlUse[];
}

/** Hooks and calls that send a GraphQL document, by package. */
const SENDERS: Record<string, string[]> = {
  '@apollo/client': ['useQuery', 'useLazyQuery', 'useSuspenseQuery', 'useBackgroundQuery', 'useMutation', 'useSubscription'],
  '@apollo/client/react': ['useQuery', 'useLazyQuery', 'useSuspenseQuery', 'useMutation', 'useSubscription'],
  urql: ['useQuery', 'useMutation', 'useSubscription'],
  'graphql-request': ['request', 'rawRequest'],
};

export function readGraphql(files: { path: string; text: string }[]): GraphqlRead {
  const operations = new Map<string, Operation>();
  const fragments = new Map<string, { on: string; fields: Selection[]; spreads: string[] }>();
  const uses: GraphqlUse[] = [];
  // Documents: gql`…`, graphql`…`, graphql(`…`) — kept by the variable that holds them (used from any file).
  const docs = new Map<string, string>();
  const parsedFiles = files.filter((f) => /\bgql\b|graphql/.test(f.text)).map((f) => ({ f, ast: parseSource(f) }));
  for (const { ast } of parsedFiles) {
    if (!ast) continue;
    const visitDocs = (n: t.Node) => {
      if (n.type === 'VariableDeclarator' && n.id.type === 'Identifier') {
        const text = docText(n.init);
        if (text) docs.set(n.id.name, text);
      }
      const text = n.type === 'TaggedTemplateExpression' || n.type === 'CallExpression' ? docText(n) : undefined;
      if (text) {
        for (const d of parseDocument(text)) {
          if (d.type === 'fragment') fragments.set(d.name, { on: d.on, fields: d.fields, spreads: d.spreads });
          else if (d.name) operations.set(d.name, { name: d.name, kind: d.type, fields: d.fields, spreads: d.spreads });
        }
      }
      forEachChild(n as never, visitDocs as never);
    };
    visitDocs(ast.program);
  }
  for (const { f, ast } of parsedFiles) {
    if (!ast) continue;
    const senders = new Set<string>();
    for (const s of ast.program.body) {
      if (s.type !== 'ImportDeclaration' || !SENDERS[s.source.value]) continue;
      for (const spec of s.specifiers) {
        if (spec.type === 'ImportSpecifier' && spec.imported.type === 'Identifier' && SENDERS[s.source.value].includes(spec.imported.name)) senders.add(spec.local.name);
      }
    }
    // The operation a send names: its document variable, or a document written in place.
    const opOf = (n: t.Node | undefined): string | undefined => {
      if (!n) return undefined;
      if (n.type === 'Identifier' && docs.has(n.name)) return parseDocument(docs.get(n.name)!).find((d) => d.type !== 'fragment')?.name;
      const text = docText(n);
      if (text) return parseDocument(text).find((d) => d.type !== 'fragment')?.name;
      // urql: useQuery({ query: DOC })
      if (n.type === 'ObjectExpression') {
        const q = n.properties.find((p): p is t.ObjectProperty => p.type === 'ObjectProperty' && p.key.type === 'Identifier' && p.key.name === 'query');
        return q ? opOf(q.value as t.Node) : undefined;
      }
      return undefined;
    };
    const stack: t.Node[] = [];
    const visitUses = (n: t.Node) => {
      if (n.type === 'CallExpression') {
        const callee = n.callee.type === 'Identifier' ? n.callee.name : n.callee.type === 'MemberExpression' && n.callee.property.type === 'Identifier' ? n.callee.property.name : '';
        const isSender = senders.has(callee) || (n.callee.type === 'MemberExpression' && /^(request|rawRequest|query|mutate)$/.test(callee));
        if (isSender) {
          // request(url, DOC) / client.request(DOC) / client.query({ query: DOC }) / useQuery(DOC)
          const op = n.arguments.map((a) => opOf(a as t.Node)).find(Boolean);
          if (op) uses.push({ operation: op, path: f.path, ...dataHolder(stack, n) });
        }
      }
      stack.push(n);
      forEachChild(n as never, visitUses as never);
      stack.pop();
    };
    visitUses(ast.program);
  }
  return { operations, fragments, uses };
}

/** A GraphQL document's text: gql`…`, graphql`…`, graphql(`…`). */
function docText(n: t.Node | null | undefined): string | undefined {
  if (!n) return undefined;
  if (n.type === 'TaggedTemplateExpression' && n.tag.type === 'Identifier' && /^(gql|graphql)$/.test(n.tag.name)) return n.quasi.quasis.map((q) => q.value.cooked ?? q.value.raw).join(' ');
  if (n.type === 'CallExpression' && n.callee.type === 'Identifier' && /^(gql|graphql)$/.test(n.callee.name)) {
    const a = n.arguments[0];
    if (a?.type === 'TemplateLiteral') return a.quasis.map((q) => q.value.cooked ?? q.value.raw).join(' ');
    if (a?.type === 'StringLiteral') return a.value;
  }
  if (n.type === 'TSAsExpression') return docText(n.expression);
  return undefined;
}

/** Where the result of a send is kept, for its type: `const { data } = …`, `const [{ data }] = …`, `const r = …`. */
function dataHolder(stack: t.Node[], call: t.Node): { start?: number; member?: 'data' } {
  let at: t.Node = call;
  for (let i = stack.length - 1; i >= 0; i--) {
    const n = stack[i];
    if (n.type === 'AwaitExpression' || n.type === 'TSAsExpression') {
      at = n;
      continue;
    }
    if (n.type !== 'VariableDeclarator' || n.init !== at) return {};
    const id = n.id.type === 'ArrayPattern' ? n.id.elements[0] : n.id;
    if (id?.type === 'Identifier') return { start: id.start ?? 0, ...(at.type === 'AwaitExpression' ? {} : { member: 'data' as const }) };
    if (id?.type === 'ObjectPattern') {
      const p = id.properties.find((x): x is t.ObjectProperty => x.type === 'ObjectProperty' && x.key.type === 'Identifier' && x.key.name === 'data');
      const v = p?.value.type === 'AssignmentPattern' ? p.value.left : p?.value;
      return v?.type === 'Identifier' ? { start: v.start ?? 0 } : {};
    }
    return {};
  }
  return {};
}

// ---------------------------------------------------------------------------
// A small GraphQL reader: operations, fragments and selections (arguments, variables and directives are skipped)
// ---------------------------------------------------------------------------

type Definition =
  | { type: 'query' | 'mutation' | 'subscription'; name?: string; fields: Selection[]; spreads: string[] }
  | { type: 'fragment'; name: string; on: string; fields: Selection[]; spreads: string[] };

export function parseDocument(text: string): Definition[] {
  const tokens = text.replace(/#[^\n]*/g, ' ').match(/\.\.\.|"""[\s\S]*?"""|"(?:\\.|[^"\\])*"|[A-Za-z_][\w]*|[{}():@$!=[\],]|-?\d[\d.eE+-]*/g) ?? [];
  let i = 0;
  const peek = () => tokens[i];
  const next = () => tokens[i++];
  /** Skips a balanced (…) group. */
  const skipParens = () => {
    if (peek() !== '(') return;
    let depth = 0;
    do {
      const tk = next();
      if (tk === '(') depth++;
      if (tk === ')') depth--;
    } while (depth > 0 && i < tokens.length);
  };
  const skipDirectives = () => {
    while (peek() === '@') {
      next();
      next();
      skipParens();
    }
  };
  const selection = (): { fields: Selection[]; spreads: string[] } => {
    const fields: Selection[] = [];
    const spreads: string[] = [];
    if (peek() !== '{') return { fields, spreads };
    next();
    while (i < tokens.length && peek() !== '}') {
      const tk = next();
      if (tk === '...') {
        if (peek() === 'on') {
          next();
          const on = next();
          skipDirectives();
          const inner = selection();
          // An inline fragment's fields belong to the same object.
          fields.push(...inner.fields.map((f) => f));
          spreads.push(...inner.spreads);
          if (on) fields.push({ key: '__on', on });
        } else if (peek() === '@' || peek() === '{') {
          skipDirectives();
          const inner = selection();
          fields.push(...inner.fields);
          spreads.push(...inner.spreads);
        } else {
          spreads.push(next());
          skipDirectives();
        }
        continue;
      }
      if (!/^[A-Za-z_]/.test(tk)) continue;
      const key = tk;
      if (peek() === ':') {
        next();
        next();
      }
      skipParens();
      skipDirectives();
      if (peek() === '{') {
        const inner = selection();
        fields.push({ key, fields: inner.fields, ...(inner.spreads.length ? { spreads: inner.spreads } : {}) });
      } else fields.push({ key });
    }
    next();
    return { fields, spreads };
  };
  const defs: Definition[] = [];
  while (i < tokens.length) {
    const tk = peek();
    if (tk === '{') {
      defs.push({ type: 'query', ...selection() });
      continue;
    }
    next();
    if (tk === 'query' || tk === 'mutation' || tk === 'subscription') {
      const name = peek() && /^[A-Za-z_]/.test(peek()) ? next() : undefined;
      skipParens();
      skipDirectives();
      defs.push({ type: tk, ...(name ? { name } : {}), ...selection() });
    } else if (tk === 'fragment') {
      const name = next();
      next(); // on
      const on = next();
      skipDirectives();
      defs.push({ type: 'fragment', name, on, ...selection() });
    }
  }
  return defs;
}

/**
 * The shape of an operation's data: every field it asks for (fragments filled in), with __typename on each object
 * (Apollo's cache needs it). Lists and kinds are guessed from names here; a TypeScript type, merged in, makes them
 * exact.
 */
export function operationShape(op: Operation, fragments: GraphqlRead['fragments']): Shape {
  const build = (fields: Selection[], spreads: string[], typename: string | undefined, depth: number): Shape => {
    const out: Record<string, Shape> = {};
    let on = typename;
    const add = (list: Selection[], more: string[], seen: Set<string>) => {
      for (const f of list) {
        if (f.key === '__on') {
          on = f.on ?? on;
          continue;
        }
        if (f.key === '__typename') continue;
        if (!f.fields) {
          out[f.key] ??= {};
          continue;
        }
        const plural = /(s|List|edges|nodes|items)$/.test(f.key) && !/(ss|us|status|address|news|settings|stats|details)$/i.test(f.key);
        const inner = depth < 8 ? build(f.fields, f.spreads ?? [], typeNameFor(f.key), depth + 1) : { kind: 'object' as const, fields: {} };
        out[f.key] = plural ? { kind: 'array', item: inner } : inner;
      }
      for (const name of more) {
        const fr = fragments.get(name);
        if (!fr || seen.has(name)) continue;
        seen.add(name);
        on = fr.on;
        add(fr.fields, fr.spreads, seen);
      }
    };
    add(fields, spreads, new Set());
    if (depth > 0) out.__typename = { kind: 'string', values: [on ?? 'Item'] };
    return { kind: 'object', fields: out };
  };
  return build(op.fields, op.spreads, undefined, 0);
}

/** `orders` → "Order", `customer` → "Customer": a type name for an object with no fragment to name it. */
function typeNameFor(key: string): string {
  const one = key.replace(/(ies)$/, 'y').replace(/(edges|nodes)$/, 'node').replace(/s$/, '');
  return one[0].toUpperCase() + one.slice(1);
}

/**
 * The selection's shape with the TypeScript type's kinds: lists, numbers, the values a field can have. Only the
 * fields the operation asks for are kept (that's what a GraphQL reply has).
 */
export function fitToType(typed: Shape | undefined, sel: Shape): Shape {
  if (!typed) return sel;
  if (typed.kind === 'array' || typed.item) {
    const item = sel.item ?? (sel.fields ? sel : {});
    return { kind: 'array', item: fitToType(typed.item, item) };
  }
  const one = sel.kind === 'array' || sel.item ? (sel.item ?? {}) : sel;
  if (one.fields) {
    return { kind: 'object', fields: Object.fromEntries(Object.entries(one.fields).map(([k, v]) => [k, fitToType(typed.fields?.[k], v)])) };
  }
  return typed;
}
