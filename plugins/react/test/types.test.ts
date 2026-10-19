import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { reactPlugin, previews } from '../src/plugin';
import { readShapesAndBindings } from '../src/read/shapes';
import { TypeView } from '../src/read/types';

// The repository's TypeScript 5 stands in for the project's own.
const ts = createRequire(__filename)('typescript-5');
const root = resolve('plugins/react/test/fixtures/ts-shop');
const files: { path: string; text: string }[] = [];
const walk = (d: string) => {
  for (const n of readdirSync(d)) {
    const p = join(d, n);
    if (statSync(p).isDirectory()) walk(p);
    else files.push({ path: relative(root, p), text: readFileSync(p, 'utf8') });
  }
};
walk(root);
const code = files.filter((f) => /\.tsx?$/.test(f.path));

test('types: the reader follows project references and reads a reply\'s exact type', () => {
  const view = new TypeView(ts, root);
  const { bindings } = readShapesAndBindings(code);
  const orders = bindings.find((b) => b.match === '/api/orders');
  assert.ok(orders, `bindings: ${JSON.stringify(bindings)}`);
  const shape = view.shapeOf(view.typeAt(orders.path, orders.start)!)!;
  const item = shape.fields!.items.item!;
  assert.deepEqual(item.fields!.status, { kind: 'string', values: ['new', 'paid', 'shipped', 'cancelled'] });
  assert.deepEqual(item.fields!.customer.fields!.role, { kind: 'string', values: ['admin', 'staff', 'customer'] });
  assert.deepEqual(item.fields!.placedAt, { kind: 'date' });
  assert.equal(item.fields!.items.kind, 'array');
  assert.deepEqual(shape.fields!.nextCursor, { kind: 'string' });
});

test('types: previews get example data and props that match the types exactly', async () => {
  previews.fallbackTypeScript = ts;
  const reader = reactPlugin.readers![0];
  const project = { root, name: 'ts-shop', files: files.map((f) => f.path), packageJson: { dependencies: { react: '19' } } };
  await reader.read(files.filter((f) => reader.wants(f.path)), project);
  // What previews need is worked out when the first one opens (not on every read).
  assert.equal((previews as any).known.get(root).extras, undefined);
  await (previews as any).extrasFor((previews as any).known.get(root));
  const rules = (previews as any).rulesFor(root, (previews as any).known.get(root));
  const list = rules.find((r: any) => r.match === '/api/orders').reply;
  assert.equal(list.items.length, 3);
  assert.deepEqual(list.items.map((o: any) => o.status), ['new', 'paid', 'shipped']);
  assert.ok(['admin', 'staff', 'customer'].includes(list.items[0].customer.role));
  assert.ok(!Number.isNaN(Date.parse(list.items[0].placedAt)));
  assert.equal(typeof list.items[0].items[0].price, 'number');
  assert.equal(typeof list.total, 'number');
  const detail = rules.find((r: any) => r.match === '/api/orders/').reply;
  assert.equal(detail.customer.email, 'ada@example.com');
  // The detail reply has every field of Order, not only the one the page reads (id).
  assert.ok(detail.items && detail.total !== undefined && detail.status);

  const card = (previews as any).known.get(root).model.components.find((c: any) => c.name === 'OrderCard');
  const props = (previews as any).propsFor(root, card, () => undefined);
  assert.deepEqual(props.onOpen, { __visualEditorCallback: 'onOpen' });
  assert.equal(props.tone, 'calm');
  assert.equal(typeof props.compact, 'boolean');
  assert.equal(props.order.status, 'new');
});
