// The project's own dev server, which draws the previews: found if it's already running (for this project), otherwise
// started quietly in the background and stopped when Visual Editor closes. Vite projects for now (Next.js comes with
// its own plugin). From No-Code Map's Playground, where it was proven. No VS Code APIs, so it can be tested.

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { PREVIEW_DIR } from './harness';

export type DevKind = 'vite';

export interface DevPlan {
  kind: DevKind;
  /** The command that starts it, e.g. `npm run dev -- --port 5199 --strictPort`. */
  command: (port: number) => string;
  /** Ports it usually runs on (to find one that's already running). */
  ports: number[];
  /** The address that answers with this project's token (to recognise its server). */
  idPath: string;
  /** How long one check may take. */
  checkMs: number;
}

/** How to run this project's dev server, from package.json, or why previews can't be drawn for it yet. */
export function devPlan(root: string): DevPlan | { unsupported: string } {
  let pkg: { scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> } = {};
  try {
    pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  } catch {
    return { unsupported: "No package.json in this folder, so there's no dev server to draw previews with." };
  }
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const pm = existsSync(join(root, 'pnpm-lock.yaml')) ? 'pnpm' : existsSync(join(root, 'yarn.lock')) ? 'yarn' : existsSync(join(root, 'bun.lockb')) || existsSync(join(root, 'bun.lock')) ? 'bun' : 'npm';
  const run = (name: string) => (pm === 'npm' ? `npm run ${name} --` : pm === 'bun' ? `bun run ${name}` : `${pm} ${name}`);
  const script = Object.entries(pkg.scripts ?? {}).find(([name, cmd]) => name === 'dev' && /\bvite\b/.test(cmd)) ?? Object.entries(pkg.scripts ?? {}).find(([, cmd]) => /^\s*vite(\s|$)/.test(cmd));
  if (!deps.vite || !script) {
    if (deps.next) return { unsupported: 'Previews of Next.js apps come with the Next.js plugin. This plugin previews Vite apps.' };
    return { unsupported: "Previews work with Vite apps for now, and this project's dev script doesn't use Vite." };
  }
  const [name] = script;
  const configPort = Number(readConfig(root).match(/port\s*:\s*(\d{2,5})/)?.[1]);
  return {
    kind: 'vite',
    // npm needs "--" before the script's own options; the others pass them through.
    command: (port) => `${run(name)} --port ${port} --strictPort`,
    // Its usual ports, then the ones Visual Editor starts it on.
    ports: [...new Set([configPort, 5173, 5174, 5175, 5176, 5177, 5178, 5179, 5180, 5199, 5200, 5201, 5202].filter((p) => p > 0))],
    idPath: `/${PREVIEW_DIR}/server-id.txt`,
    checkMs: 1500,
  };
}

function readConfig(root: string): string {
  for (const f of ['vite.config.ts', 'vite.config.mts', 'vite.config.js', 'vite.config.mjs']) {
    try {
      return readFileSync(join(root, f), 'utf8');
    } catch {
      // next
    }
  }
  return '';
}

/**
 * A plain HTTP GET over a socket. Not node:http on purpose: VS Code wraps node:http for its proxy support, and on
 * some machines that sends requests for localhost to a proxy, so the dev server is never found.
 */
function get(url: string, ms = 1500): Promise<{ status: number; body: string } | undefined> {
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

/** Whether a dev server at `url` serves THIS project: it can see the mark file written into the preview folder. */
export async function servesProject(url: string, token: string, idPath = `/${PREVIEW_DIR}/server-id.txt`, ms = 1500): Promise<boolean> {
  const r = await get(`${url}${idPath}`, ms);
  return !!r && r.status === 200 && r.body.includes(token);
}

/**
 * Vite may listen only on IPv6 (::1) or only on IPv4, and "localhost" doesn't resolve the same way everywhere
 * (VS Code's extension host prefers IPv4). So each address form is tried; the previews use "localhost", which the
 * browser resolves both ways.
 */
async function findOn(port: number, token: string, plan: { idPath: string; checkMs: number }): Promise<string | undefined> {
  for (const host of ['127.0.0.1', '[::1]']) {
    const url = `http://${host}:${port}`;
    if ((await servesProject(url, token, plan.idPath, plan.checkMs)) && (await runsReact(url, plan.checkMs))) return `http://${PREVIEW_HOST}:${port}`;
  }
  return undefined;
}

/**
 * Whether a server that serves the project's files also runs its React setup (its Vite config with the React
 * plugin): a server started elsewhere in the folder, or without the config, serves the files but can't run them.
 */
export async function runsReact(url: string, ms = 1500): Promise<boolean> {
  const r = await get(`${url}/${PREVIEW_DIR}/app-shell.tsx`, Math.max(ms, 4000));
  return !!r && r.status === 200 && /jsx-dev-runtime|jsx-runtime|@react-refresh/.test(r.body);
}

/**
 * The name previews are opened at. Browsers send any *.localhost name to this computer, and keep storage (databases,
 * localStorage) per name: so a preview's example data never mixes with the app's own at "localhost", even on the
 * same dev server. Vite accepts *.localhost names by default. (An IP address would do too, but browsers' databases
 * don't work at IPv6 addresses like [::1], and Vite often listens only there.)
 */
export const PREVIEW_HOST = process.env.VISUAL_EDITOR_PREVIEW_HOST || 'visual-editor.localhost';

/** Whether nothing listens on `port` at `host` (undefined: every address, IPv6 and IPv4). */
function canListen(port: number, host?: string): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createServer();
    s.once('error', () => resolve(false));
    s.listen(port, host, () => s.close(() => resolve(true)));
  });
}

