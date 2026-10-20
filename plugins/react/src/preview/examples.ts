// Example values for the data a component needs, made from its shape (from the types, or from how the code uses it)
// and its name: an email looks like an email, a price is a number, a list has three items that differ a little, a
// person has a person's name. What can't be worked out (no type, no use, a name that says nothing) is left out and
// reported as missing, for the developer to fill in. Pure, so it can be tested.

import type { Shape } from './shape';

/** A function prop in an example: the preview page turns it into a function that reports its calls. */
export const CALLBACK = '__visualEditorCallback';
/** Something React draws (children, an icon slot): the preview page shows it as this text. */
export const NODE_TEXT = 'Example content';

export interface Example {
  value: unknown;
  /** Paths inside the value that couldn't be worked out ('' is the value itself; 'customer.address' a field). */
  missing: string[];
}

const LIST_LENGTH = 3;
const NUMBERISH = /^(total|price|amount|cost|count|qty|quantity|size|width|height|x|y|score|rating|age|index|position|rank|duration|progress|percent|balance|views|likes|visits|number|num|no|revenue|sales|income|spend|budget|subtotal|tax|discount|stock|page|limit|offset)$/i;
/** Fields whose values are a few fixed words (a status, a role): never numbered. */
const FIXED_WORDS = /(status|state|type|kind|role|category|level|priority|stage|currency|country|lang|locale|unit|method)$/i;
const PEOPLE = ['Ada Lovelace', 'Grace Hopper', 'Alan Turing', 'Katherine Johnson', 'Linus Torvalds'];
const PERSONISH = /^(user|users|customer|owner|author|member|person|people|profile|account|me|staff|admin|assignee|creator|sender|recipient|contact|employee|player|student|patient)$/i;
const ISO_DATE = /^\d{4}-\d\d-\d\dT/;
const GENERIC = ['item', 'data', 'result', 'response', 'root', 'entry', 'row', 'node', 'value'];
const COUNTISH = /^(total|count|totalCount|totalItems|size|length)$/i;
const PAGING = /^(page|pages|pageSize|perPage|limit|offset|cursor|nextCursor|prevCursor|previousCursor|next|previous|prev|hasMore|hasNext|hasPrevious|totalPages|pageCount|lastPage|currentPage)$/i;
/** A small grey picture, so images show without the network. */
export const PLACEHOLDER_IMAGE =
  "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='160' height='120'><rect width='100%' height='100%' fill='%23cbd5e1'/><circle cx='56' cy='46' r='14' fill='%2394a3b8'/><path d='M0 120 L60 70 L100 100 L130 80 L160 110 L160 120Z' fill='%2394a3b8'/></svg>";

/**
 * Names that say clearly what a value is, even with no type and no use to go by: with one of these, a value can be
 * made; with any other name and nothing else known, it's missing.
 */
const TELLING_NAME =
  /^(id|.*Id|.*ID|uuid|key|slug|email|.*Email|url|.*Url|href|link|src|image|img|avatar|photo|picture|logo|thumbnail|cover|name|.*Name|title|.*Title|label|heading|subtitle|description|summary|text|content|message|body|caption|placeholder|children|count|total|price|amount|quantity|qty|index|age|rating|score|width|height|size|date|.*At|.*Date|time|timestamp|color|colour|.*Color|phone|status|className|style|(is|has|can|should|show|was|will)[A-Z].*|on[A-Z].*|open|disabled|loading|selected|checked|visible|active|enabled|expanded|readOnly|required)$/;

const singular = (name: string) => name.replace(/(ies)$/, 'y').replace(/s$/, '');

/** A page of results: one list, a count, and paging fields only ({ items, total, nextCursor }). */
function isPage(shape: Shape): boolean {
  const entries = Object.entries(shape.fields ?? {});
  const lists = entries.filter(([, f]) => f.kind === 'array' || f.item);
  return lists.length === 1 && entries.every(([k, f]) => f === lists[0][1] || COUNTISH.test(k) || PAGING.test(k));
}

/** Nothing is known about it: no kind, no fields, no items, no values. */
const unknown = (s: Shape) => !s.kind && !s.fields && !s.item && !s.values?.length;

interface Owner {
  name: string;
  person: boolean;
  page?: boolean;
}

/** A date in an example that must be a real Date (a prop, a context value): the preview page turns it into one. */
export const DATE = '__visualEditorDate';

