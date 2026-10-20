// GraphQL answers: for a query against a schema, an answer with exactly the fields the query asks for (fragments,
// lists, aliases and __typename included), each with a realistic value (the same heuristics as other contracts: an
// email looks like an email). And a check of a real answer: fields the query asked for that aren't there, or whose
// kind is wrong. Pure.

import {
  getNamedType,
  getNullableType,
  isAbstractType,
  isEnumType,
  isListType,
  isNonNullType,
  isObjectType,
  isScalarType,
  parse,
  type FieldNode,
  type FragmentDefinitionNode,
  type GraphQLNamedType,
  type GraphQLObjectType,
  type GraphQLOutputType,
  type GraphQLSchema,
  type OperationDefinitionNode,
  type SelectionSetNode,
} from 'graphql';
import { exampleOf } from './schema';

/** What a GraphQL call sends: { query, variables, operationName }. */
export interface GraphqlRequest {
  query?: string;
  operationName?: string;
  variables?: Record<string, unknown>;
}

function operationOf(schema: GraphQLSchema, req: GraphqlRequest) {
  const doc = parse(req.query ?? '');
  const ops = doc.definitions.filter((d): d is OperationDefinitionNode => d.kind === 'OperationDefinition');
  const op = (req.operationName ? ops.find((o) => o.name?.value === req.operationName) : undefined) ?? ops[0];
  if (!op) throw new Error('the call has no query');
  const fragments = new Map(doc.definitions.filter((d): d is FragmentDefinitionNode => d.kind === 'FragmentDefinition').map((f) => [f.name.value, f]));
  const root = op.operation === 'mutation' ? schema.getMutationType() : op.operation === 'subscription' ? schema.getSubscriptionType() : schema.getQueryType();
  if (!root) throw new Error(`the schema has no ${op.operation} type`);
  return { op, fragments, root };
}

/** The answer to a query: { data: … } shaped by what it asks for. */
export function graphqlAnswer(schema: GraphQLSchema, req: GraphqlRequest): unknown {
  try {
    const { op, fragments, root } = operationOf(schema, req);
    return { data: selection(schema, root, op.selectionSet, fragments, 0, 0) };
  } catch (e) {
    return { errors: [{ message: e instanceof Error ? e.message : String(e) }] };
  }
}

/** The fields asked for on a type, through fragments ("... on Order" picks the type for abstract types). */
function fieldsOf(type: GraphQLNamedType, set: SelectionSetNode, fragments: Map<string, FragmentDefinitionNode>, out: FieldNode[] = []): FieldNode[] {
  for (const s of set.selections) {
    if (s.kind === 'Field') out.push(s);
    else if (s.kind === 'InlineFragment') {
      if (!s.typeCondition || s.typeCondition.name.value === type.name || !isObjectType(type)) fieldsOf(type, s.selectionSet, fragments, out);
      else if (isObjectType(type) && type.getInterfaces().some((i) => i.name === s.typeCondition!.name.value)) fieldsOf(type, s.selectionSet, fragments, out);
    } else {
      const f = fragments.get(s.name.value);
      if (f && (f.typeCondition.name.value === type.name || (isObjectType(type) && type.getInterfaces().some((i) => i.name === f.typeCondition.name.value)))) fieldsOf(type, f.selectionSet, fragments, out);
    }
  }
  return out;
}

function selection(schema: GraphQLSchema, type: GraphQLObjectType, set: SelectionSetNode, fragments: Map<string, FragmentDefinitionNode>, i: number, depth: number): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fieldsOf(type, set, fragments)) {
    const key = f.alias?.value ?? f.name.value;
    if (f.name.value === '__typename') {
      out[key] = type.name;
      continue;
    }
    const def = type.getFields()[f.name.value];
    if (!def) continue;
    out[key] = value(schema, def.type, f, fragments, f.name.value, i, depth + 1);
  }
  return out;
}

