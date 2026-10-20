import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { readContract } from '../src/contracts/readers';
import { check, exampleOf } from '../src/contracts/schema';
import { graphqlAnswer, checkGraphql } from '../src/contracts/graphql';
import { Contracts } from '../src/contracts/contracts';
import { Fakes } from '../src/proxy/fakes';
import { AppProxy } from '../src/proxy/proxy';
import { CALL_HEADER } from '../src/proxy/inspector';

const OPENAPI = `
openapi: 3.0.3
info: { title: Shop }
servers: [{ url: https://api.shop.test/v1 }]
paths:
  /orders/{orderId}:
    get:
      summary: One order
      responses:
        '200':
          content:
            application/json:
              schema: { $ref: '#/components/schemas/Order' }
        '404':
          content:
            application/json:
              example: { error: not found }
  /orders:
    get:
      responses:
        '200':
          content:
            application/json:
              schema: { type: array, items: { $ref: '#/components/schemas/Order' } }
components:
  schemas:
    Order:
      type: object
      required: [id, total, status, customer]
      properties:
        id: { type: integer }
        total: { type: number }
        status: { type: string, enum: [new, paid, sent] }
        createdAt: { type: string, format: date-time }
        customer: { $ref: '#/components/schemas/Customer' }
    Customer:
      allOf:
        - { $ref: '#/components/schemas/Person' }
        - { type: object, properties: { vip: { type: boolean } } }
    Person:
      type: object
      required: [email]
      properties: { name: { type: string }, email: { type: string } }
`;

test('contracts: OpenAPI (YAML, refs, allOf, the server’s path), examples made from shapes, checks', () => {
  const c = readContract('openapi.yaml', OPENAPI)!;
  assert.equal(c.kind, 'openapi');
  assert.equal(c.title, 'Shop');
  assert.deepEqual(c.operations.map((o) => o.id), ['GET /v1/orders/:orderId', 'GET /v1/orders']);
  const one = c.operations[0];
  assert.deepEqual(one.responses.map((r) => r.status), ['200', '404']);
  assert.deepEqual(one.responses[1].example, { error: 'not found' });
  const order = exampleOf(one.responses[0].schema, c.resolve) as Record<string, any>;
  assert.equal(typeof order.id, 'number');
  assert.equal(order.status, 'new');
  assert.match(order.createdAt, /^\d{4}-\d\d-\d\dT/);
  assert.match(order.customer.email, /@example\.com$/);
  assert.equal(typeof order.customer.vip, 'boolean');
  const list = exampleOf(c.operations[1].responses[0].schema, c.resolve) as any[];
  assert.equal(list.length, 3);
  assert.notDeepEqual(list[0], list[1], 'list items differ');
  // A real answer that doesn't fit.
  const issues = check(one.responses[0].schema, { id: 'x', total: 3, status: 'lost', customer: {} }, c.resolve);
  assert.deepEqual(issues, ['id: the contract says integer, it was text', 'status: "lost" isn\'t one of "new", "paid", "sent"', 'customer.email: missing (the contract requires it)']);
  assert.deepEqual(check(one.responses[0].schema, order, c.resolve), []);
});