/**
 * An example for a value of this shape called `name` (the key it sits under), with what couldn't be worked out.
 * `realDates`: dates are marked to become real Date objects (props, context); otherwise they're text, as a server
 * sends them (API replies).
 */
export function example(shape: Shape | undefined, name: string, realDates = false, quiet = false): Example {
  const missing: string[] = [];
  dates = realDates;
  calm = quiet;
  whole = name;
  const value = make(shape ?? {}, name, 0, undefined, '', missing);
  return { value, missing };
}

/** Whether the example being made marks its dates (see example()). */
let dates = false;
/** Whether what covers the screen (dialogs, menus, toasts, progress) starts closed (`quiet` in example()). */
let calm = false;
/** The name of the whole value being made (a store called `regenerateModalStore` says its `isOpen` is a dialog's). */
let whole = '';
const COVERS = /modal|dialog|popover|popup|menu|dropdown|tooltip|toast|confirm|drawer|overlay|sheet|lightbox|generating|saving|loading|pending|busy|error|fail|warning|alert|banner|picker|palette|prompt/i;

function make(shape: Shape, name: string, i: number, owner: Owner | undefined, path: string, missing: string[]): unknown {
  const at = (key: string | number) => (path ? `${path}.${key}` : String(key));
  if (shape.kind === 'set') return { __visualEditorSet: make({ kind: 'array', item: shape.item ?? {} }, name, i, owner, path, missing) };
  if (shape.kind === 'map') {
    const items = make({ kind: 'array', item: shape.item ?? {} }, name, i, owner, path, missing) as unknown[];
    return { __visualEditorMap: items.map((v, k) => [`${singular(name)}-${k + 1}`, v]) };
  }
  if (shape.kind === 'array' || shape.item) {
    const one = singular(name);
    const item = shape.item ?? {};
    // A list of who-knows-what: empty (a real value for any list), rather than items made up from nothing.
    if (unknown(item) && !TELLING_NAME.test(one)) return [];
    return Array.from({ length: LIST_LENGTH }, (_v, k) => make(item, one, k, owner, k === 0 ? at(0) : '', k === 0 ? missing : []));
  }
  if (shape.kind === 'object' || shape.fields) {
    const fields = Object.keys(shape.fields ?? {});
    // An object with no fields the types know (Record<string, unknown>): empty is a real value for it.
    if (!fields.length && shape.kind === 'object') return {};
    const named = GENERIC.includes(name) && owner && !GENERIC.includes(owner.name) ? (owner.page ? singular(owner.name) : `${owner.name} ${name}`) : name;
    const page = isPage(shape);
    const me: Owner = { name: named, person: PERSONISH.test(name) || fields.includes('email') || fields.includes('role'), page };
    return Object.fromEntries(
      Object.entries(shape.fields ?? {}).map(([k, s]) => [k, page && COUNTISH.test(k) && (!s.kind || s.kind === 'number') && !s.values ? 42 : make(s, k, i, me, at(k), missing)]),
    );
  }
  if (shape.kind === 'function') return { [CALLBACK]: name };
  if (shape.kind === 'node') return NODE_TEXT;
  // A ref (to an element) starts empty; the browser's own objects (an element, an event) are nothing in the data.
  if (shape.kind === 'ref') return { current: null };
  if (shape.kind === 'opaque') return null;
  // What it's called: a person's real-sounding name, or the thing's kind and number.
  if (/^(name|fullName|displayName|title|label)$/i.test(name) && owner && (!shape.kind || shape.kind === 'string') && !shape.values) {
    if (owner.person && !/title|label/i.test(name)) return PEOPLE[i % PEOPLE.length];
    if (!GENERIC.includes(owner.name) && /^[a-z]/i.test(owner.name)) {
      const kind = owner.name.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
      return `${kind[0].toUpperCase()}${kind.slice(1)} ${i + 1}`;
    }
  }
  if (shape.values?.length) {
    // Inside the tree, a status rests (idle, done) rather than being busy or failing.
    const resting = calm && i === 0 ? shape.values.find((v) => typeof v === 'string' && /^(idle|none|done|success|succeeded|ready|complete|completed|closed|default|normal|ok|active)$/i.test(v)) : undefined;
    return resting ?? shape.values[i % shape.values.length];
  }
  if (shape.kind === 'date') {
    const iso = new Date(Date.now() - i * 86_400_000).toISOString();
    return dates ? { [DATE]: iso } : iso;
  }
  // Nothing says what it is: noted, and null (only a value that's wholly unknown has to be filled in).
  if (unknown(shape) && !TELLING_NAME.test(name) && !NUMBERISH.test(name)) {
    missing.push(path);
    return null;
  }
  const kind = shape.kind ?? (NUMBERISH.test(name) ? 'number' : /^(is|has|can|should|show|was|will)[A-Z]/.test(name) ? 'boolean' : /^on[A-Z]/.test(name) ? 'function' : undefined);
  if (kind === 'function') return { [CALLBACK]: name };
  if (name === 'children') return NODE_TEXT;
  const value = kind === 'number' ? numberFor(name) : kind === 'boolean' ? booleanFor(name) : stringFor(name);
  if (i === 0) return value;
  // Items in a list differ a little: ids, names and numbers.
  if (typeof value === 'number') return Math.round(value * (1 + 0.37 * i));
  if (typeof value === 'string' && /^id-\d+$/.test(value)) return `id-${1042 + i}`;
  if (typeof value === 'string' && ISO_DATE.test(value)) return new Date(Date.parse(value) - i * 86_400_000).toISOString();
  if (typeof value === 'string' && !FIXED_WORDS.test(name) && !/^(https?:|data:|#|\/|\{)/.test(value) && value.length < 40) return `${value} ${i + 1}`;
  return value;
}

/** Yes for what is usually so (active, verified, a dialog open); no for trouble (deleted, failed, locked). */
function booleanFor(name: string): boolean {
  if (calm && (COVERS.test(name) || (/^(is)?(open|opened|visible|shown|show|displayed|active)$/i.test(name) && COVERS.test(whole)))) return false;
  const n = name.toLowerCase();
  if (/(disabled|hidden|deleted|archived|error|loading|locked|blocked|banned|failed|empty|expired|dirty|pending|readonly)/.test(n)) return false;
  return /^(is|has|can|in|show|should|was|will)[a-z]|^(open|expanded|visible|enabled|active|available|verified|published|online|instock|selected|checked|done|completed|paid|read|required)$/.test(n);
}

function numberFor(name: string): number {
  const n = name.toLowerCase();
  // Sizes of things on screen: a real panel's, not a count's.
  if (/width$/.test(n)) return 320;
  if (/height$/.test(n)) return 240;
  if (/(at|date|time|timestamp)$/.test(n)) return Date.now() - 3_600_000;
  if (/price|amount|total|cost|revenue|sales|income|spend|budget|balance|subtotal|tax|discount/.test(n)) return 1299;
  if (/^(number|num|no)$/.test(n)) return 1042;
  if (/qty|quantity/.test(n)) return 2;
  if (/count|size|length|stock/.test(n)) return 12;
  if (/age/.test(n)) return 34;
  if (/star|rating|score/.test(n)) return 4;
  if (/percent|progress/.test(n)) return 64;
  if (/^(page|index|position|rank)$/.test(n)) return 1;
  if (/id$/.test(n)) return 1042;
  return 42;
}

function stringFor(name: string): string {
  const n = name.toLowerCase();
  if (/^(data|json|payload|config|settings|meta|metadata|snapshot)$/.test(n)) return '{}';
  if (n === 'id' || n.endsWith('id') || n === 'uuid' || n === 'key') return 'id-1042';
  if (n === 'slug') return 'example-item';
  if (/email/.test(n)) return 'ada@example.com';
  if (/avatar|image|img|^src$|photo|picture|cover|thumbnail|logo/.test(n)) return PLACEHOLDER_IMAGE;
  if (/url|link|href/.test(n)) return '/';
  if (/classname/.test(n)) return '';
  // methodName → "Method name", pageTitle → "Page title"; a bare name or title → a plain one.
  const words = name.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').toLowerCase();
  if (/^(name|title|label|heading)$/.test(n)) return 'Order dashboard';
  if (/(name|title|label|heading)$/.test(n)) return `${words[0].toUpperCase()}${words.slice(1)}`;
  if (/desc|summary|subtitle|bio|text|content|message|body|caption/.test(n)) return 'A short description, long enough to wrap onto a second line in narrow cards.';
  if (/placeholder/.test(n)) return 'Type here…';
  if (/colou?r|accent|bg$|background|fg$|foreground|fill$|stroke$|tint$|shade$/.test(n)) return /fg$|foreground|text/.test(n) ? '#ffffff' : '#6366f1';
  if (/status|state/.test(n)) return 'active';
  if (/(at|date|time|timestamp)$/.test(n)) return new Date().toISOString();
  if (/phone/.test(n)) return '+1 555 0100';
  return `Example ${name}`;
}
