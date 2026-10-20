// Shapes of data, as every contract format is turned into: a subset of JSON Schema (what OpenAPI uses too). From a
// shape: a realistic example (an email looks like an email, a list has a few items that differ, an enum takes one of
// its values), and a check of a real answer against it ("total: the contract says number, it was text"). Pure.

export interface Schema {
  type?: string | string[];
  properties?: Record<string, Schema>;
  required?: string[];
  items?: Schema;
  additionalProperties?: boolean | Schema;
  enum?: unknown[];
  const?: unknown;
  format?: string;
  nullable?: boolean;
  oneOf?: Schema[];
  anyOf?: Schema[];
  allOf?: Schema[];
  /** A reference to a named shape (#/components/schemas/Order, #/definitions/Order, or #/types/Order). */
  $ref?: string;
  example?: unknown;
  examples?: unknown[];
  default?: unknown;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  title?: string;
  description?: string;
}

/** Finds the shape a $ref names (undefined: unknown, or outside the contract). */
export type Resolve = (ref: string) => Schema | undefined;

const PEOPLE = ['Ada Lovelace', 'Grace Hopper', 'Alan Turing', 'Katherine Johnson'];

/** The shape a reference points to (following references in references), merged with allOf's parts. */
export function deref(s: Schema | undefined, resolve: Resolve, seen = new Set<string>()): Schema | undefined {
  if (!s) return undefined;
  if (s.$ref) {
    if (seen.has(s.$ref)) return {};
    const target = resolve(s.$ref);
    const found = target ? deref(target, resolve, new Set([...seen, s.$ref])) : {};
    // "Order | null": a reference that can also be null.
    return s.nullable && found ? { ...found, nullable: true } : found;
  }
  if (s.allOf?.length) {
    const parts = s.allOf.map((p) => deref(p, resolve, seen) ?? {});
    const merged: Schema = { ...s, allOf: undefined, type: s.type ?? parts.find((p) => p.type)?.type ?? 'object', properties: { ...Object.assign({}, ...parts.map((p) => p.properties ?? {})), ...s.properties }, required: [...new Set([...(s.required ?? []), ...parts.flatMap((p) => p.required ?? [])])] };
    delete merged.allOf;
    return merged;
  }
  return s;
}

function typeOf(s: Schema): string | undefined {
  if (Array.isArray(s.type)) return s.type.find((t) => t !== 'null');
  return s.type ?? (s.properties ? 'object' : s.items ? 'array' : undefined);
}

/** A realistic example of a shape; `name` is the field it's for (it helps: an email, a price, a person's name). */
export function exampleOf(schema: Schema | undefined, resolve: Resolve, name = '', i = 0, depth = 0): unknown {
  const s = deref(schema, resolve);
  if (!s || depth > 8) return null;
  if (s.example !== undefined && i === 0) return s.example;
  if (s.examples?.length) return s.examples[i % s.examples.length];
  if (s.const !== undefined) return s.const;
  if (s.enum?.length) return s.enum[i % s.enum.length];
  if (s.default !== undefined && i === 0) return s.default;
  const pick = s.oneOf?.[0] ?? s.anyOf?.find((x) => deref(x, resolve)?.type !== 'null');
  if (pick && !s.properties) return exampleOf(pick, resolve, name, i, depth);
  const type = typeOf(s);
  if (type === 'object' || s.properties) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(s.properties ?? {})) out[k] = exampleOf(v, resolve, k, i, depth + 1);
    if (!s.properties && typeof s.additionalProperties === 'object') for (const k of ['a', 'b']) out[k] = exampleOf(s.additionalProperties, resolve, k, i, depth + 1);
    return out;
  }
  if (type === 'array') {
    const one = name.replace(/ies$/, 'y').replace(/s$/, '');
    return Array.from({ length: Math.max(s.minItems ?? 0, 3) }, (_v, k) => exampleOf(s.items, resolve, one, k, depth + 1));
  }
  if (type === 'integer' || type === 'number') return numberFor(name, s, i, type === 'integer');
  if (type === 'boolean') return !/(disabled|deleted|archived|error|locked|blocked|failed|expired|pending)/i.test(name);
  if (type === 'null') return null;
  return stringFor(name, s.format, i);
}

function numberFor(name: string, s: Schema, i: number, integer: boolean): number {
  const n = name.toLowerCase();
  // createdAt, updatedTime, timestamp: a moment, in milliseconds since 1970.
  if (/(at|time|timestamp|date)$/.test(n) && !/(format|rate|seat|stat|flat|lat)$/.test(n)) return Date.UTC(2026, 9, 20 - i, 9, 30);
  let v = /price|amount|total|cost|balance|subtotal|tax/.test(n) ? 129.9 : /count|quantity|qty|size|length/.test(n) ? 3 : /age/.test(n) ? 34 : /rating|score|stars/.test(n) ? 4 : /id$/.test(n) ? 1042 : /(page|index|position|rank)$/.test(n) ? 1 : /percent|progress/.test(n) ? 64 : 42;
  v = v * (1 + 0.37 * i);
  if (s.minimum !== undefined) v = Math.max(v, s.minimum);
  if (s.maximum !== undefined) v = Math.min(v, s.maximum);
  return integer || /id$|count|quantity|age|page|index/.test(n) ? Math.round(v) : Math.round(v * 100) / 100;
}

