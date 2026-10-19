// React Flow: panels and editors that show "the selected node" find it among the diagram's nodes by an id they're
// given (`nodes.find(n => n.id === nodeId)`), then read its data as a type (`node?.data as EntityNode`). Shown on
// their own there's no diagram, so they'd wait forever. This finds those lookups, so the preview can put an example
// node with that id, and data of that type, into React Flow first. Pure (types are worked out by the caller).

import type * as t from '@babel/types';
import { forEachChild, parseSource } from '../read/ast';

export interface NodeLookup {
  /** The prop (or variable) holding the id looked up, e.g. "nodeId". */
  idFrom: string;
  /** Where the variable holding the node's data is written (its type is the data's type), when it has one. */
  dataAt?: number;
  /** The file it's in. */
  path: string;
}

/** Hooks and calls that give a React Flow diagram's nodes. */
const NODES = /\b(useNodes|getNodes)\b/;

/** `nodes.find((n) => n.id === nodeId)` lookups in a file, with the typed variable that reads the found node's data. */
export function nodeLookups(path: string, text: string): NodeLookup[] {
  if (!NODES.test(text) || !/\.find\s*\(/.test(text)) return [];
  const ast = parseSource({ path, text });
  if (!ast) return [];
  const found: { holder?: string; idFrom: string }[] = [];
  const declarators: t.VariableDeclarator[] = [];
  const stack: t.Node[] = [];
  const visit = (n: t.Node) => {
    if (n.type === 'VariableDeclarator') declarators.push(n);
    // Only lookups among the diagram's nodes: `nodes.find(…)`, `rfNodes.find(…)`, `getNodes().find(…)`.
    const among = n.type === 'CallExpression' && n.callee.type === 'MemberExpression' ? n.callee.object : undefined;
    const ofNodes = !!among && ((among.type === 'Identifier' && /nodes$/i.test(among.name)) || (among.type === 'CallExpression' && among.callee.type === 'Identifier' && /^(getNodes|useNodes)$/.test(among.callee.name)));
    if (ofNodes && n.type === 'CallExpression' && n.callee.type === 'MemberExpression' && n.callee.property.type === 'Identifier' && n.callee.property.name === 'find') {
      const fn = n.arguments[0];
      if (fn && (fn.type === 'ArrowFunctionExpression' || fn.type === 'FunctionExpression') && fn.params[0]?.type === 'Identifier') {
        const param = fn.params[0].name;
        const body = fn.body.type === 'BlockStatement' ? (fn.body.body[0]?.type === 'ReturnStatement' ? fn.body.body[0].argument : undefined) : fn.body;
        // n.id === nodeId (either way round)
        if (body?.type === 'BinaryExpression' && (body.operator === '===' || body.operator === '==')) {
          const isId = (x: t.Node) => x.type === 'MemberExpression' && x.object.type === 'Identifier' && x.object.name === param && x.property.type === 'Identifier' && x.property.name === 'id';
          const other = isId(body.left) ? body.right : isId(body.right) ? body.left : undefined;
          if (other?.type === 'Identifier') {
            const parent = stack[stack.length - 1];
            const holder = parent?.type === 'VariableDeclarator' && parent.id.type === 'Identifier' ? parent.id.name : undefined;
            found.push({ holder, idFrom: other.name });
          }
        }
      }
    }
    stack.push(n);
    forEachChild(n as never, visit as never);
    stack.pop();
  };
  visit(ast.program);
  return found.map((f) => {
    // const node = (rfNode?.data as unknown as EntityNode | undefined) ?? null
    // The closest variable that reads it (not a whole function that happens to contain the read).
    const reads = f.holder
      ? declarators
          .filter((d) => d.id.type === 'Identifier' && d.init && d.init.type !== 'ArrowFunctionExpression' && d.init.type !== 'FunctionExpression' && readsDataAs(d.init, f.holder!))
          .sort((a, b) => (a.end ?? 0) - (a.start ?? 0) - ((b.end ?? 0) - (b.start ?? 0)))[0]
      : undefined;
    return { idFrom: f.idFrom, path, ...(reads ? { dataAt: (reads.id as t.Identifier).start ?? 0 } : {}) };
  });
}

/** Whether an expression reads `<holder>.data` (or `?.data`) as a type. */
function readsDataAs(expr: t.Node, holder: string): boolean {
  let cast = false;
  let reads = false;
  const visit = (n: t.Node) => {
    if (n.type === 'TSAsExpression') cast = true;
    if ((n.type === 'MemberExpression' || n.type === 'OptionalMemberExpression') && n.object.type === 'Identifier' && n.object.name === holder && n.property.type === 'Identifier' && n.property.name === 'data') reads = true;
    forEachChild(n as never, visit as never);
  };
  visit(expr);
  return cast && reads;
}
