import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exampleOf, replyRules } from '../src/preview/replies';

test('replies: examples from shapes, by name and kind; lists of three that differ', () => {
  const list = exampleOf({ kind: 'array', item: { kind: 'object', fields: { id: {}, title: {}, total: { kind: 'number' }, owner: { kind: 'object', fields: { email: {} } } } } }, 'orders') as Record<string, unknown>[];
  assert.equal(list.length, 3);
  assert.deepEqual(list.map((o) => o.id), ['id-1042', 'id-1043', 'id-1044']);
  assert.equal(list[0].title, 'Order dashboard');
  assert.equal(list[1].title, 'Order dashboard 2');
  assert.equal(typeof list[0].total, 'number');
  assert.notEqual(list[0].total, list[1].total);
  assert.deepEqual(list[0].owner, { email: 'ada@example.com' });
  // A field named like a number is a number even when the code never says.
  assert.equal(typeof exampleOf({}, 'price'), 'number');
});

test('replies: rules for reads only, longest address first', () => {
  const rules = replyRules([
    { match: '/api/orders', method: 'GET', shape: { kind: 'array', item: {} } },
    { match: '/api/orders/', method: 'GET', shape: { kind: 'object', fields: { id: {} } } },
    { match: '/api/orders', method: 'POST', shape: {} },
    { match: '"projects"', method: 'QUERY', shape: { kind: 'array', item: {} } },
  ]);
  assert.deepEqual(rules.map((r) => r.match), ['/api/orders/', '/api/orders', '"projects"']);
});