test('contracts: Swagger 2, Postman, HAR, JSON Schema', () => {
  const sw = readContract('swagger.json', JSON.stringify({ swagger: '2.0', basePath: '/api', paths: { '/users/{id}': { get: { responses: { 200: { schema: { $ref: '#/definitions/User' } } } } } }, definitions: { User: { type: 'object', properties: { name: { type: 'string' } } } } }))!;
  assert.equal(sw.kind, 'swagger');
  assert.equal(sw.operations[0].id, 'GET /api/users/:id');
  assert.equal((exampleOf(sw.operations[0].responses[0].schema, sw.resolve) as any).name, 'Ada Lovelace');

  const pm = readContract('shop.postman_collection.json', JSON.stringify({ info: { _postman_id: 'x', name: 'Shop' }, item: [{ name: 'Orders', item: [{ name: 'One order', request: { method: 'GET', url: { raw: '{{baseUrl}}/api/orders/42' } }, response: [{ code: 200, body: '{"id":42,"total":9.5}' }] }] }] }))!;
  assert.equal(pm.kind, 'postman');
  assert.equal(pm.operations[0].id, 'GET /api/orders/:id');
  assert.deepEqual(pm.operations[0].responses[0].example, { id: 42, total: 9.5 });

  const har = readContract('session.har', JSON.stringify({ log: { entries: [{ request: { method: 'GET', url: 'http://localhost:8080/api/me' }, response: { status: 200, content: { mimeType: 'application/json', text: '{"name":"Ada"}' } } }, { request: { method: 'GET', url: 'http://localhost:8080/logo.png' }, response: { status: 200, content: { mimeType: 'image/png' } } }] } }))!;
  assert.deepEqual(har.operations.map((o) => o.id), ['GET /api/me']);
  assert.deepEqual(check(har.operations[0].responses[0].schema, { name: 3 }, har.resolve), ['name: the contract says string, it was number']);

  const js = readContract('order.schema.json', JSON.stringify({ $schema: 'https://json-schema.org/draft/2020-12/schema', title: 'Order', type: 'object', properties: { item: { $ref: '#/$defs/Item' } }, $defs: { Item: { type: 'object', properties: { price: { type: 'number' } } } } }))!;
  assert.equal(js.kind, 'json-schema');
  assert.equal(typeof (exampleOf({ $ref: '#/types/Order' }, js.resolve) as any).item.price, 'number');
});

test('contracts: TypeScript types and Zod schemas, read from the code', () => {
  const ts = readContract('types.ts', `
    export interface Base { id: string }
    export interface Order extends Base { total: number; status: 'new' | 'paid'; note?: string; lines: Line[]; at: Date; owner: User | null }
    type Line = { sku: string; qty: number };
    export type User = { email: string; tags: Array<string> };
  `)!;
  assert.equal(ts.kind, 'typescript');
  assert.deepEqual(Object.keys(ts.types).sort(), ['Base', 'Line', 'Order', 'User']);
  const o = exampleOf({ $ref: '#/types/Order' }, ts.resolve) as Record<string, any>;
  assert.equal(typeof o.id, 'string');
  assert.equal(o.status, 'new');
  assert.equal(o.lines.length, 3);
  assert.equal(typeof o.lines[0].qty, 'number');
  assert.match(o.owner.email, /@/);
  assert.deepEqual(check({ $ref: '#/types/Order' }, { ...o, status: 'gone', owner: null }, ts.resolve), ['status: "gone" isn\'t one of "new", "paid"']);
  const { total: _t, ...noTotal } = o;
  assert.deepEqual(check({ $ref: '#/types/Order' }, noTotal, ts.resolve), ['total: missing (the contract requires it)']);

  const zod = readContract('schemas.ts', `
    import { z } from 'zod';
    export const UserSchema = z.object({ email: z.string().email(), age: z.number().int().optional(), role: z.enum(['admin', 'user']) });
    export const Team = z.object({ name: z.string(), members: z.array(UserSchema).min(2) });
  `)!;
  assert.equal(zod.kind, 'zod');
  const team = exampleOf({ $ref: '#/types/Team' }, zod.resolve) as Record<string, any>;
  assert.match(team.members[0].email, /@example\.com$/);
  assert.equal(team.members[0].role, 'admin');
  assert.deepEqual(check({ $ref: '#/types/User' }, { email: 'a@b.c' }, zod.resolve), ['role: missing (the contract requires it)'], 'age is optional');
});

test('contracts: GraphQL answers have exactly what the query asks for', () => {
  const c = readContract('schema.graphql', `
    type Query { order(id: ID!): Order, orders: [Order!]! }
    type Order { id: ID!, total: Float!, status: Status!, customer: Customer, createdAt: String }
    type Customer { name: String, email: String! }
    enum Status { NEW PAID }
  `)!;
  assert.equal(c.kind, 'graphql');
  const req = { query: 'query One { order(id: 1) { id status buyer: customer { email } ...F } } fragment F on Order { __typename total }' };
  const a = graphqlAnswer(c.graphql!, req) as any;
  assert.deepEqual(Object.keys(a.data.order).sort(), ['__typename', 'buyer', 'id', 'status', 'total']);
  assert.equal(a.data.order.__typename, 'Order');
  assert.equal(a.data.order.status, 'NEW');
  assert.match(a.data.order.buyer.email, /@example\.com$/);
  assert.equal(typeof a.data.order.total, 'number');
  assert.equal((graphqlAnswer(c.graphql!, { query: '{ orders { id } }' }) as any).data.orders.length, 3);
  assert.deepEqual(checkGraphql(c.graphql!, req, a), []);
  assert.deepEqual(checkGraphql(c.graphql!, req, { data: { order: { id: '1', status: 'LOST', __typename: 'Order', total: 'x' } } }), ['data.order.status: "LOST" isn\'t one of Status\'s values', 'data.order.buyer: missing (the query asks for it)', 'data.order.total: the schema says Float, it was text']);
});

