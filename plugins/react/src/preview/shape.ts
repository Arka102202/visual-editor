// What a piece of data looks like, as far as the types or the code show: its kind, its fields, a list's items, or
// the only values it can have. Both readers (TypeScript's types, and how the code uses data) produce these.

export interface Shape {
  kind?: 'string' | 'number' | 'boolean' | 'array' | 'object' | 'date' | 'function' | 'set' | 'map' | 'node' | 'ref' | 'opaque';
  fields?: Record<string, Shape>;
  item?: Shape;
  /** The only values it can have ('admin' | 'user', an enum's values), when the type says. */
  values?: (string | number)[];
  /** It may be left out (an optional field, or one that can be undefined). */
  optional?: boolean;
}

/** How much a shape says (to pick the richest part of a union). */
export function weight(s: Shape): number {
  return (s.fields ? Object.keys(s.fields).length + 2 : 0) + (s.item ? 2 : 0) + (s.kind ? 1 : 0);
}

/** The type's shape first (it's complete), with anything the code uses that the type doesn't mention added. */
export function mergeShapes(typed: Shape | undefined, used: Shape | undefined): Shape {
  if (!typed) return used ?? {};
  if (!used) return typed;
  const out: Shape = { ...typed };
  if (used.item && (typed.item || typed.kind === 'array')) out.item = mergeShapes(typed.item, used.item);
  if (used.fields && (typed.fields || typed.kind === 'object' || !typed.kind)) {
    out.fields = { ...typed.fields };
    for (const [k, v] of Object.entries(used.fields)) out.fields[k] = mergeShapes(typed.fields?.[k], v);
    out.kind ??= 'object';
  }
  if (!out.kind && used.kind) out.kind = used.kind;
  return out;
}
