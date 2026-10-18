// The assistant hub's door: serves the MCP server over HTTP on this machine only, behind a secret key.
// Stateless: each request gets a fresh server, which keeps it simple and robust across reconnects.
// No VS Code APIs here, so it can be tested with a real MCP client.

import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export const MCP_PATH = '/mcp';
const MAX_BODY = 1_000_000;

export interface HttpHostOptions {
  /** Preferred port. If it's taken, any free port is used instead (see `portChanged`). */
  port: number;
  token: string;
  /** `client` is the assistant's name when known (e.g. "claude-code"), to sign what it writes. */
  makeServer: (client?: string) => McpServer;
  /** Called when an assistant connects, with the name it gives (e.g. "claude-code"). */
  onClient?: (name: string) => void;
}

export interface HttpHost {
  port: number;
  /** True when the preferred port was taken and another one was used. */
  portChanged: boolean;
  url: string;
  close(): Promise<void>;
}

export async function startHttpHost(opts: HttpHostOptions): Promise<HttpHost> {
  // Stateless: tool calls don't repeat who's calling, so remember the last assistant that said hello.
  let lastClient: string | undefined;
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname !== MCP_PATH) {
        res.writeHead(404).end();
        return;
      }
      // Only this machine, and only with the key (it's stored privately in the assistant's own settings).
      if (req.headers.authorization !== `Bearer ${opts.token}`) {
        res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'Missing or wrong key. Reconnect from VS Code: Visual Editor: Connect Claude Code.' }));
        return;
      }
      const body = req.method === 'POST' ? await readJson(req) : undefined;
      const hello = clientName(body);
      if (hello) {
        lastClient = hello;
        opts.onClient?.(hello);
      }

      const mcp = opts.makeServer(fromUserAgent(req.headers['user-agent']) ?? lastClient);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on('close', () => {
        void transport.close();
        void mcp.close();
      });
      await mcp.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (e) {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
    }
  });

  const listen = (port: number) =>
    new Promise<void>((resolve, reject) => {
      const onError = (e: Error) => {
        server.off('listening', onListening);
        reject(e);
      };
      const onListening = () => {
        server.off('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, '127.0.0.1');
    });

  let portChanged = false;
  try {
    await listen(opts.port);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EADDRINUSE' || opts.port === 0) throw e;
    await listen(0);
    portChanged = true;
  }
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    portChanged,
    url: `http://127.0.0.1:${port}${MCP_PATH}`,
    close: () => closeServer(server),
  };
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('Request too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      try {
        resolve(text ? JSON.parse(text) : undefined);
      } catch {
        reject(new Error('The request is not valid JSON'));
      }
    });
    req.on('error', reject);
  });
}

/** The first message an assistant sends ("initialize") says who it is. */
function clientName(body: unknown): string | undefined {
  for (const msg of Array.isArray(body) ? body : [body]) {
    const m = msg as { method?: string; params?: { clientInfo?: { name?: string } } } | undefined;
    if (m?.method === 'initialize' && m.params?.clientInfo?.name) return m.params.clientInfo.name;
  }
  return undefined;
}

/** Some assistants say who they are on every request; better than "the last one that connected". */
function fromUserAgent(ua: string | undefined): string | undefined {
  if (!ua) return undefined;
  if (/claude-code/i.test(ua)) return 'claude-code';
  return undefined;
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
}
