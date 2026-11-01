import assert from 'node:assert/strict';
import test from 'node:test';
import { readModel } from '../src/cards';
import { FieldReader } from '../src/read/fields';

const FILES: Record<string, string> = {
  'src/db.ts': `export const db = {} as any\n`,
  'src/useThings.ts': `import { useState, useEffect } from 'react'
import { db } from './db'
export function useThings() {
  const [things, setThings] = useState<any[]>([])
  useEffect(() => { void (async () => { const rows = await db.things.toArray(); setThings(rows) })() }, [])
  return { things }
}
`,
  'src/Badge.tsx': `export function Badge({ label }: { label: string }) { return <i>{label}</i> }\n`,
  'src/Row.tsx': `import { Badge } from './Badge'
export function Row({ thing, extra }: { thing: { name: string; color: string }; extra?: string }) {
  const loud = thing.name.toUpperCase()
  return (
    <li className={thing.color}>
      <b>{thing.name}</b>
      <span title={thing.name}>{loud}</span>
      <Badge label={thing.name} />
    </li>
  )
}
`,
  'src/List.tsx': `import { Row } from './Row'
import { useThings } from './useThings'
export function List() {
  const { things } = useThings()
  return <ul>{things.map((t) => <Row key={t.name} thing={t} />)}</ul>
}
`,
  'src/Grid.tsx': `import { Row } from './Row'
export function Grid() { return <Row thing={{ name: 'Sample', color: 'red' }} /> }
`,
};
const model = readModel(Object.entries(FILES).map(([path, text]) => ({ path, text })));
const byId = new Map(model.components.map((c) => [c.id, c]));
const reader = () =>
  new FieldReader({
    read: (p) => FILES[p],
    files: new Set(Object.keys(FILES)),
    aliases: [],
    folders: [],
    cardOf: (_p, n) => `card:${n}`,
    usedBy: (p, n) => (byId.get(`${p}#${n}`)?.usedBy ?? []).map((u) => ({ path: u.path, line: u.line, ...(u.from ? { from: { path: byId.get(u.from)!.path, name: byId.get(u.from)!.name } } : {}) })),
  });
const lines = (steps: { kind: string; text: string; depth?: number }[]) => steps.map((s) => `${'  '.repeat(s.depth ?? 0)}[${s.kind}] ${s.text}`);

test('follow a field: the fields one can follow are a component\'s props and the parts its code reads (not text methods)', () => {
  assert.deepEqual(reader().fieldsOf('src/Row.tsx', 'Row'), ['thing', 'thing.name', 'thing.color', 'extra']);
});

test('follow a field: where it comes from, each way from where it starts (saved data, a hook\'s state, a list; a fixed object)', () => {
  const trail = reader().follow('src/Row.tsx', 'Row', 'thing.name');
  const ways = lines(trail.comesFrom).join('\n').split(/\[branch\] /).filter(Boolean);
  assert.equal(ways.length, 2);
  const fromDb = ways.find((w) => w.includes('saved data'))!;
  assert.match(fromDb, /\[origin\] saved data \(db\.things\)\n\[step\] kept in useThings's state things, set by setThings\(rows\)\n\[step\] useThings gives it as things\n\[step\] List goes through things one by one: each is t \(it reads t\.name\)\n\[step\] List passes it as thing: thing=t\n\[here\] Row gets it as thing\.name/);
  const fixed = ways.find((w) => !w.includes('saved data'))!;
  assert.match(fixed, /\[origin\] a fixed value in Grid: 'Sample'\n\[step\] Grid passes it as thing: thing=\{ name: 'Sample', color: 'red' \}\n\[here\] Row gets it as thing\.name/);
});

test('follow a field: where it\'s shown (text, an attribute), passed into a child and shown there, or used; not other parts of it', () => {
  const trail = reader().follow('src/Row.tsx', 'Row', 'thing.name');
  assert.deepEqual(lines(trail.shown), [
    '[used] Row uses it in code: const loud = thing.name.toUpperCase()',
    '[shown] Row shows it as text in <b>',
    '[shown] Row shows it as the title of <span>',
    '[into] Row passes it to Badge as label',
    '  [shown] Badge shows it as text in <i>',
  ]);
  assert.ok(!trail.shown.some((s) => /look/.test(s.kind)), 'thing.color is another part: not this field');
  assert.deepEqual(lines(reader().follow('src/Row.tsx', 'Row', 'thing.color').shown), ['[look] Row uses it for the look of <li> (className)']);
});

test('follow a field: a prop no one gives says so', () => {
  const trail = reader().follow('src/Row.tsx', 'Row', 'extra');
  assert.deepEqual(lines(trail.comesFrom), ["[unsure] Nothing in the project gives Row its extra (or it couldn't be found)", '[here] Row gets it as extra']);
});
