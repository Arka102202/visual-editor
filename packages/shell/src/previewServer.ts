// Serves preview pages (HTML a plugin gave) on this computer only, each at an address nobody can guess. A page served
// this way runs in its own frame, apart from VS Code and from the other pages, so its scripts can't reach anything.
// No VS Code APIs here, so it can be tested on its own.

import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/** Pages kept at once; older ones are dropped (a preview is redrawn often). */
const KEEP = 40;

export class PreviewServer {
  private server: Server | undefined;
  private port = 0;
  private readonly pages = new Map<string, string>();

  async start(): Promise<void> {
    if (this.server) return;
    const server = createServer((req, res) => {
      const id = /^\/p\/([a-f0-9]{32})$/.exec(req.url ?? '')?.[1];
      const html = id ? this.pages.get(id) : undefined;
      if (req.method !== 'GET' || html === undefined) {
        res.writeHead(404, { 'content-type': 'text/plain' }).end('This preview is gone. Reload it.');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }).end(html);
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    this.server = server;
    this.port = (server.address() as AddressInfo).port;
  }

  /** Puts a page up and gives its address. */
  host(html: string): string {
    if (!this.server) throw new Error('The preview server is not running.');
    const id = randomBytes(16).toString('hex');
    this.pages.set(id, html);
    while (this.pages.size > KEEP) this.pages.delete(this.pages.keys().next().value!);
    return `http://127.0.0.1:${this.port}/p/${id}`;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    this.pages.clear();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
