// The TypeScript check as its own process (dist/typesCheck.js, with a memory limit), with the project's own TypeScript:
// reads { root, files } on stdin, writes the result (types/typeCheck.ts) as JSON, or { error }.

import { createRequire } from 'node:module';
import { join } from 'node:path';
import { typeCheck, type Ts } from './types/typeCheck';

let input = '';
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  try {
    const { root, files } = JSON.parse(input) as { root: string; files: Record<string, string | null> };
    let ts: Ts;
    try {
      ts = createRequire(join(root, 'package.json'))('typescript');
    } catch {
      process.stdout.write(JSON.stringify({ error: 'This project has no TypeScript in node_modules, so there is nothing to check with.' }));
      return;
    }
    process.stdout.write(JSON.stringify(typeCheck(ts, root, files)));
  } catch (e) {
    process.stdout.write(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
  }
});
