// Opens a real project (PROJECT=<folder>) with the shell and the plugins, and takes screenshots of what it shows:
// the map fitted, and one card with its drawer (CARD=<label>, default: the card with most lines). Changes nothing.

import * as vscode from 'vscode';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
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

async function shot(name: string) {
  const dir = process.env.VISUAL_EDITOR_REQUESTS!;
  if (!process.env.VISUAL_EDITOR_SHOTS) return;
  writeFileSync(join(dir, `shot-${name}.ask`), '{}');
  await until(() => existsSync(join(dir, `shot-${name}.done`)), name, 10_000).catch(() => say(`  (no screenshot for ${name})`));
}

export async function run() {
  const api: any = await vscode.extensions.getExtension('arka102202.visual-editor')!.activate();
  const t = api._test;
  for (const e of vscode.extensions.all) if (e.id.startsWith('arka102202.visual-editor-')) await e.activate();
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  await vscode.commands.executeCommand('workbench.view.extension.visualEditor');
  await until(() => t.index.snapshot().some((s: any) => s.items.length), 'cards');
  await t.index.idle();
  for (const s of t.index.snapshot()) {
    const maps = new Map<string, number>();
    for (const i of s.items) maps.set(i.map, (maps.get(i.map) ?? 0) + 1);
    say(`${s.project.name}: ${s.detected.map((d: any) => d.plugin.name).join(', ')} · ${[...maps].map(([m, n]) => `${m} ${n}`).join(', ')} · ${s.links.length} lines${s.problems.length ? ` · problems: ${JSON.stringify(s.problems)}` : ''}`);
  }
  t.map.show();
  await until(() => t.map.ready, 'the map');
  await wait(2500);
  await shot('look-map');
  const s = t.current.get();
  const count = (id: string) => s.links.filter((l: any) => l.from === id || l.to === id).length;
  const card = process.env.CARD ? s.items.find((i: any) => i.label === process.env.CARD) : [...s.items].sort((a: any, b: any) => count(b.id) - count(a.id))[0];
  if (card) {
    t.map.focus(card.id);
    await wait(2000);
    await shot('look-card');
    say(`card: ${card.label} (${card.kind}) · ${count(card.id)} lines`);
  }
  // PREVIEW=<label>[,<label>…]: open each card's preview, wait until it's on screen, take pictures in some situations.
  for (const label of (process.env.PREVIEW ?? '').split(',').filter(Boolean)) {
    const item = s.items.find((i: any) => i.label === label);
    if (!item) {
      say(`preview ${label}: no such card`);
      continue;
    }
    const started = Date.now();
    t.preview.shownFrames = 0;
    await t.preview.show({ root: s.project.root, item: item.id });
    const seen: any[] = [];
    const post = t.preview.panel.webview.postMessage.bind(t.preview.panel.webview);
    t.preview.panel.webview.postMessage = (m: any) => (seen.push(m), post(m));
    const shown = () => seen.filter((m) => m.type === 'show').at(-1);
    try {
      await until(() => t.preview.shownFrames >= 1 || !!shown()?.frames[0]?.error, `the preview of ${label}`, 100_000);
    } catch (e) {
      say(`preview ${label}: ${e instanceof Error ? e.message : e}`);
    }
    const f = shown()?.frames[0];
    say(`preview ${label}: ${f?.error ? `error: ${f.error}` : `on screen after ${Math.round((Date.now() - started) / 1000)} s · ${f?.url ?? ''}`}`);
    await wait(9000);
    const said = t.preview.frameMessages.slice(-6).map((m: any) => `${m.type}${m.outcome ? ` ${m.outcome}` : ''}${m.message ? `: ${String(m.message).slice(0, 160)}` : ''}`);
    say(`  page said: ${said.join(' · ') || 'nothing'}`);
    t.preview.frameMessages.length = 0;
    await shot(`look-preview-${label}`);
    for (const situation of (process.env.SITUATIONS ?? '').split(',').filter(Boolean)) {
      t.preview.shownFrames = 0;
      t.preview.receive({ type: 'situation', name: situation });
      await until(() => shown()?.situation === situation, situation, 30_000).catch(() => undefined);
      await wait(3000);
      await shot(`look-preview-${label}-${situation.replace(/\s+/g, '-')}`);
    }
  }

  if (process.env.VISUAL_EDITOR_REPORT) writeFileSync(process.env.VISUAL_EDITOR_REPORT, lines.join('\n') + '\n');
  void readFileSync;
}
