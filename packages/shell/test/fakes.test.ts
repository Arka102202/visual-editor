import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { endpointId, Fakes, fits, patch, patternFor, FAKES_DIR } from '../src/proxy/fakes';
import { AppProxy } from '../src/proxy/proxy';
import { CALL_HEADER } from '../src/proxy/inspector';

test('fakes: file names, address patterns, and changing fields', () => {
  assert.equal(endpointId('GET', '/api/orders/:id'), 'get-api-orders-{id}');
  assert.equal(endpointId('POST', '/v1/items', 'http://localhost:8080'), 'post-localhost-8080-v1-items');
  assert.equal(patternFor('/api/orders/1042/items/7?x=1'), '/api/orders/:id/items/:id2');
  assert.equal(patternFor('/api/users/3f2a9c1e-5b7d-4e2a-9f1c-8d6e4b2a7c90'), '/api/users/:id');
  assert.ok(fits('/api/orders/:id', '/api/orders/7?x=1'));
  assert.ok(!fits('/api/orders/:id', '/api/orders/7/items'));
  assert.ok(fits('/api/*', '/api/orders/7/items'));
  assert.deepEqual(patch({ items: [{ status: 'new' }], total: 1 }, { 'items.0.status': 'paid', total: 9 }), { items: [{ status: 'paid' }], total: 9 });
});

test('fakes: kept in the project; the case in use, a scenario winning over it, the most specific pattern', () => {
  const root = mkdtempSync(join(tmpdir(), 've-fakes-'));
  const fakes = new Fakes(root);
  fakes.save({ id: 'get-api-orders', method: 'GET', path: '/api/orders', use: 'empty', cases: { empty: { body: [] }, down: { status: 500, body: { error: 'down' } } } });
  fakes.save({ id: 'get-api-all', method: 'GET', path: '/api/*', use: 'pass', cases: {} });
  assert.ok(readFileSync(join(root, FAKES_DIR, 'get-api-orders.json'), 'utf8').includes('"empty"'));
  const again = new Fakes(root);
  assert.equal(again.find('GET', '/api/orders')?.id, 'get-api-orders', 'the most specific pattern');
  const d = again.decide('GET', '/api/orders');
  assert.equal(d.kind, 'answer');
  assert.equal(d.kind === 'answer' && d.body.toString(), '[]');
  again.saveScenarios({ active: 'server down', scenarios: { 'server down': { 'get-api-orders': 'down' } } });
  const s = new Fakes(root).decide('GET', '/api/orders');
  assert.equal(s.kind === 'answer' && s.status, 500, 'the scenario wins');
  assert.equal(new Fakes(root).decide('POST', '/api/orders').kind, 'pass');
});

function serve(server: Server): Promise<string> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`)));
}

test('fakes: the proxy answers, changes the answer, fails, or passes with the developer’s headers', async () => {
  const seen: Record<string, string | undefined>[] = [];
  const backend = createServer((req, res) => {
    seen.push({ url: req.url, auth: req.headers.authorization });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ items: [{ id: 1, status: 'new' }], total: 1 }));
  });
  const origin = await serve(backend);
  const root = mkdtempSync(join(tmpdir(), 've-fakes-'));
  const fakes = new Fakes(root);
  fakes.save({ id: 'get-api-orders', method: 'GET', path: '/api/orders', use: 'one paid', cases: { 'one paid': { pass: true, patch: { 'items.0.status': 'paid' }, status: 201 } } });
  fakes.save({ id: 'get-api-me', method: 'GET', path: '/api/me', use: 'ada', cases: { ada: { body: { name: 'Ada' }, delay: 30 } } });
  fakes.save({ id: 'post-api-pay', method: 'POST', path: '/api/pay', use: 'offline', cases: { offline: { network: true } } });
  const proxy = new AppProxy(async () => origin, { fakes: () => fakes, headers: () => ({ Authorization: 'Bearer secret' }) });
  const at = await proxy.start(5650);
  const call = (path: string, init: RequestInit = {}) => fetch(`${at}${path}`, { ...init, headers: { [CALL_HEADER]: '1' } });
  try {
    // Answered by the fake (after its delay): the backend never hears of it.
    const me = await call('/api/me');
    assert.deepEqual(await me.json(), { name: 'Ada' });
    // Passed on, then changed: another status, a field set.
    const orders = await call('/api/orders');
    assert.equal(orders.status, 201);
    assert.equal((await orders.json()).items[0].status, 'paid');
    // Failed like a dropped connection.
    await assert.rejects(call('/api/pay', { method: 'POST', body: '{}' }));
    // Passed through, with the developer's header added.
    await call('/api/other');
    assert.deepEqual(seen.map((s) => s.url), ['/api/orders', '/api/other']);
    assert.ok(seen.every((s) => s.auth === 'Bearer secret'));
    const faked = proxy.records.filter((r) => r.faked).map((r) => `${r.url} ${r.faked!.case} ${r.status ?? r.error}`);
    assert.deepEqual(faked.sort(), ['/api/me ada 200', '/api/orders one paid 201', '/api/pay offline failed on purpose (a fake): the connection dropped'].sort());
  } finally {
    await proxy.stop();
    backend.closeAllConnections();
    backend.close();
  }
});
