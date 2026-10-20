import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { connect } from 'node:net';
import { AppProxy, withInspector } from '../src/proxy/proxy';
import { CALL_HEADER } from '../src/proxy/inspector';

/** A server on a free port of this computer; returns its address. */
function serve(server: Server): Promise<string> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`)));
}

/** A dev server: a page, code, an API it answers itself, and a live-reload socket that echoes. */
const dev = createServer((req, res) => {
  if (req.url === '/') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><html><head><title>App</title><script type="module" src="/main.js"></script></head><body></body></html>');
  } else if (req.url === '/main.js') {
    res.writeHead(200, { 'content-type': 'text/javascript' });
    res.end('console.log("app")');
  } else if (req.url?.startsWith('/api/orders')) {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ orders: [{ id: 1 }], got: body || null }));
    });
  } else {
    res.writeHead(404);
    res.end();
  }
});
dev.on('upgrade', (_req, socket) => {
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
  socket.on('data', (d) => socket.write(`echo:${d}`));
});
/** A backend at another address, which sets a cookie for its own domain. */
const backend = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'session=abc; Domain=api.local; Path=/; Secure; SameSite=None' });
  res.end(JSON.stringify({ items: ['a', 'b'], path: req.url, origin: req.headers.origin ?? null }));
});

test('proxy: pages get the inspector first, calls are recorded, other addresses are routed through it, sockets pass', async () => {
  const devOrigin = await serve(dev);
  const backendOrigin = await serve(backend);
  const proxy = new AppProxy(async () => devOrigin);
  const origin = await proxy.start(5600);
  try {
    // The page, with the inspector before the app's own script.
    const page = await (await fetch(`${origin}/`, { headers: { accept: 'text/html' } })).text();
    assert.ok(page.indexOf('/__ve/inspector.js') < page.indexOf('/main.js'), 'the inspector comes first');
    const inspector = await fetch(`${origin}/__ve/inspector.js`);
    assert.match(await inspector.text(), /window\.fetch = function/);
    // A file: passed through, not kept.
    assert.equal(await (await fetch(`${origin}/main.js`)).text(), 'console.log("app")');
    // A call the page makes (marked by the inspector), with its body.
    const answer = await (await fetch(`${origin}/api/orders?x=1`, { method: 'POST', body: '{"n":2}', headers: { [CALL_HEADER]: '1', 'content-type': 'application/json' } })).json();
    assert.equal(answer.got, '{"n":2}');
    // A call to another address, routed through the proxy.
    const routed = await fetch(`${origin}/__ve/x/${encodeURIComponent(backendOrigin)}/v1/items?q=1`, { headers: { origin } });
    const items = await routed.json();
    assert.deepEqual(items.items, ['a', 'b']);
    assert.equal(items.path, '/v1/items?q=1');
    assert.equal(items.origin, backendOrigin, 'the backend sees its own origin');
    const cookie = routed.headers.get('set-cookie') ?? '';
    assert.doesNotMatch(cookie, /Domain=/i, 'the cookie now belongs to the proxy’s address');
    assert.doesNotMatch(cookie, /Secure/i);
    // What was recorded.
    const kinds = proxy.records.map((r) => `${r.kind} ${r.method} ${r.url}`);
    assert.ok(kinds.includes('page GET /'));
    assert.ok(kinds.includes('file GET /main.js'));
    assert.ok(kinds.includes('api POST /api/orders?x=1'));
    assert.ok(kinds.includes(`api GET ${backendOrigin}/v1/items?q=1`));
    const call = proxy.records.find((r) => r.url === '/api/orders?x=1')!;
    assert.equal(call.requestBody, '{"n":2}');
    assert.match(call.responseBody!, /"orders"/);
    assert.equal(call.status, 200);
    assert.equal(proxy.records.find((r) => r.url === '/main.js')!.responseBody, undefined, 'files aren’t kept');
    // The dev server's live-reload socket passes straight through.
    const port = Number(new URL(origin).port);
    const echoed = await new Promise<string>((resolve, reject) => {
      const s = connect(port, '127.0.0.1', () => s.write('GET /hmr HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n'));
      let got = '';
      s.on('data', (d) => {
        got += String(d);
        if (got.includes('101') && !got.includes('echo:')) s.write('ping');
        if (got.includes('echo:ping')) {
          s.destroy();
          resolve(got);
        }
      });
      s.on('error', reject);
    });
    assert.match(echoed, /101 Switching Protocols/);
  } finally {
    await proxy.stop();
    dev.closeAllConnections();
    backend.closeAllConnections();
    dev.close();
    backend.close();
  }
});

test('proxy: the inspector goes first in <head>, or makes one', () => {
  assert.match(withInspector('<html><head><title>x</title></head></html>'), /<head>\n {4}<script src="\/__ve\/inspector\.js"><\/script><title>/);
  assert.match(withInspector('<html><body>x</body></html>'), /<html><head><script src="\/__ve\/inspector\.js"><\/script><\/head><body>/);
  const once = withInspector('<head></head>');
  assert.equal(withInspector(once), once, 'never twice');
});
