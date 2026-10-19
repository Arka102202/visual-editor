import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appProviders, appShell, appShellChain, routeElementModule, shellChain, standInsModule } from '../src/preview/providers';
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
  return <Routes>
    <Route path="/" element={<Home />} />
    <Route path="/admin" element={<RequireAuth role="admin"><Admin /></RequireAuth>} />
  </Routes>
}`;
  const m = routeElementModule('src/App.tsx', text, 7, DIR);
  assert.ok(m);
  assert.match(m, /import \{ RequireAuth \} from '..\/..\/..\/src\/auth\/RequireAuth'/);
  assert.match(m, /return \(<RequireAuth role="admin"><Admin \/><\/RequireAuth>\)/);
  assert.doesNotMatch(m, /Home|__VeRoutes/);
  assert.equal(routeElementModule('src/App.tsx', text, 6, DIR), undefined);
  // Route objects too.
  const objects = `import Guard from './Guard'\nimport Admin from './Admin'\nexport const routes = [\n  { path: '/admin', element: <Guard><Admin /></Guard> },\n]`;
  assert.match(routeElementModule('src/routes.tsx', objects, 3, DIR) ?? '', /<Guard><Admin \/><\/Guard>/);
});

test('providers: routes around a page (a guard, a layout) show it in their Outlet', () => {
  const text = `import { Route, Routes } from 'react-router-dom'
import { RequireAuth } from './RequireAuth'
import { Shell } from './Shell'
import { Orders } from './Orders'
import { Login } from './Login'
export const App = () => (
  <Routes>
    <Route path="/login" element={<Login />} />
    <Route element={<RequireAuth />}>
      <Route element={<Shell />}>
        <Route path="/orders" element={<Orders />} />
      </Route>
    </Route>
  </Routes>
)`;
  const m = routeElementModule('src/App.tsx', text, 10, DIR, 'react-router');
  assert.ok(m);
  assert.match(m, /import \{ Routes as __VeRoutes, Route as __VeRoute \} from 'react-router'/);
  assert.match(m, /<__VeRoutes><__VeRoute element=\{<RequireAuth \/>\}><__VeRoute element=\{<Shell \/>\}><__VeRoute index element=\{<Orders \/>\} \/><\/__VeRoute><\/__VeRoute><\/__VeRoutes>/);
  assert.doesNotMatch(m, /Login/);
  // Route objects with children.
  const objects = `import { Guard } from './Guard'
import { Orders } from './Orders'
export const routes = [{
  element: <Guard />,
  children: [
    { path: '/orders', element: <Orders /> },
  ],
}]`;
  assert.match(routeElementModule('src/routes.tsx', objects, 5, DIR) ?? '', /<__VeRoute element=\{<Guard \/>\}><__VeRoute index element=\{<Orders \/>\} \/>/);
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

test('app shell: App.tsx\'s providers and router frame every preview; its layout and siblings stay out', () => {
  const text = `import { useState } from 'react'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { Provider } from 'react-redux'
import { store } from './store'
import { ThemeContext } from './theme'
import { Navbar } from './Navbar'
import Home from './pages/Home'
import './App.css'

