import { test } from 'node:test';
import assert from 'node:assert/strict';
import { needOf, previewFix, PROVIDERS_PATH } from '../src/providers';

const project = (deps: Record<string, string>, files: string[] = ['src/main.tsx']) => ({ root: '/x', name: 'shop', files, packageJson: { dependencies: deps } });

test('providers: a page that needs a router is recognised from what stopped it', () => {
  assert.equal(needOf('useHref() may be used only in the context of a <Router> component.'), 'router');
  assert.equal(needOf('You cannot render a <Link> outside a <Router>.'), 'router');
  // react-router 7 in a project's dev server says it this way.
  assert.equal(needOf("Cannot destructure property 'basename' of 'React10.useContext(...)' as it is null."), 'router');
  assert.equal(needOf("Cannot read properties of undefined (reading 'map')"), undefined);
});

test('providers: a router in memory is proposed, from the router package the project uses', () => {
  const c = previewFix(project({ react: '19', 'react-router-dom': '7' }), 'router', () => undefined);
  assert.ok(typeof c !== 'string', String(c));
  assert.equal(c.changes[0].path, PROVIDERS_PATH);
  assert.equal(c.changes[0].before, null);
  assert.match(c.changes[0].after, /import \{ MemoryRouter \} from 'react-router-dom'/);
  assert.match(c.changes[0].after, /return <MemoryRouter>\{children\}<\/MemoryRouter>/);
  const v7 = previewFix(project({ 'react-router': '7' }), 'router', () => undefined);
  assert.ok(typeof v7 !== 'string');
  assert.match(v7.changes[0].after, /from 'react-router'/);
  // What can't be done is said, with what to do.
  assert.match(String(previewFix(project({ react: '19' }), 'router', () => undefined)), /no react-router/);
  assert.match(String(previewFix(project({ 'react-router-dom': '7' }, ['src/visual-editor.providers.tsx']), 'router', () => 'x')), /is there already: add a router to it/);
});
