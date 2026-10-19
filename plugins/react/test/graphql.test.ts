import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fitToType, operationShape, parseDocument, readGraphql } from '../src/read/graphql';
import { exampleOf } from '../src/preview/replies';
import { installSituations } from '../src/preview/situations';

const files = [
  {
    path: 'src/graphql/orders.ts',
    text: `import { gql } from '@apollo/client'
export const ORDER_FIELDS = gql\`
  fragment OrderFields on Order { id total status customer { name email } }
\`
export const GET_ORDERS = gql\`
  # every order, newest first
  query GetOrders($first: Int = 10) {
    orders(first: $first) @connection(key: "orders") { ...OrderFields lineItems: items { sku quantity } }
    viewer { id ... on Admin { permissions } }
  }
  \${ORDER_FIELDS}
\``,
  },
  {
    path: 'src/pages/Orders.tsx',
    text: `import { useQuery, useMutation } from '@apollo/client'
import { GET_ORDERS } from '../graphql/orders'
import { gql } from '@apollo/client'
const CANCEL = gql\`mutation CancelOrder($id: ID!) { cancelOrder(id: $id) { id status } }\`
export function Orders() {
  const { data, loading } = useQuery(GET_ORDERS)
  const [cancel] = useMutation(CANCEL)
  return null
}`,
  },
  {
    path: 'src/pages/Me.tsx',
    text: `import { useQuery } from 'urql'\nimport { graphql } from '../gql'\nconst ME = graphql(\`query Me { me { name } }\`)\nexport function Me() { const [{ data }] = useQuery({ query: ME }); return null }`,
  },
];

test('graphql: operations, fragments, aliases and where results are kept', () => {
  const read = readGraphql(files);
  assert.deepEqual([...read.operations.keys()].sort(), ['CancelOrder', 'GetOrders', 'Me']);
  assert.equal(read.operations.get('CancelOrder')!.kind, 'mutation');
  assert.deepEqual(read.uses.map((u) => u.operation).sort(), ['CancelOrder', 'GetOrders', 'Me']);
  const orders = read.uses.find((u) => u.operation === 'GetOrders')!;
  assert.ok(orders.start! > 0 && !orders.member);
  assert.ok(read.uses.find((u) => u.operation === 'Me')!.start);
  const shape = operationShape(read.operations.get('GetOrders')!, read.fragments);
  const order = shape.fields!.orders.item!;
  assert.deepEqual(Object.keys(order.fields!).sort(), ['__typename', 'customer', 'id', 'lineItems', 'status', 'total']);
  assert.deepEqual(order.fields!.__typename, { kind: 'string', values: ['Order'] });
  assert.equal(order.fields!.lineItems.kind, 'array');
  assert.deepEqual(shape.fields!.viewer.fields!.__typename.values, ['Admin']);
  assert.ok(shape.fields!.viewer.fields!.permissions);
  // The example reply has every field asked for.
  const data = exampleOf(shape, 'data') as any;
  assert.equal(data.orders.length, 3);
  assert.equal(data.orders[0].__typename, 'Order');
  assert.ok(data.orders[0].customer.email.includes('@'));
});

test('graphql: a type makes kinds exact but keeps only the fields asked for', () => {
  const sel = { kind: 'object' as const, fields: { order: { kind: 'object' as const, fields: { id: {}, tags: {}, __typename: { kind: 'string' as const, values: ['Order'] } } } } };
  const typed = { kind: 'object' as const, fields: { order: { kind: 'object' as const, fields: { id: { kind: 'string' as const }, tags: { kind: 'array' as const, item: { kind: 'string' as const } }, secret: { kind: 'string' as const } } } } };
  const fit = fitToType(typed, sel);
  assert.deepEqual(Object.keys(fit.fields!.order.fields!).sort(), ['__typename', 'id', 'tags']);
  assert.equal(fit.fields!.order.fields!.tags.kind, 'array');
});

test('graphql: a document without a name, and comments and strings, read cleanly', () => {
  const defs = parseDocument('{ hello(name: "a } b") # not { this\n }');
  assert.equal(defs.length, 1);
  assert.deepEqual(defs[0].fields, [{ key: 'hello' }]);
});

test('situations: GraphQL requests get the reply for their operation only', async () => {
  const sent: string[] = [];
  class FakeResponse {
    constructor(readonly body: string, readonly init: { status: number }) {}
    get status() { return this.init.status; }
    async json() { return JSON.parse(this.body); }
  }
  const win: any = { fetch: async (u: string) => (sent.push(u), new FakeResponse('{"real":true}', { status: 200 })), Response: FakeResponse, URL };
  installSituations({ id: 'normal', fixtures: { situations: { normal: { requests: [{ match: '', operation: 'GetOrders', reply: { data: { orders: [] } }, wait: 0 }, { match: '/api', reply: { rest: true }, wait: 0 }] } } }, log: () => () => {}, win });
  const ask = async (op: string) => (await win.fetch('/api/graphql', { method: 'POST', body: JSON.stringify({ operationName: op, query: `query ${op} { x }` }) })).json();
  assert.deepEqual(await ask('GetOrders'), { data: { orders: [] } });
  // Another operation isn't answered by the REST rule for /api: it goes on to the server.
  assert.deepEqual(await ask('Other'), { real: true });
  assert.deepEqual(await (await win.fetch('/api/items')).json(), { rest: true });
});