export default function App() {
  const [theme, setTheme] = useState('dark')
  return (
    <Provider store={store}>
      <ThemeContext.Provider value={{ theme, setTheme }}>
        <BrowserRouter>
          <div className="layout">
            <Navbar />
            <Routes>
              <Route path="/" element={<Home />} />
            </Routes>
          </div>
        </BrowserRouter>
      </ThemeContext.Provider>
    </Provider>
  )
}`;
  const sh = appShell('src/App.tsx', text, 'default', DIR);
  const module = sh.modules['shell/0.tsx'];
  assert.equal(sh.hasRouter, true);
  assert.deepEqual(sh.names, ['Provider', 'ThemeContext.Provider']);
  assert.equal(sh.component, 'App');
  // The frame: providers, then the preview's router, then the component.
  assert.match(module, /<Provider store=\{store\}><ThemeContext\.Provider value=\{\{ theme, setTheme \}\}><__ve\.Router>\{__ve\.children\}<\/__ve\.Router><\/ThemeContext\.Provider><\/Provider>/);
  // The whole app: as written, with its router swapped.
  assert.match(module, /__ve\.whole \? \(<Provider store=\{store\}>[\s\S]*<__ve\.Router>[\s\S]*<Navbar \/>[\s\S]*<\/__ve\.Router>/);
  assert.doesNotMatch(module, /BrowserRouter>/);
  // Its hook stays, and imports point back at the app.
  assert.match(module, /const \[theme, setTheme\] = useState\('dark'\)/);
  assert.match(module, /from '..\/..\/..\/src\/store'/);
  assert.match(module, /export \{ App as __VeHop \}/);
  assert.match(sh.modules['app-shell.tsx'], /import \{ __VeHop as Top \} from '.\/shell\/0'/);
});

test('app shell: none when App has no providers or router, or when it starts the app itself', () => {
  const plain = `import { Routes, Route } from 'react-router-dom'\nimport { Navbar } from './Navbar'\nexport function App() { return <><Navbar /><Routes><Route path="/" element={<p />} /></Routes></> }`;
  assert.equal(appShell('src/App.tsx', plain, 'App', DIR).file, undefined);
  const inline = `import { createRoot } from 'react-dom/client'\nfunction App() { return <Suspense><Routes /></Suspense> }\ncreateRoot(root).render(<App />)`;
  assert.equal(appShell('src/main.tsx', inline, 'default', DIR).file, undefined);
  // useRoutes: the routes variable is where pages go; an anonymous default export gets a name.
  const hooks = `import { useRoutes } from 'react-router-dom'\nimport { QueryClientProvider } from '@tanstack/react-query'\nimport { routes } from './routes'\nexport default () => {\n  const element = useRoutes(routes)\n  return <QueryClientProvider client={qc}>{element}</QueryClientProvider>\n}`;
  const sh = appShell('src/App.tsx', hooks, 'default', DIR);
  const module = sh.modules['shell/0.tsx'];
  assert.deepEqual(sh.names, ['QueryClientProvider']);
  assert.match(module, /const __VeApp = \(\) =>/);
  assert.match(module, /export default __VeApp/);
  assert.match(module, /<QueryClientProvider client=\{qc\}>\{__ve\.children\}<\/QueryClientProvider>/);
});

test('providers: the entry says where <App /> comes from', () => {
  const p = appProviders('src/main.tsx', `import { createRoot } from 'react-dom/client'\nimport Root from './app/Root'\ncreateRoot(r).render(<Root />)`, DIR);
  assert.deepEqual(p.app, { from: 'src/app/Root', export: 'default' });
});

test('app shell: App hands over to a component that holds the router; each step is copied, pointing at the next', () => {
  const app = { path: 'src/App.tsx', name: 'default', text: `import { AppRouter } from '@routes'\nimport { useLoadSettings } from './hooks'\nexport default function App() {\n  useLoadSettings()\n  return <AppRouter />\n}` };
  const router = { path: 'src/routes/AppRouter.tsx', name: 'AppRouter', text: `import { BrowserRouter, Routes, Route } from 'react-router-dom'\nimport { Home } from '../pages/Home'\nconst AppRouter = () => (\n  <BrowserRouter>\n    <Routes><Route path="/" element={<Home />} /></Routes>\n  </BrowserRouter>\n)\nexport default AppRouter` };
  const chain = shellChain(app, (s) => (s === app ? [{ tag: 'AppRouter', step: router }] : []));
  assert.equal(chain?.length, 2);
  const sh = appShellChain(chain!, DIR);
  assert.equal(sh.hasRouter, true);
  assert.equal(sh.component, 'App');
  // App: as written (its hook runs), drawing the next copy.
  assert.match(sh.modules['shell/0.tsx'], /import \{ __VeHop as __VeNext \} from '.\/1'/);
  assert.match(sh.modules['shell/0.tsx'], /useLoadSettings\(\)\n  return <__VeNext \/>/);
  assert.match(sh.modules['shell/0.tsx'], /from '..\/..\/..\/src\/hooks'/);
  // AppRouter: the frame, its router swapped.
  assert.match(sh.modules['shell/1.tsx'], /<__ve\.Router>\{__ve\.children\}<\/__ve\.Router>/);
  assert.match(sh.modules['shell/1.tsx'], /export \{ AppRouter as __VeHop \}/);
  // Nothing to follow: no frame.
  assert.equal(shellChain(app, () => []), undefined);
});
