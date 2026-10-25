import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { PageSession } from '../src/pageSession';
import { findChrome } from '../src/pictures';
import { startHttpHost } from '../src/hub/http';
import { readTester, testerPrompt, testerServer } from '../src/hub/tester';

// A search box whose label is hidden (for screen readers), and a list it filters: like the Dashboard's.
const PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<input id="q" aria-label="Search projects" placeholder="Search projects">
<ul><li>order-service</li><li>payments</li></ul><p id="none" hidden>No projects match</p>
<button id="clear" hidden>Clear search</button>
<script>
const q = document.getElementById('q');
q.oninput = () => { let shown = 0; for (const li of document.querySelectorAll('li')) { li.hidden = !li.textContent.includes(q.value); shown += !li.hidden; } document.getElementById('none').hidden = shown > 0; document.getElementById('clear').hidden = shown > 0; };
document.getElementById('clear').onclick = () => { q.value = ''; q.oninput(); };
</script></body></html>`;

test('tester: its page tools read the page like a person (controls numbered, hidden labels said), type, click and take pictures', { skip: !findChrome() && 'no Chrome here' }, async () => {
  const site = createServer((_req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end(PAGE));
  await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(site.address() as { port: number }).port}/`;
  const page = new PageSession(mkdtempSync(join(tmpdir(), 've-tester-')));
  const http = await startHttpHost({ port: 0, token: 't', makeServer: () => testerServer(page, url) });
  const client = new Client({ name: 'tester', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(http.url), { requestInit: { headers: { Authorization: 'Bearer t' } } }));
  const call = async (name: string, args: Record<string, unknown> = {}) => ((await client.callTool({ name, arguments: args })) as { content: { text: string }[] }).content[0].text;
  try {
    const opened = await call('page_open', { url: '/' });
    assert.match(opened, /Controls \(click or type by number\):\n\[1\] textbox "Search projects" \(placeholder "Search projects", its label is hidden \(screen readers only\)\)/);
    assert.match(opened, /Text on the page:\norder-service\npayments/);
    assert.equal(await call('page_type', { ref: 1, text: 'zzz' }), 'Typed "zzz" into [1].');
    const after = await call('page_read');
    assert.match(after, /\[1\] textbox "Search projects" \(placeholder "Search projects", value "zzz", its label is hidden/, 'the box keeps its label after typing');
    assert.match(after, /\[2\] button "Clear search"/);
    assert.match(after, /No projects match/);
    assert.equal(await call('page_click', { ref: 2 }), 'Clicked [2].');
    assert.match(await call('page_read'), /order-service\npayments/);
    assert.match(await call('page_click', { ref: 9 }), /no control \[9\] now/);
    const pic = /Picture: (\S+)/.exec(await call('page_picture'))![1];
    assert.ok(existsSync(pic));
  } finally {
    await client.close();
    await http.close();
    page.close();
    site.close();
  }
});

test('tester: what it is asked, and its verdict read', () => {
  const prompt = testerPrompt(['A lasting label on the search box'], { case: 'Type: the label stays', expected: 'The label stays', run: { where: 'app', page: '/', steps: [{ do: 'type', target: { role: 'textbox', name: 'Search projects' }, text: 'a' }], expect: [{ see: 'Search projects' }] }, found: '“Search projects” isn\'t shown', url: 'http://a/' });
  assert.match(prompt, /- A lasting label on the search box\n\nThe scenario: Type: the label stays\nIt should: The label stays\nA quick automatic run tried it like this: \{"steps"[\s\S]*and found: “Search projects” isn't shown[\s\S]*page_open at http:\/\/a\//);
  const ok = readTester(JSON.stringify({ result: 'Done.\n{"ok": true, "found": "Typed a; the box still has its label Search projects.", "why": "A label that stays: it does."}', total_cost_usd: 0.01 }));
  assert.deepEqual(ok, { ok: true, found: 'Typed a; the box still has its label Search projects. A label that stays: it does.', cost: 0.01 });
  const already = readTester(JSON.stringify({ result: '{"ok": false, "found": "The toggle needs two clicks.", "why": "w", "already": true}' }));
  assert.deepEqual(already, { ok: false, found: 'The toggle needs two clicks. w', already: true });
  const withBaseline = testerPrompt(['a'], { case: 'c', expected: 'e', run: { where: 'app', page: '/settings', steps: [], expect: [] }, found: 'f', url: 'http://draft/settings', baseline: 'http://real/settings' });
  assert.match(withBaseline, /try the same steps on the app without the change, at http:\/\/real\/settings[\s\S]*"already": true if it goes wrong the same way without the change/);
  assert.match(readTester(JSON.stringify({ result: 'no idea' })) as string, /no clear verdict/);
  assert.match(readTester(JSON.stringify({ is_error: true, result: 'limit' })) as string, /couldn't finish: limit/);
  assert.match(readTester('garbage') as string, /couldn't be read/);
});
