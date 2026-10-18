import { test } from 'node:test';
import assert from 'node:assert/strict';
import { areaNames, areaOf, cardColours, NEUTRAL, PALETTE, usedBy } from '../src/styles';
import { layoutMap } from '../src/layout';

/** OKLab distance ×100 between two #rrggbb colours (how different they look). */
function distance(a: string, b: string): number {
  const lab = (h: string) => {
    const [r, g, bl] = [1, 3, 5].map((i) => {
      const c = parseInt(h.slice(i, i + 2), 16) / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * bl);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * bl);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * bl);
    return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
  };
  const x = lab(a);
  const y = lab(b);
  return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]) * 100;
}

test('styles: kind colours never look like the status marks, and differ from each other', () => {
  const status = ['#d9a400', '#2f6fdb']; // proposed, changed
  for (const tone of [NEUTRAL, ...PALETTE]) for (const c of [tone.dark, tone.light]) for (const s of status) assert.ok(distance(c, s) >= 15, `${c} is too close to ${s}`);
  for (const mode of ['dark', 'light'] as const) {
    for (const a of PALETTE) for (const b of PALETTE) if (a !== b) assert.ok(distance(a[mode], b[mode]) >= 15, `${a[mode]} vs ${b[mode]}`);
  }
});

test('styles: the most common kind is neutral, rarer kinds get colours in order, never repeated', () => {
  const item = (id: string, kind: string) => ({ id, map: 'm', kind, label: id });
  const kinds = ['a', 'a', 'a', 'b', 'b', 'c', 'd', 'e'].map((k, i) => item(String(i), k));
  const colours = cardColours(kinds);
  assert.equal(colours.a, NEUTRAL);
  assert.deepEqual([colours.b, colours.c, colours.d, colours.e], PALETTE);
  const more = cardColours([...kinds, item('x', 'f')]);
  assert.equal(more.f.dashed, true);
  assert.deepEqual(cardColours([item('x', 'only')]), { only: NEUTRAL });
  assert.deepEqual(usedBy([{ from: 'a', to: 'c', kind: 'renders' }, { from: 'a', to: 'c', kind: 'uses' }, { from: 'b', to: 'c', kind: 'renders' }]), { c: 2 });
});

test('styles: feature areas from folders, named by the feature', () => {
  const at = (path: string) => areaOf({ id: path, map: 'm', kind: 'k', label: 'x', source: { path } });
  assert.equal(at('src/components/shared/Toggle/Toggle.tsx'), 'src/components/shared');
  assert.equal(at('src/components/shared/Toggle/index.tsx'), 'src/components/shared');
  assert.equal(at('src/pages/Editor/Canvas.tsx'), 'src/pages/Editor');
  assert.deepEqual(areaNames(['src/pages/Editor/components/InspectorPanel/components', 'src/components', 'src/nodes']), {
    'src/pages/Editor/components/InspectorPanel/components': 'Editor › InspectorPanel',
    'src/components': 'components',
    'src/nodes': 'nodes',
  });
});

test('layout: Folders puts each folder in its own box, boxes never overlap', () => {
  const items = ['a/X.tsx', 'a/Y.tsx', 'b/Z.tsx', 'b/W.tsx', 'c/V.tsx'].map((path) => ({ id: path, map: 'm', kind: 'k', label: path, source: { path } }));
  const layout = layoutMap(items, [{ from: 'a/X.tsx', to: 'b/Z.tsx', kind: 'renders' }], [], 'folders');
  assert.deepEqual(layout.sections.map((s) => [s.map.id, s.cards.length]), [['a', 2], ['b', 2], ['c', 1]]);
  for (const a of layout.sections) for (const b of layout.sections) {
    if (a !== b) assert.ok(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y, `${a.map.id} overlaps ${b.map.id}`);
  }
  assert.equal(layout.links.length, 1);
});
