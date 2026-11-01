// 2.17: every kind of design session and every agent, started from a button and from the chat, on a real React project
// (TEST=kinds PROJECT=<a copy of a project> PLUGINS=react). Claude isn't used: the chat's tool calls are made here
// directly, the check planner is a fixed one (every check it may use, no scenarios), and agents run a stand-in for
// `claude` (VISUAL_EDITOR_CLAUDE_BIN) that keeps what it was given in VISUAL_EDITOR_FAKE_OUT. A New page is built for
// real: saved into its session, checked, and sent to Review; the same page with a mistake is held back.

import * as vscode from 'vscode';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
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
    await wait(200);
  }
  throw new Error(`waited too long for: ${what}`);
}

/** A small page in the previewable shape (docs/variants.md), as Claude would make it from the New page brief. */
function helpPage(mistake = false): { path: string; content: string }[] {
  const at = 'src/pages/Help';
  return [
    {
      path: `${at}/Help.types.ts`,
      content: `/** What a parent passes: nothing (it's a page). */
export type HelpProps = Record<string, never>

export interface HelpQuestion {
  q: string
  a: string
}

/** What the static part starts from. */
export interface HelpStart {
  questions: HelpQuestion[]
}

/** What every design gets: the questions, which one is open, and what a click does. */
export interface HelpView {
  questions: HelpQuestion[]
  open: number | null
  onToggle: (index: number) => void
}
`,
    },
    {
      path: `${at}/Help.variant.tsx`,
      content: `import type { HelpView } from './Help.types'

export const variant = { id: 'default', name: 'Default' }

/** The questions as a list: one opens at a time. */
export default function HelpDefault({ questions, open, onToggle }: HelpView) {
  return (
    <main style={{ padding: 32, maxWidth: 720, margin: '0 auto' }}>
      <h1>Help</h1>
      {questions.length === 0 ? (
        <p>No questions yet.</p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0 }}>
          {questions.map((x, i) => (
            <li key={x.q} style={{ marginBottom: 12 }}>
              <button type="button" onClick={() => onToggle(i)}>{x.q}</button>
              {open === i && <p>{${mistake ? 'x.answer' : 'x.a'}}</p>}
            </li>
          ))}
        </ul>
      )}
    </main>
  )
}
`,
    },
    {
      path: `${at}/Help.switcher.tsx`,
      content: `import { makeSwitcher } from '@visual-editor/react'
// The design in use: change this line to use another.
import Selected, { variant } from './Help.variant'

import type { HelpView } from './Help.types'

export default makeSwitcher<HelpView>(
  Selected,
  variant,
  // Every design, for Preview only (left out of production builds).
  import.meta.env.DEV ? () => [import('./Help.variant')] : undefined,
)
`,
    },
    {
      path: `${at}/Help.data.tsx`,
      content: `import { useState } from 'react'
import HelpSwitcher from './Help.switcher'
import type { HelpQuestion } from './Help.types'

const QUESTIONS: HelpQuestion[] = [
  { q: 'How do I make a project?', a: 'Press New on the projects page and give it a name.' },
  { q: 'Where is my work kept?', a: 'In your browser, on this computer.' },
]

/** The real data: the app's questions, and opening one. */
export default function HelpData() {
  const [open, setOpen] = useState<number | null>(null)
  return <HelpSwitcher questions={QUESTIONS} open={open} onToggle={(i) => setOpen(open === i ? null : i)} />
}
`,
    },
    {
      path: `${at}/Help.static.tsx`,
      content: `import { useState } from 'react'
import HelpSwitcher from './Help.switcher'
import type { HelpStart } from './Help.types'

/** The prototype: the questions in memory; one opens at a time. */
export default function HelpStatic({ questions }: HelpStart) {
  const [open, setOpen] = useState<number | null>(null)
  return <HelpSwitcher questions={questions} open={open} onToggle={(i) => setOpen(open === i ? null : i)} />
}
`,
    },
    {
      path: `${at}/Help.mock.ts`,
      content: `import type { HelpStart } from './Help.types'

/** The starting data for Preview: one state per case worth seeing. */
export const states: Record<string, HelpStart> = {
  default: {
    questions: [
      { q: 'How do I make a project?', a: 'Press New on the projects page and give it a name.' },
      { q: 'Where is my work kept?', a: 'In your browser, on this computer.' },
    ],
  },
  empty: { questions: [] },
}
`,
    },
    {
      path: `${at}/index.tsx`,
      content: `import { StaticPart, useVariantKey } from '@visual-editor/react'
import HelpData from './Help.data'

// The static part and its starting data: development only (left out of production builds).
const preview = import.meta.env.DEV ? { start: () => import('./Help.mock'), part: () => import('./Help.static') } : undefined

/** The chooser: the dynamic part in the app; the static prototype in Preview and the Playground. */
export default function Help() {
  if (useVariantKey() === 'real' || !preview) return <HelpData />
  return <StaticPart {...preview} props={{}} />
}

export { Help }
`,
    },
  ];
}

