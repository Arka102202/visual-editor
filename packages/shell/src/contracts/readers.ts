// Contract formats, each read into the same form: operations (a method and an address, with the shapes and examples
// of what's sent and answered) and named types (shapes on their own). OpenAPI 3 and Swagger 2 (YAML or JSON), Postman
// collections, HAR files (recorded traffic), JSON Schema, plain JSON examples, TypeScript types and Zod schemas (read
// from the code) and GraphQL schemas. Pure: text in, contract out.

import { parse as parseYaml } from 'yaml';
import { parse as parseCode } from '@babel/parser';
import type * as t from '@babel/types';
import { buildSchema, type GraphQLSchema } from 'graphql';
import { patternFor } from '../proxy/fakePaths';
import { shapeOfExample, type Resolve, type Schema } from './schema';

export type ContractKind = 'openapi' | 'swagger' | 'postman' | 'har' | 'json-schema' | 'json-example' | 'typescript' | 'zod' | 'graphql';

export interface Operation {
  /** "GET /api/orders/:id". */
  id: string;
  method: string;
  /** The address pattern, as fakes use it (/api/orders/:id). */
  path: string;
  summary?: string;
  request?: Schema;
  /** What it answers, by status ("200", "404", "default"), with a shape and/or an example. */
  responses: { status: string; schema?: Schema; example?: unknown }[];
}

export interface Contract {
  /** Where it was read from: a project file, or an address. */
  source: string;
  kind: ContractKind;
  title?: string;
  operations: Operation[];
  /** Named shapes (referred to as #/types/Name). */
  types: Record<string, Schema>;
  /** Why it couldn't be read. */
  error?: string;
  /** Finds what a $ref inside this contract points to. */
  resolve: Resolve;
  /** A GraphQL schema: answers are made for each query (see graphql.ts). */
  graphql?: GraphQLSchema;
}

const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];

function contract(source: string, kind: ContractKind, operations: Operation[], types: Record<string, Schema>, refs: (ref: string) => Schema | undefined = () => undefined, title?: string): Contract {
  return {
    source,
    kind,
    ...(title ? { title } : {}),
    operations,
    types,
    resolve: (ref) => {
      const m = /^#\/types\/(.+)$/.exec(ref);
      return m ? types[decodeURIComponent(m[1])] : refs(ref);
    },
  };
}

