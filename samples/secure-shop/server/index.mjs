// The secure shop's dev backend: a fake login that accepts any password, protecting each part a different way, so
// every common kind of web security has a working example (see README.md). Plain Node, no packages.
//   node server/index.mjs        (listens on 127.0.0.1:4600; Vite sends /api and /files here)

import { createServer } from 'node:http';
import { createHmac, randomBytes } from 'node:crypto';

const SECRET = 'dev-only-secret';
const PORT = Number(process.env.PORT ?? 4600);
const API_KEY = 'catalog-dev-key';
const BASIC = Buffer.from('ops:ops').toString('base64');
const ACCESS_SECONDS = 60;

// ---- tokens: "JWT-like" signed strings (header.payload.signature), enough for a demo
const sign = (payload) => {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `ve.${body}.${createHmac('sha256', SECRET).update(body).digest('base64url')}`;
};
const verify = (token) => {
  const [, body, sig] = String(token ?? '').split('.');
  if (!body || createHmac('sha256', SECRET).update(body).digest('base64url') !== sig) return undefined;
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
  return payload.exp && payload.exp < Date.now() / 1000 ? undefined : payload;
};

// ---- people: any email logs in; the email decides the role and plan, so every case can be tried
const userFor = (email) => ({
  id: `u-${Buffer.from(email).toString('hex').slice(0, 8)}`,
  name: email.split('@')[0].replace(/^./, (c) => c.toUpperCase()),
  email,
  role: email.startsWith('admin') ? 'admin' : email.startsWith('staff') ? 'staff' : 'customer',
  plan: email.includes('pro') ? 'pro' : 'free',
});
const sessions = new Map(); // sid → user (A1: server-side session)
const refreshTokens = new Map(); // rt → user (A4)
const magicCodes = new Map(); // email → code (A9)
const twoFactor = new Set(); // users who passed 2FA in the last minute (A10)

const orders = [
  { id: 'A-1001', status: 'paid', total: 129.5, placedAt: '2026-10-01T10:00:00Z', items: [{ sku: 'TEA-1', name: 'Green tea', quantity: 2, price: 12.5 }], customer: { id: 'c1', name: 'Grace Hopper', email: 'grace@example.com', role: 'customer' } },
  { id: 'A-1002', status: 'shipped', total: 48, placedAt: '2026-10-03T15:30:00Z', items: [{ sku: 'MUG-2', name: 'Blue mug', quantity: 1, price: 48 }], customer: { id: 'c2', name: 'Alan Turing', email: 'alan@example.com', role: 'customer' } },
];

// ---- helpers
const cookies = (req) => Object.fromEntries((req.headers.cookie ?? '').split(/;\s*/).filter(Boolean).map((c) => c.split('=').map(decodeURIComponent)));
const cookie = (name, value, extra = '') => `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax${extra}`;
const send = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
};
const readBody = (req) =>
  new Promise((resolve) => {
    let text = '';
    req.on('data', (d) => (text += d));
    req.on('end', () => {
      try {
        resolve(text ? JSON.parse(text) : {});
      } catch {
        resolve({});
      }
    });
  });
