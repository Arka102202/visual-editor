import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Item } from '@visual-editor/contract';
import { helloPlugin } from '../../../plugins/hello/src/plugin';
import { CurrentProject } from '../src/currentProject';
import { CARD_WIDTH, cardHeight, layoutMap } from '../src/layout';
import { ProjectIndex } from '../src/projectIndex';
import { findWorkspace } from '../src/projects';
import { PluginRegistry } from '../src/registry';

const card = (id: string, map = 'm', fields = 0): Item => ({
  id,
  map,
  kind: 'k',
  label: id,
  fields: Array.from({ length: fields }, (_, i) => ({ name: `f${i}` })),
});

const overlaps = (a: { x: number; y: number; w: number; h: number }, b: typeof a) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

test('layout: cards never overlap, and each map gets its own section', () => {
  const items = [...Array.from({ length: 7 }, (_, i) => card(`a${i}`, 'one', i)), card('b', 'two', 12)];
  const layout = layoutMap(items, [], [{ id: 'one', title: 'One' }]);
  assert.deepEqual(layout.sections.map((s) => s.map.title), ['One', 'two']);
  const all = layout.sections.flatMap((s) => s.cards);
  assert.equal(all.length, 8);
  for (const a of all) for (const b of all) if (a !== b) assert.ok(!overlaps(a, b), `${a.item.id} overlaps ${b.item.id}`);
  assert.ok(layout.sections[1].y >= layout.sections[0].y + layout.sections[0].h);
  // Long field lists are cut to a "+ N more" row.
  assert.equal(cardHeight(card('x', 'm', 12)), cardHeight(card('y', 'm', 9)));
});

test('layout: lines flow left to right, loops are cut, and lines to missing cards are dropped', () => {
  const items = ['app', 'list', 'item', 'loopA', 'loopB'].map((id) => card(id));
  const links = [
    { from: 'app', to: 'list', kind: 'renders' },
    { from: 'list', to: 'item', kind: 'renders' },
    { from: 'app', to: 'item', kind: 'renders' },
    { from: 'loopA', to: 'loopB', kind: 'calls' },
    { from: 'loopB', to: 'loopA', kind: 'calls' },
    { from: 'app', to: 'gone', kind: 'renders' },
  ];
  const layout = layoutMap(items, links, []);
  const x = Object.fromEntries(layout.sections[0].cards.map((c) => [c.item.id, c.x]));
  assert.equal(x.app, 0);
  assert.equal(x.list > x.app, true);
  assert.equal(x.item > x.list, true, 'item sits right of the deepest card pointing at it');
  assert.notEqual(x.loopA, x.loopB);
  assert.equal(layout.links.length, 5);
  assert.equal(layout.sections[0].cards[0].w, CARD_WIDTH);
});

test('switcher: remembers the choice, and falls back when the chosen project is gone', async () => {
  const states = [
    { project: { root: '/a', name: 'a', files: [] }, detected: [], items: [], links: [], cards: {}, problems: [] },
    { project: { root: '/b', name: 'b', files: [] }, detected: [{ plugin: helloPlugin, reason: 'r' }], items: [], links: [], cards: {}, problems: [] },
  ];
  let saved: string | undefined;
  let heard = 0;
  const current = new CurrentProject(() => states, { get: () => saved, set: (r) => (saved = r) });
  current.onChange(() => heard++);
  assert.equal(current.get()?.project.name, 'b', 'first the one a plugin understands');
  current.choose('/a');
  assert.equal(current.get()?.project.name, 'a');
  assert.equal(heard, 1);
  saved = '/gone';
  assert.equal(current.get()?.project.name, 'b');
});

test('done when: installing Hello puts its card on the map, removing it takes the card away', async () => {
  const root = mkdtempSync(join(tmpdir(), 've-map-'));
  try {
    writeFileSync(join(root, 'package.json'), '{"name":"shop"}');
    const registry = new PluginRegistry();
    const index = new ProjectIndex(registry);
    await index.setProjects(findWorkspace(root).projects);
    const draw = () => {
      const [state] = index.snapshot();
      return layoutMap(state.items, state.links, state.detected.flatMap((d) => d.plugin.maps ?? [])).sections.flatMap((s) => s.cards.map((c) => c.item.label));
    };
    assert.deepEqual(draw(), []);
    const installed = registry.register(helloPlugin);
    await index.idle();
    assert.deepEqual(draw(), ['Hello, shop']);
    installed.dispose();
    await index.idle();
    assert.deepEqual(draw(), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
