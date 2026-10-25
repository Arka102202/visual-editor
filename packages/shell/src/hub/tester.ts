// The tester: a Claude that tries one scenario like a person would, in the change's own app, and judges it against
// what the developer asked. Used where the fast runner (caseRunner.ts) and the reading of the code disagree: the code
// reads as working, but the run broke or couldn't find what it looked for. Pages are dynamic and requests can mean more
// than one thing; matching text can't tell, a person (or Claude) can. It runs as Claude Code (Haiku unless set
// otherwise), with only the page's tools (its own small server, for this run only, with its own key) and Read to look
// at its pictures. No VS Code APIs.

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { RunSpec } from '../caseRunner';
import { PageSession } from '../pageSession';
import { FREE_READ_ENV } from './claudeLock';
import { startHttpHost } from './http';

const TOOLS = ['page_open', 'page_read', 'page_click', 'page_type', 'page_press', 'page_wait', 'page_picture'];

/** The page's tools, for one tester run. */
export function testerServer(page: PageSession, start: string): McpServer {
  const server = new McpServer({ name: 'tester', version: '1' });
  const reply = (text: string) => ({ content: [{ type: 'text' as const, text }] });
  server.registerTool('page_open', { description: `Opens a page of the app (an address starting with ${start.replace(/\/[^/]*$/, '')}/, or a path like "/settings"), and reads it.`, inputSchema: { url: z.string() } }, async ({ url }) => reply(await page.open(url.startsWith('/') ? new URL(url, start).toString() : url)));
  server.registerTool('page_read', { description: 'The page now: its controls (numbered: click or type by number), its text, and any errors it threw.', inputSchema: {} }, async () => reply(await page.read()));
  server.registerTool('page_click', { description: 'Clicks a control by its number (from page_read).', inputSchema: { ref: z.number() } }, async ({ ref }) => reply(await page.click(ref)));
  server.registerTool('page_type', { description: 'Types into a box by its number (what was in it is replaced).', inputSchema: { ref: z.number(), text: z.string() } }, async ({ ref, text }) => reply(await page.type(ref, text)));
  server.registerTool('page_press', { description: 'Presses a key (Enter, Escape, Tab, ArrowDown, a letter…).', inputSchema: { key: z.string() } }, async ({ key }) => reply(await page.press(key)));
  server.registerTool('page_wait', { description: 'Waits (up to 10 seconds), e.g. for something slow to show.', inputSchema: { ms: z.number() } }, async ({ ms }) => reply(await page.wait(ms)));
  server.registerTool('page_picture', { description: 'Takes a picture of what is on screen now; look at it with Read (its file).', inputSchema: {} }, async () => reply(`Picture: ${await page.picture()}\nOpen it with Read to look at it.`));
  return server;
}

export interface TesterCase {
  case: string;
  expected: string;
  /** How the fast runner tried it, and what it found. */
  run: RunSpec;
  found: string;
  /** Where it starts. */
  url: string;
  /** The same place in the app without the change (to tell what the change caused from what was so already). */
  baseline?: string;
}

