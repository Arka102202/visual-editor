// How Visual Editor performs on a big project (PROJECT=<folder>, PLUGINS=react): reading it, drawing each map and
// moving around it (frame times), noticing a saved change, previews, and the assistant hub. Changes nothing (the
// one file it edits is put back).

import * as vscode from 'vscode';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/* eslint-disable @typescript-eslint/no-explicit-any */
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const lines: string[] = [];
const say = (l: string) => (lines.push(l), console.log(l));
const s1 = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`);
const mb = (b: number) => `${Math.round(b / 1024 / 1024)} MB`;

async function until(check: () => boolean, what: string, ms = 60_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return;
    await wait(100);
  }
  throw new Error(`waited too long for: ${what}`);
}

export async function run() {
  const opened = Date.now() - process.uptime() * 1000;
  const api: any = await vscode.extensions.getExtension('arka102202.visual-editor')!.activate();
  const t = api._test;
  for (const e of vscode.extensions.all) if (e.id.startsWith('arka102202.visual-editor-')) await e.activate();
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');

  // 1. Reading the project.
  await until(() => t.index.snapshot().some((s: any) => s.items.length), 'cards', 15 * 60_000);
  await t.index.idle();
  const readMs = Date.now() - opened;
  const s = t.index.snapshot()[0];
  const byMap = new Map<string, number>();
  for (const i of s.items) byMap.set(i.map, (byMap.get(i.map) ?? 0) + 1);
  say(`project: ${s.project.files.length} files · ${s.items.length} cards (${[...byMap].map(([m, n]) => `${m} ${n}`).join(', ')}) · ${s.links.length} lines`);
  say(`read: ${s1(readMs)} from the window opening to every card read · extension host memory ${mb(process.memoryUsage().rss)} (heap ${mb(process.memoryUsage().heapUsed)})`);

  // 2. Each map: layout (in the extension), drawing (in the map), frame times while panning and zooming.
  t.map.show();
  await until(() => t.map.ready, 'the map', 120_000);
  const measureMap = async (label: string) => {
    await wait(1500);
    t.map.measure();
    await until(() => !!t.map.measured, `measuring ${label}`, 10 * 60_000).catch((e) => say(String(e)));
    const m = t.map.measured;
    if (!m) return;
    say(`map ${label}: ${m.cards} cards, ${m.lines} lines, ${m.elements} page elements · layout ${s1(t.map.layoutMs)} · drawing ${s1(m.drawMs)}`);
    say(`  frames zoomed out: panning average ${m.pan.avg} ms (95% under ${m.pan.p95}, worst ${m.pan.max}) · zooming average ${m.zoom.avg} ms (95% under ${m.zoom.p95}, worst ${m.zoom.max})`);
    if (m.nearPan) say(`  frames zoomed in: panning average ${m.nearPan.avg} ms (95% under ${m.nearPan.p95}, worst ${m.nearPan.max}) with ${m.nearCards} card elements`);
    if (m.paintPan) say(`  painting per frame: ${m.paintPan.avg} ms panning, ${m.paintZoom.avg} ms zooming`);
  };
  const shownAt = Date.now();
  await measureMap(`${t.map.shownMap} (first open, ${s1(Date.now() - shownAt)} to draw)`);
  for (const map of [...byMap.keys()]) {
    for (const arrange of ['folders', 'flow']) {
      t.map.receive({ type: 'chooseMap', id: map });
      t.map.receive({ type: 'arrange', arrange });
      await wait(500);
      await measureMap(`${map} · ${arrange}`);
    }
  }

  // 3. A saved change: noticed and the cards updated.
  const file = s.items.find((i: any) => i.source?.path?.includes('features/'))?.source.path ?? s.project.files.find((f: string) => f.endsWith('.tsx'));
  const full = join(s.project.root, file);
  const original = readFileSync(full, 'utf8');
  let changed = false;
  const off = t.index.onChange(() => (changed = true));
  const editAt = Date.now();
  writeFileSync(full, original.replace(/<h3>/, '<h3 data-perf="1">'));
  await until(() => changed, 'the change to be noticed', 120_000).catch((e) => say(String(e)));
  await t.index.idle();
  say(`a saved change: noticed and read again in ${s1(Date.now() - editAt)} (${file})`);
  off.dispose();
  writeFileSync(full, original);
  await wait(1500);
  await t.index.idle();

  // 4. Previews: the first (starts the dev server, reads the types), then others.
  const preview = async (label: string) => {
    const item = s.items.find((i: any) => i.label === label);
    if (!item) return say(`preview ${label}: no such card`);
    t.preview.frameMessages.length = 0;
    t.preview.shownFrames = 0;
    const at = Date.now();
    await t.preview.show({ root: s.project.root, item: item.id });
    await until(() => t.preview.frameMessages.some((m: any) => m.type === 'text' || m.type === 'error'), `preview ${label}`, 5 * 60_000).catch((e) => say(String(e)));
    const text = t.preview.frameMessages.find((m: any) => m.type === 'text')?.text ?? t.preview.frameMessages.find((m: any) => m.type === 'error')?.message;
    say(`preview ${label}: ${s1(Date.now() - at)} until it shows · "${String(text ?? '').slice(0, 90)}"`);
  };
  const components = s.items.filter((i: any) => i.id.startsWith('react:component:'));
  const pick = (re: RegExp) => components.find((i: any) => re.test(i.label))?.label;
  for (const label of [pick(/Card0$/), pick(/List51$/), pick(/^Page250$/), pick(/Banner9998$/) ?? pick(/9998$/)].filter(Boolean)) await preview(label as string);

  // 5. The assistant hub, as Claude Code calls it.
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  await until(() => !!t.hub.url, 'the hub to start');
  const client = new Client({ name: 'claude-code', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(t.hub.url), { requestInit: { headers: { Authorization: `Bearer ${t.hub.token}` } } }));
  for (const [name, args] of [['overview', {}], ['list_cards', {}], ['list_cards', { search: 'Order' }], ['card', { id: components[0]?.id }]] as const) {
    const at = Date.now();
    const r = (await client.callTool({ name, arguments: args as Record<string, unknown> })) as any;
    const text = String(r.content?.[0]?.text ?? '');
    say(`hub ${name}${Object.keys(args).length ? ` ${JSON.stringify(args).slice(0, 40)}` : ''}: ${s1(Date.now() - at)} · ${Math.round(text.length / 1024)} KB of text`);
  }
  await client.close();
  say(`extension host memory at the end: ${mb(process.memoryUsage().rss)} (heap ${mb(process.memoryUsage().heapUsed)})`);

  if (process.env.VISUAL_EDITOR_REPORT) writeFileSync(process.env.VISUAL_EDITOR_REPORT, lines.join('\n') + '\n');
}
