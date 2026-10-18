import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CONTRACT_VERSION, type Plugin } from '@visual-editor/contract';
import { startHttpHost } from '../src/hub/http';
import { createHubServer, type HubHost } from '../src/hub/tools';
import type { MemoryEntry } from '../src/memory';
import type { ProjectState } from '../src/projectIndex';
import type { Proposal } from '../src/proposals';

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
  const memory: MemoryEntry[] = [{ id: 'r', at: '2026-10-18T00:00:00.000Z', kind: 'rule', text: 'Use theme colours', by: { kind: 'developer', name: 'You' } }];
  const files: Record<string, string> = { 'src/Card.tsx': 'export const Card = () => null;\n' };
  const host: HubHost = {
    projects: () => [state],
    current: () => state,
    whenReady: async () => {},
    proposals: () => proposals,
    memory: () => memory,
    readFile: async (_root, path) => files[path],
    propose: (_root, p) => void proposals.unshift(p),
    remember: (_root, e) => void memory.unshift(e),
  };
  return { host, proposals, memory };
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
    assert.deepEqual(tools, ['card', 'list_cards', 'memory', 'overview', 'proposal_status', 'propose_change', 'remember']);
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
