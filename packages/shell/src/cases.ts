// Data cases from props' types (pure: the map page uses it too): props a component needs, and suggested cases that
// each change one thing (text empty and very long, lists empty and long, flags flipped, each option, numbers at the
// edges, optional props filled in). A function prop is {"$action": "name"}.

import type { Field } from '@visual-editor/contract';

export interface DataCase {
  name: string;
  props: Record<string, unknown>;
}

const LONG = 'A much longer piece of text than anyone planned for, to see how it wraps, truncates or pushes things around when the space runs out.';

/** A value for a prop from its type as written (and its name). */
export function exampleFor(name: string, type = '', callback = false): unknown {
  const t = type.trim();
  if (callback || /=>/.test(t) || /^(on|handle)[A-Z]/.test(name)) return { $action: name };
  const parts = options(t);
  const literal = parts.find(isLiteral);
  if (literal) return JSON.parse(literal.replace(/^['`](.*)['`]$/, '"$1"'));
  const one = parts[0] ?? '';
  if (/\[\]$|^(Readonly)?Array</.test(one)) return [];
  if (one === 'string') return textFor(name);
  if (one === 'number') return /count|total|size|amount|quantity|index|page/i.test(name) ? 3 : 42;
  if (one === 'boolean') return /^(is|show|open|visible|enabled|active|checked|selected|expanded)/i.test(name);
  if (/ReactNode|ReactElement|JSX\.Element|ReactChild/.test(one) || name === 'children') return textFor(name === 'children' ? 'label' : name);
  if (one === 'Date') return '2026-10-20T09:30:00.000Z';
  if (/^Record<|^\{/.test(one)) return {};
  return parts.length ? {} : null;
}

function options(type: string): string[] {
  return type
    .split('|')
    .map((x) => x.trim())
    .filter((x) => x && x !== 'undefined' && x !== 'null');
}

function isLiteral(x: string): boolean {
  return /^(['"`]).*\1$|^-?\d+(\.\d+)?$|^(true|false)$/.test(x);
}

function textFor(name: string): string {
  const n = name.toLowerCase();
  if (/email/.test(n)) return 'ada@example.com';
  if (/url|href|link|src|image|avatar/.test(n)) return 'https://picsum.photos/seed/visual-editor/400/240';
  if (/date|at$/.test(n)) return '2026-10-20';
  if (/(^|_)id$|Id$/.test(name)) return 'id-1042';
  if (/name|author|user|owner/.test(n)) return 'Ada Lovelace';
  if (/desc|text|body|content|message|summary|note/.test(n)) return 'A short description, long enough to wrap onto a second line in narrow cards.';
  if (/status|state/.test(n)) return 'active';
  return name.replace(/^./, (c) => c.toUpperCase()).replace(/([a-z])([A-Z])/g, '$1 $2');
}

/** A copy of the props with one value changed, deep inside (path: ["project", "name"]). */
function setAt(base: Record<string, unknown>, path: string[], value: unknown): Record<string, unknown> {
  const out = structuredClone(base);
  let at: Record<string, unknown> = out;
  for (const k of path.slice(0, -1)) at = at[k] as Record<string, unknown>;
  at[path[path.length - 1]] = value;
  return { [path[0]]: out[path[0]] };
}

/** Props a component needs (and children), from the types on its card. */
export function exampleProps(fields: Field[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    if (f.tag === 'optional' && f.name !== 'children') continue;
    out[f.name] = exampleFor(f.name, f.value, f.tag === 'callback');
  }
  return out;
}

/**
 * Cases worth seeing, from the props' types, each a change from `base`: text empty and very long, lists empty and
 * long, each flag flipped, each option of a union, numbers at zero and huge, and optional props filled in.
 */
export function suggestCases(fields: Field[], base: Record<string, unknown>, max = 14): DataCase[] {
  const out: DataCase[] = [];
  const add = (name: string, change: Record<string, unknown>) => {
    if (out.length < max && !out.some((c) => c.name === name)) out.push({ name, props: { ...base, ...change } });
  };
  for (const f of fields) {
    const t = (f.value ?? '').trim();
    const parts = options(t);
    if (f.tag === 'callback' || /=>/.test(t)) continue;
    const literals = parts.filter(isLiteral);
    if (literals.length > 1) {
      for (const l of literals) {
        const v = JSON.parse(l.replace(/^['`](.*)['`]$/, '"$1"'));
        if (v !== base[f.name]) add(`${f.name}: ${String(v)}`, { [f.name]: v });
      }
      continue;
    }
    const one = parts[0] ?? '';
    if (one === 'string' || f.name === 'children' || /ReactNode/.test(one)) {
      add(`long ${f.name}`, { [f.name]: LONG });
      add(`empty ${f.name}`, { [f.name]: '' });
    } else if (one === 'boolean') add(`${f.name} ${base[f.name] ? 'off' : 'on'}`, { [f.name]: !base[f.name] });
    else if (one === 'number') {
      add(`${f.name} zero`, { [f.name]: 0 });
      add(`${f.name} huge`, { [f.name]: 1234567 });
    } else if (/\[\]$|^(Readonly)?Array</.test(one)) {
      add(`no ${f.name}`, { [f.name]: [] });
      const item = one.replace(/\[\]$/, '').replace(/^(Readonly)?Array<(.*)>$/, '$2');
      if (item === 'string' || item === 'number') add(`many ${f.name}`, { [f.name]: Array.from({ length: 12 }, (_v, i) => (item === 'string' ? `${textFor(f.name.replace(/s$/, ''))} ${i + 1}` : i + 1)) });
    }
    if (f.tag === 'optional' && !(f.name in base) && f.name !== 'children') add(`with ${f.name}`, { [f.name]: exampleFor(f.name, f.value) });
  }
  // From the data itself (real data has more in it than the types say): each text in it long and empty, each list
  // in it empty and long.
  const walk = (value: unknown, path: string[], depth: number) => {
    if (depth > 2 || out.length >= max) return;
    if (Array.isArray(value)) {
      if (path.length > 1) {
        add(`no ${path.join('.')}`, setAt(base, path, []));
        if (value.length) add(`many ${path.join('.')}`, setAt(base, path, Array.from({ length: 12 }, (_v, i) => value[i % value.length])));
      }
      return;
    }
    if (value && typeof value === 'object') {
      if ('$action' in (value as object)) return;
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) walk(v, [...path, k], depth + 1);
      return;
    }
    if (typeof value === 'string' && path.length > 1 && !/(^|\.)(id|.*Id|url|href|src|color|colour|accentColor)$/i.test(path.join('.'))) {
      add(`long ${path.join('.')}`, setAt(base, path, LONG));
      add(`empty ${path.join('.')}`, setAt(base, path, ''));
    }
  };
  for (const [k, v] of Object.entries(base)) if (v && typeof v === 'object') walk(v, [k], 1);
  return out;
}