function stringFor(name: string, format: string | undefined, i: number): string {
  const n = name.toLowerCase();
  const day = new Date(Date.UTC(2026, 9, 20 - i, 9, 30)).toISOString();
  if (format === 'date-time' || /(at|time|timestamp)$/.test(n)) return day;
  if (format === 'date' || /date$|birthday/.test(n)) return day.slice(0, 10);
  if (format === 'email' || /email/.test(n)) return ['ada@example.com', 'grace@example.com', 'alan@example.com'][i % 3];
  if (format === 'uuid' || n === 'uuid') return `3f2a9c1e-5b7d-4e2a-9f1c-8d6e4b2a7c9${i}`;
  if (format === 'uri' || format === 'url' || /url|link|href|website/.test(n)) return `https://example.com/${n || 'page'}/${i + 1}`;
  if (/avatar|image|photo|picture|logo|thumbnail/.test(n)) return `https://picsum.photos/seed/${n}${i}/200`;
  if (n === 'id' || /id$/.test(n)) return `${n.replace(/id$/, '') || 'id'}-${1042 + i}`;
  if (/^(name|fullname|displayname|username|author|owner|customer)$/.test(n)) return PEOPLE[i % PEOPLE.length];
  if (/phone/.test(n)) return `+1 555 01${String(i).padStart(2, '0')}`;
  if (/status|state/.test(n)) return ['active', 'pending', 'done'][i % 3];
  if (/(title|label|heading|subject)$/.test(n)) return `${n.replace(/(title|label|heading|subject)$/, '').replace(/^./, (c) => c.toUpperCase()) || 'Item'} ${i + 1}`.trim();
  if (/desc|summary|text|body|content|message|note|comment/.test(n)) return 'A short description, long enough to wrap onto a second line in narrow cards.';
  if (/currency/.test(n)) return 'EUR';
  if (/country/.test(n)) return 'DE';
  if (/color|colour/.test(n)) return '#3b5bdb';
  return `${name || 'text'} ${i + 1}`;
}

/** Where a real answer differs from its shape (the first differences, path by path). */
export function check(schema: Schema | undefined, value: unknown, resolve: Resolve, path = '', out: string[] = []): string[] {
  const s = deref(schema, resolve);
  if (!s || out.length >= 20) return out;
  const at = path || 'the answer';
  if (value === null) {
    if (!s.nullable && !(Array.isArray(s.type) && s.type.includes('null')) && s.type !== 'null' && typeOf(s)) out.push(`${at}: the contract says ${typeOf(s)}, it was null`);
    return out;
  }
  const options = s.oneOf ?? s.anyOf;
  if (options?.length) {
    // Fits one of them: fine; none: the closest one's differences.
    const tries = options.map((o) => check(o, value, resolve, path, []));
    if (!tries.some((t) => !t.length)) out.push(...tries.sort((a, b) => a.length - b.length)[0].slice(0, 5));
    return out;
  }
  if (s.enum && !s.enum.some((e) => e === value)) out.push(`${at}: ${JSON.stringify(value)} isn't one of ${s.enum.map((e) => JSON.stringify(e)).join(', ')}`);
  const type = typeOf(s);
  const got = Array.isArray(value) ? 'array' : typeof value === 'number' ? (Number.isInteger(value) ? 'integer' : 'number') : typeof value;
  const fits = !type || type === got || (type === 'number' && got === 'integer');
  if (!fits) {
    out.push(`${at}: the contract says ${type}, it was ${got === 'string' ? 'text' : got === 'integer' ? 'number' : got}`);
    return out;
  }
  if (type === 'object' || (s.properties && got === 'object')) {
    const obj = value as Record<string, unknown>;
    for (const r of s.required ?? []) if (!(r in obj)) out.push(`${path ? `${path}.` : ''}${r}: missing (the contract requires it)`);
    for (const [k, v] of Object.entries(obj)) {
      const p = s.properties?.[k];
      if (p) check(p, v, resolve, path ? `${path}.${k}` : k, out);
      else if (s.additionalProperties === false) out.push(`${path ? `${path}.` : ''}${k}: not in the contract`);
      else if (typeof s.additionalProperties === 'object') check(s.additionalProperties, v, resolve, path ? `${path}.${k}` : k, out);
    }
  }
  if (type === 'array' && Array.isArray(value)) value.slice(0, 20).forEach((v, k) => check(s.items, v, resolve, `${path}[${k}]`, out));
  return out;
}

/** A shape guessed from an example (for contracts that only give examples: Postman, HAR, JSON files). */
export function shapeOfExample(value: unknown): Schema {
  if (value === null) return { type: 'null' };
  if (Array.isArray(value)) return { type: 'array', items: value.length ? shapeOfExample(value[0]) : {} };
  if (typeof value === 'object') return { type: 'object', properties: Object.fromEntries(Object.entries(value as object).map(([k, v]) => [k, shapeOfExample(v)])) };
  if (typeof value === 'number') return { type: Number.isInteger(value) ? 'integer' : 'number' };
  if (typeof value === 'boolean') return { type: 'boolean' };
  if (typeof value === 'string' && /^\d{4}-\d\d-\d\dT/.test(value)) return { type: 'string', format: 'date-time' };
  return { type: 'string' };
}
