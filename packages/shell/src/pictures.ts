// Pictures of previews, for assistants and checkers (and the developer): so they can see what a card looks like at
// each size and in each situation, and fix what looks wrong before anyone else looks. Uses a browser already on this
// computer (Chrome, Edge, Chromium, Brave), headless, through its debugging pipe: nothing to install. A preview page
// says when it's ready through \`window.__visualEditorPreview = { ready, error }\`; pages that don't are taken once
// loaded. No VS Code APIs, so it can be tested. From No-Code Map's Playground, where it was proven.

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';

const READY_STATE = 'window.__visualEditorPreview ? { ready: !!window.__visualEditorPreview.ready, error: window.__visualEditorPreview.error ?? null } : undefined';

/** A Chromium-based browser on this machine, or undefined. `configured` (a setting) wins. */
export function findBrowser(configured?: string): string | undefined {
  if (configured) return existsSync(configured) ? configured : undefined;
  const env = process.env;
  const candidates =
    process.platform === 'darwin'
      ? ['Google Chrome', 'Google Chrome Canary', 'Chromium', 'Microsoft Edge', 'Brave Browser', 'Arc'].map((app) => `/Applications/${app}.app/Contents/MacOS/${app}`)
      : process.platform === 'win32'
        ? [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA]
            .filter(Boolean)
            .flatMap((base) => [`${base}\\Google\\Chrome\\Application\\chrome.exe`, `${base}\\Microsoft\\Edge\\Application\\msedge.exe`, `${base}\\Chromium\\Application\\chrome.exe`, `${base}\\BraveSoftware\\Brave-Browser\\Application\\brave.exe`])
        : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium', '/usr/bin/microsoft-edge', '/usr/bin/brave-browser'];
  return candidates.find((p) => existsSync(p));
}

export interface Picture {
  png: Buffer;
  width: number;
  height: number;
  /** The error the preview hit, if any (the picture shows it too). */
  error?: string;
  /** False when the preview never said it was ready (it may still show something). */
  ready: boolean;
}

type Message = { id?: number; method?: string; params?: Record<string, unknown>; result?: Record<string, unknown>; error?: { message: string }; sessionId?: string };

/** One headless browser, for several pictures in a row. */
export class Pictures {
  private child: ChildProcess | undefined;
  private profile: string | undefined;
  private nextId = 1;
  private readonly waiting = new Map<number, { resolve: (r: Record<string, unknown>) => void; reject: (e: Error) => void }>();
  private buffer = '';

  constructor(private readonly browser: string) {}

