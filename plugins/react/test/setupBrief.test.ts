import assert from 'node:assert/strict';
import test from 'node:test';
import type { Item, ProjectInfo } from '@visual-editor/contract';
import { readProviders, setupBriefText } from '../src/setupBrief';

const reader = (files: Record<string, string>) => async (p: string) => files[p];

const VITE_STARTER = {
  'index.html': '<div id="root"></div>\n<script type="module" src="/src/main.tsx"></script>\n',
  'src/main.tsx': `import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
`,
  'src/App.tsx': `import { useState } from 'react'
export default function App() {
  const [count, setCount] = useState(0)
  return (
    <div className="card">
      <button onClick={() => setCount((c) => c + 1)}>count is {count}</button>
    </div>
  )
}
`,
};

test('setup brief: a fresh Vite app is wrapped in nothing previews need, so no providers file', async () => {
  const p = await readProviders(reader(VITE_STARTER), 'src/main.tsx');
  assert.deepEqual(p.wrappers.map((w) => [w.name, w.becomes]), [['StrictMode', 'left out']]);
  assert.equal(p.text, undefined);
  assert.deepEqual(p.checks, []);
});

const REAL_APP = {
  'index.html': '<script type="module" src="/src/main.tsx"></script>',
  'src/main.tsx': `import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Provider } from 'react-redux'
import { Toaster } from 'sonner'
import { store } from './store'
import { AuthProvider } from './auth/AuthProvider'
import App from './App'

const queryClient = new QueryClient()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Provider store={store}>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <AuthProvider>
            <App />
            <Toaster richColors />
          </AuthProvider>
        </BrowserRouter>
      </QueryClientProvider>
    </Provider>
  </React.StrictMode>,
)
`,
  'src/App.tsx': `import { ThemeProvider, createTheme, CssBaseline } from '@mui/material'
import { Routes, Route } from 'react-router-dom'
import { brand } from './theme/brand'
import Home from './pages/Home'

const theme = createTheme({ palette: { primary: { main: brand } } })

export default function App() {
  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <Routes>
        <Route path="/" element={<Home />} />
      </Routes>
    </ThemeProvider>
  )
}
`,
  'src/store.ts': 'export const store = {}\n',
  'src/auth/AuthProvider.tsx': 'export function AuthProvider({ children }) { return children }\n',
};

test('setup brief: a real app\'s wrappers become a providers file made for previews', async () => {
  const p = await readProviders(reader(REAL_APP), 'src/main.tsx');
  assert.deepEqual(p.wrappers.map((w) => [w.name, w.becomes]), [
    ['React.StrictMode', 'left out'],
    ['Provider', 'same'],
    ['QueryClientProvider', 'queries'],
    ['BrowserRouter', 'router'],
    ['AuthProvider', 'same'],
    ['Toaster', 'same'],
    ['ThemeProvider', 'same'],
    ['CssBaseline', 'same'],
  ]);
  const text = p.text!;
  // The router is one in memory; queries get their own client; the store, the theme (and what it's made from) come along.
  assert.match(text, /import \{ MemoryRouter \} from 'react-router-dom'/);
  assert.match(text, /import \{ QueryClient, QueryClientProvider \} from '@tanstack\/react-query'/);
  assert.match(text, /import \{ store \} from '\.\/store'/);
  assert.match(text, /import \{ AuthProvider \} from '\.\/auth\/AuthProvider'/);
  assert.match(text, /import \{ ThemeProvider, createTheme, CssBaseline \} from '@mui\/material'|import \{ (?=.*ThemeProvider)(?=.*createTheme)(?=.*CssBaseline)[^}]+\} from '@mui\/material'/);
  assert.match(text, /import \{ brand \} from '\.\/theme\/brand'/);
  assert.match(text, /const theme = createTheme\(\{ palette: \{ primary: \{ main: brand \} \} \}\)/);
  assert.doesNotMatch(text, /BrowserRouter|StrictMode|queryClient\b|Routes|Home/, 'what previews don\'t need stays out');
  assert.equal((text.match(/\{children\}/g) ?? []).length, 1, 'the preview goes in once');
  assert.match(text, /<Provider store=\{store\}>\n\s+<QueryClientProvider client=\{previewQueries\}>\n\s+<MemoryRouter>\n\s+<AuthProvider>\n\s+<ThemeProvider theme=\{theme\}>\n\s+<CssBaseline \/>\n\s+\{children\}\n\s+<\/ThemeProvider>\n\s+<Toaster richColors \/>/);
  // The project's own provider is flagged: it might sign in or load data.
  assert.match(p.checks.join('\n'), /AuthProvider \(\.\/auth\/AuthProvider\) is the project's own/);
});

