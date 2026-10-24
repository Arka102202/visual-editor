// Opens a real project (PROJECT=<folder>) with the shell and the plugins, opens the Webview on its app (through the
// proxy, with its dev server), and stays open so it can be driven from outside (DEBUG_PORT: Chrome's debugging
// protocol; <requests>/hub.json has the hub's address and key): until <requests>/stop exists, or HOLD_S seconds
// (default 600). Changes nothing in the project by itself.

import * as vscode from 'vscode';
import { existsSync, writeFileSync } from 'node:fs';
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

export async function run() {
  const requests = process.env.VISUAL_EDITOR_REQUESTS!;
  try {
    const api: any = await vscode.extensions.getExtension('arka102202.visual-editor')!.activate();
    const t = api._test;
    for (const e of vscode.extensions.all) if (e.id.startsWith('arka102202.visual-editor-')) await e.activate();
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await vscode.commands.executeCommand('workbench.view.extension.visualEditor');
    await until(() => t.index.snapshot().some((s: any) => s.items.length), 'cards', 60_000);
    t.map.show();
    await until(() => t.map.ready, 'the map');
    await vscode.commands.executeCommand('visualEditor.openWebview');
    say('webview opened');
    // The hub's address and key, so the driver can point a real Claude Code at it.
    await until(() => !!t.hub.url, 'the hub');
    writeFileSync(join(requests, 'hub.json'), JSON.stringify({ url: t.hub.url, token: t.hub.token }));
    // CONNECT=1: press Connect, as the developer would (Claude Code's settings for this folder get the hub and the agents).
    if (process.env.VISUAL_EDITOR_CONNECT === '1') {
      await t.hub.connectClaudeCode();
      say(`connected: ${t.hub.claudeState()}, agents ${t.hub.assistants()[0].agents}`);
    }
    writeFileSync(join(requests, 'ready'), '');
    await until(() => existsSync(join(requests, 'stop')), 'stop', Number(process.env.HOLD_S ?? 600) * 1000).catch(() => say('held until the time ran out'));
  } catch (e) {
    say(`failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (process.env.VISUAL_EDITOR_REPORT) writeFileSync(process.env.VISUAL_EDITOR_REPORT, lines.join('\n') + '\n');
}