function serve(server: Server): Promise<string> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`)));
}

test('contracts: found in the project, listed in contracts.json (types mapped to endpoints, an address), faked from, and answers checked', async () => {
  const root = mkdtempSync(join(tmpdir(), 've-contracts-'));
  mkdirSync(join(root, 'docs'));
  mkdirSync(join(root, 'node_modules', 'x'), { recursive: true });
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'docs', 'openapi.yaml'), OPENAPI.replace('https://api.shop.test/v1', '/api'));
  writeFileSync(join(root, 'node_modules', 'x', 'openapi.yaml'), OPENAPI);
  writeFileSync(join(root, 'src', 'types.ts'), 'export interface Me { name: string; email: string }');
  mkdirSync(join(root, '.visual-editor'));
  writeFileSync(join(root, '.visual-editor', 'contracts.json'), JSON.stringify({ sources: ['src/types.ts', 'http://backend.test/schema'], map: { 'GET /api/me': 'Me' } }));
  const contracts = new Contracts(root, async (url) => (url === 'http://backend.test/schema' ? 'type Query { hello: String }' : undefined));
  await contracts.load();
  assert.deepEqual(contracts.list.map((c) => `${c.kind} ${c.source}`), ['openapi docs/openapi.yaml', 'typescript src/types.ts', 'graphql http://backend.test/schema', 'json-schema .visual-editor/contracts.json']);
  assert.equal(contracts.find('GET', '/api/orders/7')?.operation.id, 'GET /api/orders/:orderId');
  assert.equal(contracts.find('GET', '/api/me')?.operation.id, 'GET /api/me');

  const backend = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(req.url === '/api/me' ? { name: 'Ada' } : [{ id: 1, total: 2, status: 'paid', customer: { email: 'a@b.c' } }]));
  });
  const origin = await serve(backend);
  const fakes = new Fakes(root, () => contracts);
  fakes.save({ id: 'get-api-orders-{id}', method: 'GET', path: '/api/orders/:id', use: 'contract', cases: { contract: { contract: { operation: 'GET /api/orders/:orderId' } }, missing: { contract: { operation: 'GET /api/orders/:orderId', status: '404' } } } });
  const proxy = new AppProxy(async () => origin, { fakes: () => fakes, contracts: () => contracts });
  const at = await proxy.start(5680);
  const call = (path: string) => fetch(`${at}${path}`, { headers: { [CALL_HEADER]: '1' } });
  try {
    // Faked from the contract: made from its shape.
    const one = await call('/api/orders/7');
    assert.equal(one.status, 200);
    const body = await one.json();
    assert.ok(['new', 'paid', 'sent'].includes(body.status));
    assert.match(body.customer.email, /@example\.com$/);
    fakes.save({ ...fakes.endpoints[0], use: 'missing' });
    const gone = await call('/api/orders/7');
    assert.equal(gone.status, 404);
    assert.deepEqual(await gone.json(), { error: 'not found' });
    // Real answers checked: the list fits, /api/me lacks the email its type requires.
    await call('/api/orders');
    await call('/api/me');
    const checked = Object.fromEntries(proxy.records.map((r) => [`${r.url} ${r.faked?.case ?? 'real'}`, r.contract?.issues]));
    assert.deepEqual(checked, { '/api/orders/7 contract': [], '/api/orders/7 missing': [], '/api/orders real': [], '/api/me real': ['email: missing (the contract requires it)'] });
  } finally {
    await proxy.stop();
    backend.closeAllConnections();
    backend.close();
  }
});
