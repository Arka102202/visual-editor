// 2.17: every kind of design session and every agent, started from a button and from the chat, on a real React project
// (TEST=kinds PROJECT=<a copy of a project> PLUGINS=react). Claude isn't used: the chat's tool calls are made here
// directly, the check planner is a fixed one (every check it may use, no scenarios), and agents run a stand-in for
// `claude` (VISUAL_EDITOR_CLAUDE_BIN) that keeps what it was given in VISUAL_EDITOR_FAKE_OUT. A New page is built for
// real: saved into its session, checked, and sent to Review; the same page with a mistake is held back.

import * as vscode from 'vscode';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
  const folderInUse = () => projectCard().preview.variants.find((v: any) => v.inUse)?.name;
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
    await until(() => new JobStore(root).list().some((j: any) => j.agent === 'make-previewable' && j.card === modal.id && /CreateProjectModal \(src\/.*CreateProjectModal\.tsx\)/.test(j.request)), 'its job, for that card', 10_000);
    // (Its stand-in for claude finishes before the next steps use it.)
    const fakes = process.env.VISUAL_EDITOR_FAKE_OUT!;
    await until(() => existsSync(fakes) && readdirSync(fakes).some((f) => { try { return JSON.parse(readFileSync(join(fakes, f), 'utf8')).prompt.includes('CreateProjectModal'); } catch { return false; } }), 'the stand-in to be given the job', 20_000);
    t.hub.assistants = realAssistants;
    for (const j of new JobStore(root).list()) rmSync(join(root, '.visual-editor', 'jobs', `${j.id}.json`), { force: true });
  });

  await step('Story view: ProjectList\'s Delete is told from the click in ProjectCard to the saved data, step by step', async () => {
    const list = card('ProjectList');
    if (!list) throw new Error('ProjectList is not on the map');
    t.map.show();
    const seen: any[] = [];
    const post = t.map.panel.webview.postMessage.bind(t.map.panel.webview);
    t.map.panel.webview.postMessage = (m: any) => (seen.push(m), post(m));
    await until(() => t.map.ready, 'the map page', 20_000);
    t.map.receive({ type: 'card', id: list.id });
    await until(() => seen.some((m) => m.type === 'stories' && m.id === list.id), 'its stories', 20_000);
    const stories = seen.find((m) => m.type === 'stories' && m.id === list.id).stories;
    const del = stories.find((s: any) => /^Click “Delete project” on ProjectCard$/.test(s.title));
    if (!del) throw new Error(`its stories: ${stories.map((s: any) => s.title).join(' | ')}`);
    const texts = del.steps.map((x: any) => x.text);
    for (const want of [/^You click “Delete project”$/, /^ProjectCard calls onDelete, which ProjectList gives it$/, /^Runs deleteProject from useProjectList$/, /^Deletes from saved data \(db\.projects\)$/]) {
      if (!texts.some((x: string) => want.test(x))) throw new Error(`no step ${want}: ${texts.join(' / ')}`);
    }
    const cards = new Set(del.steps.map((x: any) => x.card));
    if (!cards.has(projectCard().id) || !cards.has(list.id)) throw new Error(`its steps' cards: ${[...cards].join(', ')}`);
  });

  await step('Impact: ProjectCard is rendered by both of ProjectList\'s designs; its onDelete is passed in both (the drawer, and Claude\'s impact tool)', async () => {
    const pc = projectCard();
    t.map.show();
    const seen: any[] = [];
    const post = t.map.panel.webview.postMessage.bind(t.map.panel.webview);
    t.map.panel.webview.postMessage = (m: any) => (seen.push(m), post(m));
    await until(() => t.map.ready, 'the map page', 20_000);
    t.map.receive({ type: 'card', id: pc.id });
    await until(() => seen.some((m) => m.type === 'impact' && m.id === pc.id && !m.impact.prop), 'its impact', 20_000);
    const whole = seen.find((m) => m.type === 'impact' && m.id === pc.id && !m.impact.prop).impact;
    const users = whole.direct.map((p: any) => p.label).sort().join(' | ');
    if (users !== 'ProjectCard\'s own parts | ProjectList (Dashboard design) | ProjectList (Default design)') throw new Error(`directly: ${users}`);
    if (!whole.further.some((p: any) => /^the page at \/: /.test(p.why))) throw new Error(`further: ${JSON.stringify(whole.further)}`);
    t.map.receive({ type: 'impact', id: pc.id, prop: 'onDelete' });
    await until(() => seen.some((m) => m.type === 'impact' && m.impact.prop === 'onDelete'), 'onDelete\'s impact', 20_000);
    const one = seen.find((m) => m.type === 'impact' && m.impact.prop === 'onDelete').impact;
    if (!/^onDelete is passed in 2 places\. Renaming it: 2 places must change too\./.test(one.verdict) || one.direct.filter((p: any) => /^passes onDelete=/.test(p.why)).length !== 2) throw new Error(`onDelete: ${JSON.stringify(one)}`);
    const said = await chat('impact', { id: pc.id, prop: 'onDelete' });
    if (said.error || !/^If you change ProjectCard's prop "onDelete":\nonDelete is passed in 2 places/.test(said.text)) throw new Error(`Claude is told: ${said.text}`);
  });

  await step('Follow a field: ProjectCard\'s project.name comes from the saved data both ways, and shows in its design in use (drawer, and Claude\'s tool)', async () => {
    const pc = projectCard();
    t.map.show();
    const seen: any[] = [];
    const post = t.map.panel.webview.postMessage.bind(t.map.panel.webview);
    t.map.panel.webview.postMessage = (m: any) => (seen.push(m), post(m));
    await until(() => t.map.ready, 'the map page', 20_000);
    t.map.receive({ type: 'card', id: pc.id });
    await until(() => seen.some((m) => m.type === 'field' && m.id === pc.id), 'its fields', 20_000);
    const fields = seen.find((m) => m.type === 'field' && m.id === pc.id).trail.fields;
    if (!fields.includes('project.name') || fields.some((f: string) => /charAt/.test(f))) throw new Error(`its fields: ${fields.join(', ')}`);
    t.map.receive({ type: 'field', id: pc.id, field: 'project.name' });
    await until(() => seen.some((m) => m.type === 'field' && m.trail.field === 'project.name'), 'project.name followed', 20_000);
    const trail = seen.find((m) => m.type === 'field' && m.trail.field === 'project.name').trail;
    const origins = trail.comesFrom.filter((s: any) => s.kind === 'origin').map((s: any) => s.text);
    if (origins.length !== 2 || origins.some((o: string) => o !== 'saved data (db.projects)')) throw new Error(`it starts at: ${origins.join(' | ')}`);
    const inUse = folderInUse();
    if (!trail.shown.some((s: any) => s.kind === 'shown' && s.text.startsWith(`ProjectCard (${inUse} design)`))) throw new Error(`shown: ${trail.shown.map((s: any) => s.text).join(' | ')}`);
    const said = await chat('follow_field', { id: pc.id, field: 'project.name' });
    if (said.error || !/Starts at saved data \(db\.projects\)/.test(said.text)) throw new Error(`Claude is told: ${said.text}`);
  });

  await step('History: a card\'s story from git (its commits, newest first; a change not committed yet), a commit opens; Claude\'s card tool tells the same', async () => {
    const pc = projectCard();
    const file = join(root, pc.source.path);
    const before = readFileSync(file, 'utf8');
    t.map.show();
    const seen: any[] = [];
    const post = t.map.panel.webview.postMessage.bind(t.map.panel.webview);
    t.map.panel.webview.postMessage = (m: any) => (seen.push(m), post(m));
    try {
      await until(() => t.map.ready, 'the map page', 20_000);
      const history = async () => {
        seen.length = 0;
        t.map.receive({ type: 'card', id: pc.id });
        await until(() => seen.some((m) => m.type === 'history' && m.id === pc.id), 'its history', 20_000);
        return seen.find((m) => m.type === 'history' && m.id === pc.id);
      };
      const h = await history();
      if (!h.git) throw new Error('archFlow is in git, yet not said so');
      const commits = h.lines.filter((l: any) => l.kind === 'commit').map((l: any) => l.text);
      if (commits.join(' | ') !== 'test committed “test start” | Arka102202 committed “Git: initial commit”') throw new Error(`its commits: ${commits.join(' | ')}`);
      // Changed by hand, not committed: said, newest first.
      writeFileSync(file, `${before}\n// a change by hand\n`);
      const h2 = await history();
      const top = h2.lines[0];
      if (top.kind !== 'edit' || top.text !== 'Changed since the last commit, not committed yet' || !/: \+\d+ −\d+ lines/.test(top.detail)) throw new Error(`newest: ${JSON.stringify(top)}`);
      // A commit opens: its message and its changes.
      t.map.receive({ type: 'openHistory', open: h.lines.find((l: any) => l.kind === 'commit').open });
      await until(() => vscode.window.activeTextEditor?.document.languageId === 'diff', 'the commit to open', 10_000);
      if (!/^commit [0-9a-f]{40}\nAuthor: test\n[\s\S]*test start/.test(vscode.window.activeTextEditor!.document.getText())) throw new Error('not the commit');
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
      const said = await chat('card', { id: pc.id });
      if (said.error || !/\nHistory \(newest first\):\n- \d{4}-\d\d-\d\d · Changed since the last commit, not committed yet\.[^\n]*\n(- [^\n]*\n)*- [^\n]* · test committed “test start”/.test(said.text)) throw new Error(`Claude is told: ${said.text}`);
    } finally {
      writeFileSync(file, before);
      t.map.panel.webview.postMessage = post;
    }
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
  // archFlow is set up already: Set up project has nothing to do there. (The steps after stand in for a project that
  // isn't, so it has work.)
  const setUpAgent = t.registry.list().find((p: any) => p.id === 'react').agents.find((a: any) => a.name === 'set-up-project');
  const realDone = setUpAgent.done;
  await step('Set up project in a project set up already: nothing to do, its buttons say so; a start (button or chat) is refused; the other agents still start', async () => {
    const rows = () => t.agentsView.state().groups.find((g: any) => g.name === 'React').items;
    const row = rows().find((e: any) => e.name === 'set-up-project');
    if (!/^archflow is set up for Preview and the Playground already \(its providers file is src\/visual-editor\.providers\.tsx, and \d+ components can be previewed\): nothing for Set up project to do\.$/.test(row.done ?? '')) throw new Error(`its row: ${JSON.stringify(row)}`);
    if (row.blocked) throw new Error('said as blocked too');
    for (const name of ['make-previewable', 'new-variant']) if (rows().find((e: any) => e.name === name).done) throw new Error(`${name} has nothing to do?`);
    const n = new JobStore(root).list().length;
    if ((await vscode.commands.executeCommand('visualEditor.runAgent', 'set-up-project', 'background')) !== false || new JobStore(root).list().length !== n) throw new Error('it started');
    const said = await chat('job_start', { agent: 'set-up-project', request: 'Set it up (chat)' });
    if (!said.error || !/^Set up project can't start now\. archflow is set up for Preview and the Playground already/.test(said.text)) throw new Error(`the chat: ${said.text}`);
    setUpAgent.done = () => undefined;
    if (rows().find((e: any) => e.name === 'set-up-project').done) throw new Error('still done once the project needs it');
  });
  setUpAgent.done = () => undefined;
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

  // Jobs from buttons: at most 2 at once (every agent's together), each its own row; Stop one and the next one starts;
  // Resume carries a stopped one on where it was. (The stand-in for claude stays busy while the hold file is there.)
  const jobsNow = () => new JobStore(root).list();
  const statusOf = (id: string) => jobsNow().find((j) => j.id === id)?.status;
  const hold = join(fakeOut, '.hold');
  const given = (id: string) =>
    (existsSync(fakeOut) ? readdirSync(fakeOut).filter((f) => f.endsWith('.json')).sort() : [])
      .map((f) => { try { return JSON.parse(readFileSync(join(fakeOut, f), 'utf8')); } catch { return undefined; } })
      .filter((g) => g?.prompt.includes(id));
  const reactRows = (name: string) => t.agentsView.state().groups.find((g: any) => g.name === 'React').items.find((e: any) => e.name === name);
  const free = t.index.snapshot()[0].items.filter((i: any) => i.map === 'components' && i.source && !i.preview).slice(0, 3);
  const ids: string[] = [];
  await step('jobs: at most 2 run at once, every agent\'s together (each its own row); a third waits its turn; a second job on the same card is refused', async () => {
    if (free.length < 3) throw new Error('not 3 cards to try');
    mkdirSync(fakeOut, { recursive: true });
    writeFileSync(hold, '');
    for (const [i, c] of free.entries()) {
      const started = await vscode.commands.executeCommand('visualEditor.runAgent', i === 2 ? 'new-variant' : 'make-previewable', 'background', `Queue test ${i}: ${c.label}`, c.id);
      if (started !== true) throw new Error(`job ${i} did not start`);
      ids.push(jobsNow().find((j) => j.request === `Queue test ${i}: ${c.label}`)!.id);
    }
    if (ids.map(statusOf).join() !== 'working,working,waiting') throw new Error(`statuses: ${ids.map(statusOf).join()}`);
    await until(() => given(ids[0]).length === 1 && given(ids[1]).length === 1, 'the first two to be given to Claude Code', 20_000);
    await wait(1000);
    if (given(ids[2]).length) throw new Error('the third ran while two were at work');
    const mp = (reactRows('make-previewable').jobs ?? []).map((j: any) => j.id);
    const nv = reactRows('new-variant').jobs ?? [];
    if (!mp.includes(ids[0]) || !mp.includes(ids[1]) || nv[0]?.id !== ids[2] || !/^waiting its turn \(next\)/.test(nv[0].progress ?? '')) throw new Error(`rows: ${JSON.stringify({ mp, nv })}`);
    // The same card again, by any agent: refused, nothing new starts. (Another card is fine: it waits its turn.)
    const n = jobsNow().length;
    if ((await vscode.commands.executeCommand('visualEditor.runAgent', 'new-variant', 'background', 'Same card', free[0].id)) !== false || jobsNow().length !== n) throw new Error('a second job on the same card started');
  });
  await step('jobs: Stop stops that one only (Resume offered); the one waiting starts in its place', async () => {
    await vscode.commands.executeCommand('visualEditor.stopJob', { job: { id: ids[0] } });
    await until(() => given(ids[2]).length === 1, 'the waiting one to start', 20_000);
    if (ids.map(statusOf).join() !== 'stopped,working,working') throw new Error(`statuses: ${ids.map(statusOf).join()}`);
    const row = (reactRows('make-previewable').recent ?? []).find((r: any) => r.id === ids[0]);
    if (!row?.resumable) throw new Error(`its row: ${JSON.stringify(row)}`);
    if ((reactRows('make-previewable').jobs ?? []).some((j: any) => j.id === ids[0])) throw new Error('still shown at work');
  });
  await step('jobs: Resume carries a stopped job on where it was: in its own Claude conversation when that\'s kept, else a new one told where the job stands', async () => {
    // Both places taken: it waits its turn.
    if ((await vscode.commands.executeCommand('visualEditor.resumeJob', ids[0])) !== true || statusOf(ids[0]) !== 'waiting') throw new Error(`resumed: ${statusOf(ids[0])}`);
    const session = jobsNow().find((j) => j.id === ids[0])!.session;
    if (!session || given(ids[0])[0].args[given(ids[0])[0].args.indexOf('--session-id') + 1] !== session) throw new Error(`its conversation: ${session}`);
    // Its conversation kept (Claude Code's file for it, in a throwaway Claude folder): resumed in it when a place frees.
    const config = mkdtempSync(join(tmpdir(), 've-claude-'));
    const realConfig = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = config;
    try {
      const folder = join(config, 'projects', realpathSync(root).replace(/[^a-zA-Z0-9]/g, '-'));
      mkdirSync(folder, { recursive: true });
      writeFileSync(join(folder, `${session}.jsonl`), '');
      await vscode.commands.executeCommand('visualEditor.stopJob', { job: { id: ids[1] } });
      await until(() => given(ids[0]).length === 2, 'it to carry on', 20_000);
    } finally {
      if (realConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = realConfig;
      rmSync(config, { recursive: true, force: true });
    }
    const again = given(ids[0])[1];
    if (again.args[again.args.indexOf('--resume') + 1] !== session || again.args.includes('--session-id') || !/^The developer resumed this job/.test(again.prompt)) throw new Error(`resumed with: ${again.args.join(' ')} / ${again.prompt}`);
    if (statusOf(ids[0]) !== 'working') throw new Error(`then: ${statusOf(ids[0])}`);
    // Its conversation not kept (here: Claude's own folder has no such file): a new one, told the job and where it is.
    await vscode.commands.executeCommand('visualEditor.stopJob', { job: { id: ids[0] } });
    await until(() => statusOf(ids[0]) === 'stopped', 'it to stop', 5000);
    if ((await vscode.commands.executeCommand('visualEditor.resumeJob', ids[0])) !== true) throw new Error('not resumed');
    await until(() => given(ids[0]).length === 3, 'it to carry on in a new conversation', 20_000);
    const fresh = given(ids[0])[2];
    if (fresh.args.includes('--resume') || !fresh.args.includes('--session-id') || !fresh.prompt.includes(`carry on job ${ids[0]}`) || !/Don't call job_start/.test(fresh.prompt)) throw new Error(`resumed with: ${fresh.args.join(' ')} / ${fresh.prompt}`);
    // (The stand-ins finish: what they left unfinished stops where it was, to resume.)
    rmSync(hold, { force: true });
    await until(() => ids.every((id) => statusOf(id) === 'stopped') && !ids.some((id) => t.agentRuns.has(id)), 'every run to end', 20_000);
    const last = jobsNow().find((j) => j.id === ids[2])!.history.at(-1)!.what;
    if (!/Claude Code finished without finishing the job\. Resume carries on from here/.test(last)) throw new Error(`its run ended with: ${last}`);
    for (const id of ids) rmSync(join(root, '.visual-editor', 'jobs', `${id}.json`), { force: true });
  });

  await step('set up first: until the project is set up only Set up project starts (from a button, a card or the chat), and it asks nothing; set up, the others start', async () => {
    const react = t.registry.list().find((p: any) => p.id === 'react');
    const real = react.setUpFirst;
    const state = t.index.snapshot()[0];
    if (real(state.project, state.items) !== undefined) throw new Error('archFlow is set up, yet it says it isn\'t');
    if (reactRows('make-previewable').blocked || reactRows('new-variant').blocked) throw new Error('blocked while set up');
    react.setUpFirst = () => ({ agent: 'set-up-project', why: 'archflow isn’t set up for Preview yet.' });
    try {
      const n = jobsNow().length;
      if ((await vscode.commands.executeCommand('visualEditor.runAgent', 'make-previewable', 'background', 'Gate test', free[0].id)) !== false || jobsNow().length !== n) throw new Error('Make previewable started before the set-up');
      for (const name of ['make-previewable', 'new-variant']) if (!/^archflow isn’t set up for Preview yet\. Run Set up project first\.$/.test(reactRows(name).blocked ?? '')) throw new Error(`${name}: ${reactRows(name).blocked}`);
      if (reactRows('set-up-project').blocked) throw new Error('Set up project itself is blocked');
      const said = await chat('job_start', { agent: 'new-variant', request: 'Gate test (chat)' });
      if (!said.error || !/New variant can't start now/.test(said.text)) throw new Error(`the chat: ${said.text}`);
      // The card's note says it waits.
      t.map.show();
      const seen: any[] = [];
      const post = t.map.panel.webview.postMessage.bind(t.map.panel.webview);
      t.map.panel.webview.postMessage = (m: any) => (seen.push(m), post(m));
      await until(() => t.map.ready, 'the map page', 20_000);
      t.map.receive({ type: 'card', id: free[0].id });
      await until(() => seen.some((m) => m.type === 'card' && m.id === free[0].id), 'its drawer', 5000);
      const note = seen.find((m) => m.type === 'card' && m.id === free[0].id).nudges?.[0];
      if (!/isn’t set up for Preview yet/.test(note?.waits ?? '')) throw new Error(`its note: ${JSON.stringify(note)}`);
      // Set up project starts, asking nothing (no request given); while it works, the others say so.
      writeFileSync(hold, '');
      if ((await vscode.commands.executeCommand('visualEditor.runAgent', 'set-up-project', 'background')) !== true) throw new Error('Set up project did not start');
      const setUp = jobsNow().find((j) => j.agent === 'set-up-project' && j.request === 'Set this project up for Preview and the Playground.');
      if (!setUp) throw new Error('no set-up job with its own request');
      if (!/^Set up project is getting archflow ready now/.test(reactRows('make-previewable').blocked ?? '')) throw new Error(`while it works: ${reactRows('make-previewable').blocked}`);
      await vscode.commands.executeCommand('visualEditor.stopJob', { job: { id: setUp.id } });
      rmSync(join(root, '.visual-editor', 'jobs', `${setUp.id}.json`), { force: true });
    } finally {
      react.setUpFirst = real;
      rmSync(hold, { force: true });
    }
    // Set up again: they start (no false alarm).
    if (reactRows('make-previewable').blocked) throw new Error('still blocked once set up');
    const started = await vscode.commands.executeCommand('visualEditor.runAgent', 'make-previewable', 'background', 'Gate test, set up', free[0].id);
    if (started !== true) throw new Error('it did not start once set up');
    await until(() => !t.agentRuns.has(jobsNow().find((j) => j.request === 'Gate test, set up')?.id ?? ''), 'its run to end', 20_000);
    for (const j of jobsNow()) rmSync(join(root, '.visual-editor', 'jobs', `${j.id}.json`), { force: true });
  });
  await step('Set up project works one job at a time (another would do the same): a second start or Resume is refused while one works; once it stops, it starts again', async () => {
    writeFileSync(hold, '');
    try {
      const setUps = () => jobsNow().filter((j) => j.agent === 'set-up-project');
      if ((await vscode.commands.executeCommand('visualEditor.runAgent', 'set-up-project', 'background')) !== true) throw new Error('the first did not start');
      const first = setUps()[0];
      if ((await vscode.commands.executeCommand('visualEditor.runAgent', 'set-up-project', 'terminal')) !== false || setUps().length !== 1) throw new Error('a second one started');
      if (!/^Set up project is at work already \(round 1 of 3\): one at a time/.test(reactRows('set-up-project').blocked ?? '')) throw new Error(`its buttons: ${reactRows('set-up-project').blocked}`);
      const said = await chat('job_start', { agent: 'set-up-project', request: 'Set it up (chat)' });
      if (!said.error || !/is at work already/.test(said.text)) throw new Error(`the chat: ${said.text}`);
      // Stopped: a new one starts; the stopped one can't be resumed while the new one works.
      await vscode.commands.executeCommand('visualEditor.stopJob', { job: { id: first.id } });
      if (reactRows('set-up-project').blocked) throw new Error('still blocked once stopped');
      if ((await vscode.commands.executeCommand('visualEditor.runAgent', 'set-up-project', 'background')) !== true) throw new Error('it did not start again');
      const second = setUps().find((j) => j.id !== first.id)!;
      if ((await vscode.commands.executeCommand('visualEditor.resumeJob', first.id)) !== false || statusOf(first.id) !== 'stopped') throw new Error('resumed alongside the new one');
      // The new one stopped: the first resumes.
      await vscode.commands.executeCommand('visualEditor.stopJob', { job: { id: second.id } });
      if ((await vscode.commands.executeCommand('visualEditor.resumeJob', first.id)) !== true) throw new Error('not resumed once alone');
      await vscode.commands.executeCommand('visualEditor.stopJob', { job: { id: first.id } });
    } finally {
      rmSync(hold, { force: true });
    }
    await until(() => !jobsNow().some((j) => t.agentRuns.has(j.id)), 'every run to end', 20_000);
    for (const j of jobsNow()) rmSync(join(root, '.visual-editor', 'jobs', `${j.id}.json`), { force: true });
  });
  setUpAgent.done = realDone;
  t.hub.assistants = realAssistants;

  await client.close();
  require('node:fs').writeFileSync(process.env.VISUAL_EDITOR_REPORT!, lines.join('\n') + '\n');
  if (failed) throw new Error(`${failed} step(s) failed`);
}
