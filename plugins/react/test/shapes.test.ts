import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { readShapes, type ReplyShape } from '../src/read/shapes';

const shapes = (files: Record<string, string>) => readShapes(Object.entries(files).map(([path, text]) => ({ path, text })));
const find = (all: ReplyShape[], match: string) => {
  const r = all.find((x) => x.match === match);
  assert.ok(r, `no shape for ${match}; have ${all.map((x) => x.match).join(', ')}`);
  return r.shape;
};

test('shapes: fetch into state, mapped, and passed down to a child that formats numbers', () => {
  const all = shapes({
    'src/Orders.jsx': `
      import { useEffect, useState } from 'react'
      import { OrderList } from './OrderList'
      export function Orders() {
        const [orders, setOrders] = useState([])
        useEffect(() => { fetch('/api/orders?page=1').then((r) => r.json()).then(setOrders) }, [])
        return <section><h2>{orders.length} orders</h2><OrderList orders={orders} /></section>
      }`,
    'src/OrderList.jsx': `
      export function OrderList({ orders }) {
        return orders.map((o) => <div key={o.id}>{o.customer.name}: {o.total.toFixed(2)} <small>{o.status.toUpperCase()}</small></div>)
      }`,
  });
  assert.deepEqual(find(all, '/api/orders'), {
    kind: 'array',
    item: { kind: 'object', fields: { id: {}, customer: { kind: 'object', fields: { name: {} } }, total: { kind: 'number' }, status: { kind: 'string' } } },
  });
});

test('shapes: React Query through an API helper in another file; destructured items', () => {
  const all = shapes({
    'src/api.js': `export const api = { listProjects: () => fetch('/api/projects').then((r) => r.json()) }`,
    'src/Projects.jsx': `
      import { useQuery } from '@tanstack/react-query'
      import { api } from './api'
      export function Projects() {
        const { data: page, isLoading } = useQuery({ queryKey: ['projects'], queryFn: () => api.listProjects() })
        if (isLoading) return null
        const { items, total } = page
        return <div>{total} · {items.map(({ title, owner }) => <p key={title}>{title} by {owner.email}</p>)}</div>
      }`,
  });
  assert.deepEqual(find(all, '/api/projects'), {
    kind: 'object',
    fields: { items: { kind: 'array', item: { kind: 'object', fields: { title: {}, owner: { kind: 'object', fields: { email: {} } } } } }, total: {} },
  });
});

test('shapes: SWR by address, await with axios, and a props object', () => {
  const all = shapes({
    'src/Me.jsx': `
      import useSWR from 'swr'
      export function Me() {
        const { data } = useSWR('/api/me', fetcher)
        return <Avatar user={data} />
      }
      function Avatar(props) { return <img alt={props.user.name} src={props.user.photo} /> }`,
    'src/Stats.jsx': `
      import axios from 'axios'
      import { useEffect, useState } from 'react'
      export function Stats() {
        const [stats, setStats] = useState(null)
        useEffect(() => { (async () => { const { data } = await axios.get('/api/stats'); setStats(data.summary) })() }, [])
        return <b>{stats?.visits.toFixed(0)}</b>
      }`,
  });
  assert.deepEqual(find(all, '/api/me'), { kind: 'object', fields: { name: {}, photo: {} } });
  assert.deepEqual(find(all, '/api/stats'), { kind: 'object', fields: { summary: { kind: 'object', fields: { visits: { kind: 'number' } } } } });
});

test('shapes: the sample app (axios hook, fetch chain, axios instance)', () => {
  const root = 'plugins/react/test/fixtures/web';
  const files: Record<string, string> = {};
  const walkDir = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walkDir(p);
      else if (/\.[jt]sx?$/.test(n)) files[relative(root, p)] = readFileSync(p, 'utf8');
    }
  };
  walkDir(root);
  const all = shapes(files);
  assert.deepEqual(find(all, '/api/products/'), { kind: 'object', fields: { name: {} } });
  assert.deepEqual(find(all, '/api/orders'), { kind: 'array', item: { kind: 'object', fields: { id: {} } } });
  assert.deepEqual(find(all, '/me'), { kind: 'object', fields: { name: {} } });
});
