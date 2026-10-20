// The project's own dev server, behind the proxy: found if one is already running for this project (Vite, recognised
// by its package.json), otherwise started quietly in the background on a free port and stopped when Visual Editor
// closes. Any dev script works: Vite, Next.js, Create React App, or anything that takes a port. No VS Code APIs.

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { join } from 'node:path';

export interface DevPlan {
  /** What it is, in words (for messages): "Vite", "Next.js"… */
  kind: string;
  /** The command that starts it on a port. */
  command: (port: number) => string;
  /** Extra settings it reads from the environment (PORT for Create React App and most others). */
  env: (port: number) => Record<string, string>;
  /** Ports it may already be running on (only checked when it can be recognised: Vite). */
  ports: number[];
  /** A running server can be recognised as this project's. */
  recognisable: boolean;
}

interface Pkg {
  name?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

function readPkg(root: string): Pkg | undefined {
  try {
    return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as Pkg;
  } catch {
    return undefined;
  }
}

/** How to run this project's dev server, from its package.json, or why there's none to run. */
export function devPlan(root: string): DevPlan | { unsupported: string } {
  const pkg = readPkg(root);
  if (!pkg) return { unsupported: 'There’s no package.json in this folder, so there’s no dev server to run.' };
  const scripts = pkg.scripts ?? {};
  const name = ['dev', 'start', 'serve', 'develop'].find((n) => scripts[n]);
  if (!name) return { unsupported: 'package.json has no dev, start or serve script to run the app with.' };
  const script = scripts[name];
  const pm = existsSync(join(root, 'pnpm-lock.yaml')) ? 'pnpm' : existsSync(join(root, 'yarn.lock')) ? 'yarn' : existsSync(join(root, 'bun.lockb')) || existsSync(join(root, 'bun.lock')) ? 'bun' : 'npm';
  // npm needs "--" before the script's own options; the others pass them through.
  const run = (args: string) => (pm === 'npm' ? `npm run ${name}${args ? ` -- ${args}` : ''}` : pm === 'bun' ? `bun run ${name} ${args}` : `${pm} ${name} ${args}`).trim();
  const base = { env: (port: number) => ({ PORT: String(port), BROWSER: 'none' }), ports: [] as number[], recognisable: false };
  if (/\bvite\b/.test(script)) {
    const config = ['vite.config.ts', 'vite.config.mts', 'vite.config.js', 'vite.config.mjs'].map((f) => (existsSync(join(root, f)) ? readFileSync(join(root, f), 'utf8') : '')).join('\n');
    const configPort = Number(config.match(/port\s*:\s*(\d{2,5})/)?.[1]);
    return {
      ...base,
      kind: 'Vite',
      command: (port) => run(`--port ${port} --strictPort`),
      ports: [...new Set([configPort, 5173, 5174, 5175, 5176, 5177, 5178, 5179, 5180].filter((p) => p > 0))],
      recognisable: true,
    };
  }
  if (/\bnext\b/.test(script)) return { ...base, kind: 'Next.js', command: (port) => run(`-p ${port}`) };
  if (/react-scripts|craco/.test(script)) return { ...base, kind: 'Create React App', command: () => run('') };
  if (/\bastro\b/.test(script)) return { ...base, kind: 'Astro', command: (port) => run(`--port ${port}`) };
  if (/webpack(-dev-server| serve)/.test(script)) return { ...base, kind: 'webpack', command: (port) => run(`--port ${port}`) };
  return { ...base, kind: `the "${name}" script`, command: () => run('') };
}

/**
 * A plain HTTP GET over a socket. Not node:http on purpose: VS Code wraps node:http for its proxy support, and on some
 * machines that sends requests for this computer to a proxy, so a running dev server is never found.
 */
export function get(url: string, ms = 1500): Promise<{ status: number; body: string } | undefined> {
  const u = new URL(url);
  const host = u.hostname.replace(/^\[|\]$/g, '');
  return new Promise((resolve) => {
    const socket = connect({ host, port: Number(u.port) || 80 });
    let data = '';
    const done = (r: { status: number; body: string } | undefined) => {
      socket.destroy();
      resolve(r);
    };
    socket.setTimeout(ms, () => done(undefined));
    socket.on('error', () => done(undefined));
    socket.on('connect', () => socket.write(`GET ${u.pathname}${u.search} HTTP/1.1\r\nHost: ${u.host}\r\nAccept: */*\r\nConnection: close\r\n\r\n`));
    socket.on('data', (d) => (data += String(d)));
    socket.on('end', () => {
      const status = Number(data.match(/^HTTP\/1\.[01] (\d{3})/)?.[1] ?? 0);
      done(status ? { status, body: data.slice(data.indexOf('\r\n\r\n') + 4) } : undefined);
    });
  });
}

/** Whether nothing listens on `port` (on every address form). */
function canListen(port: number, host?: string): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createServer();
    s.once('error', () => resolve(false));
    s.listen(port, host, () => s.close(() => resolve(true)));
  });
}

