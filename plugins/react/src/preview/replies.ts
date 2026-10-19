// Example replies from data shapes: what the preview answers in the "normal" situation, so components show
// real-looking data without a backend (and without logging in). Values are chosen by each field's name and kind;
// lists get three items that differ a little, so lists look like lists.
// Pure, so it can be tested.

import type { ReplyShape, Shape } from '../read/shapes';
import { sample } from './harness';

/** The rule the preview page understands: requests whose address (or React Query key) contains `match` get `reply`. */
export interface ReplyRule {
  match: string;
  reply: unknown;
  /** A GraphQL operation's name: only requests sending it get this reply. */
  operation?: string;
}

const LIST_LENGTH = 3;
/** Field names that are almost always numbers. */
const NUMBERISH = /^(total|price|amount|cost|count|qty|quantity|size|width|height|x|y|score|rating|age|index|position|rank|duration|progress|percent|balance|views|likes|visits|number|num|no|revenue|sales|income|spend|budget|subtotal|tax|discount|stock)$/i;
/** Fields whose values are a few fixed words (a status, a role): never numbered. */
const FIXED_WORDS = /(status|state|type|kind|role|category|level|priority|stage|currency|country|lang|locale|unit|method)$/i;

/** People's names, for objects that are people (they have an email or a role). */
const PEOPLE = ['Ada Lovelace', 'Grace Hopper', 'Alan Turing', 'Katherine Johnson', 'Linus Torvalds'];
const PERSONISH = /^(user|users|customer|owner|author|member|person|people|profile|account|me|staff|admin|assignee|creator|sender|recipient|contact|employee|player|student|patient)$/i;
const ISO_DATE = /^\d{4}-\d\d-\d\dT/;
/** Names that say nothing about what a thing is. */
const GENERIC = ['item', 'data', 'result', 'response', 'root', 'entry', 'row', 'node'];
/** Fields that count things. */
const COUNTISH = /^(total|count|totalCount|totalItems|size|length)$/i;

/** Fields a page of results has besides its list and its count. */
const PAGING = /^(page|pages|pageSize|perPage|limit|offset|cursor|nextCursor|prevCursor|previousCursor|next|previous|prev|hasMore|hasNext|hasPrevious|totalPages|pageCount|lastPage|currentPage)$/i;

/** A page of results: one list, a count, and paging fields only ({ items, total, nextCursor }). */
function isPage(shape: Shape): boolean {
  const entries = Object.entries(shape.fields ?? {});
  const lists = entries.filter(([, f]) => f.kind === 'array' || f.item);
  return lists.length === 1 && entries.every(([k, f]) => f === lists[0][1] || COUNTISH.test(k) || PAGING.test(k));
}

const singular = (name: string) => name.replace(/(ies)$/, 'y').replace(/s$/, '');

/**
 * An example value for a shape: `name` is the field it sits in, `i` the item's place in a list (for variety), and
 * `owner` the object it belongs to (so a person's name is a name, and a product's is "Product 2").
 */
export function exampleOf(shape: Shape, name: string, i = 0, owner?: { name: string; person: boolean; page?: boolean }): unknown {
  // A Set or a Map: written so the page can turn it back into one (JSON has neither).
  if (shape.kind === 'set') return { __visualEditorSet: exampleOf({ kind: 'array', item: shape.item ?? {} }, name, i, owner) };
  if (shape.kind === 'map') return { __visualEditorMap: (exampleOf({ kind: 'array', item: shape.item ?? {} }, name, i, owner) as unknown[]).map((v, k) => [`${singular(name)}-${k + 1}`, v]) };
  if (shape.kind === 'array' || shape.item) {
    const one = singular(name);
    return Array.from({ length: LIST_LENGTH }, (_v, k) => exampleOf(shape.item ?? {}, one, k, owner));
  }
  if (shape.kind === 'object' || shape.fields) {
    const fields = Object.keys(shape.fields ?? {});
    // A generic name takes its owner's: a page of orders holds orders; an order's items are "Order item"s.
    const named = GENERIC.includes(name) && owner && !GENERIC.includes(owner.name) ? (owner.page ? singular(owner.name) : `${owner.name} ${name}`) : name;
    const page = isPage(shape);
    const me = { name: named, person: PERSONISH.test(name) || fields.includes('email') || fields.includes('role'), page };
    return Object.fromEntries(
      // In a page of results, total/count is how many there are, not an amount of money.
      Object.entries(shape.fields ?? {}).map(([k, s]) => [k, page && COUNTISH.test(k) && (!s.kind || s.kind === 'number') && !s.values ? 42 : exampleOf(s, k, i, me)]),
    );
  }
  // What it's called: a person's real-sounding name, or the thing's kind and number.
  if (/^(name|fullName|displayName|title|label)$/i.test(name) && owner && (!shape.kind || shape.kind === 'string') && !shape.values) {
    if (owner.person && !/title|label/i.test(name)) return PEOPLE[i % PEOPLE.length];
    if (!GENERIC.includes(owner.name) && /^[a-z]/i.test(owner.name)) {
      const kind = owner.name.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
      return `${kind[0].toUpperCase()}${kind.slice(1)} ${i + 1}`;
    }
  }
  // The type says exactly which values it can have ('admin' | 'user', an enum): one of those, varied across a list.
  if (shape.values?.length) return shape.values[i % shape.values.length];
  if (shape.kind === 'date') return new Date(Date.now() - i * 86_400_000).toISOString();
  if (shape.kind === 'function') return { __visualEditorCallback: name };
  const kind = shape.kind ?? (NUMBERISH.test(name) ? 'number' : undefined);
  const value = sample(name, kind, 0);
  // Items in a list differ a little: ids, names and numbers.
  if (i === 0) return value;
  if (typeof value === 'number') return Math.round(value * (1 + 0.37 * i));
  if (typeof value === 'string' && /^id-\d+$/.test(value)) return `id-${1042 + i}`;
  // Dates move back a day per item, so they stay dates.
  if (typeof value === 'string' && ISO_DATE.test(value)) return new Date(Date.parse(value) - i * 86_400_000).toISOString();
  if (typeof value === 'string' && !FIXED_WORDS.test(name) && !/^(https?:|data:|#|\/|\{)/.test(value) && value.length < 40) return `${value} ${i + 1}`;
  return value;
}

/** Rules for every reply the code reads (longest match first, so /api/orders/1 isn't answered by /api/orders). */
export function replyRules(shapes: ReplyShape[]): ReplyRule[] {
  return shapes
    .filter((s) => s.method === 'GET' || s.method === 'QUERY')
    .sort((a, b) => b.match.length - a.match.length)
    .map((s) => {
      // Named by the address: /api/orders is orders; /api/orders/7 (one, not a list or a page) is an order.
      const last = s.match.split('/').filter(Boolean).pop() ?? 'item';
      const one = s.shape.kind !== 'array' && !s.shape.item && (s.shape.fields || s.shape.kind === 'object') && !isPage(s.shape);
      return { match: s.match, reply: exampleOf(s.shape, one ? singular(last) : last, 0) };
    });
}