  private start() {
    if (this.child) return;
    this.profile = mkdtempSync(join(tmpdir(), 'visual-editor-pictures-'));
    const child = spawn(
      this.browser,
      ['--headless=new', '--remote-debugging-pipe', '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars', '--mute-audio', `--user-data-dir=${this.profile}`, 'about:blank'],
      { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] },
    );
    this.child = child;
    const fromBrowser = child.stdio[4] as Readable;
    fromBrowser.on('data', (d: Buffer) => {
      this.buffer += d.toString('utf8');
      let end: number;
      while ((end = this.buffer.indexOf('\0')) >= 0) {
        const raw = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 1);
        let m: Message;
        try {
          m = JSON.parse(raw) as Message;
        } catch {
          continue;
        }
        if (m.id !== undefined && this.waiting.has(m.id)) {
          const w = this.waiting.get(m.id)!;
          this.waiting.delete(m.id);
          if (m.error) w.reject(new Error(m.error.message));
          else w.resolve(m.result ?? {});
        }
      }
    });
    child.on('exit', () => {
      for (const w of this.waiting.values()) w.reject(new Error('The browser closed.'));
      this.waiting.clear();
      this.child = undefined;
    });
  }

  private send(method: string, params: Record<string, unknown> = {}, sessionId?: string, ms = 15_000): Promise<Record<string, unknown>> {
    this.start();
    const id = this.nextId++;
    const toBrowser = this.child!.stdio[3] as Writable;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error(`The browser didn't answer (${method}).`));
      }, ms);
      this.waiting.set(id, {
        resolve: (r) => (clearTimeout(timer), resolve(r)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
      toBrowser.write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
    });
  }

  private async evaluate<T>(sessionId: string, expression: string): Promise<T | undefined> {
    const r = (await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId)) as { result?: { value?: T } };
    return r.result?.value;
  }

  /**
   * A picture of a preview page at a width. `hug`: as wide as the component (Actual size), else the page width.
   * Waits until the preview says it's ready, its fonts are in, and a moment for data to arrive.
   */
  async take(url: string, width: number, opts: { hug?: boolean; page?: boolean; timeoutMs?: number; settleMs?: number } = {}): Promise<Picture> {
    const { targetId } = (await this.send('Target.createTarget', { url: 'about:blank' })) as { targetId: string };
    const { sessionId } = (await this.send('Target.attachToTarget', { targetId, flatten: true })) as { sessionId: string };
    try {
      await this.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 500 }, sessionId);
      await this.send('Page.navigate', { url }, sessionId);
      const started = Date.now();
      const deadline = started + (opts.timeoutMs ?? 20_000);
      let state: { ready: boolean; error: string | null } | undefined;
      while (Date.now() < deadline) {
        state = await this.evaluate<{ ready: boolean; error: string | null }>(sessionId, READY_STATE).catch(() => undefined);
        if (state?.ready || state?.error) break;
        // A page that doesn't say when it's ready (a plugin's own HTML): loaded, then a moment.
        if (!state && Date.now() - started > 1500 && (await this.evaluate<string>(sessionId, 'document.readyState').catch(() => undefined)) === 'complete') break;
        await new Promise((r) => setTimeout(r, 150));
      }
      await this.evaluate(sessionId, 'document.fonts ? document.fonts.ready.then(() => true) : true').catch(() => undefined);
      await new Promise((r) => setTimeout(r, opts.settleMs ?? 600));
      state = (await this.evaluate<{ ready: boolean; error: string | null }>(sessionId, READY_STATE).catch(() => undefined)) ?? state;
      // The component's own size, as the Playground measures it.
      const size = (await this.evaluate<{ width: number; height: number }>(
        sessionId,
        `(() => { const root = document.getElementById('root') || document.body; if (!root) return undefined; const base = root.getBoundingClientRect(); let w = 0, h = 0; for (const el of Array.from(root.children)) { const r = el.getBoundingClientRect(); w = Math.max(w, r.right - base.left); h = Math.max(h, r.bottom - base.top); } const pad = parseFloat(getComputedStyle(root).paddingBottom) || 0; return { width: Math.ceil(w + pad), height: Math.ceil(h + pad) }; })()`,
      )) ?? { width, height: 300 };
      // A whole page: as tall as the document.
      if (opts.page) size.height = (await this.evaluate<number>(sessionId, 'document.documentElement.scrollHeight')) ?? size.height;
      const w = opts.hug ? Math.min(width, Math.max(size.width, 40)) : width;
      const h = Math.min(Math.max(size.height, 40), 4000);
      const shot = (await this.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: w, height: h, scale: 1 }, captureBeyondViewport: true }, sessionId, 30_000)) as { data: string };
      return { png: Buffer.from(shot.data, 'base64'), width: w, height: h, ready: !!state?.ready, ...(state?.error ? { error: state.error } : {}) };
    } finally {
      await this.send('Target.closeTarget', { targetId }).catch(() => undefined);
    }
  }

  close() {
    const child = this.child;
    this.child = undefined;
    child?.kill();
    if (this.profile) {
      const p = this.profile;
      // The browser lets go of its profile shortly after it exits.
      setTimeout(() => rmSync(p, { recursive: true, force: true }), 1500);
    }
  }
}