/** The first port from `from` that nothing listens on. */
export async function freePort(from: number): Promise<number> {
  for (let port = from; port < from + 200; port++) {
    if ((await canListen(port)) && (await canListen(port, '127.0.0.1')) && (await canListen(port, '::1'))) return port;
  }
  return from;
}

/** The address a server answers at on this port (it may listen on IPv4 or IPv6 only), or undefined. */
async function answering(port: number, path = '/'): Promise<{ origin: string; body: string } | undefined> {
  for (const host of ['127.0.0.1', '[::1]']) {
    const r = await get(`http://${host}:${port}${path}`);
    if (r) return { origin: `http://${host}:${port}`, body: r.body };
  }
  return undefined;
}

export class DevServer {
  private child: ChildProcess | undefined;
  private log = '';
  /** Where it answers (e.g. http://127.0.0.1:5173). */
  origin: string | undefined;
  private starting: Promise<string> | undefined;

  constructor(
    readonly root: string,
    private readonly shell = process.env.SHELL || '/bin/zsh',
  ) {}

  get startedByUs(): boolean {
    return !!this.child;
  }

  /** The last of what it printed (for errors). */
  get output(): string {
    return this.log.slice(-4000);
  }

  /** A dev server for this project: one already running, or a new one. Asked several times at once, it starts one. */
  ensure(onLog: (text: string) => void = () => {}): Promise<string> {
    this.starting ??= this.ensureOnce(onLog).finally(() => (this.starting = undefined));
    return this.starting;
  }

  /** Whether a running Vite at `port` serves this project: its package.json is this one. */
  private async isOurs(port: number): Promise<string | undefined> {
    const name = readPkg(this.root)?.name;
    const r = await answering(port, '/package.json?raw');
    if (!r) return undefined;
    return name ? (r.body.includes(JSON.stringify(name).slice(1, -1)) ? r.origin : undefined) : undefined;
  }

  private async ensureOnce(onLog: (text: string) => void): Promise<string> {
    const plan = devPlan(this.root);
    if ('unsupported' in plan) throw new Error(plan.unsupported);
    if (this.origin && (await answering(Number(new URL(this.origin).port)))) return this.origin;
    if (plan.recognisable) {
      for (const port of plan.ports) {
        const found = await this.isOurs(port);
        if (found) return (this.origin = found);
      }
    }
    if (this.child) await this.stop();
    const port = await freePort(5300);
    const cmd = plan.command(port);
    this.log = `$ ${cmd}\n`;
    onLog(this.log);
    // The developer's login shell, so their Node/npm setup (nvm, Homebrew…) is found, as in their own terminal.
    const child = spawn(this.shell, ['-ilc', cmd], { cwd: this.root, env: { ...process.env, ...plan.env(port), FORCE_COLOR: '0' }, detached: true });
    this.child = child;
    let starting = true;
    const add = (d: Buffer) => {
      this.log += String(d).replace(/\x1b\[[0-9;]*m/g, '');
      if (starting) onLog(this.output);
    };
    child.stdout?.on('data', add);
    child.stderr?.on('data', add);
    const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      const done = await Promise.race([exited.then((c) => ({ exit: c })), new Promise<undefined>((r) => setTimeout(r, 500))]);
      if (done) {
        this.child = undefined;
        throw new Error(`The dev server stopped (exit code ${done.exit}).\n${this.output}`);
      }
      const found = await answering(port);
      if (found) {
        starting = false;
        return (this.origin = found.origin);
      }
    }
    starting = false;
    await this.stop();
    throw new Error(`The dev server didn't start within 90 seconds.\n${this.output}`);
  }

  /** Stops the dev server, only if Visual Editor started it. */
  async stop() {
    const child = this.child;
    this.child = undefined;
    this.origin = undefined;
    if (!child?.pid) return;
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      child.kill('SIGTERM');
    }
  }
}
