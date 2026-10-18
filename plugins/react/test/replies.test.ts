import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exampleOf, replyRules } from '../src/preview/replies';

test('replies: examples from shapes, by name and kind; lists of three that differ', () => {
  const list = exampleOf({ kind: 'array', item: { kind: 'object', fields: { id: {}, title: {}, total: { kind: 'number' }, owner: { kind: 'object', fields: { email: {} } } } } }, 'orders') as Record<string, unknown>[];
  assert.equal(list.length, 3);
  assert.deepEqual(list.map((o) => o.id), ['id-1042', 'id-1043', 'id-1044']);
  assert.equal(list[0].title, 'Order 1');
  assert.equal(list[1].title, 'Order 2');
  assert.equal(typeof list[0].total, 'number');
  assert.notEqual(list[0].total, list[1].total);
  assert.deepEqual(list[0].owner, { email: 'ada@example.com' });
  // People get people's names; dates stay dates across a list.
  const people = exampleOf({ kind: 'array', item: { kind: 'object', fields: { name: {}, email: {}, joinedAt: { kind: 'date' } } } }, 'users') as Record<string, unknown>[];
  assert.deepEqual(people.map((p) => p.name), ['Ada Lovelace', 'Grace Hopper', 'Alan Turing']);
  assert.ok(people.every((p) => !Number.isNaN(Date.parse(p.joinedAt as string))));
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