test('setup brief: what a component makes itself can\'t come along, and is said; a data router becomes one in memory', async () => {
  const files = {
    'src/main.tsx': `import { createRoot } from 'react-dom/client'
import { RouterProvider } from 'react-router-dom'
import { ThemeProvider } from 'styled-components'
import { router } from './router'
function Root() { return null }
createRoot(document.getElementById('root')!).render(<ThemeProvider theme={darkMode ? dark : light}><RouterProvider router={router} /></ThemeProvider>)
`,
  };
  const p = await readProviders(reader(files), 'src/main.tsx');
  assert.match(p.text!, /<ThemeProvider theme=\{darkMode \? dark : light\}>\n\s+<MemoryRouter>\n\s+\{children\}/);
  assert.doesNotMatch(p.text!, /\.\/router'|router=\{/, 'the app\'s routes are not brought along');
  assert.match(p.checks.join('\n'), /can't come along as they are: darkMode, dark, light/);
});

const project = (files: Record<string, string>, extra: Partial<ProjectInfo> = {}): ProjectInfo => ({ root: '/p', name: 'shop', files: Object.keys(files), packageJson: { dependencies: { react: '19' } }, ...extra }) as ProjectInfo;
const comp = (label: string, path: string, over: Partial<Item> = {}): Item => ({ id: `react:${label}`, map: 'components', kind: 'component', label, source: { path }, ...over });

test('setup brief: says what is in place, the providers file, and the first component to make previewable', async () => {
  const files = { ...VITE_STARTER, 'vite.config.ts': "import { defineConfig } from 'vite'\nexport default defineConfig({ resolve: { alias: { '@visual-editor/react': './.visual-editor/react/visual-editor.tsx' } } })\n", 'tsconfig.app.json': '{ "compilerOptions": { "paths": { "@visual-editor/react": ["./.visual-editor/react/visual-editor.tsx"] } } }', '.visual-editor/react/visual-editor.tsx': 'export const HELPER_VERSION = 4\n', 'src/Badge.tsx': 'a\nb\nc\nd\ne\nf\n', 'src/Button.tsx': 'a\nb\nc\nd\ne\nf\ng\nh\n', 'src/Tiny.tsx': 'x\n' };
  const items = [comp('Button', 'src/Button.tsx'), comp('Badge', 'src/Badge.tsx'), comp('Tiny', 'src/Tiny.tsx'), comp('Home', 'src/Home.tsx', { kind: 'page' })];
  const text = await setupBriefText({ project: project(files), items, read: reader(files) }, 'export const HELPER_VERSION = 4\n');
  assert.match(text, /## Visual Editor’s helper\nReady: \.visual-editor\/react\/visual-editor\.tsx \(version 4\)/);
  assert.match(text, /The app starts in src\/main\.tsx\.\nWhat the app is wrapped in[^\n]*\n- StrictMode[^\n]*left out/);
  assert.match(text, /- Badge · react:Badge · src\/Badge\.tsx \(7 lines\)\n- Button · react:Button/, 'plain ones, the shortest first; too small and pages left out');
  assert.doesNotMatch(text, /Tiny|Home/);
  // A fresh app with only its App (a page here): that one.
  assert.match(await setupBriefText({ project: project(files), items: [comp('App', 'src/App.tsx', { kind: 'page' })], read: reader(files) }, 'export const HELPER_VERSION = 4\n'), /- App · react:App · src\/App\.tsx \(10 lines\)/);
  // Something previewable already: nothing more to make.
  const ready = await setupBriefText({ project: project(files), items: [comp('Badge', 'src/Badge.tsx', { preview: { variants: [], states: [] } })], read: reader(files) }, 'export const HELPER_VERSION = 4\n');
  assert.match(ready, /1 already: Badge\. Making one more is not needed/);
});

test('setup brief: a project that isn\'t Vite is refused, saying what it uses', async () => {
  const files = { 'next.config.js': 'module.exports = {}' };
  assert.match(await setupBriefText({ project: project(files), items: [], read: reader(files) }), /NOT SUPPORTED: only Vite projects can be set up for now, and this one uses Next\.js\. Don't change anything/);
  const cra = await setupBriefText({ project: project({}, { packageJson: { dependencies: { 'react-scripts': '5' } } } as Partial<ProjectInfo>), items: [], read: reader({}) });
  assert.match(cra, /uses Create React App/);
});

test('setup brief: the app\'s own router (<AppRouter />, by a short name) is the app; with react-router, previews still get one; what the entry runs first is said', async () => {
  const files = {
    'src/main.tsx': `import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useSettingsStore } from "@store";
import App from "./App";
export const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 60000 } } });
document.documentElement.setAttribute("data-theme", useSettingsStore.getState().theme);
createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    <App />
  </QueryClientProvider>,
);
`,
    'src/App.tsx': `import { AppRouter } from "@routes";
export default function App() {
  return <AppRouter />;
}
`,
  };
  const p = await readProviders(reader(files), 'src/main.tsx', { 'react-router-dom': '7' });
  assert.deepEqual(p.wrappers.map((w) => [w.name, w.becomes]), [['QueryClientProvider', 'queries'], ['MemoryRouter', 'router']]);
  assert.match(p.text!, /<QueryClientProvider client=\{previewQueries\}>\n\s+<MemoryRouter>\n\s+\{children\}\n\s+<\/MemoryRouter>/);
  assert.doesNotMatch(p.text!, /AppRouter|@routes|staleTime/);
  assert.match(p.checks.join('\n'), /also runs this before the app draws[^\n]*document\.documentElement\.setAttribute\( ?"data-theme"/);
  // Without react-router: no router is added.
  assert.doesNotMatch((await readProviders(reader(files), 'src/main.tsx')).text!, /MemoryRouter/);
});

test('setup brief: providers that sign in or call a server are flagged; object keys aren\'t taken for names', async () => {
  const files = {
    'src/main.tsx': `import { createRoot } from 'react-dom/client'
import { Auth0Provider } from '@auth0/auth0-react'
import { AuthProvider } from '@/auth/AuthContext'
import App from '@/App'
createRoot(document.getElementById('root')!).render(<Auth0Provider domain="d" authorizationParams={{ redirect_uri: window.location.origin }}><AuthProvider><App /></AuthProvider></Auth0Provider>)
`,
  };
  const p = await readProviders(reader(files), 'src/main.tsx');
  const checks = p.checks.join('\n');
  assert.match(checks, /Auth0Provider \(@auth0\/auth0-react\) talks to a server or signs in/);
  assert.match(checks, /AuthProvider \(@\/auth\/AuthContext\) is the project's own/);
  assert.doesNotMatch(checks, /redirect_uri|can't come along/);
  assert.match(p.text!, /import \{ AuthProvider \} from '@\/auth\/AuthContext'/);
});

test('setup brief: the map nudges a Vite app with nothing set up to Set up project, and no other', async () => {
  const { reactPlugin } = await import('../src/plugin');
  const fresh = project({ 'vite.config.ts': '', 'src/main.tsx': '', 'src/App.tsx': '' });
  const nudges = reactPlugin.nudges!(fresh, [comp('App', 'src/App.tsx')]);
  assert.deepEqual(nudges.map((n) => [n.id, n.agent]), [['set-up', 'set-up-project']]);
  assert.match(nudges[0].text, /^shop isn’t set up for Preview yet: Set up project gets it ready/);
  // Set up already (a providers file, or something previewable), or not Vite: no nudge.
  assert.deepEqual(reactPlugin.nudges!(project({ 'vite.config.ts': '', 'src/visual-editor.providers.tsx': '' }), []), []);
  assert.deepEqual(reactPlugin.nudges!(fresh, [comp('Badge', 'src/Badge.tsx', { preview: { variants: [], states: [] } })]), []);
  assert.deepEqual(reactPlugin.nudges!(project({ 'next.config.js': '' }), []), []);
});

test('card nudges: a component that isn\'t previewable gets Make previewable in its drawer; a previewable one, an API call or one without a file doesn\'t', async () => {
  const { reactPlugin } = await import('../src/plugin');
  const p = project({ 'vite.config.ts': '' });
  const nudges = reactPlugin.cardNudges!(comp('CreateProjectModal', 'src/CreateProjectModal.tsx'), p);
  assert.deepEqual(nudges.map((n) => n.agent), ['make-previewable']);
  assert.match(nudges[0].text, /^Not previewable yet:/);
  assert.deepEqual(reactPlugin.cardNudges!(comp('ProjectCard', 'src/ProjectCard/index.tsx', { preview: { variants: [], states: [] } }), p), []);
  assert.deepEqual(reactPlugin.cardNudges!({ id: 'react:api:GET /x', map: 'api', kind: 'api call', label: 'GET /x', source: { path: 'src/api.ts' } }, p), []);
  assert.deepEqual(reactPlugin.cardNudges!({ id: 'react:X', map: 'components', kind: 'component', label: 'X' }, p), []);
});
