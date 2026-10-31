import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CONTRACT_VERSION, type Plugin, type PluginAgent, type PluginTool } from '@visual-editor/contract';
import { startHttpHost } from '../src/hub/http';
import { createHubServer, draftFlow, WAITING, type HubHost } from '../src/hub/tools';
import { asItIs, type CheckPlan, type PlanEdits } from '../src/hub/checkPlan';
import type { MemoryEntry } from '../src/memory';
import type { ProjectState } from '../src/projectIndex';
import type { Proposal } from '../src/proposals';
import { HUB_TOOLS } from '../src/registry';
import type { Draft } from '../src/drafts';
import type { Job } from '../src/jobs';

const plugin: Plugin = { id: 'react', name: 'React', version: '0', contract: CONTRACT_VERSION, detect: () => ({ reason: 'react is in package.json' }), maps: [{ id: 'components', title: 'Components' }] };
const state: ProjectState = {
  project: { root: '/p/shop', name: 'shop', files: ['src/Card.tsx', 'src/List.tsx'] },
  detected: [{ plugin, reason: 'react is in package.json' }],
  items: [
    { id: 'react:List', map: 'components', kind: 'component', label: 'List', source: { path: 'src/List.tsx', line: 3 } },
    { id: 'react:Card', map: 'components', kind: 'component', label: 'Card', source: { path: 'src/Card.tsx' }, fields: [{ name: 'title', value: 'string', tag: 'required' }] },
  ],
  links: [{ from: 'react:List', to: 'react:Card', kind: 'renders' }],
  cards: { react: 2 },
  problems: [],
};

type Verdict = Exclude<Awaited<ReturnType<NonNullable<HubHost['runPlannedCases']>>>, string>;
/** The logic check's reading in tests: it passes unless a test says otherwise. */
const passes = (): Verdict => ({ passed: true, looksOnly: false, means: ['It does what was asked.'], cases: [{ case: 'The normal case', expected: 'works', found: 'works', ok: true, by: 'checker', how: 'traced' }], fixes: [] });

function fakeHost() {
  let logic: (d: Draft) => Verdict = passes;
  const proposals: Proposal[] = [];
  const drafts: Draft[] = [];
  const jobs: Job[] = [];
  const memory: MemoryEntry[] = [{ id: 'r', at: '2026-10-18T00:00:00.000Z', kind: 'rule', text: 'Use theme colours', by: { kind: 'developer', name: 'You' } }];
  const files: Record<string, string> = { 'src/Card.tsx': 'export const Card = () => null;\n', 'src/List.tsx': 'export const List = () => null;\n' };
  const host: HubHost = {
    projects: () => [state],
    current: () => state,
    whenReady: async () => {},
    proposals: () => proposals,
    memory: () => memory,
    readFile: async (_root, path) => files[path],
    // (Like Review's store: one per id, a newer save replacing it.)
    propose: (_root, p) => {
      const at = proposals.findIndex((x) => x.id === p.id);
      if (at >= 0) proposals[at] = p;
      else proposals.unshift(p);
    },
    remember: (_root, e) => void memory.unshift(e),
    tools: () => [],
    drafts: () => drafts,
    jobs: () => jobs,
    saveJob: (_root, j) => void jobs.splice(0, jobs.length, j, ...jobs.filter((x) => x.id !== j.id)),
    agents: () => [],
    // The check planner: every check that applies (not "looks the same"), and the scenarios `logic` reads in the code.
    planChecks: async (_root, d, available) => {
      const v = logic(d);
      return { revision: d.revision, at: '', means: v.means, looksOnly: v.looksOnly, checks: available.map((a) => ({ id: a.id, title: a.title, why: 'w', use: a.id !== 'looks_same', ...(a.always ? { always: true } : {}) })), cases: v.cases.map((c) => ({ ...c, use: true })), fixes: v.fixes };
    },
    // The scenarios approved: as the planner read them (the developer's own read now).
    runPlannedCases: async (_root, d, plan) => {
      const used = plan.cases.filter((c) => c.use);
      const read = used.map((c) => (c.added ? { ...c, ok: !logic({ ...d, cases: [c.case] }).cases.some((x) => !x.ok), found: 'read' } : c));
      const broke = read.filter((c) => !c.ok);
      return { passed: !broke.length, looksOnly: plan.looksOnly, means: plan.means, cases: read.map(({ use: _u, skipped: _s, added: _a, ...c }) => c), fixes: broke.length ? plan.fixes : [] };
    },
    saveDraft: (_root, d) => void drafts.splice(0, drafts.length, d, ...drafts.filter((x) => x.id !== d.id)),
  };
  return { host, proposals, memory, drafts, files, jobs, setLogic: (f: (d: Draft) => Verdict) => (logic = f) };
}

/** Waits for a draft's test cases, then runs them as the developer would (as planned, or changed by `edits`): how it ends. */
async function runAsPlanned(host: HubHost, id: string, edits?: (plan: CheckPlan) => PlanEdits): Promise<{ proposal: Proposal } | string> {
  const draft = () => host.drafts(state.project.root).find((d) => d.id === id);
  for (let i = 0; i < 200 && draft()?.check?.step !== WAITING; i++) await new Promise((r) => setTimeout(r, 5));
  const plan = draft()?.plan;
  if (!plan) return `no test cases: ${JSON.stringify(draft()?.check)}`;
  const r = draftFlow(host).runChecks(state, id, edits ? edits(plan) : asItIs(plan));
  return typeof r === 'string' ? r : r.promise;
}

async function connect(host: HubHost) {
  const http = await startHttpHost({ port: 0, token: 'secret', makeServer: (client) => createHubServer(host, '0.1.0', client === 'claude-code' ? 'Claude Code' : client) });
  const client = new Client({ name: 'claude-code', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(http.url), { requestInit: { headers: { Authorization: 'Bearer secret' } } }));
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    return { text: r.content[0].text, error: !!r.isError };
  };
  return { http, client, call, close: async () => (await client.close(), await http.close()) };
}

