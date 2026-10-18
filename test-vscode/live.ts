// The "live backend" situation, end to end (npm run test:vscode with TEST=live PROJECT=<a Vite app proxying /api to
// 127.0.0.1:4555>): a backend that needs a login refuses the preview, which offers to log in; with a dev token the
// real replies come back and are recorded; with the backend off, "normal" shows the recorded real data.

import * as vscode from 'vscode';
import { createServer, type Server } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/* eslint-disable @typescript-eslint/no-explicit-any */
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const lines: string[] = [];
const say = (l: string) => (lines.push(l), console.log(l));
async function until(check: () => boolean, what: string, ms = 30_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return;
    await wait(200);
  }
  throw new Error(`waited too long for: ${what}`);
}

/** A dev backend that wants `Authorization: Bearer dev-token` (or a session cookie). */
function backend(): Promise<Server> {
  const orders = [
    { id: 'A-1', customer: { name: 'Grace Hopper' }, status: 'shipped', items: [{ sku: 't1' }, { sku: 't2' }], total: 88.5 },
    { id: 'A-2', customer: { name: 'Alan Turing' }, status: 'new', items: [{ sku: 't3' }], total: 12 },
  ];
  const server = createServer((req, res) => {
    const ok = req.headers.authorization === 'Bearer dev-token' || /session=ok/.test(req.headers.cookie ?? '');
    res.setHeader('content-type', 'application/json');
    if (!ok) return void res.writeHead(401).end(JSON.stringify({ error: 'login required' }));
    if (req.url?.startsWith('/api/orders')) return void res.end(JSON.stringify(orders));
    res.writeHead(404).end('{}');
  });
  return new Promise((r) => server.listen(4555, '127.0.0.1', () => r(server)));
}

export async function run() {
  const shellApi: any = await vscode.extensions.getExtension('arka102202.visual-editor')!.activate();
  const t = shellApi._test;
  const react: any = await vscode.extensions.getExtension('arka102202.visual-editor-react')!.activate();
  const previews = react.previews;
  previews.allowLive = async () => true;
  let token: string | undefined;
  previews.token = async () => token;
  await until(() => t.index.snapshot().some((s: any) => s.items.length), 'cards');
  await t.index.idle();
  const s = t.current.get();
  const item = s.items.find((i: any) => i.label === 'Orders');
  const server = await backend();
  let failed = 0;
  const step = async (name: string, fn: () => Promise<void>) => {
    try {
      await fn();
      say(`✔ ${name}`);
    } catch (e) {
      failed++;
      say(`✖ ${name}: ${e instanceof Error ? e.message : e}`);
    }
  };
  const textNow = () => t.preview.frameMessages.filter((m: any) => m.type === 'text').at(-1)?.text as string | undefined;
  const open = async (situation: string) => {
    t.preview.frameMessages.length = 0;
    await t.preview.show({ root: s.project.root, item: item.id });
    await until(() => t.preview.ready, 'the preview page');
    t.preview.receive({ type: 'situation', name: situation });
    await until(() => !!textNow(), `the ${situation} preview to show`, 60_000);
  };

  await step('without a login, the backend refuses and the preview offers to log in', async () => {
    await open('live backend');
    await until(() => t.preview.frameMessages.some((m: any) => m.type === 'needs-login'), 'the login offer');
    say(`  showed: "${textNow()}"`);
  });

  await step('with the dev token, real replies come back and are recorded (data only)', async () => {
    token = 'dev-token';
    await open('live backend');
    await until(() => (textNow() ?? '').includes('Grace Hopper'), 'real data on screen');
    say(`  showed: "${textNow()}"`);
    await until(() => t.preview.frameMessages.some((m: any) => m.type === 'recorded'), 'a recorded reply');
    await wait(500);
    const file = readFileSync(join(s.project.root, '.visual-editor/preview/recordings.json'), 'utf8');
    if (!file.includes('Grace Hopper')) throw new Error('the reply was not kept');
    if (/dev-token|authorization|cookie/i.test(file)) throw new Error('a login detail was written to disk');
  });

  await step('with the backend off, "normal" shows the recorded real data', async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await t.index.setProjects(t.index.snapshot().map((x: any) => x.project));
    await open('normal');
    await until(() => (textNow() ?? '').includes('Grace Hopper'), 'recorded data in normal');
    say(`  showed: "${textNow()}"`);
  });

  server.close();
  if (process.env.VISUAL_EDITOR_REPORT) writeFileSync(process.env.VISUAL_EDITOR_REPORT, lines.join('\n') + '\n');
  if (failed) throw new Error(`${failed} step(s) failed`);
}