/**
 * The first free port from `from`. Checked on every address and on 127.0.0.1: a server on `::` (IPv6, as Node and
 * Next.js listen by default) doesn't stop a test on 127.0.0.1 alone from passing.
 */
async function freePort(from: number): Promise<number> {
  for (let port = from; port < from + 200; port++) {
    // Every address form: a dev server may listen only on ::1 (IPv6), which a check on :: alone can miss.
    if ((await canListen(port)) && (await canListen(port, '127.0.0.1')) && (await canListen(port, '::1'))) return port;
  }
  return from;
}

export class DevServer {
  private child: ChildProcess | undefined;
  private log = '';
  url: string | undefined;
  /** The same for every window on this project, so they recognise each other's dev server. */
  private readonly token: string;

  constructor(
    readonly root: string,
    private readonly shell = process.env.SHELL || '/bin/zsh',
  ) {
    this.token = serverToken(root);
  }

  get startedByUs(): boolean {
    return !!this.child;
  }

  get output(): string {
    return this.log.slice(-4000);
  }

  private starting: Promise<string> | undefined;

  /**
   * A running dev server for this project, or a new one. Reports progress through `onLog`. Asked several times at
   * once (Before and After, versions side by side), it starts one server and every caller waits for it.
   */
  ensure(onLog: (text: string) => void = () => {}): Promise<string> {
    this.starting ??= this.ensureOnce(onLog).finally(() => (this.starting = undefined));
    return this.starting;
  }

  private async ensureOnce(onLog: (text: string) => void): Promise<string> {
    const plan = devPlan(this.root);
    if ('unsupported' in plan) throw new Error(plan.unsupported);
    if (this.url && (await findOn(Number(new URL(this.url).port), this.token, plan))) return this.url;
    writeServerMark(this.root, this.token);
    for (const port of plan.ports) {
      const found = await findOn(port, this.token, plan);
      if (found) return (this.url = found);
    }
    if (this.child) await this.stop();
    const port = await freePort(5199);
    const cmd = plan.command(port);
    this.log = `$ ${cmd}\n`;
    onLog(this.log);
    // The user's login shell, so their Node/npm setup (nvm, Homebrew…) is found, like in their own terminal.
    const child = spawn(this.shell, ['-ilc', cmd], { cwd: this.root, env: { ...process.env, BROWSER: 'none', FORCE_COLOR: '0' }, detached: true });
    this.child = child;
    // Progress is reported only while starting; after that the output is just kept (for errors).
    let starting = true;
    const add = (d: Buffer) => {
      this.log += String(d).replace(/\x1b\[[0-9;]*m/g, '');
      if (starting) onLog(this.output);
    };
    child.stdout?.on('data', add);
    child.stderr?.on('data', add);
    const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const done = await Promise.race([exited.then((c) => ({ exit: c })), new Promise<undefined>((r) => setTimeout(r, 500))]);
      if (done) {
        this.child = undefined;
        throw new Error(`The dev server stopped (exit code ${done.exit}).\n${this.output}`);
      }
      const found = await findOn(port, this.token, plan);
      if (found) {
        starting = false;
        return (this.url = found);
      }
    }
    starting = false;
    await this.stop();
    throw new Error(`The dev server didn't start within a minute.\n${this.output}`);
  }

  /** Stops the dev server, only if Visual Editor started it. */
  async stop() {
    const child = this.child;
    this.child = undefined;
    this.url = undefined;
    if (!child?.pid) return;
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      child.kill('SIGTERM');
    }
  }
}

/** The same for every window on this project, so they recognise each other's dev server. */
export function serverToken(root: string): string {
  return createHash('sha256').update(`visual-editor-preview:${root}`).digest('hex').slice(0, 16);
}

/** A file only this project's dev server can serve: how a running server is recognised as this project's. */
export function writeServerMark(root: string, token: string) {
  mkdirSync(join(root, PREVIEW_DIR), { recursive: true });
  writeFileSync(join(root, PREVIEW_DIR, 'server-id.txt'), token);
}
