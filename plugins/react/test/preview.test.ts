import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import type { SourceFile } from '@visual-editor/contract';
import { readModel, wantsFile } from '../src/cards';
import { PreviewReader, STATIC_DIR } from '../src/preview/reader';
import { previewHtml, previewTsx, GUARD } from '../src/preview/page';
import { planOf } from '../src/preview/sources';
import { flowHints, putAt } from '../src/preview/flow';
import { parseSource, walk } from '../src/read/ast';

/** The test project, copied somewhere temporary (previews write `.preview.json` files next to components). */
function project(name: string): { root: string; reader: () => PreviewReader } {
  const root = mkdtempSync(join(tmpdir(), 've-preview-'));
  cpSync(`plugins/react/test/fixtures/${name}`, root, { recursive: true });
  const reader = () => {
    const files: SourceFile[] = [];
    const walk = (dir: string) => {
      for (const n of readdirSync(dir)) {
        const p = join(dir, n);
        if (statSync(p).isDirectory()) walk(p);
        else if (wantsFile(relative(root, p))) files.push({ path: relative(root, p), text: readFileSync(p, 'utf8') });
      }
    };
    walk(root);
    return new PreviewReader(readModel(files), files, root);
  };
  return { root, reader };
}

const shop = project('ts-shop');
const DETAIL = 'src/pages/OrderDetail.tsx#OrderDetail';

test('preview: hooks and state an effect fills are the sources; the effect that fills it is left out', () => {
  const needs = shop.reader().needsOf(DETAIL);
  const ids = needs.map((n) => n.id);
  assert.ok(ids.includes(`${DETAIL}|useParams`), 'the router hook is a source');
  const order = needs.find((n) => n.id === `${DETAIL}|order`);
  assert.ok(order, 'the state filled by the request is a source');
  assert.equal(order.type, 'Order | null');
  assert.equal((order.value as { customer: { email: string } }).customer.email, 'ada@example.com');
  assert.equal(order.from, 'from its type');
});

test('preview: the whole tree, all the way down; only the root has props to give', () => {
  const needs = shop.reader().needsOf('src/pages/Orders.tsx#Orders');
  const groups = [...new Set(needs.map((n) => n.group))];
  assert.equal(groups[0], 'Orders');
  const page = needs.find((n) => n.id === 'src/pages/Orders.tsx#Orders|useQuery');
  assert.ok(page, 'the query hook is a source');
  assert.equal((page.value as { data: { items: unknown[] } }).data.items.length, 3);
  // OrderCard is drawn by Orders: its props come from Orders, so they aren't asked for.
  assert.ok(!needs.some((n) => n.id.startsWith('prop:')));
});

test('preview: values are kept next to the file; the developer’s own value stays, and is flagged when its type changes', () => {
  const first = shop.reader();
  first.needsOf(DETAIL);
  const kept = join(shop.root, 'src/pages/OrderDetail.preview.json');
  assert.ok(existsSync(kept));
  first.keep(DETAIL, `${DETAIL}|order`, { id: 'mine' });
  const again = shop.reader().needsOf(DETAIL).find((n) => n.id === `${DETAIL}|order`)!;
  assert.deepEqual(again.yours, { id: 'mine' });
  assert.equal(again.check, undefined);
  const saved = JSON.parse(readFileSync(kept, 'utf8'));
  assert.deepEqual(saved.components.OrderDetail.needs.order.yours, { id: 'mine' });
});

test('preview: the static copy reads every source from the list, leaves the effect out, and exports its components', () => {
  const spec = shop.reader().drawSpec(DETAIL)!;
  assert.equal(spec.root, `${STATIC_DIR}/src/pages/OrderDetail.tsx`);
  assert.equal(spec.exportName, '__Ve_OrderDetail');
  const copy = spec.files.find((f) => f.path === spec.root)!.text;
  assert.match(copy, /useState<Order \| null>\(globalThis\.__veValue\("src\/pages\/OrderDetail\.tsx#OrderDetail\|order"\)\)/);
  assert.match(copy, /const \{ id \} = globalThis\.__veValue\("src\/pages\/OrderDetail\.tsx#OrderDetail\|useParams"\)/);
  assert.match(copy, /left out by the preview/);
  assert.doesNotMatch(copy, /getJson<Order>/);
  assert.match(copy, /export \{ OrderDetail as __Ve_OrderDetail \}/);
});

test('preview: the page keeps the app head without its scripts, and the guard loads first', () => {
  const html = previewHtml('<html><head><title>App</title><script src="https://track.example.com/a.js"></script></head><body><div id="app"></div></body></html>');
  assert.match(html, /<title>Preview<\/title>/);
  assert.doesNotMatch(html, /track\.example\.com/);
  const runtime = previewTsx({ css: ['/src/index.css'], providers: { router: 'react-router-dom' } });
  assert.match(runtime.split('\n')[1], /^import '\.\/guard'$/);
  assert.match(runtime, /__veValue/);
  assert.match(GUARD, /window\.fetch = /);
  assert.match(GUARD, /serviceWorker/);
});

test('preview: a React Flow canvas gets one node of each kind in its nodeTypes map, joined by edges of each kind', () => {
  const code = `
import { ReactFlow } from '@xyflow/react'
import { useCanvas } from './useCanvas'
const NODE_TYPES = { service: ServiceNode, table: TableNode } as const
export function Board() {
  const { nodes, edges } = useCanvas()
  return <ReactFlow nodes={nodes} edges={edges} nodeTypes={NODE_TYPES} edgeTypes={{ uses: UsesEdge }} />
}`;
  const ast = parseSource({ path: 'Board.tsx', text: code })!;
  let fn: Parameters<typeof planOf>[0] | undefined;
  walk(ast, (n) => {
    if (n.type === 'FunctionDeclaration' && n.id?.name === 'Board') fn = n;
  });
  const plan = planOf(fn!, code);
  const [hint] = flowHints(fn!, ast, plan.sources);
  assert.deepEqual(hint.nodes, { local: 'useCanvas', at: ['nodes'] });
  assert.deepEqual(hint.edges, { local: 'useCanvas', at: ['edges'] });
  assert.deepEqual(hint.nodeTypes.map((x) => x.key), ['service', 'table']);
  assert.deepEqual(hint.edgeTypes, [{ key: 'uses', component: 'UsesEdge' }]);
  assert.deepEqual(putAt({ nodes: [], other: 1 }, ['nodes'], [1, 2]), { nodes: [1, 2], other: 1 });
});
