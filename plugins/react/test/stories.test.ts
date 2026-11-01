import assert from 'node:assert/strict';
import test from 'node:test';
import { StoryReader } from '../src/read/stories';
import type { VariantFolder } from '../src/read/variants';

const FILES: Record<string, string> = {
  'src/messages.ts': `export const MESSAGES = { list: { remove: 'Remove it', open: 'Open' } } as const\n`,
  'src/api.ts': `import axios from 'axios'
export const api = {
  remove: (id: string) => axios.delete(\`/api/things/\${id}\`),
}
`,
  'src/db.ts': `export const db = {} as any\n`,
  'src/useThings.ts': `import { useState } from 'react'
import { api } from './api'
import { db } from './db'
export function useThings() {
  const [things, setThings] = useState<string[]>([])
  const reload = async () => setThings(await db.things.toArray())
  const deleteThing = async (id: string) => {
    await api.remove(id)
    await db.things.delete(id)
    await reload()
  }
  return { things, deleteThing }
}
`,
  'src/Row.tsx': `import { MESSAGES } from './messages'
export function Row({ name, onRemove, onPick }: { name: string; onRemove: () => void; onPick: () => void }) {
  return (
    <li>
      <span onClick={(e) => e.stopPropagation()}>{name}</span>
      <button title={\`Pick \${name}\`} onClick={onPick}>…</button>
      <button onClick={() => { if (!confirm('Remove this thing?')) return; onRemove() }}>{MESSAGES.list.remove}</button>
    </li>
  )
}
`,
  'src/List.tsx': `import { useNavigate } from 'react-router-dom'
import { Row } from './Row'
import { useThings } from './useThings'
export default function List() {
  const navigate = useNavigate()
  const { things, deleteThing } = useThings()
  const [open, setOpen] = useState(false)
  return (
    <div onClick={() => setOpen(false)}>
      <button aria-label={open ? 'Close' : 'Open'} onClick={() => { setOpen(!open); fetch('/api/seen', { method: 'POST' }) }}>x</button>
      {things.map((t) => <Row key={t} name={t} onRemove={() => deleteThing(t)} onPick={() => navigate(\`/things/\${t}\`)} />)}
    </div>
  )
}
`,
  // A previewable folder: the design's buttons, the data part's handlers.
  'src/Card/index.tsx': `import CardData from './Card.data'\nexport default function Card() { return <CardData /> }\n`,
  'src/Card/Card.switcher.tsx': `export default function Switcher(p: any) { return null }\n`,
  'src/Card/Card.variant.tsx': `export const variant = { id: 'default', name: 'Default' }
export default function Default({ title, onSave }: { title: string; onSave: () => void }) {
  return <button onClick={onSave}>Save {title}</button>
}
`,
  'src/Card/Card.data.tsx': `import CardSwitcher from './Card.switcher'
import { useThings } from '../useThings'
export default function CardData({ id }: { id: string }) {
  const { deleteThing } = useThings()
  return <CardSwitcher title="x" onSave={() => deleteThing(id)} />
}
`,
};
const folder: VariantFolder = { dir: 'src/Card', name: 'Card', files: { chooser: 'src/Card/index.tsx', data: 'src/Card/Card.data.tsx', switcher: 'src/Card/Card.switcher.tsx' }, version: 2, variants: [{ id: 'default', name: 'Default', path: 'src/Card/Card.variant.tsx' }], selected: 'default', states: [] };
const reader = () => new StoryReader({ read: (p) => FILES[p], files: new Set(Object.keys(FILES)), aliases: [], folders: [folder], cardOf: (_p, n) => `card:${n}` });
const steps = (s: { steps: { kind: string; text: string; depth?: number }[] }) => s.steps.map((x) => `${'  '.repeat(x.depth ?? 0)}[${x.kind}] ${x.text}`);

test('stories: a child\'s click is followed through what its parent gives it, a hook and an API module, to the server and saved data', () => {
  const stories = reader().storiesOf('src/List.tsx', 'List');
  const remove = stories.find((s) => s.title === 'Click “Remove it” on Row')!;
  assert.deepEqual(steps(remove), [
    '[action] You click “Remove it”',
    '  [ask] Asks “Remove this thing?” and goes on only on yes',
    '[run] Row calls onRemove, which List gives it',
    '  [run] Runs deleteThing from useThings',
    '    [run] Runs api.remove (src/api.ts)',
    '      [api] Sends DELETE /api/things/${id}',
    '    [data] Deletes from saved data (db.things)',
    '    [run] Runs reload',
    '      [state] Sets things to await db.things.toArray()',
  ]);
  assert.deepEqual(remove.steps.map((x) => x.card), ['card:Row', 'card:Row', 'card:List', 'card:List', 'card:List', undefined, 'card:List', 'card:List', 'card:List'].map((c, i) => (i === 5 ? remove.steps[5].card : c)));
  assert.deepEqual(steps(stories.find((s) => s.title === 'Click “Pick …” on Row')!), ['[action] You click “Pick …”', '[run] Row calls onPick, which List gives it', '  [navigate] Opens /things/${t}']);
  assert.deepEqual(steps(stories.find((s) => s.title === 'Click “Close / Open”')!), ['[action] You click “Close / Open”', '  [state] Sets open to !open', '  [api] Sends POST /api/seen']);
  assert.deepEqual(steps(stories.find((s) => s.title === 'Click an area')!), ['[action] You click an area', '  [state] Sets open to false']);
});

test('stories: a callback no one gives stays the parent\'s to tell; a click that does nothing isn\'t a story', () => {
  const row = reader().storiesOf('src/Row.tsx', 'Row');
  assert.deepEqual(row.map((s) => s.title), ['Click “Pick …”', 'Click “Remove it”'], 'the name\'s click only stops the click going further');
  assert.equal(row[1].steps.at(-1)!.kind, 'prop');
  assert.match(row[1].steps.at(-1)!.text, /^Calls onRemove, which it was given \(what it does is up to the component using it\)$/);
});

test('stories: a previewable component\'s design in use is followed into its data part', () => {
  const card = reader().storiesOf('src/Card/index.tsx', 'Card');
  assert.deepEqual(card.map((s) => s.title), ['Click “Save …”']);
  assert.deepEqual(steps(card[0]).slice(0, 3), ['[action] You click “Save …”', "[run] Card's real data part handles onSave", '  [run] Runs deleteThing from useThings']);
  assert.ok(card[0].steps.every((s) => s.card === 'card:Card' || s.card === undefined), 'its steps belong to its card');
});