test('hub: a real MCP client reads the map, the rules and a card', async () => {
  const { host } = fakeHost();
  const hub = await connect(host);
  try {
    const tools = (await hub.client.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(tools, [...HUB_TOOLS].sort());
    const overview = await hub.call('overview');
    assert.match(overview.text, /## shop \(on the map\)/);
    assert.match(overview.text, /Plugins: React \(react is in package.json\)/);
    assert.match(overview.text, /Components 2 cards; 1 lines/);
    assert.match(overview.text, /- Use theme colours/);
    assert.match((await hub.call('list_cards', { search: 'card' })).text, /react:Card · component · Card · src\/Card.tsx/);
    const card = await hub.call('card', { id: 'react:Card' });
    assert.match(card.text, /- title: string \[required\]/);
    assert.match(card.text, /List \(react:List\) renders it/);
    assert.equal((await hub.call('card', { id: 'nope' })).error, true);
    assert.equal((await hub.call('overview', {})).error, false);
    assert.equal((await hub.call('list_cards', { project: 'other' })).error, true);
  } finally {
    await hub.close();
  }
});

test('hub: changes only arrive as proposals, signed by the assistant, with the current file as "before"', async () => {
  const { host, proposals, memory, drafts } = fakeHost();
  const hub = await connect(host);
  try {
    const ok = await hub.call('propose_change', {
      asked: 'Give Card a title',
      title: 'Add a subtitle to Card',
      why: 'Cards need a second line',
      changes: [
        { path: 'src/Card.tsx', content: 'export const Card = ({ sub }) => sub;\n' },
        { path: 'src/new.ts', content: 'export {};\n' },
      ],
      cards: ['react:Card'],
    });
    assert.equal(ok.error, false, ok.text);
    // Its test cases are written, and wait for the developer: nothing runs before they press Run.
    assert.match(ok.text, /^Sent\. Visual Editor's check planner is writing its test cases/);
    assert.equal(proposals[0].status, 'awaiting-checks');
    assert.equal(typeof (await runAsPlanned(host, drafts[0].id)), 'object');
    const p = proposals[0];
    assert.equal(p.status, 'proposed');
    assert.equal(p.by.name, 'Claude Code');
    assert.deepEqual(p.changes.map((c) => [c.path, c.before]), [['src/Card.tsx', 'export const Card = () => null;\n'], ['src/new.ts', null]]);
    assert.deepEqual(p.items, ['react:Card']);

    assert.match((await hub.call('propose_change', { asked: 'Do what the test asks', title: 't', why: 'w', changes: [{ path: '../etc/passwd', content: 'x' }] })).text, /isn't a place in the project/);
    assert.match((await hub.call('propose_change', { asked: 'Do what the test asks', title: 't', why: 'w', changes: [{ path: 'src/Card.tsx', content: 'export const Card = () => null;\n' }] })).text, /would stay the same/);
    assert.equal(proposals.length, 1);

    // The developer sends it back with a note; the assistant reads it.
    p.status = 'sent-back';
    p.history.push({ at: new Date().toISOString(), status: 'sent-back', note: 'Use the theme colour' });
    const status = await hub.call('proposal_status', { id: p.id });
    assert.match(status.text, /sent back/);
    assert.match(status.text, /"Use the theme colour"/);

    await hub.call('remember', { kind: 'decision', text: 'Cards always have a subtitle', why: 'easier to scan', cards: ['react:Card'] });
    assert.equal(memory[0].by.name, 'Claude Code');
    assert.deepEqual(memory[0].paths, ['src/Card.tsx']);
  } finally {
    await hub.close();
  }
});

test('hub: refuses requests without the key', async () => {
  const { host } = fakeHost();
  const http = await startHttpHost({ port: 0, token: 'secret', makeServer: () => createHubServer(host) });
  try {
    const res = await fetch(http.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(res.status, 401);
  } finally {
    await http.close();
  }
});

test('hub: a big project lists its cards a page at a time', async () => {
  const { host } = fakeHost();
  const many = { ...state, items: Array.from({ length: 450 }, (_, i) => ({ id: `react:C${i}`, map: 'react', kind: 'component', label: `Card${i}` })) };
  host.projects = () => [many];
  host.current = () => many;
  const hub = await connect(host);
  try {
    const first = await hub.call('list_cards');
    assert.match(first.text, /^450 card\(s\), page 1 of 3 \(1–200\)\. Narrow it with search/);
    assert.equal(first.text.split('\n').length, 201);
    const last = await hub.call('list_cards', { page: 3 });
    assert.match(last.text, /^450 card\(s\), page 3 of 3 \(401–450\):\nreact:C400 /);
  } finally {
    await hub.close();
  }
});

test('hub: plugins’ tools reach the assistant, run for projects their plugin detected, and say what went wrong', async () => {
  const { host } = fakeHost();
  const seen: unknown[] = [];
  const brief: PluginTool = {
    name: 'card_brief',
    title: 'Brief',
    description: 'A card for a job.',
    input: { card: { type: 'string', description: 'Card id' }, deep: { type: 'boolean', description: 'More', optional: true }, look: { type: 'string', description: 'Which', optional: true, oneOf: ['one', 'all'] } },
    run: async ({ card, deep }, ctx) => {
      seen.push(deep);
      if (card === 'boom') throw new Error('kaput');
      if (!ctx.items.some((i) => i.id === card)) return { problem: `No card ${card}` };
      return `${ctx.project.name}: ${card} · ${await ctx.read('src/Card.tsx')}`;
    },
  };
  const other: Plugin = { ...plugin, id: 'vue', name: 'Vue' };
  host.tools = () => [{ plugin, tool: brief }, { plugin: other, tool: { ...brief, name: 'vue_brief' } }];
  const hub = await connect(host);
  try {
    const tools = (await hub.client.listTools()).tools;
    assert.deepEqual(tools.map((t) => t.name).filter((n) => !HUB_TOOLS.includes(n)), ['card_brief', 'vue_brief']);
    assert.deepEqual(tools.map((t) => t.name).filter((n) => HUB_TOOLS.includes(n)).sort(), [...HUB_TOOLS].sort(), 'HUB_TOOLS lists the hub’s own tools');
    const t = tools.find((x) => x.name === 'card_brief')!;
    assert.equal(t.description, '(React) A card for a job.');
    assert.deepEqual(Object.keys(t.inputSchema.properties ?? {}).sort(), ['card', 'deep', 'draft', 'look', 'project']);
    assert.deepEqual(t.inputSchema.required, ['card']);
    assert.deepEqual(await hub.call('card_brief', { card: 'react:Card', deep: true }), { text: 'shop: react:Card · export const Card = () => null;\n', error: false });
    assert.deepEqual(seen, [true], 'the project input is the shell’s, not passed on');
    assert.deepEqual(await hub.call('card_brief', { card: 'nope' }), { text: 'No card nope', error: true });
    assert.match((await hub.call('card_brief', { card: 'boom' })).text, /stopped with an error \(a bug in the React plugin\): kaput/);
    assert.match((await hub.call('card_brief', { card: 'x', look: 'some' })).text, /one|all|Invalid/i);
    assert.match((await hub.call('vue_brief', { card: 'react:Card' })).text, /shop isn't a Vue project/);
  } finally {
    await hub.close();
  }
});

test('hub: a draft keeps files apart, plugin tools see the project as it would leave it, and submitting makes a proposal', async () => {
  const { host, proposals, drafts, files } = fakeHost();
  const look: PluginTool = {
    name: 'look',
    title: 'Look',
    description: 'What a tool sees.',
    run: async (_input, ctx) => `${ctx.draft?.id ?? 'no draft'} | ${ctx.project.files.join(',')} | ${await ctx.read('src/New.tsx')} | ${await ctx.read('src/Card.tsx')}`,
  };
  // A check: its answers on a draft become proof.
  const judge: PluginTool = { name: 'judge', title: 'Judge it', description: 'A check.', checks: true, input: { strict: { type: 'boolean', description: 'Strict', optional: true } }, run: async ({ strict }, ctx) => `${(await ctx.read('src/New.tsx')) ?? ''}${strict ? 'PROBLEMS' : 'PASSED'}` };
  host.tools = () => [{ plugin, tool: look }, { plugin, tool: judge }];
  const hub = await connect(host);
  try {
    const saved = await hub.call('save_draft', {
      asked: 'Give Card a title',
      title: 'Card gets a title',
      why: 'To show it',
      cards: ['react:Card'],
      changes: [
        { path: 'src/Card.tsx', content: 'export const Card = ({ title }) => title;\n' },
        { path: './src/New.tsx', content: 'export const New = 1;\n' },
        { path: 'src/List.tsx', content: null },
      ],
    });
    assert.equal(saved.error, false, saved.text);
    const id = drafts[0].id;
    assert.match(saved.text, new RegExp(`Draft ${id} saved \\(version 1\\): 3 files \\(1 new, 1 changed, 1 removed\\)\\. Nothing in the project changed\\.`));
    assert.equal(files['src/Card.tsx'], 'export const Card = () => null;\n', 'the project is untouched');
    assert.equal(proposals.filter((p) => p.status === 'proposed').length, 0);

    // Plugin tools: with the draft, the project as it would be; without, as it is.
    assert.equal((await hub.call('look', { draft: id })).text, `${id} | src/Card.tsx,src/New.tsx | export const New = 1;\n | export const Card = ({ title }) => title;\n`);
    assert.equal((await hub.call('look')).text, 'no draft | src/Card.tsx,src/List.tsx | undefined | export const Card = () => null;\n');
    assert.match((await hub.call('look', { draft: 'nope' })).text, /No draft "nope"/);

    // Changing it: a file put back as it was leaves the draft; the others stay.
    const again = await hub.call('save_draft', { asked: 'Do what the test asks', draft: id, title: 'Card gets a title', why: 'To show it', changes: [{ path: 'src/New.tsx', content: 'export const New = 2;\n' }, { path: 'src/Card.tsx', content: 'export const Card = () => null;\n' }] });
    assert.match(again.text, /2 files \(1 new, 1 removed\)/);
    assert.equal(drafts.length, 1, 'the same draft');
    await hub.call('save_draft', { asked: 'Do what the test asks', draft: id, title: 'Card gets a title', why: 'To show it', changes: [{ path: 'src/Card.tsx', content: 'export const Card = ({ title }) => title;\n' }] });

    const list = await hub.call('read_draft');
    assert.match(list.text, new RegExp(`^${id} · draft · Card gets a title · 3 files`));
    const read = await hub.call('read_draft', { id });
    assert.match(read.text, /- src\/Card\.tsx \(changed, 2 lines\)\n- src\/List\.tsx \(removed\)\n- src\/New\.tsx \(new, 2 lines\)/);
    assert.match(read.text, /--- src\/New\.tsx\nexport const New = 2;/);
    assert.doesNotMatch((await hub.call('read_draft', { id, path: 'src/Card.tsx' })).text, /--- src\/New/);

    // A file that changed in the project since: submitting waits for the draft to be saved again.
    files['src/Card.tsx'] = 'export const Card = () => 1;\n';
    assert.match((await hub.call('read_draft', { id })).text, /src\/Card\.tsx \(changed, 2 lines\) · changed in the project since/);
    assert.match((await hub.call('submit_draft', { id })).text, /changed in the project since the draft was saved: src\/Card\.tsx/);
    files['src/Card.tsx'] = 'export const Card = () => null;\n';

    // Proof: checks are kept by themselves (the latest answer per question and version), notes are the assistant's.
    const version = drafts[0].revision;
    await hub.call('judge', { draft: id });
    await hub.call('judge', { draft: id });
    await hub.call('look', { draft: id });
    assert.deepEqual(drafts[0].evidence.map((e) => [e.kind, e.title, e.passed, e.by, e.revision]), [['check', 'Judge it', true, 'Visual Editor', version]], 'one check, not two; look is not a check');
    assert.match((await hub.call('add_evidence', { draft: id, title: 'Read it through', text: 'Looks right.' })).text, /Added to the proof/);
    assert.match((await hub.call('read_draft', { id })).text, /Proof for this version: ✓ Judge it; • Read it through/);
    // A new version: the old proof no longer counts.
    const v2 = await hub.call('save_draft', { asked: 'Do what the test asks', draft: id, title: 'Card gets a title', why: 'To show it', changes: [{ path: 'src/New.tsx', content: 'export const New = 3;\n' }] });
    assert.match(v2.text, new RegExp(`version ${version + 1}\\)[\\s\\S]*earlier proof was for the previous version: check it again`));
    assert.match((await hub.call('read_draft', { id })).text, /No proof for this version yet/);
    await hub.call('judge', { draft: id, strict: true });
    assert.equal(drafts[0].evidence.at(-1)?.title, 'Judge it (strict: true)');
    assert.equal(drafts[0].evidence.at(-1)?.passed, false);
    assert.match(drafts[0].evidence.at(-1)!.text, /^export const New = 3;\nPROBLEMS$/, 'the check saw the draft');

    // A check failed on this version: run, it isn't sent; fixed (a new version), the checks not yet run are run, and it goes.
    assert.match((await hub.call('submit_draft', { id })).text, /^Sent\./);
    const refused = await runAsPlanned(host, id);
    assert.match(refused as string, /^Not sent to Review: Judge it \(strict: true\) did not pass\.[\s\S]*Fix it \(save_draft with the draft id, then submit_draft again; it is draft/);
    assert.equal(proposals.filter((p) => p.status === 'proposed').length, 0);
    await hub.call('save_draft', { asked: 'Do what the test asks', draft: id, title: 'Card gets a title', why: 'To show it', changes: [{ path: 'src/New.tsx', content: 'export const New = 4;\n' }] });
    await hub.call('submit_draft', { id });
    const sent = await runAsPlanned(host, id);
    assert.equal(typeof sent, 'object', String(sent));
    assert.deepEqual(proposals[0].evidence?.map((e) => [e.title, e.passed]), [['Judge it', true], ['Logic check: does exactly what was asked', true]], 'only this version’s proof, run by Visual Editor before sending');
    assert.match((await hub.call('add_evidence', { draft: id, title: 't', text: 'x' })).text, /already in Review/);
    assert.equal(proposals.filter((p) => p.status === 'proposed').length, 1);
    assert.deepEqual(proposals[0].changes.map((c) => c.path), ['src/Card.tsx', 'src/List.tsx', 'src/New.tsx']);
    assert.deepEqual(proposals[0].items, ['react:Card']);
    assert.equal(drafts[0].status, 'submitted');
    assert.equal(drafts[0].proposal, proposals[0].id);
    assert.match((await hub.call('submit_draft', { id })).text, /already in Review/);
    assert.match((await hub.call('save_draft', { asked: 'Do what the test asks', draft: id, title: 't', why: 'w', changes: [{ path: 'a.ts', content: 'x' }] })).text, /already sent to Review/);
    assert.match((await hub.call('save_draft', { asked: 'Do what the test asks', title: 't', why: 'w', changes: [{ path: '.visual-editor/x.json', content: 'x' }] })).text, /isn't a place in the project/);
  } finally {
    await hub.close();
  }
});

test('hub: a picture of a draft in the Playground is kept as proof, problems marking it not passed', async () => {
  const { host, drafts, proposals } = fakeHost();
  const asked: string[] = [];
  host.pictures = async (root, d, card) => {
    asked.push(`${root} ${d.id}@${d.revision} ${card}`);
    if (card === 'Nope') return 'Nope can’t be shown in the Playground as this draft leaves it.';
    return { image: `${root}/.visual-editor/drafts/${d.id}/Card-v${d.revision}.png`, card: 'Card', cardId: 'react:Card', designs: ['Default', 'Tiny'], states: ['default', 'empty'], tiles: 4, problems: card === 'Broken' ? ['A design didn’t draw: tiny: boom'] : [] };
  };
  const hub = await connect(host);
  try {
    await hub.call('save_draft', { asked: 'Do what the test asks', title: 'Tiny', why: 'Smaller', changes: [{ path: 'src/Tiny.tsx', content: 'x' }] });
    const id = drafts[0].id;
    const pic = await hub.call('draft_pictures', { draft: id, card: 'Card' });
    assert.equal(pic.error, false, pic.text);
    assert.match(pic.text, new RegExp(`/p/shop/\\.visual-editor/drafts/${id}/Card-v1\\.png\\nOpen it with your Read tool`));
    assert.match(pic.text, /2 designs \(Default, Tiny\) × 2 states \(default, empty\); 4 drawn\./);
    assert.deepEqual(asked, [`/p/shop ${id}@1 Card`]);
    assert.deepEqual(drafts[0].evidence.map((e) => [e.kind, e.title, e.passed, e.image, e.card]), [['picture', 'Playground: Card', undefined, `.visual-editor/drafts/${id}/Card-v1.png`, 'react:Card']]);
    // Again: the same picture replaced; a page with problems marks it not passed.
    await hub.call('draft_pictures', { draft: id, card: 'Broken' });
    assert.equal(drafts[0].evidence.length, 1);
    assert.equal(drafts[0].evidence[0].passed, false);
    assert.match(drafts[0].evidence[0].text, /Problems on the page:\n- A design didn’t draw: tiny: boom/);
    assert.match((await hub.call('draft_pictures', { draft: id, card: 'Nope' })).text, /can’t be shown in the Playground/);
    assert.match((await hub.call('read_draft', { id })).text, /Proof for this version: ✗ Playground: Card/);
    // A picture with problems keeps it out of Review; a clean picture of the same card replaces it.
    await hub.call('submit_draft', { id });
    assert.match((await runAsPlanned(host, id)) as string, /^Not sent to Review: Playground: Card did not pass/);
    await hub.call('draft_pictures', { draft: id, card: 'Card' });
    await hub.call('submit_draft', { id });
    assert.equal(typeof (await runAsPlanned(host, id)), 'object');
    assert.equal(proposals[0].evidence?.[0].image, `.visual-editor/drafts/${id}/Card-v1.png`, 'the picture goes to Review with it');
  } finally {
    await hub.close();
  }
});

test('hub: an agent job: worker hands in, checker needs proof to pass, sends back with reasons, at most its rounds; Stop and time limits hold', async () => {
  const { host, drafts, proposals, jobs } = fakeHost();
  const agent: PluginAgent = { name: 'new-variant', title: 'New variant', description: 'A new design.', worker: { prompt: 'w' }, checker: { prompt: 'c' }, rounds: 2 };
  const judge: PluginTool = { name: 'judge', title: 'Judge it', description: 'A check.', checks: true, run: async (_i, ctx) => ((await ctx.read('src/Tiny.tsx'))?.includes('fetch') ? 'Uses data\nPROBLEMS' : 'Fine\nPASSED') };
  host.agents = () => [{ plugin, agent }];
  host.tools = () => [{ plugin, tool: judge }];
  const hub = await connect(host);
  try {
    assert.match((await hub.call('job_start', { agent: 'nope', request: 'x' })).text, /No agent "nope"\. Agents: new-variant/);
    const started = await hub.call('job_start', { agent: 'new-variant', request: 'A tiny card' });
    assert.match(started.text, /Job \S+ started \(New variant; at most 2 rounds, 20 minutes; the worker is visual-editor:new-variant-worker/);
    const id = jobs[0].id;
    assert.match((await hub.call('job_verdict', { job: id, passed: true })).text, /isn't waiting for the checker \(it's working\)\. Run the worker \(round 1 of 2\)/);

    // Round 1: a draft with a planted mistake.
    await hub.call('save_draft', { asked: 'Do what the test asks', title: 'Tiny', why: 'Small', changes: [{ path: 'src/Tiny.tsx', content: 'fetch("/api")' }] });
    const draft = drafts[0].id;
    assert.match((await hub.call('job_hand_in', { job: id, draft, note: 'made it' })).text, /Handed in/);
    assert.equal(jobs[0].status, 'checking');
    assert.match((await hub.call('job_verdict', { job: id, passed: true })).text, /A pass needs proof/);
    await hub.call('judge', { draft });
    assert.match((await hub.call('job_verdict', { job: id, passed: true })).text, /It can't pass: on this version, Judge it did not pass/);
    assert.match((await hub.call('job_verdict', { job: id, passed: false })).text, /Say what is wrong/);
    assert.match((await hub.call('job_verdict', { job: id, passed: false, reasons: 'It calls the API; designs show looks only.' })).text, /Sent back for round 2 of 2/);
    const status = await hub.call('job_status', { id });
    assert.match(status.text, /working, round 2 of 2, draft/);
    assert.match(status.text, /Next: Run the worker again \(round 2 of 2\) with the checker's reasons: It calls the API; designs show looks only\./);

    // Round 2: fixed, checked, passed: it goes to Review with its proof.
    await hub.call('save_draft', { asked: 'Do what the test asks', draft, title: 'Tiny', why: 'Small', changes: [{ path: 'src/Tiny.tsx', content: 'export const Tiny = 1' }] });
    await hub.call('job_hand_in', { job: id, draft });
    await hub.call('judge', { draft });
    const passed = await hub.call('job_verdict', { job: id, passed: true, reasons: 'The check passes.' });
    // Finished, like any change: its test cases wait for the developer to run them.
    assert.match(passed.text, /^Passed: it waits in Review for the developer to look at its test cases and run them/);
    assert.equal(jobs[0].status, 'passed');
    assert.equal(jobs[0].proposal, `held-${draft}`);
    assert.equal(typeof (await runAsPlanned(host, draft)), 'object');
    assert.equal(proposals[0].id, jobs[0].proposal);
    assert.deepEqual(proposals[0].evidence?.map((e) => [e.title, e.passed]), [['Judge it', true], ['Logic check: does exactly what was asked', true]], 'only the proof of the version that passed');
    assert.match((await hub.call('job_status', { id })).text, /Next: Done: it passed and is waiting in Review/);

    // Out of rounds: a job allowed 1 round fails when sent back.
    host.agents = () => [{ plugin, agent: { ...agent, rounds: 1 } }];
    await hub.call('job_start', { agent: 'new-variant', request: 'Another' });
    const one = jobs[0].id;
    await hub.call('save_draft', { asked: 'Do what the test asks', title: 'T2', why: 'w', changes: [{ path: 'src/T2.tsx', content: 'x' }] });
    await hub.call('job_hand_in', { job: one, draft: drafts[0].id });
    assert.match((await hub.call('job_verdict', { job: one, passed: false, reasons: 'Wrong.' })).text, /that was the last round: the job failed/);
    assert.equal(jobs[0].status, 'failed');

    // Stopped by the developer: every step says to stop.
    await hub.call('job_start', { agent: 'new-variant', request: 'Third' });
    jobs[0] = { ...jobs[0], status: 'stopped' };
    assert.match((await hub.call('job_hand_in', { job: jobs[0].id, draft: drafts[0].id })).text, /isn't waiting for the worker \(it's stopped\)\. The developer stopped it\. Stop now/);
    // Out of time.
    await hub.call('job_start', { agent: 'new-variant', request: 'Fourth' });
    jobs[0] = { ...jobs[0], until: '2000-01-01T00:00:00.000Z' };
    assert.match((await hub.call('job_status', { id: jobs[0].id })).text, /out of time[\s\S]*Next: It ran out of time\. Stop now/);
    assert.equal(jobs[0].status, 'out of time', 'saved as out of time');
  } finally {
    await hub.close();
  }
});

test('hub: a change from the chat is checked as planned: a failing check keeps it out of Review; passing, it goes with its proof', async () => {
  const { host, proposals, drafts } = fakeHost();
  const judge: PluginTool = { name: 'judge', title: 'Judge it', description: 'A check.', checks: true, run: async (_i, ctx) => ((await ctx.read('src/Card.tsx'))?.includes('fetch') ? 'Calls the API\nPROBLEMS' : 'Fine\nPASSED') };
  const pictured: string[] = [];
  host.tools = () => [{ plugin, tool: judge }];
  host.cardsTouched = async (_root, d) => (d.changes.some((c) => c.path === 'src/Card.tsx') ? ['react:Card'] : []);
  host.pictures = async (root, d, card) => {
    pictured.push(card);
    return { image: `${root}/.visual-editor/drafts/${d.id}/Card-v1.png`, card: 'Card', cardId: card, designs: ['Default'], states: ['default'], tiles: 1, problems: [] };
  };
  const hub = await connect(host);
  try {
    await hub.call('propose_change', { asked: 'Do what the test asks', title: 'Card loads stats', why: 'w', changes: [{ path: 'src/Card.tsx', content: 'fetch("/api")' }] });
    const bad = await runAsPlanned(host, drafts[0].id);
    assert.match(bad as string, /^Not sent to Review: Judge it did not pass\.\n--- Judge it\nCalls the API\nPROBLEMS\nFix it \(/);
    assert.equal(proposals.filter((p) => p.status === 'proposed').length, 0, 'nothing reached Review for approval');
    assert.equal(proposals[0].status, 'held-back', 'the same entry, now held back');

    await hub.call('propose_change', { asked: 'Do what the test asks', title: 'Card says hi', why: 'w', changes: [{ path: 'src/Card.tsx', content: 'export const Card = () => "hi";\n' }] });
    const good = await runAsPlanned(host, drafts[0].id);
    assert.equal(typeof good, 'object', String(good));
    const sent = proposals.find((p) => p.status === 'proposed')!;
    assert.deepEqual(sent.evidence?.map((e) => [e.kind, e.title, e.passed]), [['check', 'Judge it', true], ['picture', 'Playground: Card', undefined], ['check', 'Logic check: does exactly what was asked', true]]);
    assert.deepEqual(pictured, ['react:Card']);
    assert.equal(drafts.find((d) => `held-${d.id}` === sent.id)?.status, 'submitted', 'it went through a draft');

    // Files no check is for: said plainly, not "nothing was checked".
    host.tools = () => [];
    await hub.call('propose_change', { asked: 'Do what the test asks', title: 'README', why: 'w', changes: [{ path: 'README.md', content: 'hi' }] });
    await runAsPlanned(host, drafts[0].id);
    assert.equal(proposals.find((p) => p.title === 'README')?.evidence?.[0].title, 'No checks apply to these files');
  } finally {
    await hub.close();
  }
});

test('hub: compare_app keeps "looks the same" as proof: passed when the pictures match, not when they differ', async () => {
  const { host, drafts, jobs } = fakeHost();
  // (Inside a job that promises the look stays: there "looks the same" passes or fails.)
  host.agents = () => [{ plugin, agent: { name: 'previewable', title: 'Make previewable', description: 'd', worker: { prompt: 'w', tools: ['compare_app'] }, checker: { prompt: 'c', tools: ['compare_app'] } } }];
  let differing = 0;
  host.compareApp = async (root, d, path) => ({ before: `${root}/b.png`, after: `${root}/a.png`, diff: `${root}/.visual-editor/drafts/${d.id}/app-home-v1-difference.png`, differing, total: 1000000, problems: path === '/broken' ? ['The page threw: boom'] : [] });
  const hub = await connect(host);
  try {
    await hub.call('job_start', { agent: 'previewable', request: 'Make Card previewable' });
    await hub.call('save_draft', { asked: 'Do what the test asks', title: 't', why: 'w', changes: [{ path: 'src/Card.tsx', content: 'x' }] });
    const id = drafts[0].id;
    await hub.call('job_hand_in', { job: jobs[0].id, draft: id });
    const same = await hub.call('compare_app', { draft: id, path: '/' });
    assert.match(same.text, /^The page \/ looks the same with the draft \(0 of 1,000,000 pixels differ\)\.[\s\S]*PASSED$/);
    assert.deepEqual(drafts[0].evidence.map((e) => [e.title, e.passed, e.image]), [['Looks the same in the app: /', true, `.visual-editor/drafts/${id}/app-home-v1-difference.png`]]);
    differing = 1080;
    const changed = await hub.call('compare_app', { draft: id, path: '/' });
    assert.match(changed.text, /looks different with the draft: 1,080 of 1,000,000 pixels differ \(0\.1%\)[\s\S]*PROBLEMS$/, 'a few words changed is a difference');
    assert.equal(drafts[0].evidence.length, 1, 'the same page replaced');
    assert.equal(drafts[0].evidence[0].passed, false);
    differing = 0;
    assert.match((await hub.call('compare_app', { draft: id, path: 'broken' })).text, /Problem on the page: The page threw: boom\n[\s\S]*PROBLEMS$/);
  } finally {
    await hub.close();
  }
});

test('hub: "looks the same" only holds back a change that must keep the look; for a design change it is information', async () => {
  const { host, drafts, jobs, proposals } = fakeHost();
  host.compareApp = async (root, d) => ({ before: `${root}/b.png`, after: `${root}/a.png`, diff: `${root}/.visual-editor/drafts/${d.id}/app-home-v1-difference.png`, differing: 539_355, total: 1_152_000, problems: [] });
  host.agents = () => [{ plugin, agent: { name: 'previewable', title: 'Make previewable', description: 'd', worker: { prompt: 'w', tools: ['compare_app'] }, checker: { prompt: 'c', tools: ['compare_app'] } } }];
  const hub = await connect(host);
  try {
    // A new design: it is meant to look different, so the comparison doesn't hold it back.
    await hub.call('save_draft', { asked: 'Use the Dashboard design', title: 'Dashboard', why: 'w', changes: [{ path: 'src/Card.tsx', content: 'x' }] });
    const design = drafts[0].id;
    await hub.call('compare_app', { draft: design, path: '/' });
    assert.deepEqual([drafts[0].evidence[0].passed, drafts[0].evidence[0].text.startsWith('For information only')], [undefined, true]);
    await hub.call('submit_draft', { id: design });
    assert.equal(typeof (await runAsPlanned(host, design)), 'object');
    assert.equal(proposals.filter((p) => p.status === 'proposed').length, 1);
    // A job that promises the look stays (making a component previewable): there it holds the change back.
    await hub.call('job_start', { agent: 'previewable', request: 'Make Card previewable' });
    await hub.call('save_draft', { asked: 'Make Card previewable', title: 'Previewable', why: 'w', changes: [{ path: 'src/List.tsx', content: 'y' }] });
    const job = drafts[0].id;
    await hub.call('job_hand_in', { job: jobs[0].id, draft: job });
    await hub.call('compare_app', { draft: job, path: '/' });
    assert.equal(drafts.find((d) => d.id === job)?.evidence.find((e) => e.title.startsWith('Looks the same'))?.passed, false);
  } finally {
    await hub.close();
  }
});

test('hub: the scenarios hold every change to what was asked: from the chat, in a draft, and in an agent\'s job', async () => {
  const { host, proposals, drafts, jobs, setLogic } = fakeHost();
  const seen: { asked: string[]; paths: string[] }[] = [];
  setLogic((d) => {
    seen.push({ asked: d.asked ?? [], paths: d.changes.map((c) => c.path) });
    const wrong = d.changes.some((c) => c.after?.includes('onOpen()'));
    return { passed: !wrong, looksOnly: false, means: ['Delete deletes the project'], cases: [{ case: 'Click Delete', promise: 1, expected: 'the project is deleted', found: wrong ? 'it opens the project' : 'the project is deleted', ok: !wrong, by: 'checker', how: 'traced' }], fixes: wrong ? ['src/Card.tsx: Delete calls onOpen() instead of onDelete(): call onDelete().'] : [] };
  });
  host.agents = () => [{ plugin, agent: { name: 'fixer', title: 'Fixer', description: 'd', worker: { prompt: 'w' }, checker: { prompt: 'c' } } }];
  host.tools = () => [{ plugin, tool: { name: 'judge', title: 'Judge it', description: 'A check.', checks: true, run: async () => 'Fine\nPASSED' } }];
  const hub = await connect(host);
  const bad = 'export const Delete = () => <button onClick={() => onOpen()}>Delete</button>;\n';
  const good = 'export const Delete = () => <button onClick={() => onDelete()}>Delete</button>;\n';
  try {
    // From the chat: held back when run, with the reason; what was asked went to the planner.
    await hub.call('propose_change', { asked: 'Make Delete delete the project', title: 'Delete', why: 'w', changes: [{ path: 'src/Card.tsx', content: bad }] });
    const direct = await runAsPlanned(host, drafts[0].id);
    assert.match(direct as string, /^Not sent to Review: Logic check: does exactly what was asked did not pass\.[\s\S]*Asked: Make Delete delete the project\nWhat it means:\n1\. Delete deletes the project\nCases tried:\n✗ Click Delete: expected the project is deleted, but it opens the project\nTo fix:\n- src\/Card\.tsx: Delete calls onOpen\(\) instead of onDelete\(\)/);
    const held = proposals.find((p) => p.status === 'held-back');
    assert.ok(held, 'kept as held back');
    assert.deepEqual(held.asked, ['Make Delete delete the project']);
    assert.equal(held.evidence?.find((e) => e.logic)?.logic?.cases[0].ok, false);
    assert.deepEqual(seen[0], { asked: ['Make Delete delete the project'], paths: ['src/Card.tsx'] });
    assert.equal(proposals.filter((p) => p.status === 'proposed').length, 0, 'nothing waiting for approval');
    // A draft: asked is needed to start one; held back too; fixed, it goes, carrying what was asked.
    assert.match((await hub.call('save_draft', { title: 'Delete', why: 'w', changes: [{ path: 'src/Card.tsx', content: bad }] })).text, /Say what the developer asked for/);
    await hub.call('save_draft', { asked: 'Make Delete delete the project', title: 'Delete', why: 'w', changes: [{ path: 'src/Card.tsx', content: bad }] });
    const id = drafts[0].id;
    await hub.call('submit_draft', { id });
    assert.match((await runAsPlanned(host, id)) as string, /^Not sent to Review: Logic check/);
    await hub.call('save_draft', { draft: id, title: 'Delete', why: 'w', changes: [{ path: 'src/Card.tsx', content: good }] });
    await hub.call('submit_draft', { id });
    assert.equal(typeof (await runAsPlanned(host, id)), 'object');
    assert.deepEqual(proposals.find((p) => p.status === 'proposed')?.asked, ['Make Delete delete the project']);
    // An agent: when its checker passes it, it waits for its test cases like any change; run, the mistake is caught.
    await hub.call('job_start', { agent: 'fixer', request: 'Delete should delete' });
    await hub.call('save_draft', { asked: 'x', title: 'Delete again', why: 'w', changes: [{ path: 'src/Card.tsx', content: bad }] });
    const jobDraft = drafts[0].id;
    await hub.call('job_hand_in', { job: jobs[0].id, draft: jobDraft });
    await hub.call('judge', { draft: jobDraft });
    assert.match((await hub.call('job_verdict', { job: jobs[0].id, passed: true })).text, /waits in Review for the developer to look at its test cases/);
    assert.match((await runAsPlanned(host, jobDraft)) as string, /^Not sent to Review: Logic check/);
  } finally {
    await hub.close();
  }
});

test('hub: the developer\'s own cases reach the assistant when sent back, and go with the next try to the check planner', async () => {
  const { host, proposals, drafts, setLogic } = fakeHost();
  const tried: string[][] = [];
  setLogic((d) => {
    tried.push(d.cases ?? []);
    return { passed: true, looksOnly: false, means: ['m'], cases: [{ case: 'c', expected: 'e', found: 'e', ok: true, by: 'checker', how: 'traced' }], fixes: [] };
  });
  const hub = await connect(host);
  try {
    await hub.call('propose_change', { asked: 'Ask before deleting', title: 'Delete', why: 'w', changes: [{ path: 'src/Card.tsx', content: 'v1' }] });
    await runAsPlanned(host, drafts[0].id);
    // The developer added cases and sent it back with a note.
    const p = proposals.find((x) => x.status === 'proposed')!;
    proposals.splice(proposals.indexOf(p), 1, { ...p, status: 'sent-back', cases: ['Enter right away'], evidence: [{ kind: 'check', title: 'Logic check: does exactly what was asked', text: 't', passed: false, by: 'Visual Editor (logic checker)', at: '', revision: 1, logic: { means: ['m'], looksOnly: false, cases: [{ case: 'Enter right away', expected: 'no delete', found: 'deletes', ok: false, by: 'developer', how: 'traced' }], fixes: [] } }], history: [...p.history, { at: '', status: 'sent-back', note: 'Enter must not delete' }] });
    const status = await hub.call('proposal_status', { id: p.id });
    assert.match(status.text, /The developer's note: "Enter must not delete"\nThe developer's own cases \(pass them as cases when you propose again[^\n]*\n- Enter right away\nCases that broke:\n- Enter right away: expected no delete, but deletes\nRevise it/);
    await hub.call('propose_change', { asked: 'Ask before deleting', cases: ['Enter right away'], title: 'Delete', why: 'w', changes: [{ path: 'src/Card.tsx', content: 'v2' }] });
    await runAsPlanned(host, drafts[0].id);
    assert.deepEqual(tried, [[], ['Enter right away']], 'the next try is planned with the developer\'s case');
    assert.deepEqual(proposals.find((x) => x.status === 'proposed')?.cases, ['Enter right away']);
  } finally {
    await hub.close();
  }
});

test('hub: a proposal continued in a design session: Done puts the result back into the same proposal; a failure stays in the session', async () => {
  const { host, proposals, drafts, setLogic } = fakeHost();
  setLogic((d) => {
    const wrong = d.changes.some((c) => c.after?.includes('broken'));
    return { passed: !wrong, looksOnly: false, means: ['Card shows its title'], cases: [{ case: 'The title shows', expected: 'shown', found: wrong ? 'hidden' : 'shown', ok: !wrong, by: 'checker', how: 'traced' }], fixes: wrong ? ['src/Card.tsx: show the title'] : [] };
  });
  const hub = await connect(host);
  const at = '2026-10-25T10:00:00.000Z';
  const original = 'export const Card = () => null;\n';
  try {
    // A proposal waiting in Review, now being changed in a session (its draft starts from the proposal's changes).
    proposals.push({ id: 'p1', title: 'A new Card', why: 'w', asked: ['A new Card'], by: { kind: 'assistant', name: 'Claude Code' }, createdAt: at, status: 'proposed', changes: [{ path: 'src/Card.tsx', before: original, after: 'v1' }], history: [{ at, status: 'proposed' }], session: 'd1' });
    drafts.push({ id: 'd1', title: 'A new Card', why: 'w', by: { kind: 'assistant', name: 'Design session' }, createdAt: at, updatedAt: at, status: 'draft', changes: [{ path: 'src/Card.tsx', before: original, after: 'v1' }], asked: ['A new Card'], revision: 1, evidence: [], session: { proposal: 'p1', openedAt: at } });
    // Claude changes it in the session; a mistake is stopped, and shown in the session (not listed as held back too).
    await hub.call('save_draft', { draft: 'd1', asked: 'Make it bigger', title: 'A new, bigger Card', why: 'w', changes: [{ path: 'src/Card.tsx', content: 'broken' }] });
    // Done: its test cases are written, then run.
    const done = async () => {
      await draftFlow(host).requestChecks(state, 'd1');
      return runAsPlanned(host, 'd1');
    };
    assert.match((await done()) as string, /^Not sent to Review: Logic check/);
    assert.equal(proposals.some((p) => p.status === 'held-back'), false, 'no separate held-back entry for a session');
    assert.deepEqual([proposals.length, proposals[0].changes[0].after, proposals[0].session], [1, 'v1', 'd1'], 'the proposal is as it was, still in the session');
    // Fixed: Done puts it back into the same proposal, waiting again, with its proof and what was asked since.
    await hub.call('save_draft', { draft: 'd1', title: 'A new, bigger Card', why: 'w', changes: [{ path: 'src/Card.tsx', content: 'bigger' }] });
    assert.equal(typeof (await done()), 'object');
    assert.equal(proposals.length, 1, 'no second proposal');
    const p = proposals[0];
    assert.deepEqual([p.id, p.status, p.title, p.changes[0].after, p.changes[0].before, p.session], ['p1', 'proposed', 'A new, bigger Card', 'bigger', original, undefined]);
    assert.deepEqual(p.asked, ['A new Card', 'Make it bigger']);
    assert.equal(p.history.at(-1)?.note, 'Changed in a design session');
    assert.equal(p.evidence?.find((e) => e.logic)?.passed, true);
    assert.deepEqual([drafts[0].status, drafts[0].proposal], ['submitted', 'p1']);
  } finally {
    await hub.close();
  }
});

test('hub: sending a change answers at once; its test cases are written in the background, and nothing runs until the developer does', async () => {
  const { host, proposals, drafts } = fakeHost();
  let release: () => void = () => {};
  const slow = new Promise<void>((r) => (release = r));
  const planned = host.planChecks!;
  let plans = 0;
  host.planChecks = async (...args) => {
    plans++;
    await slow;
    return planned(...args);
  };
  const hub = await connect(host);
  try {
    const first = await hub.call('propose_change', { asked: 'Bigger card', title: 'Card', why: 'w', changes: [{ path: 'src/Card.tsx', content: 'export const Card = () => <b/>;\n' }] });
    const id = drafts[0].id;
    assert.match(first.text, new RegExp(`^Sent\\.[\\s\\S]*call proposal_status with id "${id}"`));
    assert.match((await hub.call('proposal_status', { id })).text, /check planner is writing its test cases/);
    // Sending it again while they're written doesn't start a second planner.
    await hub.call('submit_draft', { id });
    assert.equal(plans, 1);
    release();
    await new Promise((r) => setTimeout(r, 20));
    assert.match((await hub.call('proposal_status', { id })).text, /^Its test cases are written: it waits for the developer to look at them and press Run/);
    assert.equal(proposals[0].status, 'awaiting-checks', 'nothing has run');
    assert.equal(drafts[0].evidence.length, 0);
    await runAsPlanned(host, id);
    assert.match((await hub.call('proposal_status', { id })).text, /^It reached Review as proposal \S+: waiting for review/);
  } finally {
    await hub.close();
  }
});

test('hub: the developer changes the test cases before they run: what they untick doesn\'t run (with why), what they add does', async () => {
  const { host, proposals, drafts, setLogic } = fakeHost();
  const ran: string[] = [];
  host.tools = () => [{ plugin, tool: { name: 'judge', title: 'Judge it', description: 'A check.', checks: true, run: async () => (ran.push('judge'), 'No\nPROBLEMS') } }];
  setLogic((d) => ({ passed: true, looksOnly: false, means: ['m'], cases: (d.cases?.length ? d.cases : ['Planner case']).map((c) => ({ case: c, expected: 'e', found: 'f', ok: c !== 'Breaks it', by: 'checker' as const, how: 'traced' as const })), fixes: [] }));
  const hub = await connect(host);
  try {
    await hub.call('propose_change', { asked: 'Bigger', title: 'Card', why: 'w', changes: [{ path: 'src/Card.tsx', content: 'x' }] });
    const id = drafts[0].id;
    // Unticking needs a reason.
    assert.match((await runAsPlanned(host, id, (p) => ({ ...asItIs(p), checks: { ...asItIs(p).checks, judge: false } }))) as string, /Say why you took out “Judge it”/);
    // Unticked the judge (with why), added a scenario that breaks it: the judge doesn't run, the scenario does.
    const r = await runAsPlanned(host, id, (p) => ({ ...asItIs(p), checks: { ...asItIs(p).checks, judge: false }, added: ['Breaks it'], reason: 'Judge is for something else' }));
    assert.match(r as string, /^Not sent to Review: Logic check[\s\S]*✗ Breaks it/);
    assert.deepEqual(ran, []);
    const proof = drafts[0].evidence.find((e) => e.title === 'Your choices on the checks');
    assert.equal(proof?.text, 'Check skipped: Judge it. Why: Judge is for something else\nScenario added: Breaks it');
    // Sent without any checks (with why): it goes, marked so.
    await hub.call('save_draft', { draft: id, title: 'Card', why: 'w', changes: [{ path: 'src/Card.tsx', content: 'y' }] });
    await hub.call('submit_draft', { id });
    assert.match((await runAsPlanned(host, id, () => ({ checks: {}, cases: [], added: [], skipAll: true }))) as string, /Say why it should go without any checks/);
    assert.equal(typeof (await runAsPlanned(host, id, () => ({ checks: {}, cases: [], added: [], skipAll: true, reason: 'Trying it out' }))), 'object');
    assert.equal(proposals.find((p) => p.status === 'proposed')?.evidence?.find((e) => e.title === 'Your choices on the checks')?.text, 'Sent without any checks, by the developer. Why: Trying it out');
  } finally {
    await hub.close();
  }
});

test('hub: while a design session is open, changes go into it; Claude can open one, or continue a waiting proposal in one', async () => {
  const { host, proposals } = fakeHost();
  let open: { draft: string; title: string } | undefined;
  const started: unknown[] = [];
  host.session = () => open;
  host.startSession = (_root, { card, asked }) => {
    started.push({ card, asked });
    open = { draft: 'd9', title: 'Design session: Card' };
    return { draft: 'd9' };
  };
  host.continueProposal = (_root, id) => (proposals.some((p) => p.id === id) ? { draft: 'd10' } : `No proposal "${id}".`);
  const hub = await connect(host);
  try {
    const opened = await hub.call('start_session', { asked: 'A new look for Card', card: 'Card' });
    assert.match(opened.text, /A design session is open in the developer's editor \(draft d9\)\. Put each change into it with save_draft \(draft: "d9"\)/);
    assert.deepEqual(started, [{ card: 'react:Card', asked: 'A new look for Card' }]);
    assert.match((await hub.call('start_session', { asked: 'x', card: 'Nope' })).text, /No card "Nope"/);
    // While it's open, proposing is turned away, pointing at the session's draft.
    const turned = await hub.call('propose_change', { asked: 'Bigger', title: 't', why: 'w', changes: [{ path: 'src/Card.tsx', content: 'x' }] });
    assert.equal(turned.error, true);
    assert.match(turned.text, /^a design session is open: “Design session: Card”, draft d9\. Put every change for this request into it with save_draft \(draft: "d9"\)/);
    assert.equal(proposals.length, 0);
    // A waiting proposal: changed in a session instead of a replacement.
    open = undefined;
    proposals.push({ id: 'p1', title: 'Dashboard', by: { kind: 'assistant', name: 'Claude Code' }, createdAt: '2026-10-25T10:00:00.000Z', status: 'proposed', changes: [], history: [] });
    assert.match((await hub.call('continue_proposal', { id: 'p1' })).text, /^Proposal p1 is open in a design session \(draft d10\)[\s\S]*goes back into proposal p1/);
    assert.match((await hub.call('continue_proposal', { id: 'zz' })).text, /No proposal "zz"/);
  } finally {
    await hub.close();
  }
});

test('hub: failed checks the developer bypasses (with why) no longer hold the change back, and aren\'t run again', async () => {
  const { host, drafts, proposals } = fakeHost();
  let runs = 0;
  host.runPlannedCases = async () => {
    runs++;
    return { passed: false, looksOnly: false, means: ['m'], cases: [{ case: 'Search hides order-service', expected: 'hidden', found: 'still in the tile', ok: false, by: 'checker' as const, how: 'run' as const }], fixes: ['f'] };
  };
  const { bypassProof, failedChecks, whyFailed } = await import('../src/proposals');
  const hub = await connect(host);
  try {
    await hub.call('save_draft', { asked: 'A dashboard', title: 'Dashboard', why: 'w', changes: [{ path: 'src/Card.tsx', content: 'x' }] });
    const id = drafts[0].id;
    await hub.call('submit_draft', { id });
    assert.match((await runAsPlanned(host, id)) as string, /^Not sent to Review: Logic check/);
    const failed = failedChecks(drafts[0].evidence, drafts[0].revision);
    assert.deepEqual(failed.map((e) => e.title), ['Logic check: does exactly what was asked']);
    assert.equal(whyFailed(failed[0]), '✗ Search hides order-service: expected hidden, but still in the tile');
    // Bypassed by the developer, with why: it goes to Review, the logic check not run again.
    drafts[0] = { ...drafts[0], evidence: bypassProof(drafts[0].evidence, drafts[0].revision, [failed[0].title], 'The tile rightly names it') };
    assert.deepEqual(failedChecks(drafts[0].evidence, drafts[0].revision), []);
    assert.equal(typeof (await runAsPlanned(host, id)), 'object');
    assert.equal(runs, 1);
    const sent = proposals.find((p) => p.status === 'proposed')!;
    assert.deepEqual(sent.evidence?.find((e) => e.logic)?.bypassed?.reason, 'The tile rightly names it');
  } finally {
    await hub.close();
  }
});

test('hub: running a version\'s test cases again tries again what failed before (not just its old result)', async () => {
  const { host, drafts, proposals, setLogic } = fakeHost();
  const broken = (): Verdict => ({ passed: false, looksOnly: false, means: ['m'], cases: [{ case: 'The label stays', expected: 'stays', found: 'gone', ok: false, by: 'checker', how: 'traced' }], fixes: ['f'] });
  setLogic(broken);
  const hub = await connect(host);
  try {
    await hub.call('propose_change', { asked: 'A lasting label', title: 'Search', why: 'w', changes: [{ path: 'src/Card.tsx', content: 'x' }] });
    const id = drafts[0].id;
    assert.match((await runAsPlanned(host, id)) as string, /^Not sent to Review: Logic check/);
    // The same version, its test cases written and run again (now they pass): the old failure doesn't stop it.
    setLogic(passes);
    await draftFlow(host).requestChecks(state, id);
    assert.equal(typeof (await runAsPlanned(host, id)), 'object');
    assert.equal(proposals.find((p) => p.status === 'proposed')?.evidence?.filter((e) => e.title.startsWith('Logic check')).length, 1, 'only the new result');
  } finally {
    await hub.close();
  }
});

test('hub: Claude opens a kind of session (a new page), says what it needs, and gets the kind\'s brief', async () => {
  const { host } = fakeHost();
  const got: unknown[] = [];
  host.sessionKinds = () => [{ id: 'new-page', title: 'New page', summary: 'A new page.', needs: { name: 'Its name', page: true } }];
  host.startSession = (_root, choice) => {
    got.push(choice);
    if (choice.kind === 'new-page' && !choice.page) return 'A "New page" session needs: page.';
    return { draft: 'd5', brief: `This session makes a NEW PAGE, ${choice.name}, at ${choice.page}.` };
  };
  const hub = await connect(host);
  try {
    const tools = await hub.client.listTools();
    assert.match(tools.tools.find((t) => t.name === 'start_session')?.description ?? '', /"new-page" \(New page: A new page\. Needs: name, page\)/);
    assert.match((await hub.call('start_session', { asked: 'A billing page', kind: 'new-page', name: 'Billing' })).text, /needs: page/);
    const opened = await hub.call('start_session', { asked: 'A billing page', kind: 'new-page', name: 'Billing', page: '/billing' });
    assert.match(opened.text, /\(draft d5\)[\s\S]*\nThis session makes a NEW PAGE, Billing, at \/billing\.$/);
    assert.deepEqual(got.at(-1), { asked: 'A billing page', kind: 'new-page', name: 'Billing', page: '/billing' });
  } finally {
    await hub.close();
  }
});

test('hub: while the checks run, each one\'s state is kept (for the live list): a failed check stops the scenarios', async () => {
  const { host, drafts } = fakeHost();
  let verdict = 'PROBLEMS';
  host.tools = () => [{ plugin, tool: { name: 'judge', title: 'Judge it', description: 'A check.', checks: true, run: async () => `x\n${verdict}` } }];
  const seen: string[] = [];
  const save = host.saveDraft;
  host.saveDraft = (root, d) => {
    const running = d.check?.items?.find((i) => i.state === 'running');
    if (running) seen.push(running.id);
    save(root, d);
  };
  const hub = await connect(host);
  try {
    await hub.call('propose_change', { asked: 'Bigger', title: 'Card', why: 'w', changes: [{ path: 'src/Card.tsx', content: 'x' }] });
    const id = drafts[0].id;
    await runAsPlanned(host, id);
    const items = () => drafts.find((d) => d.id === id)!.check!.items!.map((i) => [i.id, i.state]);
    assert.deepEqual(items(), [['check:judge', 'failed'], ['check:pictures', 'not run'], ['case:0', 'not run']]);
    assert.ok(seen.includes('check:judge'), 'it was shown running');
    // Fixed: everything passes.
    verdict = 'PASSED';
    await hub.call('save_draft', { draft: id, title: 'Card', why: 'w', changes: [{ path: 'src/Card.tsx', content: 'y' }] });
    await hub.call('submit_draft', { id });
    await runAsPlanned(host, id);
    assert.deepEqual(items(), [['check:judge', 'passed'], ['check:pictures', 'done'], ['case:0', 'passed']]);
  } finally {
    await hub.close();
  }
});

test('hub: checks that stop before running (the project changed since) hold the change back with why; when up to date they run', async () => {
  const { host, proposals, drafts, files } = fakeHost();
  const hub = await connect(host);
  try {
    await hub.call('propose_change', { asked: 'Bigger', title: 'Card', why: 'w', changes: [{ path: 'src/Card.tsx', content: 'x' }] });
    const id = drafts[0].id;
    // The file changed in the project after the test cases were written: nothing can run, and it says why.
    files['src/Card.tsx'] = 'export const Card = () => 1;\n';
    assert.match((await runAsPlanned(host, id)) as string, /changed in the project since the draft was saved: src\/Card\.tsx/);
    const held = proposals.find((p) => p.id === `held-${id}`);
    assert.equal(held?.status, 'held-back', 'not left waiting under "Checks to approve"');
    assert.match(held?.evidence?.find((e) => e.title === 'Why its checks stopped')?.text ?? '', /src\/Card\.tsx/);
    assert.deepEqual(drafts.find((d) => d.id === id)!.check!.items!.map((i) => i.state), ['not run', 'not run'], 'none of them ran');
    // Saved again on top of the new file: they run, and it reaches Review.
    await hub.call('save_draft', { draft: id, title: 'Card', why: 'w', changes: [{ path: 'src/Card.tsx', content: 'y' }] });
    const sent = await hub.call('submit_draft', { id });
    assert.equal(sent.error, false, sent.text);
    const again = await runAsPlanned(host, id);
    assert.equal(typeof again, 'object', String(again));
    assert.equal(proposals.find((p) => p.status === 'proposed')?.evidence?.some((e) => e.title === 'Why its checks stopped'), false, 'the old reason is gone');
  } finally {
    await hub.close();
  }
});

test('hub: a session is worked in only while its tab is open: a closed one is refused (ask first), open_session opens it; finished ones never', async () => {
  const { host, drafts } = fakeHost();
  const open = new Set<string>();
  const opened: string[] = [];
  host.sessionOpen = (_root, id) => open.has(id);
  host.openSession = (_root, id) => (opened.push(id), open.add(id), undefined);
  const now = new Date().toISOString();
  const session = (id: string, status: Draft['status']): Draft => ({ id, title: `Session ${id}`, why: '', by: { kind: 'assistant', name: 'Design session' }, createdAt: now, updatedAt: now, status, changes: [], revision: 1, evidence: [], session: { openedAt: now }, ...(status === 'submitted' ? { proposal: 'p9' } : {}) });
  drafts.push(session('s1', 'draft'), session('s2', 'discarded'), session('s3', 'submitted'));
  const hub = await connect(host);
  try {
    const change = { title: 'Card', why: 'w', changes: [{ path: 'src/Card.tsx', content: 'export const Card = () => 1;\n' }] };
    // Closed: refused, with what to do.
    const refused = await hub.call('save_draft', { draft: 's1', ...change });
    assert.equal(refused.error, true);
    assert.match(refused.text, /The design session “Session s1” \(draft s1\) is closed: its tab isn't open[\s\S]*Ask the developer whether to open it again \(then call open_session with draft "s1"\), or make this a normal change/);
    assert.match((await hub.call('submit_draft', { id: 's1' })).text, /is closed/);
    // The developer said yes: it opens, and it's worked in.
    assert.match((await hub.call('open_session', { draft: 's1' })).text, /is open in the developer's editor again \(draft s1\)/);
    assert.deepEqual(opened, ['s1']);
    assert.equal((await hub.call('save_draft', { draft: 's1', ...change })).error, false, 'open: saved');
    // Finished ones: never opened to work in, never saved into.
    assert.match((await hub.call('open_session', { draft: 's2' })).text, /That session is finished \(discarded\)/);
    assert.match((await hub.call('open_session', { draft: 's3' })).text, /finished \(sent to Review as proposal p9\)/);
    assert.match((await hub.call('save_draft', { draft: 's2', ...change })).text, /a session the developer discarded/);
    assert.match((await hub.call('open_session', { draft: 'nope' })).text, /No design session with draft "nope"/);
    assert.deepEqual(opened, ['s1']);
  } finally {
    await hub.close();
  }
});
