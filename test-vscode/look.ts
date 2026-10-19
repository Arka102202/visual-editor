// Opens a real project (PROJECT=<folder>) with the shell and the plugins, and takes screenshots of what it shows:
// the map fitted, and one card with its drawer (CARD=<label>, default: the card with most lines). Changes nothing.

import * as vscode from 'vscode';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

  // VERSIONS=1 with CARD: the card's versions side by side (labels and checks), then CHOOSE=<version> makes it a
  // proposal (shown, then rejected: nothing changes).
  if (process.env.VERSIONS && card) {
    const root = s.project.root;
    const seen: any[] = [];
    t.preview.frameMessages.length = 0;
    await t.preview.show({ root, item: card.id, versions: true });
    const post = t.preview.panel.webview.postMessage.bind(t.preview.panel.webview);
    t.preview.panel.webview.postMessage = (m: any) => (seen.push(m), post(m));
    await until(() => seen.some((m) => m.type === 'show' && m.comparing && m.frames.every((f: any) => f.url || f.error)), 'versions', 100_000).catch((e) => say(String(e)));
    await settle(12_000);
    await wait(2500);
    const shownMsg = seen.filter((m) => m.type === 'show').at(-1);
    say(`versions of ${card.label}: ${shownMsg?.versions} · side by side: ${shownMsg?.comparing}`);
    for (const f of shownMsg?.frames ?? []) {
      const c = f.url ? new URL(f.url).searchParams.get('c') : undefined;
      const text = t.preview.frameMessages.filter((m: any) => m.type === 'text' && m.card === c).at(-1)?.text;
      const problem = t.preview.frameMessages.filter((m: any) => m.type === 'error' && m.card === c).at(-1)?.message;
      say(`  ${f.label}${f.checks ? ` [${f.checks.summary}]` : ''}: ${f.error ? `error: ${f.error}` : `"${text ?? '(nothing reported)'}"`}${problem ? ` · error: ${String(problem).slice(0, 160)}` : ''}`);
      for (const i of f.checks?.items ?? []) if (!i.ok) say(`      ⚠ ${i.text}${i.line ? ` (line ${i.line})` : ''}`);
    }
    if (process.env.CHOOSE) {
      const before = t.review.proposals(root).length;
      const original = readFileSync(join(root, card.source?.path ?? ''), 'utf8');
      t.preview.receive({ type: 'choose', version: process.env.CHOOSE });
      await until(() => t.review.proposals(root).length > before, 'the proposal', 30_000).catch((e) => say(String(e)));
      const p = t.review.proposals(root)[0];
      say(`chose ${process.env.CHOOSE}: proposal "${p?.title}" by ${p?.by?.name} · ${p?.changes?.map((c: any) => c.path).join(', ')}`);
      if (p?.why) say(`  why: ${p.why}`);
      const after = p?.changes?.[0]?.after as string | undefined;
      if (after) say(`  new code:\n${after.split('\n').map((l: string) => '    | ' + l).join('\n')}`);
      if (readFileSync(join(root, card.source?.path ?? ''), 'utf8') !== original) say('  the file changed!');
      if (p && p.by?.kind === 'plugin') {
        t.review.store(root).mark(p, 'rejected', 'only a look test');
        t.review.reload(root, false);
      }
    }
  }

  // PICTURES=<situation>[,<situation>…] (or "all") with CARD: pictures of it (and its versions, with VERSIONS=1), saved.
  if (process.env.PICTURES && card) {
    const started = Date.now();
    try {
      const sits = process.env.PICTURES === 'all' ? 'all' : process.env.PICTURES.split(',');
      const pics = await t.preview.pictures.take(s.project.root, card.id, { situations: sits, versions: !!process.env.VERSIONS, theme: 'light' });
      say(`pictures of ${card.label}: ${pics.length} in ${Math.round((Date.now() - started) / 1000)} s`);
      for (const p of pics) say(`  ${p.label} · ${p.situation} · ${p.size}${p.width ? ` ${p.width}×${p.height}` : ''}${p.file ? ` → ${p.file}` : ''}${p.error ? ` · problem: ${p.error}` : ''}`);
    } catch (e) {
      say(`pictures: ${e instanceof Error ? e.message : e}`);
    }
    // The camera button in the Preview tab: the same pictures, of what's shown.
    const dir = join(s.project.root, '.visual-editor', 'pictures');
    const mark = Date.now();
    const { readdirSync, statSync } = await import('node:fs');
    const fresh = () => readdirSync(dir, { recursive: true }).map(String).filter((f) => f.endsWith('.png') && statSync(join(dir, f)).mtimeMs > mark);
    await t.preview.show({ root: s.project.root, item: card.id });
    await until(() => t.preview.shownFrames >= 1, 'the preview', 100_000).catch(() => undefined);
    t.preview.receive({ type: 'pictures' });
    await until(() => fresh().length >= 3, 'pictures from the camera button', 120_000).catch((e) => say(String(e)));
    say(`camera button: ${fresh().sort().join(', ')}`);
    // The hub's pictures tool, called the way Claude Code calls it.
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
    await until(() => !!t.hub.url, 'the hub to start');
    const client = new Client({ name: 'claude-code', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(t.hub.url), { requestInit: { headers: { Authorization: `Bearer ${t.hub.token}` } } }));
    const r = (await client.callTool({ name: 'pictures', arguments: { id: card.id, sizes: ['mobile'], versions: !!process.env.VERSIONS } })) as any;
    const images = r.content.filter((c: any) => c.type === 'image');
    say(`hub pictures tool: ${r.isError ? 'error: ' : ''}${r.content[0].text.split('\n')[0]} · ${images.length} images (${images.map((i: any) => `${i.mimeType} ${Math.round((i.data.length * 3) / 4 / 1024)} KB`).join(', ')})`);
    await client.close();
  }

  // PROPOSE=<file>|<find>|<replace> with CARD: a proposal changing that file, previewed Before and After (then rejected).
  if (process.env.PROPOSE && card) {
    const [path, find, replace] = process.env.PROPOSE.split('|');
    const root = s.project.root;
    const before = readFileSync(join(root, path), 'utf8');
    if (!before.includes(find)) say(`propose: "${find}" isn't in ${path}`);
    const id = `look-${Date.now()}`;
    const dir = join(root, '.visual-editor', 'proposals');
    mkdirSync(dir, { recursive: true });
    const at = new Date().toISOString();
    writeFileSync(join(dir, `${id}.json`), JSON.stringify({ id, title: 'Look test proposal', by: { kind: 'developer', name: 'look test' }, createdAt: at, status: 'proposed', changes: [{ path, before, after: before.split(find).join(replace) }], history: [{ at, status: 'proposed' }] }, null, 2));
    t.review.reload(root, false);
    await until(() => t.review.proposals(root).some((p: any) => p.id === id), 'the proposal', 10_000);
    t.preview.frameMessages.length = 0;
    const seen: any[] = [];
    await t.preview.show({ root, item: card.id, proposal: id });
    const post = t.preview.panel.webview.postMessage.bind(t.preview.panel.webview);
    t.preview.panel.webview.postMessage = (m: any) => (seen.push(m), post(m));
    await until(() => t.preview.shownFrames >= 2 || seen.some((m) => m.type === 'show' && m.frames.some((f: any) => f.error)), 'Before and After', 100_000).catch((e) => say(String(e)));
    await settle(12_000);
    await wait(2000);
    const shownMsg = seen.filter((m) => m.type === 'show').at(-1);
    for (const f of shownMsg?.frames ?? []) {
      const c = f.url ? new URL(f.url).searchParams.get('c') : undefined;
      const text = t.preview.frameMessages.filter((m: any) => m.type === 'text' && m.card === c).at(-1)?.text;
      const problem = t.preview.frameMessages.filter((m: any) => m.type === 'error' && m.card === c).at(-1)?.message;
      say(`  ${f.label}: ${f.error ? `error: ${f.error}` : `"${text ?? '(nothing reported)'}"`}${problem ? ` · error: ${problem}` : ''}`);
    }
    if (readFileSync(join(root, path), 'utf8') !== before) say('  the file changed!');
    t.review.store(root).mark(t.review.proposals(root).find((p: any) => p.id === id), 'rejected', 'only a look test');
    t.review.reload(root, false);
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
