// Runs inside a real VS Code (npm run test:vscode): goes through what a developer does, checks each result, and takes a
// screenshot at each step (VISUAL_EDITOR_SHOTS). Uses the shell's test hook, which only exists when
// VISUAL_EDITOR_TEST=1.

import * as vscode from 'vscode';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/* eslint-disable @typescript-eslint/no-explicit-any */
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const lines: string[] = [];
const say = (line: string) => {
  lines.push(line);
  console.log(line);
};

async function until(check: () => boolean, what: string, ms = 10_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return;
    await wait(100);
  }
  throw new Error(`waited too long for: ${what}`);
}

/** Asks the launcher for something only it can do (capture the screen, run Claude Code), and waits until it's done. */
async function ask(name: string, payload: unknown, ms: number) {
  const dir = process.env.VISUAL_EDITOR_REQUESTS!;
  writeFileSync(join(dir, `${name}.ask`), JSON.stringify(payload ?? {}));
  await until(() => existsSync(join(dir, `${name}.done`)), name, ms);
  return readFileSync(join(dir, `${name}.done`), 'utf8');
}

async function shot(name: string) {
  if (!process.env.VISUAL_EDITOR_SHOTS) return;
  try {
    await ask(`shot-${name}`, {}, 8000);
  } catch {
    say(`  (no screenshot for ${name})`);
  }
}

/** Records what the shell sends to a page. */
function listen(panel: vscode.WebviewPanel | undefined): any[] {
  const seen: any[] = [];
  if (!panel) throw new Error('the tab did not open');
  const post = panel.webview.postMessage.bind(panel.webview);
  panel.webview.postMessage = (m: any) => {
    seen.push(m);
    return post(m);
  };
  return seen;
}

