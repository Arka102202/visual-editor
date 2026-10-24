import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CONTRACT_VERSION, type Plugin, type PluginTool } from '@visual-editor/contract';
import { startHttpHost } from '../src/hub/http';
import { createHubServer, type HubHost } from '../src/hub/tools';
import type { MemoryEntry } from '../src/memory';
import type { ProjectState } from '../src/projectIndex';
import type { Proposal } from '../src/proposals';
import { HUB_TOOLS } from '../src/registry';
import type { Draft } from '../src/drafts';

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

function fakeHost() {
  const proposals: Proposal[] = [];
  const drafts: Draft[] = [];
  const memory: MemoryEntry[] = [{ id: 'r', at: '2026-10-18T00:00:00.000Z', kind: 'rule', text: 'Use theme colours', by: { kind: 'developer', name: 'You' } }];
  const files: Record<string, string> = { 'src/Card.tsx': 'export const Card = () => null;\n', 'src/List.tsx': 'export const List = () => null;\n' };
  const host: HubHost = {
    projects: () => [state],
    current: () => state,
    whenReady: async () => {},
    proposals: () => proposals,
    memory: () => memory,
    readFile: async (_root, path) => files[path],
    propose: (_root, p) => void proposals.unshift(p),
    remember: (_root, e) => void memory.unshift(e),
    tools: () => [],
    drafts: () => drafts,
    saveDraft: (_root, d) => void drafts.splice(0, drafts.length, d, ...drafts.filter((x) => x.id !== d.id)),
  };
  return { host, proposals, memory, drafts, files };
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
    assert.deepEqual(tools, ['add_evidence', 'card', 'list_cards', 'memory', 'overview', 'proposal_status', 'propose_change', 'read_draft', 'remember', 'save_draft', 'submit_draft']);
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
  const { host, proposals, memory } = fakeHost();
  const hub = await connect(host);
  try {
    const ok = await hub.call('propose_change', {
      title: 'Add a subtitle to Card',
      why: 'Cards need a second line',
      changes: [
        { path: 'src/Card.tsx', content: 'export const Card = ({ sub }) => sub;\n' },
        { path: 'src/new.ts', content: 'export {};\n' },
      ],
      cards: ['react:Card'],
    });
    assert.equal(ok.error, false, ok.text);
    const p = proposals[0];
    assert.equal(p.status, 'proposed');
    assert.equal(p.by.name, 'Claude Code');
    assert.deepEqual(p.changes.map((c) => [c.path, c.before]), [['src/Card.tsx', 'export const Card = () => null;\n'], ['src/new.ts', null]]);
    assert.deepEqual(p.items, ['react:Card']);

    assert.match((await hub.call('propose_change', { title: 't', why: 'w', changes: [{ path: '../etc/passwd', content: 'x' }] })).text, /outside the project/);
    assert.match((await hub.call('propose_change', { title: 't', why: 'w', changes: [{ path: 'src/Card.tsx', content: 'export const Card = () => null;\n' }] })).text, /would stay the same/);
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
    assert.equal(proposals.length, 0);

    // Plugin tools: with the draft, the project as it would be; without, as it is.
    assert.equal((await hub.call('look', { draft: id })).text, `${id} | src/Card.tsx,src/New.tsx | export const New = 1;\n | export const Card = ({ title }) => title;\n`);
    assert.equal((await hub.call('look')).text, 'no draft | src/Card.tsx,src/List.tsx | undefined | export const Card = () => null;\n');
    assert.match((await hub.call('look', { draft: 'nope' })).text, /No draft "nope"/);

    // Changing it: a file put back as it was leaves the draft; the others stay.
    const again = await hub.call('save_draft', { draft: id, title: 'Card gets a title', why: 'To show it', changes: [{ path: 'src/New.tsx', content: 'export const New = 2;\n' }, { path: 'src/Card.tsx', content: 'export const Card = () => null;\n' }] });
    assert.match(again.text, /2 files \(1 new, 1 removed\)/);
    assert.equal(drafts.length, 1, 'the same draft');
    await hub.call('save_draft', { draft: id, title: 'Card gets a title', why: 'To show it', changes: [{ path: 'src/Card.tsx', content: 'export const Card = ({ title }) => title;\n' }] });

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
    const v2 = await hub.call('save_draft', { draft: id, title: 'Card gets a title', why: 'To show it', changes: [{ path: 'src/New.tsx', content: 'export const New = 3;\n' }] });
    assert.match(v2.text, new RegExp(`version ${version + 1}\\)[\\s\\S]*earlier proof was for the previous version: check it again`));
    assert.match((await hub.call('read_draft', { id })).text, /No proof for this version yet/);
    await hub.call('judge', { draft: id, strict: true });
    assert.equal(drafts[0].evidence.at(-1)?.title, 'Judge it (strict: true)');
    assert.equal(drafts[0].evidence.at(-1)?.passed, false);
    assert.match(drafts[0].evidence.at(-1)!.text, /^export const New = 3;\nPROBLEMS$/, 'the check saw the draft');

    const sent = await hub.call('submit_draft', { id });
    assert.equal(sent.error, false, sent.text);
    assert.match(sent.text, /with its proof \(1\)[\s\S]*Review shows that Judge it \(strict: true\) did not pass/);
    assert.deepEqual(proposals[0].evidence?.map((e) => [e.title, e.passed]), [['Judge it (strict: true)', false]], 'only this version’s proof');
    assert.match((await hub.call('add_evidence', { draft: id, title: 't', text: 'x' })).text, /already in Review/);
    assert.equal(proposals.length, 1);
    assert.deepEqual(proposals[0].changes.map((c) => c.path), ['src/Card.tsx', 'src/List.tsx', 'src/New.tsx']);
    assert.deepEqual(proposals[0].items, ['react:Card']);
    assert.equal(drafts[0].status, 'submitted');
    assert.equal(drafts[0].proposal, proposals[0].id);
    assert.match((await hub.call('submit_draft', { id })).text, /already in Review/);
    assert.match((await hub.call('save_draft', { draft: id, title: 't', why: 'w', changes: [{ path: 'a.ts', content: 'x' }] })).text, /already sent to Review/);
    assert.match((await hub.call('save_draft', { title: 't', why: 'w', changes: [{ path: '.visual-editor/x.json', content: 'x' }] })).text, /isn't a place in the project/);
  } finally {
    await hub.close();
  }
});
