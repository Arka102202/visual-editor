// Runs inside a real VS Code (npm run test:vscode): goes through what a developer does, checks each result, and takes a
// screenshot at each step (VISUAL_EDITOR_SHOTS). Uses the shell's test hook, which only exists when
// VISUAL_EDITOR_TEST=1.

import * as vscode from 'vscode';
import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DraftStore } from '../packages/shell/src/drafts';
import { asItIs } from '../packages/shell/src/hub/checkPlan';
import { JobStore } from '../packages/shell/src/jobs';

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
    // The last step put README back on disk: the hub reads it as the editor shows it, once VS Code has reloaded it.
    await until(() => vscode.workspace.textDocuments.every((d) => d.uri.fsPath !== readme || d.getText() === readFileSync(readme, 'utf8')), 'the open README to match the file');
    const client = new Client({ name: 'claude-code', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(t.hub.url), { requestInit: { headers: { Authorization: `Bearer ${t.hub.token}` } } }));
    const text = async (name: string, args: Record<string, unknown> = {}) => ((await client.callTool({ name, arguments: args })) as any).content[0].text as string;
    const overview = await text('overview');
    if (!overview.includes('Plugins: Hello') || !overview.includes('Use the theme colours')) throw new Error(`overview: ${overview}`);
    const before = t.review.proposals(root).length;
    const now = readFileSync(readme, 'utf8');
    await text('propose_change', { asked: 'Say hello in the README', title: 'Say hello in the README', why: 'A friendly start', changes: [{ path: 'README.md', content: now + '\nHello from the hub.\n' }], cards: ['hello:card'] });
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

  await step('Connect finds claude (even off the PATH) and adds Visual Editor’s agents for the folder; they update when plugins change; Disconnect removes both', async () => {
    await t.hub.connectClaudeCode();
    await until(() => t.hub.claudeState() === 'on', 'Claude Code settings to have the hub', 15_000);
    // The agents: made from the plugins (Hello's example agent), and installed for this folder only.
    const agents = t.hub.agents;
    const local = () => JSON.parse(readFileSync(join(root, '.claude', 'settings.local.json'), 'utf8'));
    if (t.hub.assistants()[0].agents !== 'on') throw new Error(`agents: ${t.hub.assistants()[0].agents}`);
    if (local().enabledPlugins?.[agents.ref] !== true) throw new Error(`settings.local.json: ${JSON.stringify(local())}`);
    if (!readFileSync(join(agents.dir, 'visual-editor', 'agents', 'hello-note-worker.md'), 'utf8').includes('hello_files')) throw new Error('the worker isn’t in the plugin');
    // Review only: Claude's file tools are denied in the folder, and the check before each tool is Visual Editor's own,
    // which stops a shell command writing into the project (exit code 2, with what to do instead).
    if (!t.hub.assistants()[0].reviewOnly || !local().permissions?.deny?.some((d: string) => d.startsWith('Edit(//')) ) throw new Error(`not locked to Review: ${JSON.stringify(local())}`);
    const guard: string = local().hooks.PreToolUse.find((e: any) => e.hooks[0].command.includes('visual-editor-guard')).hooks[0].command;
    const ran = require('node:child_process').spawnSync('/bin/sh', ['-c', guard], { input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'echo x > src/a.ts' }, cwd: root }), encoding: 'utf8' });
    if (ran.status !== 2 || !/save_draft[\s\S]*Stopped: writes to src\/a\.ts/.test(ran.stderr)) throw new Error(`the check: ${ran.status} ${ran.stderr}`);
    // With each message, a reminder; reading the project waits until Visual Editor is asked, then is free.
    const hook = (call: object) => require('node:child_process').spawnSync('/bin/sh', ['-c', guard], { input: JSON.stringify({ session_id: `smoke-${Date.now()}`, cwd: root, ...call }), encoding: 'utf8' });
    const session = `smoke-${Date.now()}`;
    const said = hook({ session_id: session, hook_event_name: 'UserPromptSubmit', prompt: 'hi' });
    const held = hook({ session_id: session, hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: join(root, 'README.md') } });
    hook({ session_id: session, hook_event_name: 'PreToolUse', tool_name: 'mcp__visual-editor__overview', tool_input: {} });
    const free = hook({ session_id: session, hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: join(root, 'README.md') } });
    if (said.status !== 0 || !/ask it first/.test(said.stdout) || held.status !== 2 || !/ask the map first/.test(held.stderr) || free.status !== 0) throw new Error(`map first: ${JSON.stringify([said.stdout, held.status, held.stderr, free.status, free.stderr])}`);
    // Off, then on again.
    await vscode.workspace.getConfiguration('visualEditor.claude').update('reviewOnly', false, vscode.ConfigurationTarget.Global);
    await until(() => !t.hub.assistants()[0].reviewOnly && !JSON.stringify(local()).includes('visual-editor-guard'), 'the lock to come off', 5000);
    await vscode.workspace.getConfiguration('visualEditor.claude').update('reviewOnly', undefined, vscode.ConfigurationTarget.Global);
    await until(() => t.hub.assistants()[0].reviewOnly, 'the lock to go on again', 5000);
    // A plugin that brings another agent: a new version, which Claude Code updates to for this folder by itself.
    const extra = api.register({ id: 'extra', name: 'Extra', version: '0', contract: api.contract, detect: () => undefined, agents: [{ name: 'extra-job', title: 'Extra job', description: 'A test agent.', worker: { prompt: 'Work.' }, checker: { prompt: 'Check.' } }] });
    const cache = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'plugins', 'cache', agents.marketplace, 'visual-editor');
    const updated = () => existsSync(cache) && readdirSync(cache).some((v) => existsSync(join(cache, v, 'agents', 'extra-job-worker.md')));
    await until(() => updated() && t.hub.assistants()[0].agents === 'on', 'Claude Code to update to the new agents', 30_000);
    // The Agents section lists what each plugin gives (Hello's agent, skill and tool; the extra plugin's agent).
    // (Each as a coloured badge: Agent, Skill or Tool, with a plain-words pop-over.)
    const shown = () => t.agentsView.state() as { status?: { action: string }; groups: { name: string; items: { kind: string; title: string; summary: string }[] }[] };
    const groups = shown().groups;
    const hello = groups.find((g) => g.name === 'Hello');
    if (groups.map((g) => g.name).join() !== 'Visual Editor,Extra,Hello' || hello?.items.map((i) => `${i.kind}:${i.title}`).join() !== 'agent:Write a hello note,skill:How to say hello,tool:Count the project’s files' || hello.items[0].summary !== 'An example agent: writes a one-line hello note for the README.') throw new Error(`agents section: ${JSON.stringify(groups)}`);
    // A finished job shows under its agent: how it ended, what happened, and what became of its proposal in Review.
    const proposal = t.review.proposals(root)[0];
    const at = new Date().toISOString();
    new JobStore(root).save({ id: 'test-job', agent: 'hello-note', title: 'Write a hello note', request: 'Say hello', status: 'passed', round: 2, rounds: 2, startedAt: at, until: at, proposal: proposal.id, by: 'a button (in the background)', history: [{ at, who: 'Visual Editor', what: 'Started: Say hello' }, { at, who: 'checker', what: 'Sent back: too long' }, { at, who: 'checker', what: 'Passed' }] });
    const result = (t.agentsView.state() as any).groups.find((g: any) => g.name === 'Hello').items[0].recent?.[0];
    if (!result || result.status !== 'passed' || result.steps.map((x: any) => x.what).join() !== 'Sent back: too long,Passed' || !/rejected|waiting|approved|undone|sent back/.test(result.inReview ?? '')) throw new Error(`recent result: ${JSON.stringify(result)}`);
    await vscode.commands.executeCommand('visualEditor.agents.focus');
    await wait(1500);
    await shot('11-agents-section');
    extra.dispose();
    await vscode.commands.executeCommand('visualEditor.assistants.focus');
    await wait(1500);
    await shot('10-assistant-connected');
    await t.hub.disconnectClaudeCode();
    await until(() => t.hub.claudeState() === 'off', 'the hub to be gone from Claude Code settings', 15_000);
    if (t.hub.assistants()[0].agents !== 'off' || local().enabledPlugins?.[agents.ref]) throw new Error('the agents are still installed');
    if (t.hub.assistants()[0].reviewOnly || JSON.stringify(local()).includes('visual-editor-guard')) throw new Error(`still locked after disconnect: ${JSON.stringify(local())}`);
    if (shown().status?.action !== 'connect' || shown().groups.map((g) => g.name).join() !== 'Visual Editor,Hello') throw new Error(`agents section after disconnect: ${JSON.stringify(shown())}`);
    // The test's own marketplace points at this throwaway VS Code's storage: take it out of Claude Code again.
    await new Promise((done) => require('node:child_process').exec(`claude plugin marketplace remove ${agents.marketplace}`, { cwd: root, env: { ...process.env, PATH: `${join(homedir(), '.local/bin')}:${process.env.PATH}` } }, done));
  });

  await step('a design session opens in its own tab and follows its draft as it changes', async () => {
    const draft = t.sessions.start(root);
    const seen = listen(t.sessions.panel(root, draft.id));
    const last = () => [...seen].reverse().find((m) => m.type === 'show')?.session;
    await until(() => last()?.status?.kind === 'open' && (last()?.error || last()?.app), 'the session to show (or say why its app can’t run)', 20_000);
    if (last().title !== 'Design session' || last().asked.length || last().versions.length) throw new Error(`a new session: ${JSON.stringify(last())}`);
    // Claude (or anyone) saves new versions of its draft: the tab follows by itself, versions and all.
    const store = new DraftStore(root);
    const readme = readFileSync(join(root, 'README.md'), 'utf8');
    const now = () => new Date().toISOString();
    store.save({ ...draft, asked: ['Say hello in the README'], changes: [{ path: 'README.md', before: readme, after: `${readme}\nHello!\n` }], revision: 2, updatedAt: now() });
    await until(() => last()?.revision === 2 && last()?.versions.length === 1, 'the session to follow version 2', 10_000);
    store.save({ ...store.list().find((d) => d.id === draft.id)!, changes: [{ path: 'README.md', before: readme, after: `${readme}\nHello again!\n` }], revision: 3, updatedAt: now() });
    await until(() => last()?.revision === 3 && last()?.versions.map((v: { revision: number }) => v.revision).join() === '3,2', 'the session to follow version 3', 10_000);
    if (last().asked.join() !== 'Say hello in the README') throw new Error(`what was asked: ${JSON.stringify(last().asked)}`);
    await wait(1500);
    await shot('13-design-session');
    t.sessions.panel(root, draft.id)?.dispose();
    store.remove(draft.id);
  });

  await step('a proposal continues in a design session; Done puts the result back into the same proposal', async () => {
    const readme = readFileSync(join(root, 'README.md'), 'utf8');
    const at = new Date().toISOString();
    const id = `${Date.now()}-cont1`;
    t.review.receiveProposal(root, { id, title: 'Say hello', why: 'w', asked: ['Say hello in the README'], by: { kind: 'assistant', name: 'Claude Code' }, createdAt: at, status: 'proposed', changes: [{ path: 'README.md', before: readme, after: `${readme}\nHello!\n` }], history: [{ at, status: 'proposed' }] });
    const proposal = () => t.review.proposals(root).find((p: { id: string }) => p.id === id);
    t.sessions.continueProposal(root, proposal());
    await until(() => !!proposal()?.session, 'the proposal to be marked as in a session', 5000);
    const store = new DraftStore(root);
    const draft = store.list().find((d) => d.id === proposal().session)!;
    if (draft.changes[0]?.after !== `${readme}\nHello!\n` || draft.session?.proposal !== id || draft.asked?.join() !== 'Say hello in the README') throw new Error(`the session's draft: ${JSON.stringify(draft)}`);
    // Locked while in the session: approving it does nothing.
    await vscode.commands.executeCommand('visualEditor.openReview');
    await wait(800);
    await shot('14-proposal-in-session');
    // More changes in the session, then Done: the same proposal, waiting again, with the new changes.
    store.save({ ...draft, asked: [...(draft.asked ?? []), 'And say goodbye'], changes: [{ path: 'README.md', before: readme, after: `${readme}\nHello!\nGoodbye!\n` }], revision: 2, updatedAt: new Date().toISOString() });
    // Done: its test cases are written (a README change: no planner needed), shown, then run as they are.
    const plan = await t.hub.planDraft(root, draft.id);
    if (typeof plan === 'string') throw new Error(`test cases: ${plan}`);
    const run = t.hub.runChecks(root, draft.id, asItIs(plan));
    if (typeof run === 'string') throw new Error(`Run: ${run}`);
    const sent = await run.promise;
    if (typeof sent === 'string') throw new Error(`Done: ${sent}`);
    await until(() => proposal()?.changes[0].after.endsWith('Goodbye!\n') && !proposal()?.session, 'the proposal to be updated', 5000);
    const p = proposal();
    if (p.status !== 'proposed' || p.asked.join(' | ') !== 'Say hello in the README | And say goodbye' || p.history.at(-1).note !== 'Changed in a design session' || t.review.proposals(root).filter((x: { title: string }) => x.title === 'Say hello').length !== 1) throw new Error(`the updated proposal: ${JSON.stringify(p)}`);
    t.sessions.panel(root, draft.id)?.dispose();
    store.remove(draft.id);
    require('node:fs').rmSync(join(root, '.visual-editor', 'proposals', `${id}.json`), { force: true });
  });

  await step('a change waiting with its test cases continues in a design session; Done and Run put the result back into the same proposal', async () => {
    const readme = readFileSync(join(root, 'README.md'), 'utf8');
    const at = new Date().toISOString();
    const store = new DraftStore(root);
    const id = `${Date.now()}-wait2`;
    store.save({ id, title: 'Say hello there', why: 'w', by: { kind: 'assistant', name: 'Claude Code' }, createdAt: at, updatedAt: at, status: 'draft', changes: [{ path: 'README.md', before: readme, after: `${readme}\nHello there\n` }], asked: ['Say hello there'], revision: 1, evidence: [] });
    await t.hub.planDraft(root, id);
    const entry = () => t.review.proposals(root).find((p: { id: string }) => p.id === `held-${id}`);
    await until(() => entry()?.status === 'awaiting-checks', 'it to wait with its test cases', 5000);
    t.sessions.continueProposal(root, entry());
    await until(() => !!entry()?.session, 'it to be marked as in a session', 5000);
    const session = store.list().find((d) => d.id === entry().session)!;
    if (session.changes[0]?.after !== `${readme}\nHello there\n` || session.session?.proposal !== `held-${id}`) throw new Error(`the session's draft: ${JSON.stringify(session)}`);
    store.save({ ...session, asked: [...(session.asked ?? []), 'And wave'], changes: [{ path: 'README.md', before: readme, after: `${readme}\nHello there, waving\n` }], revision: 2, updatedAt: new Date().toISOString() });
    const plan = await t.hub.planDraft(root, session.id);
    if (typeof plan === 'string') throw new Error(`test cases: ${plan}`);
    const run = t.hub.runChecks(root, session.id, asItIs(plan));
    if (typeof run === 'string') throw new Error(`Run: ${run}`);
    const sent = await run.promise;
    if (typeof sent === 'string') throw new Error(`Done: ${sent}`);
    await until(() => entry()?.status === 'proposed' && entry()?.changes[0].after.endsWith('waving\n'), 'the same proposal to come back with the new changes', 5000);
    if (t.review.proposals(root).filter((x: { title: string }) => x.title === 'Say hello there').length !== 1) throw new Error('a second proposal was made');
    t.sessions.panel(root, session.id)?.dispose();
    store.remove(session.id);
    store.remove(id);
    require('node:fs').rmSync(join(root, '.visual-editor', 'proposals', `held-${id}.json`), { force: true });
  });

  await step('a held-back change: its failed checks can be bypassed (with why), and it goes to Review marked so', async () => {
    const readme = readFileSync(join(root, 'README.md'), 'utf8');
    const at = new Date().toISOString();
    const id = `held-${Date.now()}-byp1`;
    t.review.receiveProposal(root, { id, title: 'Say hi', why: 'w', asked: ['Say hi'], by: { kind: 'assistant', name: 'Claude Code' }, createdAt: at, status: 'held-back', changes: [{ path: 'README.md', before: readme, after: `${readme}\nHi\n` }], history: [{ at, status: 'held-back' }], evidence: [{ kind: 'check', title: 'Check TypeScript', text: '1 new error: src/x.ts(1,1)', passed: false, by: 'Visual Editor', at, revision: 1 }] });
    await vscode.commands.executeCommand('visualEditor.openReview');
    const seen = listen(t.review.panel);
    t.review.askBypass(root, id);
    await until(() => seen.some((m) => m.askBypass === id && m.items.find((i: { id: string }) => i.id === id)?.failed?.length === 1), 'Review to open the bypass window', 5000);
    await wait(800);
    await shot('15-bypass-window');
    await (t.review as any).receive({ type: 'bypass', id, titles: ['Check TypeScript'], reason: 'That error is from a file this change does not touch' });
    const p = t.review.proposals(root).find((x: { id: string }) => x.id === id);
    if (p.status !== 'proposed' || p.evidence[0].bypassed?.reason !== 'That error is from a file this change does not touch' || !/bypassed: Check TypeScript\. Why: That error is from a file this change does not touch/.test(p.history.at(-1).note)) throw new Error(`after bypass: ${JSON.stringify(p)}`);
    require('node:fs').rmSync(join(root, '.visual-editor', 'proposals', `${id}.json`), { force: true });
  });

  await step('a change from the chat waits in Review with its test cases; nothing runs until the developer runs them', async () => {
    const readme = readFileSync(join(root, 'README.md'), 'utf8');
    const at = new Date().toISOString();
    const store = new DraftStore(root);
    const id = `${Date.now()}-plan1`;
    store.save({ id, title: 'Say hello again', why: 'w', by: { kind: 'assistant', name: 'Claude Code' }, createdAt: at, updatedAt: at, status: 'draft', changes: [{ path: 'README.md', before: readme, after: `${readme}\nHello again\n` }], asked: ['Say hello again'], revision: 1, evidence: [] });
    await t.hub.planDraft(root, id);
    const entry = () => t.review.proposals(root).find((p: { id: string }) => p.id === `held-${id}`);
    await until(() => entry()?.status === 'awaiting-checks', 'it to wait in Review with its test cases', 5000);
    // It's said wherever waiting changes are: the map's bar (its own chip, opening it) and Memory's Recent changes.
    t.map.show();
    const onMap = listen(t.map.panel);
    t.map.send();
    await until(() => onMap.some((m) => m.type === 'show' && m.toRun?.count === 1 && m.toRun.first === `held-${id}`), 'the map to say its test cases wait', 5000);
    const recent = t.memoryView.getChildren().find((n: any) => n.kind === 'group' && n.group === 'change');
    if (!recent?.waiting.some((p: { id: string }) => p.id === `held-${id}`)) throw new Error('Memory does not list it as needing you');
    const row = t.memoryView.getTreeItem({ kind: 'waiting', proposal: entry() });
    if (!/test cases waiting for you to run/.test(String(row.description))) throw new Error(`Memory says: ${row.description}`);
    await vscode.commands.executeCommand('visualEditor.openReview');
    const seen = listen(t.review.panel);
    t.review.askPlan(root, `held-${id}`);
    await until(() => seen.some((m) => m.askPlan === `held-${id}` && m.items.find((i: { id: string }) => i.id === `held-${id}`)?.plan?.state === 'ready'), 'Review to open its test cases', 5000);
    await wait(800);
    await shot('16-test-cases');
    if (new DraftStore(root).list().find((d) => d.id === id)?.evidence.length) throw new Error('something ran before Run');
    await (t.review as any).receive({ type: 'runPlan', id: `held-${id}`, choice: { checks: {}, cases: [], added: [], skipAll: true, reason: 'Only words' } });
    await until(() => entry()?.status === 'proposed', 'it to reach Review once run', 10_000);
    if (!/Sent without any checks, by the developer\. Why: Only words/.test(entry().evidence.map((e: { text: string }) => e.text).join('\n'))) throw new Error(`its proof: ${JSON.stringify(entry().evidence)}`);
    store.remove(id);
    require('node:fs').rmSync(join(root, '.visual-editor', 'proposals', `held-${id}.json`), { force: true });
  });

  await step('a held-back change runs its checks again from Review (the same test cases), and goes once they pass', async () => {
    const readme = readFileSync(join(root, 'README.md'), 'utf8');
    const at = new Date().toISOString();
    const store = new DraftStore(root);
    const id = `${Date.now()}-rerun1`;
    store.save({ id, title: 'Say hi once more', why: 'w', by: { kind: 'assistant', name: 'Claude Code' }, createdAt: at, updatedAt: at, status: 'draft', changes: [{ path: 'README.md', before: readme, after: `${readme}\nHi once more\n` }], asked: ['Say hi once more'], revision: 1, evidence: [] });
    await t.hub.planDraft(root, id);
    // Held back by a check that was wrong (since fixed): stopped, with its test cases kept.
    const d = new DraftStore(root).list().find((x) => x.id === id)!;
    store.save({ ...d, check: { ...d.check!, step: 'done', held: 'Not sent to Review: a check that was wrong.' } });
    t.review.receiveProposal(root, { id: `held-${id}`, title: d.title, why: 'w', asked: d.asked, by: d.by, createdAt: at, status: 'held-back', changes: d.changes, history: [{ at, status: 'held-back' }], evidence: [] });
    const entry = () => t.review.proposals(root).find((p: { id: string }) => p.id === `held-${id}`);
    await vscode.commands.executeCommand('visualEditor.openReview');
    const seen = listen(t.review.panel);
    t.review.show(`held-${id}`);
    await until(() => seen.some((m) => m.items?.find((i: { id: string }) => i.id === `held-${id}`)?.rerun?.can === true), 'Review to offer running its checks again', 5000);
    await wait(600);
    await shot('17-run-again');
    await (t.review as any).receive({ type: 'rerun', id: `held-${id}` });
    await until(() => entry()?.status === 'proposed', 'it to reach Review once its checks run again', 10_000);
    store.remove(id);
    require('node:fs').rmSync(join(root, '.visual-editor', 'proposals', `held-${id}.json`), { force: true });
  });

  await step('a plugin\'s nudge shows on the map; ▶ keeps it while its agent can\'t start; ✕ closes it for good (for this project)', async () => {
    await t.map.layouts?.update('closedNudges', []);
    const agent = { name: 'nudge-setup', title: 'Set it up', description: 'D', worker: { prompt: 'Do' }, checker: { prompt: 'Check' } };
    const registration = api.register({ id: 'nudger', name: 'Nudger', version: '0.1.0', contract: api.contract, detect: () => ({ reason: 'test' }), agents: [agent], nudges: () => [{ id: 'set-up', text: 'This project isn’t set up yet.', agent: 'nudge-setup' }] });
    try {
      t.map.show();
      const seen = listen(t.map.panel);
      const nudgesNow = () => seen.filter((m) => m.type === 'show').at(-1)?.nudges ?? [];
      await until(() => { t.map.send(); return nudgesNow().length === 1; }, 'the nudge on the map', 15_000);
      const n = nudgesNow()[0];
      if (n.title !== 'Set it up' || n.agent !== 'nudge-setup' || !n.key.endsWith('#nudger:set-up')) throw new Error(`the nudge was ${JSON.stringify(n)}`);
      await wait(800);
      await shot('17-nudge');
      // Claude Code isn't connected here: the agent can't start, so the nudge stays.
      t.map.receive({ type: 'nudge', key: n.key, act: 'run' });
      await wait(800);
      t.map.send();
      if (nudgesNow().length !== 1) throw new Error('the nudge went away though its agent never started');
      t.map.receive({ type: 'nudge', key: n.key, act: 'close' });
      await until(() => nudgesNow().length === 0, 'the nudge closed');
      t.map.send();
      await wait(300);
      if (nudgesNow().length) throw new Error('a closed nudge came back');
      if (!(t.map.layouts.get('closedNudges') ?? []).includes(n.key)) throw new Error('closing it was not kept');
      // Asked for again: it's back.
      await vscode.commands.executeCommand('visualEditor.showClosedHints');
      await until(() => nudgesNow().length === 1, 'the closed nudge back');
    } finally {
      registration.dispose();
      await vscode.commands.executeCommand('notifications.clearAll');
    }
  });

  await step('Memory → Sessions: unfinished ones with where each stands, History (sent, discarded), ✕ and the helper\'s suggestions delete; only an open tab is worked in', async () => {
    const { PLAN_STEP, WAITING } = await import('../packages/shell/src/hub/tools');
    const note = () => { try { return JSON.parse(readFileSync(join(root, '.visual-editor', 'drafts', '.session'), 'utf8')); } catch { return {}; } };
    const draft = t.sessions.start(root);
    // Open in a tab: the one worked in.
    if (note().open?.draft !== draft.id) throw new Error(`open tab, note: ${JSON.stringify(note())}`);
    t.sessions.panel(root, draft.id)?.dispose();
    // Closed: not worked in, only listed as closed.
    if (note().open || !note().closed?.some((c: { draft: string }) => c.draft === draft.id)) throw new Error(`closed tab, note: ${JSON.stringify(note())}`);
    // A note left from before a reload (a tab open then): written again at startup, with nothing open.
    require('node:fs').writeFileSync(join(root, '.visual-editor', 'drafts', '.session'), JSON.stringify({ open: { draft: draft.id, title: 'stale' } }));
    t.sessions.writeNote(root);
    if (note().open) throw new Error('a stale note still says a session is open');
    const store = new DraftStore(root);
    const top = () => t.memoryView.getChildren().find((n: any) => n.kind === 'sessions');
    const rows = () => (top()?.rows ?? []) as { id: string; state: string }[];
    const history = () => (top()?.history ?? []) as { id: string; state: string }[];
    const stateOf = () => rows().find((r) => r.id === draft.id)?.state;
    if (stateOf() !== 'no changes yet') throw new Error(`a new session: ${stateOf()}`);
    const readmeNow = readFileSync(join(root, 'README.md'), 'utf8');
    const at = () => new Date().toISOString();
    const saved = { ...store.list().find((d) => d.id === draft.id)!, changes: [{ path: 'README.md', before: readmeNow, after: `${readmeNow}\nHi\n` }], revision: 2, updatedAt: at() };
    const states: [any, string][] = [
      [undefined, 'being worked on'],
      [{ at: at(), revision: 2, step: PLAN_STEP }, 'writing its test cases'],
      [{ at: at(), revision: 2, step: WAITING }, 'test cases waiting for you'],
      [{ at: at(), revision: 2, step: 'running TypeScript' }, 'checks running'],
      [{ at: at(), revision: 2, step: 'done', held: 'Check TypeScript failed' }, 'held back'],
      [{ at: at(), revision: 1, step: 'done', held: 'An older version' }, 'being worked on'],
    ];
    for (const [check, want] of states) {
      store.save({ ...saved, ...(check ? { check } : {}) });
      if (stateOf() !== want) throw new Error(`with ${JSON.stringify(check)}: ${stateOf()}, not ${want}`);
    }
    await vscode.commands.executeCommand('visualEditor.openSession', draft.id);
    if (!t.sessions.panel(root, draft.id)) throw new Error('a click did not open it');
    t.sessions.panel(root, draft.id)?.dispose();
    // Finished: in History, not among the unfinished; sent and discarded alike.
    store.save({ ...saved, status: 'submitted', proposal: 'p1' });
    const other = { ...saved, id: `${draft.id}x`, title: 'Another try', status: 'discarded' as const };
    store.save(other);
    if (rows().some((r) => r.id === draft.id) || history().find((r) => r.id === draft.id)?.state !== 'sent to Review' || history().find((r) => r.id === other.id)?.state !== 'discarded') throw new Error(`history: ${JSON.stringify(history())}`);
    // (The note follows the drafts folder, a moment after a save.)
    await until(() => !note().closed?.some((c: { draft: string }) => c.draft === draft.id), 'a finished session not to be told about as closed', 5000);
    // The helper's suggestions: marked (the heading offers to delete them); deleting them leaves the others.
    t.memoryView.setSuggestions(root, new Map([[other.id, 'an earlier try']]));
    const head = t.memoryView.getTreeItem(top());
    const historyNode = t.memoryView.getChildren(top()).find((n: any) => n.kind === 'history');
    const marked = t.memoryView.getChildren(historyNode).map((n: any) => t.memoryView.getTreeItem(n)).find((i: any) => i.contextValue === 'session-suggested');
    if (head.contextValue !== 'sessions-suggested' || !/an earlier try/.test(String(marked?.description))) throw new Error(`marks: ${head.contextValue}, ${marked?.description}`);
    await shot('19-sessions');
    // Their window: only the suggested ones, each with why; 🗑 on one deletes it, 🗑 at the top the rest.
    const third = { ...saved, id: `${draft.id}y`, title: 'A third try', status: 'discarded' as const };
    store.save(third);
    t.memoryView.setSuggestions(root, new Map([[other.id, 'an earlier try'], [third.id, 'empty']]));
    const win: any = await vscode.commands.executeCommand('visualEditor.deleteSuggestedSessions');
    if (JSON.stringify(win.items()) !== JSON.stringify([{ id: other.id, detail: 'Why delete it: an earlier try' }, { id: third.id, detail: 'Why delete it: empty' }].sort((a, b) => win.items().findIndex((i: any) => i.id === a.id) - win.items().findIndex((i: any) => i.id === b.id)))) throw new Error(`the window lists: ${JSON.stringify(win.items())}`);
    if (win.items().some((i: any) => i.id === draft.id)) throw new Error('a session not suggested is in the window');
    if (!win.panel?.visible) throw new Error('the window did not open');
    win.deleteOne(third.id);
    if (win.items().length !== 1 || store.list().some((d) => d.id === third.id) || !store.list().some((d) => d.id === other.id)) throw new Error('🗑 on one deleted the wrong ones');
    win.deleteAll();
    await until(() => !t.sessions.panel(root, other.id) && (() => { try { return !win.panel.visible; } catch { return true; } })(), 'the window to close once they are all deleted', 5000);
    await vscode.commands.executeCommand('notifications.clearAll');
    if (history().some((r) => r.id === other.id) || !history().some((r) => r.id === draft.id)) throw new Error('🗑 at the top deleted the wrong ones');
    // ✕: one, for good.
    await vscode.commands.executeCommand('visualEditor.deleteSession', draft.id, true);
    if (history().some((r) => r.id === draft.id) || store.list().some((d) => d.id === draft.id)) throw new Error('✕ did not delete it');
  });

  await step('the map pops out into its own window and comes back', async () => {
    t.map.show();
    const mapSeen2 = listen(t.map.panel);
    t.map.receive({ type: 'window' });
    await until(() => mapSeen2.some((m) => m.type === 'show' && m.floating === true), 'the map in its own window');
    await wait(1000);
    t.map.receive({ type: 'window' });
    await until(() => mapSeen2.filter((m) => m.type === 'show').at(-1)?.floating === false, 'the map back');
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
