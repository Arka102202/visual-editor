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
  // PREVIEW=<label>[,<label>…] (or "all": every component card): open each card's preview, wait until it's on screen,
  // take pictures in some situations (SITUATIONS=<name>[,<name>…], or "all": every one the card offers but the live backend).
  const all = process.env.PREVIEW === 'all';
  const labels = all ? [...new Set(s.items.filter((i: any) => i.id.startsWith('react:component:')).map((i: any) => i.label as string))] : (process.env.PREVIEW ?? '').split(',').filter(Boolean);
  /** Waits until the page has said what it shows and then gone quiet (or `ms` passed). */
  const settle = async (ms: number) => {
    const end = Date.now() + ms;
    let count = -1;
    let quietSince = Date.now();
    while (Date.now() < end) {
      const n = t.preview.frameMessages.length;
      if (n !== count) {
        count = n;
        quietSince = Date.now();
      }
      const reported = t.preview.frameMessages.some((m: any) => m.type === 'text' || m.type === 'error');
      if (reported && Date.now() - quietSince > 1500) return;
      await wait(200);
    }
  };
  const tally = { cards: 0, views: 0, shown: 0, crashed: [] as string[], notExported: [] as string[], nothing: [] as string[], silent: [] as string[] };
  /** What one view came to, from what the page said. */
  const classify = (label: string, situation: string) => {
    tally.views++;
    const msgs = t.preview.frameMessages as any[];
    const text = msgs.filter((m) => m.type === 'text').at(-1);
    const error = msgs.filter((m) => m.type === 'error').at(-1);
    const where = `${label} (${situation})`;
    if (error && /is not exported/.test(error.message)) tally.notExported.push(where);
    else if (!text) tally.silent.push(error ? `${where}: ${String(error.message).slice(0, 120)}` : where);
    else if (/This component crashes/.test(text.text)) tally.crashed.push(`${where}: ${String(text.text).slice(0, 140)}`);
    else if (!text.text && !text.drawn) tally.nothing.push(where);
    else tally.shown++;
  };
  for (const label of labels as string[]) {
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
    await settle(12_000);
    tally.cards++;
    classify(label, 'normal');
    const said = t.preview.frameMessages.slice(-6).map((m: any) => `${m.type}${m.outcome ? ` ${m.outcome}` : ''}${m.message ? `: ${String(m.message).slice(0, 160)}` : ''}${m.text ? `: "${m.text}"` : ''}`);
    say(`  page said: ${said.join(' · ') || 'nothing'}`);
    t.preview.frameMessages.length = 0;
    await shot(`look-preview-${label}`);
    const asked = process.env.SITUATIONS === 'all' ? ((shown()?.situations ?? []) as string[]).filter((x) => x !== 'normal' && x !== 'live backend') : (process.env.SITUATIONS ?? '').split(',').filter(Boolean);
    for (const situation of asked) {
      t.preview.shownFrames = 0;
      t.preview.receive({ type: 'situation', name: situation });
      await until(() => shown()?.situation === situation, situation, 30_000).catch(() => undefined);
      await settle(situation === 'loading' ? 3000 : 8000);
      const text = t.preview.frameMessages.filter((m: any) => m.type === 'text').at(-1)?.text;
      classify(label, situation);
      say(`  ${situation}: "${text ?? '(nothing reported)'}"`);
      t.preview.frameMessages.length = 0;
      await shot(`look-preview-${label}-${situation.replace(/\s+/g, '-')}`);
    }
  }

  if (labels.length) {
    say(`summary: ${tally.cards} cards, ${tally.views} views · shows something ${tally.shown} · crashed ${tally.crashed.length} · not exported ${tally.notExported.length} · draws nothing ${tally.nothing.length} · never reported ${tally.silent.length}`);
    for (const c of tally.crashed) say(`  crashed: ${c}`);
    for (const c of tally.silent) say(`  never reported: ${c}`);
    const byCard = (list: string[]) => [...new Set(list.map((x) => x.replace(/ \(.*$/, '')))].join(', ');
    if (tally.nothing.length) say(`  draws nothing (cards): ${byCard(tally.nothing)}`);
    for (const c of tally.nothing) say(`    draws nothing: ${c}`);
    if (tally.notExported.length) say(`  not exported (cards): ${byCard(tally.notExported)}`);
  }
  if (process.env.VISUAL_EDITOR_REPORT) writeFileSync(process.env.VISUAL_EDITOR_REPORT, lines.join('\n') + '\n');
  void readFileSync;
}