function value(schema: GraphQLSchema, type: GraphQLOutputType, f: FieldNode, fragments: Map<string, FragmentDefinitionNode>, name: string, i: number, depth: number): unknown {
  const t = getNullableType(type) as GraphQLOutputType;
  if (depth > 10) return null;
  if (isListType(t)) {
    const one = name.replace(/ies$/, 'y').replace(/s$/, '');
    return Array.from({ length: 3 }, (_v, k) => value(schema, t.ofType, f, fragments, one, k, depth + 1));
  }
  const named = getNamedType(t);
  if (isEnumType(named)) {
    const values = named.getValues();
    return values.length ? values[i % values.length].value : null;
  }
  if (isScalarType(named)) {
    const kind = { Int: 'integer', Float: 'number', Boolean: 'boolean', ID: 'string', String: 'string' }[named.name];
    const format = /date ?time|timestamp/i.test(named.name) ? 'date-time' : /^date$/i.test(named.name) ? 'date' : /url|uri/i.test(named.name) ? 'uri' : /email/i.test(named.name) ? 'email' : undefined;
    return exampleOf({ type: kind ?? 'string', ...(format ? { format } : {}) }, () => undefined, named.name === 'ID' && !/id$/i.test(name) ? `${name}Id` : name, i);
  }
  if (!f.selectionSet) return null;
  // An interface or union: the first type that can be it.
  const object = isAbstractType(named) ? schema.getPossibleTypes(named)[i % Math.max(1, schema.getPossibleTypes(named).length)] : named;
  return object && isObjectType(object) ? selection(schema, object, f.selectionSet, fragments, i, depth) : null;
}

/** Where a real answer to a query differs from what the schema says it should be. */
export function checkGraphql(schema: GraphQLSchema, req: GraphqlRequest, answer: unknown): string[] {
  const out: string[] = [];
  let parsed;
  try {
    parsed = operationOf(schema, req);
  } catch (e) {
    return [`the query doesn't fit the schema: ${e instanceof Error ? e.message : String(e)}`];
  }
  const data = (answer as { data?: unknown } | null)?.data;
  if (data === undefined || data === null) return (answer as { errors?: unknown })?.errors ? [] : ['the answer has no data'];
  walk(schema, parsed.root, parsed.op.selectionSet, parsed.fragments, data, 'data', out);
  return out;
}

function walk(schema: GraphQLSchema, type: GraphQLObjectType, set: SelectionSetNode, fragments: Map<string, FragmentDefinitionNode>, data: unknown, path: string, out: string[]) {
  if (out.length >= 20 || !data || typeof data !== 'object') return;
  const obj = data as Record<string, unknown>;
  for (const f of fieldsOf(type, set, fragments)) {
    const key = f.alias?.value ?? f.name.value;
    const def = type.getFields()[f.name.value];
    if (!def) continue;
    const at = `${path}.${key}`;
    if (!(key in obj)) {
      out.push(`${at}: missing (the query asks for it)`);
      continue;
    }
    fits(schema, def.type, f, fragments, obj[key], at, out);
  }
}

function fits(schema: GraphQLSchema, type: GraphQLOutputType, f: FieldNode, fragments: Map<string, FragmentDefinitionNode>, v: unknown, at: string, out: string[]) {
  if (v === null) {
    if (isNonNullType(type)) out.push(`${at}: the schema says it's never null, it was null`);
    return;
  }
  const t = getNullableType(type) as GraphQLOutputType;
  if (isListType(t)) {
    if (!Array.isArray(v)) out.push(`${at}: the schema says a list, it was ${typeof v}`);
    else v.slice(0, 20).forEach((x, k) => fits(schema, t.ofType, f, fragments, x, `${at}[${k}]`, out));
    return;
  }
  const named = getNamedType(t);
  if (isScalarType(named)) {
    const want = { Int: 'number', Float: 'number', Boolean: 'boolean', String: 'string' }[named.name];
    if (want && typeof v !== want) out.push(`${at}: the schema says ${named.name}, it was ${typeof v === 'string' ? 'text' : typeof v}`);
    return;
  }
  if (isEnumType(named)) {
    if (!named.getValues().some((x) => x.value === v)) out.push(`${at}: ${JSON.stringify(v)} isn't one of ${named.name}'s values`);
    return;
  }
  if (!f.selectionSet) return;
  const object = isAbstractType(named) ? schema.getPossibleTypes(named).find((p) => p.name === (v as { __typename?: string }).__typename) ?? schema.getPossibleTypes(named)[0] : named;
  if (object && isObjectType(object)) walk(schema, object, f.selectionSet, fragments, v, at, out);
}
