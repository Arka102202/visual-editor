// The proxy: one local address for an app. Everything the page asks for goes through it:
//   - its pages and code go to the app's dev server; pages get the inspector added (first, before the app's code);
//     the dev server's live-reload socket passes through too;
//   - calls the page makes to other addresses come as /__ve/x/<origin>/<path> (the inspector sends them here) and go
//     on to that address;
//   - every call the page makes is recorded (and, in later steps, can be faked).
// It listens on this computer only. No VS Code APIs, so it can be tested.

import { createServer, request as httpRequest, Agent as HttpAgent, type IncomingMessage, type Server, type ServerResponse, type IncomingHttpHeaders } from 'node:http';
import { request as httpsRequest, Agent as HttpsAgent } from 'node:https';
import { connect, type Socket } from 'node:net';
import { CALL_HEADER, INSPECTOR, VE_PATH } from './inspector';
import { patch, type Decision, type Fakes } from './fakes';

/** One call the page made (or a file it loaded), as recorded. */
export interface Recorded {
  id: number;
  /** When it started (ms since 1970). */
  at: number;
  method: string;
  /** The address as the page asked for it (for calls to other addresses, that address). */
  url: string;
  /** api: a call the page made; page: an HTML page; file: code, styles, pictures… */
  kind: 'api' | 'page' | 'file';
  status?: number;
  ms?: number;
  requestHeaders: Record<string, string>;
  responseHeaders?: Record<string, string>;
  /** Bodies of calls (text, up to MAX_BODY), not of files. */
  requestBody?: string;
  responseBody?: string;
  error?: string;
  /** The fake that answered (or changed the answer): the endpoint's id and the case's name. */
  faked?: { endpoint: string; case: string };
}

/** How much of a body is kept. */
const MAX_BODY = 512 * 1024;
/** How many calls are kept (the oldest go first). */
const MAX_RECORDS = 1000;
const FILE = /^\/(@|node_modules\/|__vite|src\/)|\.(m?[jt]sx?|css|scss|less|map|svg|png|jpe?g|gif|webp|avif|ico|woff2?|ttf|otf|eot|json|wasm|mp4|webm|mp3|txt)(\?|$)/;

/** Agents of their own: not VS Code's (which may send requests for this computer to a corporate proxy). */
const httpAgent = new HttpAgent({ keepAlive: true });
const httpsAgent = new HttpsAgent({ keepAlive: true });

export class AppProxy {
  private server: Server | undefined;
  private next = 1;
  readonly records: Recorded[] = [];
  private readonly listeners = new Set<(r: Recorded) => void>();
  /** Its address (http://127.0.0.1:<port>), once started. */
  origin: string | undefined;
  /** Sockets passed through (live reload): closed with the proxy. */
  private readonly sockets = new Set<Socket>();

  constructor(
    /** Where the app's dev server answers (found or started when first needed). */
    private readonly devOrigin: () => Promise<string>,
    private readonly options: {
      /** The project's fakes (what to answer instead of the backend). */
      fakes?: () => Fakes | undefined;
      /** Headers added to every call the page makes (a token, a cookie), kept out of the project's files. */
      headers?: () => Record<string, string>;
    } = {},
  ) {}

