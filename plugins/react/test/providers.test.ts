import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appProviders, routeElementModule, standInsModule } from '../src/preview/providers';
import { exampleOf } from '../src/preview/replies';

const DIR = '.visual-editor/preview';

test('providers: the entry\'s wrappers kept in order, the router and Auth0 swapped, side effects left out', () => {
  const p = appProviders(
    'src/main.tsx',
    `import React from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { Auth0Provider } from '@auth0/auth0-react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { AuthProvider } from './auth/AuthContext'
import App from './App'
import './index.css'
const client = new QueryClient()
navigator.serviceWorker.register('/sw.js')
createRoot(document.getElementById('root')!).render(
  <React.StrictMode><Auth0Provider domain="x"><QueryClientProvider client={client}><AuthProvider><BrowserRouter><App /></BrowserRouter></AuthProvider></QueryClientProvider></Auth0Provider></React.StrictMode>,
)`,
    DIR,
  );
  assert.deepEqual(p.names, ['React.StrictMode', 'QueryClientProvider', 'AuthProvider']);
  assert.deepEqual(p.standIns, ['Auth0Provider']);
  assert.equal(p.hasRouter, true);
  assert.match(p.module, /import \{ AuthProvider \} from '..\/..\/src\/auth\/AuthContext'/);
  assert.match(p.module, /<PreviewAuth0 domain="x"><QueryClientProvider client=\{client\}><AuthProvider><PreviewRouter>\{children\}<\/PreviewRouter>/);
  assert.match(p.module, /const client = new QueryClient\(\)/);
  assert.doesNotMatch(p.module, /serviceWorker|index\.css|createRoot\(/);
  assert.match(standInsModule(p.standIns), /Auth0Context\.Provider/);
});

test('providers: only what the providers use comes along: an exported, multi-line client, and its import', () => {
  const p = appProviders(
    'src/main.tsx',
    `import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { registerSW } from 'virtual:pwa-register'
import App from './App'

// The client
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime:        1000 * 60,  // 1 minute
      refetchOnWindowFocus: false,
    },
  },
})
registerSW({ immediate: true })
const bc = new BroadcastChannel('sync')
bc.onmessage = () => void queryClient.invalidateQueries()
const root = document.getElementById('root')
createRoot(root).render(
  <QueryClientProvider client={queryClient}>
    <App />
  </QueryClientProvider>,
)`,
    DIR,
  );
  assert.deepEqual(p.names, ['QueryClientProvider']);
  assert.match(p.module, /^import \{ QueryClient, QueryClientProvider \} from '@tanstack\/react-query'$/m);
  assert.match(p.module, /^const queryClient = new QueryClient\(\{\n  defaultOptions: \{[\s\S]*\/\/ 1 minute[\s\S]*\}\)$/m);
  assert.doesNotMatch(p.module, /registerSW|BroadcastChannel|getElementById|from '..\/..\/src\/App'|createRoot|^export const/m);
});

test('providers: an entry that renders <App /> bare needs no providers', () => {
  const p = appProviders('src/main.tsx', `import { createRoot } from 'react-dom/client'\nimport App from './App'\ncreateRoot(root).render(<App />)`, DIR);
  assert.deepEqual(p.names, []);
  assert.match(p.module, /<>\{children\}<\/>/);
});

test('providers: a page is shown with its route\'s wrapper (a login guard); a bare route needs none', () => {
  const text = `import { Routes, Route } from 'react-router-dom'
import { RequireAuth } from './auth/RequireAuth'
import Admin from './pages/Admin'
import Home from './pages/Home'
export default function App() {
  return <Routes><Route path="/" element={<Home />} /><Route path="/admin" element={<RequireAuth role="admin"><Admin /></RequireAuth>} /></Routes>
}`;
  const m = routeElementModule('src/App.tsx', text, '/admin', DIR);
  assert.ok(m);
  assert.match(m, /import \{ RequireAuth \} from '..\/..\/..\/src\/auth\/RequireAuth'/);
  assert.match(m, /return \(<RequireAuth role="admin"><Admin \/><\/RequireAuth>\)/);
  assert.equal(routeElementModule('src/App.tsx', text, '/', DIR), undefined);
  // Route objects too.
  const objects = `import Guard from './Guard'\nimport Admin from './Admin'\nexport const routes = [{ path: '/admin', element: <Guard><Admin /></Guard> }]`;
  assert.match(routeElementModule('src/routes.tsx', objects, '/admin', DIR) ?? '', /<Guard><Admin \/><\/Guard>/);
});

test('replies: a page\'s total is a count, an order\'s is money; items take their owner\'s name', () => {
  const lineItems = { kind: 'array', item: { kind: 'object', fields: { name: { kind: 'string' } } } } as const;
  const order = { kind: 'object', fields: { id: { kind: 'string' }, total: { kind: 'number' }, items: lineItems } } as const;
  const page = exampleOf({ kind: 'object', fields: { items: { kind: 'array', item: order }, total: { kind: 'number' }, nextCursor: { kind: 'string' } } }, 'orders') as {
    total: number;
    items: { total: number; items: { name: string }[] }[];
  };
  assert.equal(page.total, 42);
  assert.equal(page.items[0].total, 1299);
  assert.deepEqual(page.items[0].items.map((i) => i.name), ['Order item 1', 'Order item 2', 'Order item 3']);
});
