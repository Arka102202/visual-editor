import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DraftApps } from '../src/proxy/draftApps';

// A stand-in for draftServer.js: an app on its port that answers with the draft's files it was given.
const SERVER = `
const http = require('node:http');
const fs = require('node:fs');
const [, , root, files, port] = process.argv;
http.createServer((req, res) => res.end(fs.readFileSync(files, 'utf8'))).listen(Number(port), '127.0.0.1', () => console.log('READY http://127.0.0.1:' + port));
process.stdin.on('end', () => process.exit(0));
process.stdin.resume();
`;

test('draft apps: each draft has its own, side by side; the one unused longest makes room, never one checks are using', async () => {
  const root = mkdtempSync(join(tmpdir(), 've-apps-'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { dev: 'vite' } }));
  const script = join(root, 'server.cjs');
  writeFileSync(script, SERVER);
  const apps = new DraftApps({ script, node: { command: process.execPath, env: {} }, log: () => {}, max: 2 });
  const draft = (id: string) => ({ id, revision: 1, changes: [{ path: 'src/A.tsx', before: 'a', after: id }] });
  const page = () => undefined;
  const read = async (origin: string) => (await fetch(`${origin}/x.js`).then((r) => r.text()).catch(() => 'gone'));
  try {
    const a = await apps.open(root, draft('a'), page);
    const b = await apps.open(root, draft('b'), page);
    assert.notEqual(a, b, 'its own address');
    assert.deepEqual([await read(a), await read(b)], ['{"src/A.tsx":"a"}', '{"src/A.tsx":"b"}'], 'each its own files');
    // Checks are using a: opening c (room for 2) stops b, though a was opened first.
    const release = apps.hold(root, 'a');
    await apps.open(root, draft('b'), page);
    const c = await apps.open(root, draft('c'), page);
    assert.equal(await read(a), '{"src/A.tsx":"a"}', 'a kept: it is held');
    assert.equal(await read(c), '{"src/A.tsx":"c"}');
    assert.deepEqual(apps.runningFor(root), ['a', 'c'], 'b made room');
    // Let go: a can make room now.
    release();
    await apps.open(root, draft('c'), page);
    await apps.open(root, draft('d'), page);
    assert.deepEqual(apps.runningFor(root), ['c', 'd']);
  } finally {
    await apps.stop();
  }
});
