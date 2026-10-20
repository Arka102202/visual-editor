import { test } from 'node:test';
import assert from 'node:assert/strict';
import { transformSync } from 'esbuild';
import { mapIn, original } from '../src/proxy/sourceMap';

test('source maps: a place in the code the browser runs is found in the developer’s own file', () => {
  const source = [
    "import { useState } from 'react'",
    '',
    'interface Props { name: string }',
    '',
    'export function Hello({ name }: Props) {',
    '  const [n] = useState<number>(1)',
    "  console.log('hello', name, n)",
    '  return <p>{name}</p>',
    '}',
  ].join('\n');
  // Built the way a dev server builds it: types gone, JSX turned into calls, the map inside.
  const built = transformSync(source, { loader: 'tsx', sourcemap: 'inline', sourcefile: 'src/Hello.tsx', jsx: 'automatic' }).code;
  const { map } = mapIn(built);
  assert.ok(map, 'the map is inside the code');
  const lines = built.split('\n');
  const at = lines.findIndex((l) => l.includes("console.log(\"hello\""));
  assert.ok(at >= 0);
  const column = lines[at].indexOf('console') + 1;
  const o = original(map!, at + 1, column)!;
  assert.equal(o.source, 'src/Hello.tsx');
  assert.equal(o.line, 7, 'line 7 as written');
  assert.equal(o.column, 3);
  assert.deepEqual(mapIn('const a = 1\n//# sourceMappingURL=a.js.map\n'), { url: 'a.js.map' });
  assert.deepEqual(mapIn('const a = 1'), {});
});
