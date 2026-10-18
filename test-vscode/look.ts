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
  if (process.env.VISUAL_EDITOR_REPORT) writeFileSync(process.env.VISUAL_EDITOR_REPORT, lines.join('\n') + '\n');
  void readFileSync;
}
