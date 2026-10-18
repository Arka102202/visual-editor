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
}

const LIST_LENGTH = 3;
/** Field names that are almost always numbers. */
const NUMBERISH = /^(total|price|amount|cost|count|qty|quantity|size|width|height|x|y|score|rating|age|index|position|rank|duration|progress|percent|balance|views|likes|visits|number|num|no|revenue|sales|income|spend|budget|subtotal|tax|discount|stock)$/i;
/** Fields whose values are a few fixed words (a status, a role): never numbered. */
const FIXED_WORDS = /(status|state|type|kind|role|category|level|priority|stage|currency|country|lang|locale|unit|method)$/i;

/** An example value for a shape: `name` is the field it sits in, `i` the item's place in a list (for variety). */
export function exampleOf(shape: Shape, name: string, i = 0): unknown {
  if (shape.kind === 'array' || shape.item) {
    const one = name.replace(/(ies)$/, 'y').replace(/s$/, '');
    return Array.from({ length: LIST_LENGTH }, (_v, k) => exampleOf(shape.item ?? {}, one, k));
  }
  if (shape.kind === 'object' || shape.fields) {
    return Object.fromEntries(Object.entries(shape.fields ?? {}).map(([k, s]) => [k, exampleOf(s, k, i)]));
  }
  const kind = shape.kind ?? (NUMBERISH.test(name) ? 'number' : undefined);
  const value = sample(name, kind, 0);
  // Items in a list differ a little: ids, names and numbers.
  if (i === 0) return value;
  if (typeof value === 'number') return Math.round(value * (1 + 0.37 * i));
  if (typeof value === 'string' && /^id-\d+$/.test(value)) return `id-${1042 + i}`;
  if (typeof value === 'string' && !FIXED_WORDS.test(name) && !/^(https?:|data:|#|\/|\{)/.test(value) && value.length < 40) return `${value} ${i + 1}`;
  return value;
}

/** Rules for every reply the code reads (longest match first, so /api/orders/1 isn't answered by /api/orders). */
export function replyRules(shapes: ReplyShape[]): ReplyRule[] {
  return shapes
    .filter((s) => s.method === 'GET' || s.method === 'QUERY')
    .sort((a, b) => b.match.length - a.match.length)
    .map((s) => ({ match: s.match, reply: exampleOf(s.shape, s.match.split('/').filter(Boolean).pop() ?? 'item') }));
}
