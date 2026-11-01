import assert from 'node:assert/strict';
import test from 'node:test';
import { readModel } from '../src/cards';
import { impactOf } from '../src/read/impact';

const FILES: Record<string, string> = {
  'src/store.ts': `import { create } from 'zustand'\nexport const useCountStore = create(() => ({ n: 0 }))\n`,
  'src/Card.tsx': `import { useCountStore } from './store'
export function Card({ title, onDelete }: { title: string; onDelete?: () => void }) {
  const n = useCountStore((s) => s.n)
  return <div>{title} {n}<button onClick={onDelete}>x</button></div>
}
`,
  'src/Badge.tsx': `import { useCountStore } from './store'
export function Badge() { const n = useCountStore((s) => s.n); return <b>{n}</b> }
`,
  'src/List.tsx': `import { Card } from './Card'
export function List() { return <ul><Card title="a" onDelete={() => alert('x')} /></ul> }
`,
  'src/Grid.tsx': `import { Card } from './Card'
export function Grid(props: { title: string }) { return <Card {...props} /> }
`,
  'src/Panel.tsx': `import { Card } from './Card'
export function Panel() { return <Card title="b" /> }
`,
  'src/App.tsx': `import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { List } from './List'
import { Panel } from './Panel'
import { Grid } from './Grid'
import { Badge } from './Badge'
export default function App() {
  return <BrowserRouter><Routes><Route path="/" element={<List />} /><Route path="/panel" element={<><Panel /><Grid title="g" /><Badge /></>} /></Routes></BrowserRouter>
}
`,
};
const model = readModel(Object.entries(FILES).map(([path, text]) => ({ path, text })));
const ctx = { model, read: (p: string) => FILES[p], cardOf: (id: string) => `card:${id.split('#')[1]}` };

test('impact: who renders a component and what they pass, the pages it\'s seen on, and what shares its data', () => {
  const imp = impactOf('src/Card.tsx#Card', ctx)!;
  assert.deepEqual(imp.props, ['title', 'onDelete']);
  assert.deepEqual(imp.direct.map((p) => `${p.label}: ${p.why}${p.unsure ? ' ?' : ''}`).sort(), ['Grid: renders it, passing nothing and {...} more ?', 'List: renders it, passing title, onDelete', 'Panel: renders it, passing title']);
  assert.ok(imp.direct.every((p) => p.at?.path.startsWith('src/') && p.at.line > 0), 'each with its line');
  const further = imp.further.map((p) => `${p.label}: ${p.why}`);
  assert.ok(further.some((f) => /^List: the page at \/: it's seen there$/.test(f)), further.join(' | '));
  assert.ok(further.some((f) => /^Badge: uses the same store: useCountStore$/.test(f)), further.join(' | '));
});

test('impact: one prop: the places that pass it (and what), leave it out, or can\'t be told; and what changing it means', () => {
  const imp = impactOf('src/Card.tsx#Card', ctx, 'onDelete')!;
  assert.deepEqual(imp.direct.map((p) => `${p.label}: ${p.why}${p.unsure ? ' ?' : ''}`).sort(), [
    "Grid: passes {...} into it: can't tell if onDelete is in there ?",
    "List: passes onDelete={() => alert('x')}",
    'Panel: renders it without onDelete',
  ]);
  assert.equal(imp.verdict, "onDelete is passed in 1 place, left out in 1 (and 1 that can't be told). Renaming it: 1 place must change too. Removing it: that place passes something nothing uses any more. Making it required: 1 place would have to pass it.");
  // A prop no one passes: removing it changes nothing else.
  const lone = impactOf('src/Badge.tsx#Badge', ctx, 'x')!;
  assert.match(lone.verdict!, /^x is passed in 0 places, left out in 1\. Removing it changes no other component\./);
});
