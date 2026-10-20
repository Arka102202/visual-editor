// React Flow canvases in previews. A canvas only draws a node whose `type` is one of the names in its `nodeTypes` map
// (and an edge between nodes that exist), so example nodes made from React Flow's own Node type show nothing. This
// finds `<ReactFlow nodes={…} edges={…} nodeTypes={…} edgeTypes={…}>` in a component, which source the nodes and
// edges come from (`rfNodes` from `useCanvas()`), and the names in the maps with the component drawn for each, so
// the examples can be one node of each kind, joined by one edge of each kind. Pure: code in, hints out.

import type * as t from '@babel/types';
import { walk } from '../read/ast';
import type { Source } from './sources';

type N = t.Node;

/** Where a value sits: a source of the component, and the fields inside it (`rfNodes` of `useCanvas()`). */
export interface Place {
  local: string;
  at: string[];
}

export interface FlowHint {
  nodes?: Place;
  edges?: Place;
  /** The names in the maps, with the name of the component each draws. */
  nodeTypes: { key: string; component: string }[];
  edgeTypes: { key: string; component: string }[];
}

const unwrap = (e: N | null | undefined): N | null | undefined =>
  e && (e.type === 'TSAsExpression' || e.type === 'TSSatisfiesExpression' || e.type === 'ParenthesizedExpression' || e.type === 'TSNonNullExpression') ? unwrap(e.expression) : e;

/** The canvases a component draws, with where their nodes and edges come from. */
export function flowHints(fn: t.Function, ast: t.File, sources: Source[]): FlowHint[] {
  if (fn.body.type !== 'BlockStatement') return [];
  // Which names hold which source (or a field of it).
  const names = new Map<string, Place>();
  for (const st of fn.body.body) {
    if (st.type !== 'VariableDeclaration') continue;
    for (const d of st.declarations) {
      const init = unwrap(d.init);
      const source = sources.find((s) => (s.kind === 'hook' && init && s.start === init.start) || (s.kind === 'state' && d.id.type === 'ArrayPattern' && d.id.elements[0]?.type === 'Identifier' && d.id.elements[0].name === s.local));
      if (!source) continue;
      if (d.id.type === 'Identifier') names.set(d.id.name, { local: source.local, at: [] });
      if (d.id.type === 'ArrayPattern' && d.id.elements[0]?.type === 'Identifier') names.set(d.id.elements[0].name, { local: source.local, at: [] });
      if (d.id.type === 'ObjectPattern') {
        for (const p of d.id.properties) {
          if (p.type !== 'ObjectProperty' || p.key.type !== 'Identifier') continue;
          const target = p.value.type === 'AssignmentPattern' ? p.value.left : p.value;
          if (target.type === 'Identifier') names.set(target.name, { local: source.local, at: [p.key.name] });
        }
      }
    }
  }
  // Maps defined at the top of the file: const NODE_TYPES = { microservice: MicroserviceNode, … }
  const maps = new Map<string, t.ObjectExpression>();
  for (const st of ast.program.body as N[]) {
    const decl = st.type === 'ExportNamedDeclaration' ? st.declaration : st;
    if (decl?.type !== 'VariableDeclaration') continue;
    for (const d of decl.declarations) {
      const init = unwrap(d.init);
      if (d.id.type === 'Identifier' && init?.type === 'ObjectExpression') maps.set(d.id.name, init);
    }
  }
  const entries = (e: N | undefined): { key: string; component: string }[] => {
    const obj = e?.type === 'Identifier' ? maps.get(e.name) : e?.type === 'ObjectExpression' ? e : undefined;
    const out: { key: string; component: string }[] = [];
    for (const p of obj?.properties ?? []) {
      if (p.type !== 'ObjectProperty') continue;
      const key = p.key.type === 'Identifier' ? p.key.name : p.key.type === 'StringLiteral' ? p.key.value : undefined;
      const value = unwrap(p.value as N);
      if (key && value?.type === 'Identifier') out.push({ key, component: value.name });
    }
    return out;
  };
  const hints: FlowHint[] = [];
  walk(fn.body, (n) => {
    if (n.type !== 'JSXOpeningElement' || n.name.type !== 'JSXIdentifier' || n.name.name !== 'ReactFlow') return;
    const attr = (name: string): N | undefined => {
      for (const a of n.attributes) {
        if (a.type === 'JSXAttribute' && a.name.type === 'JSXIdentifier' && a.name.name === name && a.value?.type === 'JSXExpressionContainer' && a.value.expression.type !== 'JSXEmptyExpression') return a.value.expression;
      }
      return undefined;
    };
    const place = (e: N | undefined) => (e?.type === 'Identifier' ? names.get(e.name) : undefined);
    const hint: FlowHint = { nodeTypes: entries(attr('nodeTypes')), edgeTypes: entries(attr('edgeTypes')) };
    const nodes = place(attr('nodes') ?? attr('defaultNodes'));
    const edges = place(attr('edges') ?? attr('defaultEdges'));
    if (nodes) hint.nodes = nodes;
    if (edges) hint.edges = edges;
    if (hint.nodes || hint.edges) hints.push(hint);
  });
  return hints;
}

/** Puts a value at a place inside another (a field of a hook's value), or returns it when the place is the whole. */
export function putAt(whole: unknown, at: string[], value: unknown): unknown {
  if (!at.length) return value;
  if (!whole || typeof whole !== 'object') return whole;
  let o = whole as Record<string, unknown>;
  for (const k of at.slice(0, -1)) {
    if (!o[k] || typeof o[k] !== 'object') return whole;
    o = o[k] as Record<string, unknown>;
  }
  o[at[at.length - 1]] = value;
  return whole;
}
