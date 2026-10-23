import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Item } from '@visual-editor/contract';
import { globalCss, helperFile, previewPage } from '../src/previewPage';

const project = { root: '/x', name: 'shop', files: ['index.html', 'src/main.tsx', 'src/index.css', 'src/visual-editor.tsx', 'src/cards/ProjectCard/index.tsx'] };
const sources: Record<string, string> = {
  'index.html': '<html><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>',
  'src/main.tsx': "import React from 'react'\nimport './index.css'\nimport '@xyflow/react/dist/style.css'\nimport App from './App'\n",
};

test('preview page: the app’s global styles (what its entry imports) and Visual Editor’s helper', () => {
  assert.deepEqual(globalCss(project, (p) => sources[p]), ['/src/index.css', '/node_modules/@xyflow/react/dist/style.css']);
  assert.equal(helperFile(project), 'src/visual-editor.tsx');
  assert.equal(helperFile({ ...project, files: ['src/App.tsx'] }), undefined);
});

test('preview page: the page loads the helper and the chooser, with the states and how many variants', () => {
  const item: Item = {
    id: 'react:component:x', map: 'components', kind: 'component', label: 'ProjectCard',
    source: { path: 'src/cards/ProjectCard/index.tsx' },
    preview: { variants: [{ id: 'default', name: 'Default', path: 'a', inUse: true }, { id: 'compact', name: 'Compact', path: 'b', inUse: false }], states: ['default', 'long name'] },
  };
  const html = previewPage(item, project)!;
  const config = JSON.parse(/const config = (\{.*\});/.exec(html)![1]);
  assert.deepEqual({ ...config, css: undefined }, { name: 'ProjectCard', chooser: '/src/cards/ProjectCard/index.tsx', helper: '/src/visual-editor.tsx', css: undefined, states: ['default', 'long name'], columns: 2 });
  assert.match(html, /Preview is static: no network calls/);
  assert.match(html, /\/@vite\/client/);
  // Preview: one variant in one state, from the page's address (?variant=…&state=…).
  assert.match(html, /asked\.get\('variant'\)/);
  assert.match(html, /data-ve-single/);
  // Review: before and after (?compare=old,new), each column named.
  assert.match(html, /asked\.get\('compare'\)/);
  assert.match(html, /'After' : 'Before'/);
  // Its fixed data, for Details: the mock file next to the chooser.
  const withMock = { ...project, files: [...project.files, 'src/cards/ProjectCard/ProjectCard.mock.ts', 'src/cards/Other.mock.ts'] };
  assert.equal(JSON.parse(/const config = (\{.*\});/.exec(previewPage(item, withMock)!)![1]).mock, '/src/cards/ProjectCard/ProjectCard.mock.ts');
  // A card without variants has no page.
  assert.equal(previewPage({ ...item, preview: undefined }, project), undefined);
});