export async function run() {
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

  const api: any = await vscode.extensions.getExtension('arka102202.visual-editor')!.activate();
  const t = api._test;
  if (!t) throw new Error('Start with VISUAL_EDITOR_TEST=1');
  await vscode.extensions.getExtension('arka102202.visual-editor-hello')?.activate();
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  await vscode.commands.executeCommand('workbench.view.extension.visualEditor');

  const root = vscode.workspace.workspaceFolders![0].uri.fsPath;
  const readme = join(root, 'README.md');
  const original = readFileSync(readme, 'utf8');
  const hello = () => t.index.snapshot()[0]?.items.find((i: any) => i.id === 'hello:card');
  let id = '';
  let mapSeen: any[] = [];

  await step('the project is found and Hello adds its card', async () => {
    await until(() => !!hello(), 'the Hello card');
  });

  await step('an example proposal waits in Review', async () => {
    await t.review.tryExample();
    await until(() => t.review.waiting() === 1, 'one waiting proposal');
    id = t.review.proposals(root)[0].id;
    await wait(1500);
    await shot('1-review-waiting');
  });

  await step('the map marks the Hello card yellow', async () => {
    t.map.show();
    mapSeen = listen(t.map.panel);
    await until(() => t.map.ready, 'the map page');
    t.map.send();
    const last = mapSeen.filter((m) => m.type === 'show').at(-1);
    if (last?.marks['hello:card'] !== 'proposed') throw new Error(`marks were ${JSON.stringify(last?.marks)}`);
    if (last.proposed !== 1) throw new Error(`badge said ${last.proposed} proposed`);
    await wait(1200);
    await shot('2-map-yellow');
  });

  await step('approving changes the README and memory remembers it', async () => {
    await t.review.receive({ type: 'approve', id });
    if (!readFileSync(readme, 'utf8').includes('## How to run')) throw new Error('README unchanged');
    if (t.review.proposals(root)[0].status !== 'applied') throw new Error('not marked applied');
    const change = t.memory.entries(root).find((e: any) => e.kind === 'change');
    if (change?.outcome !== 'applied' || !change.items?.includes('hello:card')) throw new Error(`memory has ${JSON.stringify(change)}`);
    // The card's README row follows the new line count.
    await until(() => hello()?.fields?.some((f: any) => f.name === 'README.md' && f.value !== `${original.split('\n').length} lines`), 'the card to update');
    t.review.show();
    await wait(1500);
    await shot('3-applied');
  });

  await step("clicking the card shows its history; a note is added to it", async () => {
    t.map.focus('hello:card');
    await until(() => mapSeen.some((m) => m.type === 'card' && m.entries.length === 1), 'the card history');
    t.memory.add(root, 'note', 'Keep this card simple: it shows on every page', { items: ['hello:card'] });
    t.memory.add(root, 'rule', 'Use the theme colours, never fixed ones');
    await until(() => mapSeen.some((m) => m.type === 'card' && m.entries.length === 2), 'the note in the drawer');
    await vscode.commands.executeCommand('visualEditor.memory.focus');
    await wait(1500);
    await shot('4-card-history-and-memory');
  });

  await step('our own change is not marked as changed outside review', async () => {
    await wait(1000);
    if (t.changes.get(root).size) throw new Error(`marked: ${[...t.changes.get(root)].join(', ')}`);
  });

  await step('undo puts the README back and is remembered', async () => {
    await t.review.receive({ type: 'undo', id });
    if (readFileSync(readme, 'utf8') !== original) throw new Error('README not back');
    if (!t.memory.entries(root).some((e: any) => e.outcome === 'undone')) throw new Error('undo not remembered');
  });

  await step('a file edited by hand is marked as changed outside review', async () => {
    await wait(3500);
    appendFileSync(readme, '\nEdited by hand.\n');
    await until(() => t.changes.get(root).has('README.md'), 'the outside change');
    t.map.show();
    await wait(800);
    const last = mapSeen.filter((m) => m.type === 'show').at(-1);
    if (last?.changed !== 1) throw new Error(`badge said ${last?.changed}`);
    await wait(800);
    await shot('5-outside-change');
    writeFileSync(readme, original);
  });

  await step('an assistant reads the map and proposes through the hub', async () => {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
    await until(() => !!t.hub.url, 'the hub to start');
    const client = new Client({ name: 'claude-code', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(t.hub.url), { requestInit: { headers: { Authorization: `Bearer ${t.hub.token}` } } }));
    const text = async (name: string, args: Record<string, unknown> = {}) => ((await client.callTool({ name, arguments: args })) as any).content[0].text as string;
    const overview = await text('overview');
    if (!overview.includes('Plugins: Hello') || !overview.includes('Use the theme colours')) throw new Error(`overview: ${overview}`);
    const before = t.review.proposals(root).length;
    const now = readFileSync(readme, 'utf8');
    await text('propose_change', { title: 'Say hello in the README', why: 'A friendly start', changes: [{ path: 'README.md', content: now + '\nHello from the hub.\n' }], cards: ['hello:card'] });
    await client.close();
    const p = t.review.proposals(root)[0];
    if (t.review.proposals(root).length !== before + 1 || p.by.name !== 'Claude Code' || p.changes[0].before !== now) throw new Error(`proposal: ${JSON.stringify(p)}`);
    if (readFileSync(readme, 'utf8') !== now) throw new Error('the file changed before review');
    // Rejecting asks for a reason in an input box; mark it directly so the test doesn't wait on one.
    t.review.store(root).mark(p, 'rejected', 'only a test');
    t.review.reload(root, false);
  });

  await step('one status bar button; assistants in their own section and behind the plug button', async () => {
    const list = t.hub.assistants();
    if (list.length !== 1 || list[0].name !== 'Claude Code' || !list[0].talking) throw new Error(JSON.stringify(list));
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await vscode.commands.executeCommand('visualEditor.assistants.focus');
    await wait(1200);
    await shot('8-assistants-section');
    void vscode.commands.executeCommand('visualEditor.chooseAssistant');
    await wait(1200);
    await shot('9-assistants-dropdown');
    await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
  });

  await step('Connect finds claude (even off the PATH), the list says connected, and Disconnect removes it', async () => {
    await t.hub.connectClaudeCode();
    await until(() => t.hub.claudeState() === 'on', 'Claude Code settings to have the hub', 15_000);
    await vscode.commands.executeCommand('visualEditor.assistants.focus');
    await wait(1500);
    await shot('10-assistant-connected');
    await t.hub.disconnectClaudeCode();
    await until(() => t.hub.claudeState() === 'off', 'the hub to be gone from Claude Code settings', 15_000);
  });

  if (process.env.VISUAL_EDITOR_CLAUDE === '1') {
    await step('real Claude Code proposes a change through the hub, and approving applies it', async () => {
      const before = t.review.proposals(root).length;
      const out = await ask('claude', { url: t.hub.url, token: t.hub.token, cwd: root }, 240_000);
      say(`  Claude Code said: ${out.trim().split('\n').slice(-3).join(' / ').slice(0, 300)}`);
      await until(() => t.review.proposals(root).length > before, 'the proposal from Claude Code', 5000);
      const p = t.review.proposals(root)[0];
      if (p.by.name !== 'Claude Code') throw new Error(`proposed by ${p.by.name}`);
      t.review.show(p.id);
      await wait(1500);
      await shot('6-claude-proposal');
      await t.review.receive({ type: 'approve', id: p.id });
      if (!readFileSync(readme, 'utf8').includes('Made with Visual Editor')) throw new Error('README does not have the line');
      await wait(1200);
      await shot('7-claude-applied');
    });
  }

  if (process.env.VISUAL_EDITOR_REPORT) writeFileSync(process.env.VISUAL_EDITOR_REPORT, lines.join('\n') + '\n');
  if (failed) throw new Error(`${failed} step(s) failed`);
}