export async function run() {
  let failed = 0;
  const step = async (name: string, fn: () => Promise<void>) => {
    const started = Date.now();
    try {
      await fn();
      say(`✔ ${name} (${Math.round((Date.now() - started) / 1000)} s)`);
    } catch (e) {
      failed++;
      say(`✖ ${name}: ${e instanceof Error ? e.message : e}`);
    }
  };

  const api: any = await vscode.extensions.getExtension('arka102202.visual-editor')!.activate();
  const t = api._test;
  if (!t) throw new Error('Start with VISUAL_EDITOR_TEST=1');
  await vscode.extensions.getExtension('arka102202.visual-editor-react')?.activate();
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  const root = vscode.workspace.workspaceFolders![0].uri.fsPath;
  const items = () => (t.index.snapshot().find((s: any) => s.project.root === root)?.items ?? []) as any[];
  const card = (label: string) => items().find((i) => i.label === label && i.map === 'components');
  const store = new DraftStore(root);
  const draft = (id: string) => store.list().find((d) => d.id === id);
  const opened: string[] = [];
  const close = (id: string) => {
    t.sessions.panel(root, id)?.dispose();
    store.remove(id);
  };

  // The check planner without Claude: every check it may use (pictures and TypeScript among them), no scenarios.
  const host = (t.hub as any).host;
  host.planChecks = async (_root: string, d: any, available: any[]) => ({ revision: d.revision, at: new Date().toISOString(), means: ['A test plan'], looksOnly: false, checks: available.map((a) => ({ id: a.id, title: a.title, why: 'test', use: a.id !== 'looks_same', ...(a.always ? { always: true } : {}) })), cases: [], fixes: [] });

  // The chat: tool calls as Claude Code makes them.
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  await until(() => !!t.hub.url, 'the hub to start', 20_000);
  const client = new Client({ name: 'claude-code', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(t.hub.url), { requestInit: { headers: { Authorization: `Bearer ${t.hub.token}` } } }));
  const chat = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as any;
    return { text: r.content[0].text as string, error: !!r.isError };
  };

  await step('the project is read: ProjectCard can be previewed', async () => {
    await until(() => !!card('ProjectCard')?.preview, 'ProjectCard on the map, previewable', 60_000);
  });

  const projectCard = () => card('ProjectCard');
  const otherDesign = () => projectCard().preview.variants.find((v: any) => !v.inUse) ?? projectCard().preview.variants[0];
  const KINDS: { kind: string; choice: () => Record<string, string>; chat: () => Record<string, string>; brief: RegExp }[] = [
    { kind: 'new-design', choice: () => ({ card: projectCard().id }), chat: () => ({ card: 'ProjectCard' }), brief: /NEW DESIGN for ProjectCard/ },
    { kind: 'change-design', choice: () => ({ card: projectCard().id, design: otherDesign().id }), chat: () => ({ card: 'ProjectCard', design: otherDesign().id }), brief: /CHANGES ONE DESIGN of ProjectCard/ },
    { kind: 'new-component', choice: () => ({ name: 'ProjectBadge' }), chat: () => ({ name: 'ProjectBadge' }), brief: /NEW COMPONENT, ProjectBadge/ },
    { kind: 'new-page', choice: () => ({ name: 'Help', page: '/help' }), chat: () => ({ name: 'Help', page: '/help' }), brief: /NEW PAGE, Help, at \/help/ },
  ];

  for (const k of KINDS) {
    await step(`${k.kind}: from the button, a session opens with its brief`, async () => {
      const id: string | undefined = await vscode.commands.executeCommand('visualEditor.startSession', { kind: k.kind, ...k.choice() });
      if (!id) throw new Error('no session started');
      const d = draft(id);
      if (d?.session?.kind?.id !== k.kind || !k.brief.test(d.session.kind.brief)) throw new Error(`its draft: ${JSON.stringify(d?.session)}`);
      if (!t.sessions.panel(root, id)) throw new Error('its tab did not open');
      close(id);
    });
    await step(`${k.kind}: from the chat, a session opens and Claude gets its brief`, async () => {
      const r = await chat('start_session', { asked: `Test: ${k.kind}`, kind: k.kind, ...k.chat() });
      if (r.error) throw new Error(r.text);
      const id = /draft ([\w-]+)\)/.exec(r.text)?.[1] ?? /draft: "([\w-]+)"/.exec(r.text)?.[1];
      if (!id || !k.brief.test(r.text)) throw new Error(`Claude was told: ${r.text}`);
      if (draft(id)?.session?.kind?.id !== k.kind) throw new Error(`its draft: ${JSON.stringify(draft(id)?.session)}`);
      opened.push(id);
      if (k.kind !== 'new-page') close(id);
    });
  }

  // The New page, built for real in the session the chat opened.
  const pageSession = opened.find((id) => draft(id)?.session?.kind?.id === 'new-page');
  const router = 'src/routes/AppRouter.tsx';
  const routed = () => {
    const now = readFileSync(join(root, router), 'utf8');
    return now.replace(/(import \{ Settings \}[^\n]*\n)/, `$1import { Help }        from '@pages/Help'\n`).replace(/(\s*)(<Route path="\*")/, `$1<Route path="/help"      element={<Help />} />$1$2`);
  };
  const pageOf = (mistake: boolean) => [...helpPage(mistake), { path: router, content: routed() }];

  await step('new-page: the page saved into its session shows in the tab, at its address', async () => {
    if (!pageSession) throw new Error('no New page session');
    const r = await chat('save_draft', { draft: pageSession, title: 'A Help page', why: 'Answers to common questions', changes: pageOf(false) });
    if (r.error) throw new Error(r.text);
    const panel = t.sessions.panel(root, pageSession) ?? (t.sessions.open(root, pageSession), t.sessions.panel(root, pageSession));
    const seen: any[] = [];
    const post = panel.webview.postMessage.bind(panel.webview);
    panel.webview.postMessage = (m: any) => (seen.push(m), post(m));
    t.sessions.draftsChanged(root);
    await until(() => seen.some((m) => m.type === 'show' && m.session?.page === '/help' && m.session?.revision >= 1), 'the session to show the Help page', 30_000);
  });

  await step('new-page: Done → its test cases → Run: TypeScript and the variant rules pass, it reaches Review with its proof', async () => {
    if (!pageSession) throw new Error('no New page session');
    const plan = await t.hub.planDraft(root, pageSession);
    if (typeof plan === 'string') throw new Error(`test cases: ${plan}`);
    const r = t.hub.runChecks(root, pageSession, asItIs(plan));
    if (typeof r === 'string') throw new Error(`Run: ${r}`);
    const sent = await r.promise;
    if (typeof sent === 'string') throw new Error(`held back: ${sent}`);
    const proof = sent.proposal.evidence ?? [];
    const types = proof.find((e: any) => /TypeScript/.test(e.title));
    if (!types?.passed) throw new Error(`TypeScript: ${JSON.stringify(types)}`);
    say(`  proof: ${proof.map((e: any) => `${e.passed === false ? '✗' : '✓'} ${e.title}`).join('; ')}`);
    rmSync(join(root, '.visual-editor', 'proposals', `${sent.proposal.id}.json`), { force: true });
    close(pageSession);
  });

  await step('new-page: the same page with a mistake (a field its type doesn\'t have) is held back by TypeScript', async () => {
    const r = await chat('start_session', { asked: 'Test: a Help page with a mistake', kind: 'new-page', name: 'Help', page: '/help' });
    const id = /draft ([\w-]+)\)/.exec(r.text)?.[1] ?? /draft: "([\w-]+)"/.exec(r.text)?.[1];
    if (!id) throw new Error(r.text);
    await chat('save_draft', { draft: id, title: 'A Help page', why: 'w', changes: pageOf(true) });
    const plan = await t.hub.planDraft(root, id);
    if (typeof plan === 'string') throw new Error(`test cases: ${plan}`);
    const run = t.hub.runChecks(root, id, asItIs(plan));
    if (typeof run === 'string') throw new Error(`Run: ${run}`);
    const out = await run.promise;
    if (typeof out !== 'string') throw new Error('a page that doesn\'t compile reached Review');
    if (!/TypeScript/.test(out) || !/answer/.test(out)) throw new Error(`held back, but for: ${out}`);
    close(id);
  });

  await step('a card that isn\'t previewable offers Make previewable in its drawer; ▶ starts it for that card', async () => {
    const modal = card('CreateProjectModal');
    if (!modal || modal.preview) throw new Error('CreateProjectModal: not on the map, or previewable already');
    t.map.show();
    const seen: any[] = [];
    const post = t.map.panel.webview.postMessage.bind(t.map.panel.webview);
    t.map.panel.webview.postMessage = (m: any) => (seen.push(m), post(m));
    await until(() => t.map.ready, 'the map page', 20_000);
    t.map.receive({ type: 'card', id: modal.id });
    await until(() => seen.some((m) => m.type === 'card' && m.id === modal.id), 'its drawer', 5000);
    const nudge = seen.find((m) => m.type === 'card' && m.id === modal.id).nudges;
    if (nudge?.[0]?.agent !== 'make-previewable' || nudge[0].title !== 'Make previewable') throw new Error(`its drawer offers: ${JSON.stringify(nudge)}`);
    t.map.receive({ type: 'card', id: projectCard().id });
    await until(() => seen.some((m) => m.type === 'card' && m.id === projectCard().id), 'ProjectCard\'s drawer', 5000);
    if (seen.find((m) => m.type === 'card' && m.id === projectCard().id).nudges?.length) throw new Error('a previewable card is offered Make previewable');
    // ▶: the agent starts for exactly this card (a stand-in for claude).
    const realAssistants = t.hub.assistants.bind(t.hub);
    t.hub.assistants = () => realAssistants().map((a: any) => (a.id === 'claude' ? { ...a, state: 'on', agents: 'on' } : a));
    t.map.receive({ type: 'cardAgent', id: modal.id, agent: 'make-previewable' });
    await until(() => new JobStore(root).list().some((j: any) => j.agent === 'make-previewable' && /CreateProjectModal \(src\/.*CreateProjectModal\.tsx\)/.test(j.request)), 'its job, for that card', 10_000);
    // (Its stand-in for claude finishes before the next steps use it.)
    const fakes = process.env.VISUAL_EDITOR_FAKE_OUT!;
    await until(() => existsSync(fakes) && readdirSync(fakes).some((f) => { try { return JSON.parse(readFileSync(join(fakes, f), 'utf8')).prompt.includes('CreateProjectModal'); } catch { return false; } }), 'the stand-in to be given the job', 20_000);
    t.hub.assistants = realAssistants;
    for (const j of new JobStore(root).list()) rmSync(join(root, '.visual-editor', 'jobs', `${j.id}.json`), { force: true });
  });

  // Agents: from a button (a stand-in for claude), and from the chat (job_start, as the agent's skill does).
  const fakeOut = process.env.VISUAL_EDITOR_FAKE_OUT!;
  const realAssistants = t.hub.assistants.bind(t.hub);
  t.hub.assistants = () => realAssistants().map((a: any) => (a.id === 'claude' ? { ...a, state: 'on', agents: 'on' } : a));
  const AGENTS: { name: string; request: string }[] = [
    { name: 'make-previewable', request: 'Make ThemeToggle previewable' },
    { name: 'new-variant', request: 'ProjectCard: the name only, on one line' },
    { name: 'set-up-project', request: 'Set it up' },
  ];
  for (const a of AGENTS) {
    await step(`${a.name}: from the button, a job starts and Claude Code is given it`, async () => {
      const before = existsSync(fakeOut) ? readdirSync(fakeOut).length : 0;
      const started = await vscode.commands.executeCommand('visualEditor.runAgent', a.name, 'background', a.request);
      if (started !== true) throw new Error('it did not start');
      const job = new JobStore(root).list().find((j: any) => j.request === a.request && j.agent === a.name);
      if (!job) throw new Error('no job');
      await until(() => existsSync(fakeOut) && readdirSync(fakeOut).length > before, 'Claude Code (the stand-in) to be run', 20_000);
      const got = readdirSync(fakeOut).sort().reverse().map((f) => { try { return JSON.parse(readFileSync(join(fakeOut, f), 'utf8')); } catch { return undefined; } }).find((g) => g?.prompt.includes(`Request: ${a.request}`));
      if (!got) throw new Error('the stand-in was not given this job');
      if (!got.prompt.includes(`visual-editor:${a.name} skill`) || !got.prompt.includes(job.id) || !got.prompt.includes(`Request: ${a.request}`)) throw new Error(`it was given: ${got.prompt}`);
      if (!got.args.includes('-p')) throw new Error(`its arguments: ${got.args.join(' ')}`);
      rmSync(join(root, '.visual-editor', 'jobs', `${job.id}.json`), { force: true });
    });
    await step(`${a.name}: from the chat, job_start starts its job`, async () => {
      const r = await chat('job_start', { agent: a.name, request: `${a.request} (chat)` });
      if (r.error) throw new Error(r.text);
      const job = new JobStore(root).list().find((j: any) => j.request === `${a.request} (chat)`);
      if (!job || job.agent !== a.name) throw new Error(`job: ${JSON.stringify(job)}; said: ${r.text}`);
      rmSync(join(root, '.visual-editor', 'jobs', `${job.id}.json`), { force: true });
    });
  }
  t.hub.assistants = realAssistants;

  await client.close();
  require('node:fs').writeFileSync(process.env.VISUAL_EDITOR_REPORT!, lines.join('\n') + '\n');
  if (failed) throw new Error(`${failed} step(s) failed`);
}