/** What the tester is asked. */
export function testerPrompt(asked: string[], c: TesterCase): string {
  return `You test one scenario of a change to a web app, the way a person would: in the app, with the page tools, and
judge it fairly against what the developer asked.

What the developer asked for:
${asked.map((a) => `- ${a}`).join('\n')}

The scenario: ${c.case}
It should: ${c.expected}
A quick automatic run tried it like this: ${JSON.stringify({ steps: c.run.steps, expect: c.run.expect })}
and found: ${c.found}
That run matches text mechanically: it can miss things a person would see (a label on a box, text that moved, a
different word for the same thing) and it can't judge what the developer meant. Try it yourself.

Start with page_open at ${c.url}, then read the page, do the steps (click, type, press, wait), and read it again. Take
a picture at the end and look at it with Read. Judge by what the developer asked (if it can mean more than one thing,
say which you took and why). Don't change any files.${c.baseline ? `
If it doesn't work, try the same steps on the app without the change, at ${c.baseline}. If it goes wrong there in the
same way, the change didn't cause it (it was so already): say so with "already": true.` : ''}

Reply with only this JSON:
{"ok": true or false, "found": "what you did and saw, in plain words", "why": "why that does or doesn't do what was asked"${c.baseline ? ', "already": true if it goes wrong the same way without the change' : ''}}`;
}

export interface TesterVerdict {
  ok: boolean;
  found: string;
  /** The last picture it took. */
  picture?: string;
  /** It goes wrong the same way without the change: not the change's doing. */
  already?: boolean;
  cost?: number;
}

/**
 * Tries one scenario with Claude Code (`claude` is the command; `model`, Haiku unless set): its own page, its own tools
 * server, then closed. A string says why it couldn't.
 */
export async function runTester(claude: string, root: string, model: string, asked: string[], c: TesterCase, dir: string, timeoutMs = 240_000): Promise<TesterVerdict | string> {
  const page = new PageSession(dir);
  const token = randomBytes(18).toString('hex');
  const http = await startHttpHost({ port: 0, token, makeServer: () => testerServer(page, c.url) });
  try {
    const config = JSON.stringify({ mcpServers: { tester: { type: 'http', url: http.url, headers: { Authorization: `Bearer ${token}` } } } });
    const allowed = [...TOOLS.map((t) => `mcp__tester__${t}`), 'Read'].join(',');
    const args = ['-p', '--output-format', 'json', '--model', model, '--max-turns', '24', '--strict-mcp-config', '--mcp-config', config, '--allowedTools', allowed, '--disallowedTools', 'Edit,Write,MultiEdit,NotebookEdit,Bash'];
    const out = await new Promise<string>((done) => {
      const child = spawn(process.env.SHELL || '/bin/zsh', ['-lc', `${claude} ${args.map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(' ')}`], { cwd: root, env: { ...process.env, FORCE_COLOR: '0', [FREE_READ_ENV]: '1' } });
      let text = '';
      let err = '';
      const timer = setTimeout(() => {
        child.kill();
        done(`!The tester took more than ${Math.round(timeoutMs / 60_000)} minutes and was stopped.`);
      }, timeoutMs);
      child.stdout.on('data', (d: Buffer) => (text += d));
      child.stderr.on('data', (d: Buffer) => (err += d));
      child.on('error', (e) => {
        clearTimeout(timer);
        done(`!Claude Code couldn't be started for the tester: ${e.message}`);
      });
      child.on('close', () => {
        clearTimeout(timer);
        done(text || `!${err.trim().slice(0, 300) || 'no answer from Claude Code'}`);
      });
      child.stdin.end(testerPrompt(asked, c));
    });
    if (out.startsWith('!')) return out.slice(1);
    return readTester(out);
  } finally {
    page.close();
    await http.close();
  }
}

/** The tester's verdict, from Claude Code's answer; a string says why it couldn't be read. */
export function readTester(out: string): TesterVerdict | string {
  let r: { result?: string; is_error?: boolean; total_cost_usd?: number };
  try {
    r = JSON.parse(out);
  } catch {
    return `The tester's answer couldn't be read: ${out.trim().slice(0, 200)}`;
  }
  if (r.is_error) return `The tester couldn't finish: ${(r.result ?? '').trim().slice(0, 300)}`;
  const reply = r.result ?? '';
  try {
    const v = JSON.parse(reply.slice(reply.indexOf('{'), reply.lastIndexOf('}') + 1)) as { ok?: unknown; found?: unknown; why?: unknown; already?: unknown };
    if (typeof v.ok !== 'boolean') throw new Error('no verdict');
    const found = [typeof v.found === 'string' ? v.found.trim() : '', typeof v.why === 'string' ? v.why.trim() : ''].filter(Boolean).join(' ');
    const picture = /(\/[^\s"']+tester-[\w-]+\.png)/.exec(reply)?.[1];
    return { ok: v.ok, found: found || (v.ok ? 'It works.' : 'It doesn’t work.'), ...(v.already === true && !v.ok ? { already: true } : {}), ...(picture ? { picture } : {}), ...(typeof r.total_cost_usd === 'number' ? { cost: r.total_cost_usd } : {}) };
  } catch {
    return `The tester gave no clear verdict: ${reply.trim().slice(0, 200)}`;
  }
}