/** Reads a file whose kind is known from its name or content; undefined when it isn't a contract. */
export function readContract(source: string, text: string): Contract | undefined {
  try {
    if (/\.(graphql|gql)$/i.test(source)) return /\b(type|schema)\s+\w*\s*\{|\btype\s+Query\b/.test(text) ? readGraphql(source, text) : undefined;
    if (/\.(ts|tsx|mts|cts)$/i.test(source)) {
      const zod = /from\s+['"]zod['"]/.test(text) ? readZod(source, text) : undefined;
      const ts = readTypeScript(source, text);
      if (zod && Object.keys(zod.types).length) return Object.keys(ts.types).length ? { ...zod, types: { ...ts.types, ...zod.types }, resolve: merged(ts, zod) } : zod;
      return Object.keys(ts.types).length ? ts : undefined;
    }
    if (/\.har$/i.test(source)) return readHar(source, JSON.parse(text));
    const data = /\.(ya?ml)$/i.test(source) ? parseYaml(text) : JSON.parse(text);
    if (!data || typeof data !== 'object') return undefined;
    if (typeof data.openapi === 'string' || typeof data.swagger === 'string') return readOpenApi(source, data);
    if (data.info?._postman_id || (typeof data.info?.schema === 'string' && /postman/.test(data.info.schema))) return readPostman(source, data);
    if (data.log?.entries) return readHar(source, data);
    if (/\.schema\.json$/i.test(source) || typeof data.$schema === 'string') return readJsonSchema(source, data);
    return undefined;
  } catch (e) {
    return { ...contract(source, 'json-example', [], {}), error: e instanceof Error ? e.message : String(e) };
  }
}

function merged(a: Contract, b: Contract): Resolve {
  return (ref) => b.resolve(ref) ?? a.resolve(ref);
}

/** OpenAPI 3 and Swagger 2. */
export function readOpenApi(source: string, doc: Record<string, any>): Contract {
  const swagger = typeof doc.swagger === 'string';
  // The part of the address every path sits under (Swagger's basePath; OpenAPI's first server's path).
  let base = '';
  if (swagger) base = doc.basePath ?? '';
  else if (Array.isArray(doc.servers) && doc.servers[0]?.url) {
    try {
      base = new URL(doc.servers[0].url, 'http://x').pathname;
    } catch {
      base = '';
    }
  }
  base = base.replace(/\/$/, '');
  const operations: Operation[] = [];
  for (const [rawPath, item] of Object.entries<Record<string, any>>(doc.paths ?? {})) {
    for (const method of METHODS) {
      const op = item?.[method];
      if (!op) continue;
      const path = `${base}${rawPath}`.replace(/\{(\w+)\}/g, ':$1');
      const responses: Operation['responses'] = [];
      for (const [status, r] of Object.entries<Record<string, any>>(op.responses ?? {})) {
        const answer = r?.$ref ? resolvePointer(doc, r.$ref) : r;
        if (swagger) {
          responses.push({ status, ...(answer?.schema ? { schema: answer.schema } : {}), ...(answer?.examples?.['application/json'] !== undefined ? { example: answer.examples['application/json'] } : {}) });
        } else {
          const content = answer?.content ?? {};
          const type = Object.keys(content).find((k) => /json/.test(k)) ?? Object.keys(content)[0];
          const media = type ? content[type] : undefined;
          const example = media?.example ?? (media?.examples ? (Object.values<any>(media.examples)[0]?.value ?? undefined) : undefined);
          responses.push({ status, ...(media?.schema ? { schema: media.schema } : {}), ...(example !== undefined ? { example } : {}) });
        }
      }
      const body = swagger ? (op.parameters ?? []).find((p: any) => p.in === 'body')?.schema : Object.values<any>(op.requestBody?.content ?? {})[0]?.schema;
      operations.push({ id: `${method.toUpperCase()} ${path}`, method: method.toUpperCase(), path, ...(op.summary ? { summary: op.summary } : {}), ...(body ? { request: body } : {}), responses });
    }
  }
  const named = swagger ? (doc.definitions ?? {}) : (doc.components?.schemas ?? {});
  return contract(source, swagger ? 'swagger' : 'openapi', operations, { ...named }, (ref) => resolvePointer(doc, ref), doc.info?.title);
}

/** A "#/a/b/c" pointer inside a document. */
function resolvePointer(doc: unknown, ref: string): any {
  if (!ref.startsWith('#/')) return undefined;
  let at: any = doc;
  for (const part of ref.slice(2).split('/')) at = at?.[part.replace(/~1/g, '/').replace(/~0/g, '~')];
  return at;
}

/** Postman collections: each request, and its saved examples as answers. */
export function readPostman(source: string, data: Record<string, any>): Contract {
  const operations: Operation[] = [];
  const walk = (items: any[]) => {
    for (const item of items ?? []) {
      if (Array.isArray(item.item)) walk(item.item);
      const req = item.request;
      if (!req) continue;
      const raw = typeof req.url === 'string' ? req.url : (req.url?.raw ?? `/${(req.url?.path ?? []).join('/')}`);
      const path = patternFor(addressPath(raw).replace(/\{\{(\w+)\}\}/g, ':$1'));
      const method = String(req.method ?? 'GET').toUpperCase();
      const responses = (item.response ?? []).map((r: any) => {
        const example = parseMaybe(r.body);
        return { status: String(r.code ?? 200), ...(example !== undefined ? { example, schema: shapeOfExample(example) } : {}) };
      });
      operations.push({ id: `${method} ${path}`, method, path, ...(item.name ? { summary: item.name } : {}), responses });
    }
  };
  walk(data.item);
  return contract(source, 'postman', dedupe(operations), {}, undefined, data.info?.name);
}

/** HAR files (traffic recorded by a browser): each call becomes an operation with what was answered. */
export function readHar(source: string, data: Record<string, any>): Contract {
  const operations: Operation[] = [];
  for (const e of data.log?.entries ?? []) {
    const type = String(e.response?.content?.mimeType ?? '');
    if (!/json/.test(type)) continue;
    const method = String(e.request?.method ?? 'GET').toUpperCase();
    const path = patternFor(addressPath(String(e.request?.url ?? '/')));
    const example = parseMaybe(e.response?.content?.text);
    operations.push({ id: `${method} ${path}`, method, path, responses: [{ status: String(e.response?.status ?? 200), ...(example !== undefined ? { example, schema: shapeOfExample(example) } : {}) }] });
  }
  return contract(source, 'har', dedupe(operations), {});
}

/** A JSON Schema file: one named shape (and its own definitions). */
export function readJsonSchema(source: string, data: Record<string, any>): Contract {
  const name = data.title ?? baseName(source).replace(/\.schema$/, '');
  const defs = { ...(data.definitions ?? {}), ...(data.$defs ?? {}) };
  return contract(source, 'json-schema', [], { [name]: data, ...defs }, (ref) => resolvePointer(data, ref) ?? defs[ref.split('/').pop() ?? '']);
}

/** A plain JSON example: its own shape, named after the file. */
export function readJsonExample(source: string, data: unknown): Contract {
  const name = baseName(source);
  return contract(source, 'json-example', [], { [name]: { ...shapeOfExample(data), example: data } });
}

// ---- TypeScript types ----

/** Interfaces and type aliases in a file, as shapes (a reference to another type: #/types/Name). */
export function readTypeScript(source: string, text: string): Contract {
  const types: Record<string, Schema> = {};
  const ast = parseCode(text, { sourceType: 'module', plugins: ['typescript', 'jsx', 'decorators-legacy'], errorRecovery: true });
  for (const st of ast.program.body) {
    const d: t.Node = st.type === 'ExportNamedDeclaration' && st.declaration ? st.declaration : st;
    if (d.type === 'TSInterfaceDeclaration') {
      const own = members(d.body.body);
      const parents = (d.extends ?? []).map((h) => (h.expression.type === 'Identifier' ? { $ref: `#/types/${h.expression.name}` } : {}));
      types[d.id.name] = parents.length ? { allOf: [...parents, own] } : own;
    } else if (d.type === 'TSTypeAliasDeclaration') types[d.id.name] = tsType(d.typeAnnotation);
    else if (d.type === 'TSEnumDeclaration') {
      types[d.id.name] = { enum: d.members.map((m) => (m.initializer && (m.initializer.type === 'StringLiteral' || m.initializer.type === 'NumericLiteral') ? m.initializer.value : m.id.type === 'Identifier' ? m.id.name : m.id.value)) };
    }
  }
  return contract(source, 'typescript', [], types);
}

function members(list: t.TSTypeElement[]): Schema {
  const properties: Record<string, Schema> = {};
  const required: string[] = [];
  for (const m of list) {
    if (m.type !== 'TSPropertySignature' || !m.typeAnnotation) continue;
    const key = m.key.type === 'Identifier' ? m.key.name : m.key.type === 'StringLiteral' ? m.key.value : undefined;
    if (!key) continue;
    properties[key] = tsType(m.typeAnnotation.typeAnnotation);
    if (!m.optional) required.push(key);
  }
  return { type: 'object', properties, ...(required.length ? { required } : {}) };
}

function tsType(n: t.TSType): Schema {
  switch (n.type) {
    case 'TSStringKeyword':
      return { type: 'string' };
    case 'TSNumberKeyword':
      return { type: 'number' };
    case 'TSBooleanKeyword':
      return { type: 'boolean' };
    case 'TSNullKeyword':
      return { type: 'null' };
    case 'TSArrayType':
      return { type: 'array', items: tsType(n.elementType) };
    case 'TSTypeLiteral':
      return members(n.members);
    case 'TSParenthesizedType':
      return tsType(n.typeAnnotation);
    case 'TSLiteralType':
      return n.literal.type === 'StringLiteral' || n.literal.type === 'NumericLiteral' || n.literal.type === 'BooleanLiteral' ? { const: n.literal.value } : {};
    case 'TSUnionType': {
      const parts = n.types.filter((x) => x.type !== 'TSUndefinedKeyword');
      const nullable = parts.some((x) => x.type === 'TSNullKeyword');
      const rest = parts.filter((x) => x.type !== 'TSNullKeyword');
      // 'a' | 'b': an enum.
      if (rest.length && rest.every((x) => x.type === 'TSLiteralType' && (x.literal.type === 'StringLiteral' || x.literal.type === 'NumericLiteral'))) {
        return { enum: rest.map((x) => ((x as t.TSLiteralType).literal as t.StringLiteral).value), ...(nullable ? { nullable: true } : {}) };
      }
      const shapes = rest.map(tsType);
      return shapes.length === 1 ? { ...shapes[0], ...(nullable ? { nullable: true } : {}) } : { anyOf: shapes, ...(nullable ? { nullable: true } : {}) };
    }
    case 'TSTypeReference': {
      const name = n.typeName.type === 'Identifier' ? n.typeName.name : '';
      const args = n.typeParameters?.params ?? [];
      if (name === 'Array' || name === 'ReadonlyArray') return { type: 'array', items: args[0] ? tsType(args[0]) : {} };
      if (name === 'Date') return { type: 'string', format: 'date-time' };
      if (name === 'Record') return { type: 'object', additionalProperties: args[1] ? tsType(args[1]) : {} };
      if (name === 'Partial' || name === 'Readonly' || name === 'Required') return args[0] ? tsType(args[0]) : {};
      return name ? { $ref: `#/types/${name}` } : {};
    }
    default:
      return {};
  }
}

// ---- Zod schemas ----

/** `const Order = z.object({…})` in a file, as shapes. */
export function readZod(source: string, text: string): Contract {
  const types: Record<string, Schema> = {};
  const ast = parseCode(text, { sourceType: 'module', plugins: ['typescript', 'jsx'], errorRecovery: true });
  for (const st of ast.program.body) {
    const d: t.Node = st.type === 'ExportNamedDeclaration' && st.declaration ? st.declaration : st;
    if (d.type !== 'VariableDeclaration') continue;
    for (const v of d.declarations) {
      if (v.id.type === 'Identifier' && v.init && /\bz\./.test(text.slice(v.init.start ?? 0, v.init.end ?? 0))) {
        const shape = zodShape(v.init);
        if (shape) types[v.id.name.replace(/Schema$/, '') || v.id.name] = shape;
      }
    }
  }
  return contract(source, 'zod', [], types);
}

/** A Zod expression (z.object({...}).optional() and the like) as a shape; undefined when it isn't one. */
function zodShape(e: t.Node): Schema | undefined {
  if (e.type === 'Identifier') return { $ref: `#/types/${e.name.replace(/Schema$/, '') || e.name}` };
  if (e.type !== 'CallExpression' || e.callee.type !== 'MemberExpression' || e.callee.property.type !== 'Identifier') return undefined;
  const method = e.callee.property.name;
  const args = e.arguments as t.Node[];
  const inner = e.callee.object;
  // z.<kind>(…)
  if (inner.type === 'Identifier' && inner.name === 'z') {
    switch (method) {
      case 'string':
        return { type: 'string' };
      case 'number':
        return { type: 'number' };
      case 'bigint':
        return { type: 'integer' };
      case 'boolean':
        return { type: 'boolean' };
      case 'date':
        return { type: 'string', format: 'date-time' };
      case 'null':
        return { type: 'null' };
      case 'literal':
        return args[0] && 'value' in args[0] ? { const: (args[0] as t.StringLiteral).value } : {};
      case 'enum':
        return args[0]?.type === 'ArrayExpression' ? { enum: args[0].elements.map((x) => (x && 'value' in x ? (x as t.StringLiteral).value : null)).filter((x) => x !== null) } : {};
      case 'array':
        return { type: 'array', items: (args[0] && zodShape(args[0])) ?? {} };
      case 'record':
        return { type: 'object', additionalProperties: (args[args.length - 1] && zodShape(args[args.length - 1])) ?? {} };
      case 'union':
        return args[0]?.type === 'ArrayExpression' ? { anyOf: args[0].elements.map((x) => (x ? (zodShape(x) ?? {}) : {})) } : {};
      case 'object': {
        const properties: Record<string, Schema> = {};
        const required: string[] = [];
        if (args[0]?.type === 'ObjectExpression') {
          for (const p of args[0].properties) {
            if (p.type !== 'ObjectProperty') continue;
            const key = p.key.type === 'Identifier' ? p.key.name : p.key.type === 'StringLiteral' ? p.key.value : undefined;
            if (!key) continue;
            const shape = zodShape(p.value) ?? {};
            properties[key] = shape;
            if (!optional(p.value)) required.push(key);
          }
        }
        return { type: 'object', properties, ...(required.length ? { required } : {}) };
      }
      default:
        return {};
    }
  }
  // A method on a schema: .optional(), .nullable(), .email(), .int(), .array()…
  const base = zodShape(inner);
  if (!base) return undefined;
  if (method === 'nullable') return { ...base, nullable: true };
  if (method === 'email') return { ...base, format: 'email' };
  if (method === 'url') return { ...base, format: 'uri' };
  if (method === 'uuid') return { ...base, format: 'uuid' };
  if (method === 'datetime') return { ...base, format: 'date-time' };
  if (method === 'int') return { ...base, type: 'integer' };
  if (method === 'array') return { type: 'array', items: base };
  if (method === 'min' && base.type === 'array' && args[0]?.type === 'NumericLiteral') return { ...base, minItems: args[0].value };
  if (method === 'default' && args[0] && 'value' in args[0]) return { ...base, default: (args[0] as t.StringLiteral).value };
  return base;
}

function optional(e: t.Node): boolean {
  return e.type === 'CallExpression' && e.callee.type === 'MemberExpression' && e.callee.property.type === 'Identifier' && (e.callee.property.name === 'optional' || e.callee.property.name === 'default' || ((e.callee.property.name === 'nullable' || e.callee.property.name === 'describe') && optional(e.callee.object)));
}

// ---- GraphQL ----

/** A GraphQL schema (SDL): every query and mutation is answered to fit what it asks for (graphql.ts). */
export function readGraphql(source: string, text: string): Contract {
  const schema = buildSchema(text, { assumeValidSDL: true });
  const operations: Operation[] = [{ id: 'POST /graphql', method: 'POST', path: '/graphql', summary: 'GraphQL: each query answered to fit what it asks for', responses: [{ status: '200' }] }];
  return { ...contract(source, 'graphql', operations, {}), graphql: schema };
}

// ---- Bits ----

/** The path of an address ({{baseUrl}}/api/x and http://host/api/x alike). */
function addressPath(raw: string): string {
  const noVars = raw.replace(/^\{\{[^}]+\}\}/, '');
  try {
    return new URL(noVars, 'http://x').pathname;
  } catch {
    return noVars.split('?')[0];
  }
}

function parseMaybe(text: unknown): unknown {
  if (typeof text !== 'string') return text;
  try {
    return JSON.parse(text);
  } catch {
    return text || undefined;
  }
}

function baseName(path: string): string {
  return (path.split('/').pop() ?? path).replace(/\.(json|ya?ml)$/i, '');
}

/** One operation per method and address (their answers together). */
function dedupe(list: Operation[]): Operation[] {
  const byId = new Map<string, Operation>();
  for (const op of list) {
    const had = byId.get(op.id);
    if (had) had.responses.push(...op.responses.filter((r) => !had.responses.some((x) => x.status === r.status)));
    else byId.set(op.id, op);
  }
  return [...byId.values()];
}