/** Who is calling, by any of the ways this backend accepts. */
const bearerUser = (req) => verify((req.headers.authorization ?? '').replace(/^Bearer /, ''))?.user;
const sessionUser = (req) => sessions.get(cookies(req).sid);
const jwtCookieUser = (req) => verify(cookies(req).jwt)?.user;

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  const path = url.pathname;
  const m = req.method;
  const c = cookies(req);

  // C21: the login form must carry a solved CAPTCHA (any non-empty token from the widget).
  if (m === 'POST' && path === '/api/login') {
    const { email, captcha } = await readBody(req);
    if (!captcha) return send(res, 400, { error: 'Please solve the CAPTCHA' });
    if (!email) return send(res, 400, { error: 'Email needed' });
    const user = userFor(email);
    const sid = randomBytes(16).toString('hex');
    const rt = randomBytes(16).toString('hex');
    sessions.set(sid, user);
    refreshTokens.set(rt, user);
    const access = sign({ user, exp: Math.floor(Date.now() / 1000) + ACCESS_SECONDS });
    return send(res, 200, { user, accessToken: access }, {
      // A1 session cookie · A2 JWT in an HttpOnly cookie · A4 refresh token cookie · C19 SameSite=Lax
      'set-cookie': [cookie('sid', sid), cookie('jwt', sign({ user })), cookie('rt', rt, '; Path=/api/refresh')],
    });
  }
  // A9: magic link / one-time code
  if (m === 'POST' && path === '/api/magic') {
    const { email } = await readBody(req);
    const code = String(100000 + Math.floor(Math.random() * 900000));
    magicCodes.set(email, code);
    return send(res, 200, { sent: true, devCode: code });
  }
  if (m === 'POST' && path === '/api/magic/verify') {
    const { email, code } = await readBody(req);
    if (magicCodes.get(email) !== code) return send(res, 401, { error: 'Wrong code' });
    const user = userFor(email);
    const sid = randomBytes(16).toString('hex');
    sessions.set(sid, user);
    return send(res, 200, { user, accessToken: sign({ user, exp: Math.floor(Date.now() / 1000) + ACCESS_SECONDS }) }, { 'set-cookie': [cookie('sid', sid), cookie('jwt', sign({ user }))] });
  }
  // A4: a short access token, renewed with the refresh cookie
  if (m === 'POST' && path === '/api/refresh') {
    const user = refreshTokens.get(c.rt);
    if (!user) return send(res, 401, { error: 'Please log in again' });
    return send(res, 200, { accessToken: sign({ user, exp: Math.floor(Date.now() / 1000) + ACCESS_SECONDS }) });
  }
  if (m === 'POST' && path === '/api/logout') {
    sessions.delete(c.sid);
    refreshTokens.delete(c.rt);
    return send(res, 200, { ok: true }, { 'set-cookie': [cookie('sid', '', '; Max-Age=0'), cookie('jwt', '', '; Max-Age=0'), cookie('rt', '', '; Path=/api/refresh; Max-Age=0')] });
  }
  // A1: who am I, from the session cookie
  if (m === 'GET' && path === '/api/me') {
    const user = sessionUser(req);
    return user ? send(res, 200, user) : send(res, 401, { error: 'Not logged in' });
  }
  // C17: a CSRF token (also in a readable cookie, the "double submit" way)
  if (m === 'GET' && path === '/api/csrf') {
    const token = randomBytes(12).toString('hex');
    return send(res, 200, { csrfToken: token }, { 'set-cookie': `csrf=${token}; Path=/; SameSite=Lax` });
  }
  // A3 + C20: orders need the Bearer access token (expires after a minute: 401, then the app refreshes)
  if (m === 'GET' && path === '/api/orders') {
    const user = bearerUser(req);
    if (!user) return send(res, 401, { error: 'Token missing or expired' });
    return send(res, 200, { items: orders, total: orders.length, nextCursor: null });
  }
  if (m === 'GET' && path.startsWith('/api/orders/')) {
    if (!bearerUser(req)) return send(res, 401, { error: 'Token missing or expired' });
    const order = orders.find((o) => o.id === path.split('/')[3]);
    return order ? send(res, 200, order) : send(res, 404, { error: 'No such order' });
  }
  // C17: changing something needs the CSRF header to match the cookie, plus the session
  if (m === 'POST' && /^\/api\/orders\/[^/]+\/cancel$/.test(path)) {
    if (!sessionUser(req)) return send(res, 401, { error: 'Not logged in' });
    if (!c.csrf || req.headers['x-csrf-token'] !== c.csrf) return send(res, 403, { error: 'CSRF check failed' });
    return send(res, 200, { id: path.split('/')[3], status: 'cancelled' });
  }
  // A2: notifications read the JWT from its HttpOnly cookie
  if (m === 'GET' && path === '/api/notifications') {
    const user = jwtCookieUser(req);
    if (!user) return send(res, 401, { error: 'Not logged in' });
    return send(res, 200, [{ id: 'n1', text: `Welcome back, ${user.name}`, read: false, at: new Date().toISOString() }]);
  }
  // B14: admins only
  if (m === 'GET' && path === '/api/admin/stats') {
    const user = bearerUser(req);
    if (!user) return send(res, 401, { error: 'Not logged in' });
    if (user.role !== 'admin') return send(res, 403, { error: 'Admins only' });
    return send(res, 200, { users: 1280, revenue: 98450.75, refunds: 12, topProduct: { sku: 'TEA-1', name: 'Green tea' } });
  }
  // B15: pro plan only
  if (m === 'GET' && path === '/api/reports') {
    const user = bearerUser(req);
    if (!user) return send(res, 401, { error: 'Not logged in' });
    if (user.plan !== 'pro') return send(res, 402, { error: 'Pro plan needed' });
    return send(res, 200, [{ id: 'r1', title: 'Monthly sales', rows: 31, createdAt: '2026-10-01T00:00:00Z' }]);
  }
  // A5: the catalog needs an API key header
  if (m === 'GET' && path === '/api/catalog') {
    if (req.headers['x-api-key'] !== API_KEY) return send(res, 401, { error: 'API key missing' });
    return send(res, 200, [{ sku: 'TEA-1', name: 'Green tea', price: 12.5, stock: 40 }, { sku: 'MUG-2', name: 'Blue mug', price: 48, stock: 3 }]);
  }
  // A6: an old internal endpoint behind HTTP Basic auth
  if (m === 'GET' && path === '/api/legacy/health') {
    if (req.headers.authorization !== `Basic ${BASIC}`) return send(res, 401, { error: 'Basic auth needed' }, { 'www-authenticate': 'Basic realm="ops"' });
    return send(res, 200, { status: 'ok', uptimeSeconds: 86400 });
  }
  // A10: deleting the account needs a recent second factor
  if (m === 'POST' && path === '/api/2fa/verify') {
    const user = sessionUser(req);
    const { code } = await readBody(req);
    if (!user) return send(res, 401, { error: 'Not logged in' });
    if (code !== '123456') return send(res, 403, { error: 'Wrong code (the demo code is 123456)' });
    twoFactor.add(user.id);
    setTimeout(() => twoFactor.delete(user.id), 60_000);
    return send(res, 200, { ok: true });
  }
  if (m === 'DELETE' && path === '/api/account') {
    const user = sessionUser(req);
    if (!user) return send(res, 401, { error: 'Not logged in' });
    if (!twoFactor.has(user.id)) return send(res, 403, { error: 'Second factor needed', needs2fa: true });
    return send(res, 200, { deleted: true });
  }
  // C22: a signed, expiring download link
  if (m === 'GET' && /^\/api\/invoices\/[^/]+\/link$/.test(path)) {
    if (!sessionUser(req)) return send(res, 401, { error: 'Not logged in' });
    const id = path.split('/')[3];
    const exp = Math.floor(Date.now() / 1000) + 30;
    const sig = createHmac('sha256', SECRET).update(`${id}:${exp}`).digest('hex').slice(0, 16);
    return send(res, 200, { url: `/files/invoices/${id}.pdf?exp=${exp}&sig=${sig}`, expiresAt: new Date(exp * 1000).toISOString() });
  }
  if (m === 'GET' && path.startsWith('/files/invoices/')) {
    const id = path.split('/').pop().replace('.pdf', '');
    const exp = Number(url.searchParams.get('exp'));
    const ok = exp > Date.now() / 1000 && url.searchParams.get('sig') === createHmac('sha256', SECRET).update(`${id}:${exp}`).digest('hex').slice(0, 16);
    if (!ok) return send(res, 403, { error: 'Link expired or invalid' });
    res.writeHead(200, { 'content-type': 'text/plain' });
    return res.end(`Invoice ${id} (a real app would send a PDF)`);
  }
  send(res, 404, { error: 'Not found' });
});

server.listen(PORT, '127.0.0.1', () => console.log(`secure-shop backend on http://127.0.0.1:${PORT}`));
