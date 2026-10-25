import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { decideFake, glance, runCase, startUrl } from '../src/caseRunner';
import { findChrome } from '../src/pictures';

// A tiny page: a theme toggle that (on purpose) only works in dark mode, a search box, and a list.
const PAGE = `<!doctype html><html data-theme="light"><head><meta charset="utf-8"></head><body>
<button id="t" aria-label="Switch to dark mode">🌙</button>
<label>Search <input id="q"></label><ul id="list"><li>apple</li><li>banana</li></ul>
<script>
const t = document.getElementById('t');
t.onclick = () => { const dark = document.documentElement.dataset.theme === 'dark'; if (!dark) return; document.documentElement.dataset.theme = 'light'; t.setAttribute('aria-label', 'Switch to dark mode'); };
document.getElementById('q').oninput = (e) => { for (const li of document.querySelectorAll('li')) li.hidden = !li.textContent.includes(e.target.value); };
</script></body></html>`;

test('cases run for real: steps on the page, then what should be seen; a broken click is caught', { skip: !findChrome() && 'no Chrome here' }, async () => {
  const server = createServer((_req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end(PAGE));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    // The toggle, clicked in light mode: should turn dark; it doesn't.
    const toggle = await runCase(`${origin}/`, { where: 'app', page: '/', steps: [{ do: 'click', target: { role: 'button', name: 'Switch to dark mode' } }], expect: [{ attr: { target: { selector: 'html' }, name: 'data-theme', value: 'dark' } }] });
    assert.deepEqual(toggle, { ok: false, ran: true, found: 'clicked the button “Switch to dark mode”: “html” has data-theme="light", not "dark"', after: '🌙 Search apple banana' });
    // Typing filters the list.
    const search = await runCase(`${origin}/`, { where: 'app', page: '/', steps: [{ do: 'type', target: { role: 'textbox', name: 'Search' }, text: 'ban' }], expect: [{ see: 'banana' }, { notSee: 'apple' }] });
    assert.deepEqual(search, { ok: true, ran: true, found: 'typed “ban” into the box “Search”: “banana” is shown; “apple” isn\'t shown' });
    // Only text that should have been shown and wasn't: which, so it can be told apart from a page that broke.
    const absent = await runCase(`${origin}/`, { where: 'app', page: '/', steps: [], expect: [{ see: 'cherry' }, { see: 'apple' }] });
    assert.deepEqual(absent, { ok: false, ran: true, found: '“cherry” isn\'t shown', missing: ['cherry'], after: '🌙 Search apple banana' });
    // Looking in one part of the page: the search box's label says "Search", the list doesn't.
    const within = await runCase(`${origin}/`, { where: 'app', page: '/', steps: [], expect: [{ notSee: 'Search', within: { selector: '#list' } }, { see: 'banana', within: { selector: '#list' } }] });
    assert.deepEqual(within, { ok: true, ran: true, found: '“Search” isn\'t shown in “#list”; “banana” is shown in “#list”' });
    const nowhere = await runCase(`${origin}/`, { where: 'app', page: '/', steps: [], expect: [{ notSee: 'Search' }] });
    assert.equal(nowhere.found, '“Search” is still shown', 'the whole page: it is');
    // Something that isn't there (on a page that's fine): nothing was tried.
    const missing = await runCase(`${origin}/`, { where: 'app', page: '/', steps: [{ do: 'click', target: { role: 'button', name: 'Delete' } }], expect: [] });
    assert.deepEqual(missing, { ok: false, ran: false, found: 'couldn\'t find the button “Delete” on the page (buttons: "Switch to dark mode"; links: none)' });
    // What a page has on it, for the checker to name.
    const [shows] = await glance([`${origin}/`]);
    assert.equal(shows.text, '🌙 Search apple banana');
    assert.equal(shows.line, 'buttons: "Switch to dark mode"; links: none; boxes: "Search"; <html data-theme="light">; text: "🌙 Search apple banana"');
  } finally {
    server.close();
  }
});

test('cases run for real: where a case starts', () => {
  assert.equal(startUrl('http://a', { where: 'playground', card: 'react:component:src/A/index.tsx#A', design: 'compact', state: 'empty', steps: [], expect: [] }), 'http://a/__ve/preview?item=react%3Acomponent%3Asrc%2FA%2Findex.tsx%23A&variant=compact&state=empty');
  assert.equal(startUrl('http://a', { where: 'app', page: 'settings', steps: [], expect: [] }), 'http://a/settings');
});

test('cases run for real: a case\'s fake API answers', () => {
  const fakes = [{ method: 'GET', path: '/api/orders/:id', status: 500, body: { error: 'down' } }, { method: '*', path: '/api/slow', network: true, delay: 99_999 }];
  const answer = decideFake(fakes, 'get', '/api/orders/7?x=1');
  assert.ok(answer?.kind === 'answer');
  assert.deepEqual([answer.status, answer.body.toString(), answer.headers['content-type']], [500, '{"error":"down"}', 'application/json; charset=utf-8']);
  const fail = decideFake(fakes, 'POST', '/api/slow');
  assert.ok(fail?.kind === 'fail');
  assert.equal(fail.delay, 30_000);
  assert.equal(decideFake(fakes, 'POST', '/api/orders/7'), undefined, 'another method: the project\'s own fakes decide');
});