  /** Calls back for each call recorded (when it has its answer). */
  onRecord(listener: (r: Recorded) => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  /** Starts listening (on this computer only) on the first free port from `from`; returns its address. */
  async start(from = 5400): Promise<string> {
    if (this.origin) return this.origin;
    const server = createServer((req, res) => void this.handle(req, res));
    server.on('upgrade', (req, socket, head) => void this.upgrade(req, socket as Socket, head));
    for (let port = from; port < from + 100; port++) {
      const ok = await new Promise<boolean>((resolve) => {
        server.once('error', () => resolve(false));
        server.listen(port, '127.0.0.1', () => resolve(true));
      });
      if (ok) {
        this.server = server;
        this.origin = `http://127.0.0.1:${port}`;
        return this.origin;
      }
    }
    throw new Error(`No free port for the proxy between ${from} and ${from + 99}.`);
  }

  async stop() {
    const server = this.server;
    this.server = undefined;
    this.origin = undefined;
    // Open connections (browsers keep them alive) and passed-through sockets close too, or closing would wait for them.
    server?.closeAllConnections();
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const path = req.url ?? '/';
    if (path === `${VE_PATH}/inspector.js`) {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
      res.end(INSPECTOR);
      return;
    }
    let target: URL;
    let shown: string;
    const routed = path.startsWith(`${VE_PATH}/x/`) ? /^\/__ve\/x\/([^/]+)(\/.*)?$/.exec(path) : null;
    try {
      if (routed) {
        const origin = decodeURIComponent(routed[1]);
        target = new URL((routed[2] ?? '/') || '/', origin);
        shown = target.href;
      } else {
        target = new URL(path, await this.devOrigin());
        shown = path;
      }
    } catch (e) {
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(`Visual Editor couldn't reach the app: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    const isCall = !!req.headers[CALL_HEADER] || !!routed;
    const wantsPage = !isCall && req.method === 'GET' && /text\/html/.test(String(req.headers.accept ?? ''));
    const record: Recorded = {
      id: this.next++,
      at: Date.now(),
      method: req.method ?? 'GET',
      url: shown,
      kind: isCall ? 'api' : wantsPage ? 'page' : FILE.test(path) ? 'file' : 'api',
      requestHeaders: flat(req.headers),
    };
    const started = performance.now();
    // The request's body (kept for calls).
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks);
    if (record.kind === 'api' && body.length) record.requestBody = text(body);
    // A fake may answer it, change the answer, or fail it.
    const decision: Decision = record.kind === 'api' ? (this.options.fakes?.()?.decide(record.method, target.pathname, routed ? target.origin : undefined) ?? { kind: 'pass' }) : { kind: 'pass' };
    if (decision.kind !== 'pass') record.faked = { endpoint: decision.endpoint.id, case: decision.name };
    if (decision.kind === 'answer' || decision.kind === 'fail') {
      if (decision.delay) await new Promise((r) => setTimeout(r, decision.delay));
      if (decision.kind === 'fail') {
        record.error = 'failed on purpose (a fake): the connection dropped';
        record.ms = Math.round(performance.now() - started);
        this.keep(record);
        req.socket.destroy();
        return;
      }
      res.writeHead(decision.status, { ...decision.headers, 'content-length': String(decision.body.length) });
      res.end(decision.body);
      record.status = decision.status;
      record.responseHeaders = decision.headers;
      record.responseBody = text(decision.body);
      record.ms = Math.round(performance.now() - started);
      this.keep(record);
      return;
    }
    const headers: Record<string, string | string[] | undefined> = { ...req.headers, host: target.host };
    delete headers[CALL_HEADER];
    // The developer's own headers (a token, a cookie) on every call the page makes.
    if (record.kind === 'api') for (const [k, v] of Object.entries(this.options.headers?.() ?? {})) headers[k.toLowerCase()] = v;
    // Plain bodies (to add the inspector to pages, and to keep what calls answered).
    delete headers['accept-encoding'];
    if (routed) {
      // The other address sees its own origin, as if the page had called it directly.
      if (headers.origin) headers.origin = target.origin;
      if (headers.referer) headers.referer = target.origin + '/';
    }
    const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
    const upstream = send(
      target,
      {
        method: req.method,
        headers,
        agent: target.protocol === 'https:' ? httpsAgent : httpAgent,
        // A backend on this computer often has a certificate of its own making.
        ...(target.protocol === 'https:' && /^(localhost|127\.|\[::1\])/.test(target.hostname) ? { rejectUnauthorized: false } : {}),
      },
      async (answer) => {
        const out: Record<string, string | string[] | undefined> = { ...answer.headers };
        // Cookies the other address sets belong to the proxy's address now (the page reaches it through here).
        if (routed && out['set-cookie']) out['set-cookie'] = ([] as string[]).concat(out['set-cookie']).map((c) => c.replace(/;\s*domain=[^;]*/gi, '').replace(/;\s*secure/gi, '').replace(/;\s*samesite=none/gi, '; SameSite=Lax'));
        const isHtml = /text\/html/.test(String(answer.headers['content-type'] ?? ''));
        if (record.kind === 'page' && !isHtml) record.kind = 'file';
        const keep = record.kind === 'api' || (record.kind === 'page' && isHtml);
        if (!keep) {
          res.writeHead(answer.statusCode ?? 502, out);
          answer.pipe(res);
          answer.on('end', () => this.done(record, answer, started));
          return;
        }
        const parts: Buffer[] = [];
        for await (const c of answer) parts.push(c as Buffer);
        let payload = Buffer.concat(parts);
        let status = answer.statusCode ?? 502;
        // A fake that changes the real answer: its status, headers, some fields, a delay.
        if (decision.kind === 'change') {
          if (decision.status) status = decision.status;
          if (decision.headers) Object.assign(out, decision.headers);
          if (decision.patch) {
            try {
              payload = Buffer.from(JSON.stringify(patch(JSON.parse(payload.toString('utf8')), decision.patch)));
              delete out['transfer-encoding'];
              out['content-length'] = String(payload.length);
            } catch {
              // Not JSON: left as it is.
            }
          }
          if (decision.delay) await new Promise((r) => setTimeout(r, decision.delay));
        }
        if (record.kind === 'page' && isHtml) {
          payload = Buffer.from(withInspector(payload.toString('utf8')));
          // Sent whole now, with its new length (not in chunks).
          delete out['transfer-encoding'];
          out['content-length'] = String(payload.length);
        } else record.responseBody = text(payload);
        res.writeHead(status, out);
        res.end(payload);
        this.done(record, answer, started, status);
      },
    );
    upstream.on('error', (e) => {
      record.error = e.message;
      record.ms = Math.round(performance.now() - started);
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(`Visual Editor couldn't reach ${target.origin}: ${e.message}`);
      this.keep(record);
    });
    upstream.end(body);
  }

  private done(record: Recorded, answer: IncomingMessage, started: number, status = answer.statusCode) {
    record.status = status;
    record.responseHeaders = flat(answer.headers);
    record.ms = Math.round(performance.now() - started);
    this.keep(record);
  }

  private keep(record: Recorded) {
    this.records.push(record);
    if (this.records.length > MAX_RECORDS) this.records.splice(0, this.records.length - MAX_RECORDS);
    for (const l of this.listeners) l(record);
  }

  /** A socket (the dev server's live reload): passed straight through to the dev server. */
  private async upgrade(req: IncomingMessage, socket: Socket, head: Buffer) {
    let origin: URL;
    try {
      origin = new URL(await this.devOrigin());
    } catch {
      socket.destroy();
      return;
    }
    const upstream = connect({ host: origin.hostname.replace(/^\[|\]$/g, ''), port: Number(origin.port) || 80 }, () => {
      const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const name = req.rawHeaders[i];
        lines.push(`${name}: ${name.toLowerCase() === 'host' ? origin.host : req.rawHeaders[i + 1]}`);
      }
      upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (head.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    // Both ends close together.
    const close = () => {
      upstream.destroy();
      socket.destroy();
      this.sockets.delete(socket);
      this.sockets.delete(upstream);
    };
    this.sockets.add(socket);
    this.sockets.add(upstream);
    for (const end of [upstream, socket]) {
      end.on('error', close);
      end.on('close', close);
    }
  }
}

/** A page with the inspector added first in its <head> (before the app's own scripts). */
export function withInspector(html: string): string {
  const tag = `<script src="${VE_PATH}/inspector.js"></script>`;
  if (html.includes(tag)) return html;
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => `${m}\n    ${tag}`);
  if (/<html[^>]*>/i.test(html)) return html.replace(/<html[^>]*>/i, (m) => `${m}<head>${tag}</head>`);
  return `${tag}\n${html}`;
}

function flat(headers: IncomingHttpHeaders): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : String(v ?? '')]));
}

/** A body as text, when it is text (up to MAX_BODY). */
function text(body: Buffer): string {
  const slice = body.subarray(0, MAX_BODY);
  // Pictures and other binary: just their size.
  if (slice.includes(0)) return `(${body.length} bytes of binary data)`;
  return slice.toString('utf8') + (body.length > MAX_BODY ? `\n… (${body.length - MAX_BODY} more bytes)` : '');
}
