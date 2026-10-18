import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { analyzeProject, type SourceFile } from '../src/read/analyzer';
import { suggestName } from '../src/read/apiReport';
import { loadAliases } from '../src/read/resolve';

const root = 'plugins/react/test/fixtures/web';
const sources: SourceFile[] = [];
const walk = (dir: string) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else sources.push({ path: relative(root, p), text: readFileSync(p, 'utf8') });
  }
};
walk(root);
const model = analyzeProject(
  sources.filter((s) => /\.[jt]sx?$/.test(s.path)),
  loadAliases(sources.filter((s) => s.path === 'jsconfig.json')),
);
const api = (id: string) => {
  const a = model.apis.find((x) => `${x.method} ${x.url}` === id);
  assert.ok(a, `endpoint ${id} not found; have ${model.apis.map((x) => `${x.method} ${x.url}`).join(', ')}`);
  return a;
};
const callers = (id: string) =>
  api(id).callers.map((c) => `${c.component.split('#')[1]} ${c.trigger ?? '?'} ${c.via ? `via ${c.via}` : 'direct'}`);
const issues = (id: string) => api(id).issues.map((i) => i.kind);

test('works out readable addresses from any way of writing them', () => {
  assert.deepEqual(model.apis.map((a) => `${a.method} ${a.url}`).sort(), [
    'DELETE /api/orders/:id', // template literal → :id
    'GET /api/features',
    'GET /api/orders', // literal, helper function ordersUrl(), and api object
    'GET /api/products/:id', // '/api/products/' + id
    'GET http://localhost:4000/api/health',
    'GET {VITE_API_URL}/me', // axios.create({ baseURL: import.meta.env.VITE_API_URL })
    'POST /api/checkout/resume',
    'POST /api/checkout/session',
    'POST /api/orders', // fetch(url, { method: 'POST' })
    'POST {VITE_API_URL}/me/avatar',
  ]);
});

test('names the component that triggers each request, how, and when', () => {
  assert.deepEqual(callers('GET /api/orders'), [
    'Dashboard load direct', // inside a local load() that useEffect calls
    'Orders load via api.getOrders',
    'OrderWidget load direct',
  ]);
  assert.deepEqual(callers('GET {VITE_API_URL}/me'), ['Profile load direct', 'Profile action direct']); // useEffect + handleRefresh
  assert.deepEqual(callers('POST {VITE_API_URL}/me/avatar'), ['Profile action direct']); // onSubmit
  assert.deepEqual(callers('POST /api/orders'), ['Cart action via useCheckout']); // a hook's submit()
  assert.deepEqual(callers('POST /api/checkout/session'), ['Cart action via useCheckout']); // returned, called from onClick
  // Handed to addEventListener inside an effect (not run on load) and run from a handler → on action.
  assert.deepEqual(callers('POST /api/checkout/resume'), ['Cart action via useCheckout']);
  assert.deepEqual(callers('DELETE /api/orders/:id'), ['Orders action via api.cancelOrder']);
  assert.deepEqual(api('GET /api/orders').callers.find((c) => c.component.endsWith('#Dashboard'))?.pages, ['/dashboard']);
});

test('flags an API handled in several places and proposes reusing the existing function', () => {
  const orders = api('GET /api/orders');
  assert.equal(orders.requestSites, 3);
  const multiple = orders.issues.find((i) => i.kind === 'multiple-handlers')!;
  assert.match(multiple.proposal.summary, /Reuse the existing api\.getOrders/);
  assert.equal(multiple.places.length, 3);
});

test('proposes a new shared function, written with the project\'s own client', () => {
  const me = api('GET {VITE_API_URL}/me').issues.find((i) => i.kind === 'multiple-handlers')!;
  assert.match(me.proposal.summary, /getMe\(\)/);
  assert.equal(me.proposal.snippet, "export async function getMe() {\n  const { data } = await http.get('/me')\n  return data\n}");
});

test('flags the same request loaded twice on one screen', () => {
  const double = api('GET /api/orders').issues.find((i) => i.kind === 'double-load')!;
  assert.match(double.message, /Dashboard loads .* and so does OrderWidget/);
  assert.match(double.proposal.summary, /Load it once in Dashboard/);
});

test('flags inconsistent addresses, hard-coded hosts and missing error states', () => {
  assert.ok(issues('GET /api/orders').includes('inconsistent-url')); // ordersUrl() vs '/api/orders'
  const host = api('GET http://localhost:4000/api/health').issues.find((i) => i.kind === 'hardcoded-host')!;
  assert.match(host.proposal.summary, /VITE_API_URL/); // reuses the env variable the project already has
  assert.deepEqual(issues('GET /api/features'), ['no-error-state']);
  assert.ok(!issues('GET {VITE_API_URL}/me').includes('no-error-state')); // Profile shows an error
});

test('flags project-wide problems: scattered requests and mixed clients', () => {
  const kinds = model.apiIssues.map((i) => i.kind);
  assert.deepEqual(kinds, ['scattered', 'mixed-clients']);
  const scattered = model.apiIssues[0];
  assert.match(scattered.proposal.summary, /existing API file, src\/api\/client\.js/);
  assert.ok(scattered.proposal.steps.some((s) => s.includes('api.getOrders() already exists')));
  assert.match(model.apiIssues[1].message, /fetch \(\d+\), axios \(\d+\)/);
});

test('suggests clear function names', () => {
  assert.equal(suggestName('GET', '/api/orders'), 'getOrders');
  assert.equal(suggestName('GET', '/api/orders/:id'), 'getOrder');
  assert.equal(suggestName('POST', '/api/categories'), 'createCategory');
  assert.equal(suggestName('PATCH', '/v1/users/:id'), 'updateUser');
  assert.equal(suggestName('DELETE', '/api/order-items/:id'), 'deleteOrderItem');
});
