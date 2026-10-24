// Pictures of a page, for proof: the developer's own Chrome (or Edge, Brave, Chromium), started hidden for the picture
// and closed after, driven through a private pipe (no network port). The page is drawn whole: the window is made as
// tall as the page, so tiles that wait until they're near the screen are drawn too. No VS Code APIs.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/** Where a Chrome-like browser usually is, on each system. */
function candidates(): string[] {
  const own = process.env.VISUAL_EDITOR_CHROME ? [process.env.VISUAL_EDITOR_CHROME] : [];
  if (process.platform === 'darwin') {
    const apps = ['Google Chrome', 'Chromium', 'Microsoft Edge', 'Brave Browser', 'Google Chrome Canary'];
    return [...own, ...apps.flatMap((a) => [`/Applications/${a}.app/Contents/MacOS/${a}`, join(homedir(), `Applications/${a}.app/Contents/MacOS/${a}`)])];
  }
  if (process.platform === 'win32') {
    const roots = [process.env['PROGRAMFILES'], process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter((r): r is string => !!r);
    return [...own, ...roots.flatMap((r) => [join(r, 'Google/Chrome/Application/chrome.exe'), join(r, 'Microsoft/Edge/Application/msedge.exe'), join(r, 'BraveSoftware/Brave-Browser/Application/brave.exe')])];
  }
  return [...own, ...['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'brave-browser'].flatMap((n) => ['/usr/bin', '/usr/local/bin', '/snap/bin'].map((d) => join(d, n)))];
}

export function findChrome(): string | undefined {
  return candidates().find((p) => existsSync(p));
}

export interface Picture {
  /** Designs drawn (tiles), when the page marks them. */
  tiles: number;
  /** What went wrong on the page: errors it threw, designs that failed to draw. */
  problems: string[];
}

const TALLEST = 12_000;
const WIDEST = 4_000;

/** Opens `url` in a hidden browser and saves a picture of the whole page as PNG at `out`. */
export async function takePicture(url: string, out: string, options: { width?: number; timeoutMs?: number } = {}): Promise<Picture> {
  const chrome = findChrome();
  if (!chrome) throw new Error('No Chrome, Edge, Brave or Chromium was found to take pictures with (set VISUAL_EDITOR_CHROME to one).');
  const profile = mkdtempSync(join(tmpdir(), 've-picture-'));
  const child = spawn(chrome, ['--headless=new', '--remote-debugging-pipe', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check', '--mute-audio', `--user-data-dir=${profile}`, 'about:blank'], {
    stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'],
  });
  const problems: string[] = [];
  let next = 1;
  let buffer = '';
  const waiting = new Map<number, (m: { result?: Record<string, unknown>; error?: { message: string } }) => void>();
  const input = child.stdio[3] as NodeJS.WritableStream;
  const output = child.stdio[4] as NodeJS.ReadableStream;
  output.on('data', (d: Buffer) => {
    buffer += d.toString('utf8');
    let end: number;
    while ((end = buffer.indexOf('\0')) >= 0) {
      const m = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      if (m.id && waiting.has(m.id)) {
        waiting.get(m.id)!(m);
        waiting.delete(m.id);
      } else if (m.method === 'Runtime.exceptionThrown') {
        problems.push(`The page threw: ${String(m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text).split('\n')[0]}`);
      }
    }
  });
  const send = (method: string, params: object = {}, sessionId?: string) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const id = next++;
      waiting.set(id, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result ?? {})));
      input.write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
    });
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const deadline = Date.now() + (options.timeoutMs ?? 45_000);
  try {
    const { targetId } = (await send('Target.createTarget', { url: 'about:blank' })) as { targetId: string };
    const { sessionId } = (await send('Target.attachToTarget', { targetId, flatten: true })) as { sessionId: string };
    const evaluate = async <T>(expression: string): Promise<T> => ((await send('Runtime.evaluate', { expression, returnByValue: true }, sessionId)) as { result?: { value?: T } }).result?.value as T;
    const size = async (width: number, height: number) => send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }, sessionId);
    await send('Runtime.enable', {}, sessionId);
    const width = options.width ?? 1400;
    await size(width, 900);
    await send('Page.navigate', { url }, sessionId);

    // Drawn: loaded, nothing still waiting, and the same height twice in a row (made as tall as the page each time,
    // so tiles drawn only when near the screen are drawn too).
    let last = -1;
    while (Date.now() < deadline) {
      await sleep(400);
      // (A board may scroll inside its own box: its full size counts, not only the page's.)
      const now = await evaluate<{ ready: boolean; waiting: number; height: number; width: number }>(
        // (The page's own size is at least the window's, so only the boards get a margin: else it would grow each round.)
        `(() => {
          const doc = document.documentElement;
          const grids = [...document.querySelectorAll('[data-ve-grid]')].map((g) => { const r = g.getBoundingClientRect(); return { right: r.left + g.scrollWidth + 28, bottom: r.top + window.scrollY + g.scrollHeight + 28 }; });
          return { ready: document.readyState === 'complete', waiting: document.querySelectorAll('[data-ve-waiting]').length, width: Math.ceil(Math.max(doc.scrollWidth, ...grids.map((g) => g.right))), height: Math.ceil(Math.max(doc.scrollHeight, ...grids.map((g) => g.bottom))) };
        })()`,
      );
      if (!now?.ready) continue;
      await size(Math.min(WIDEST, Math.max(width, now.width)), Math.min(TALLEST, Math.max(900, now.height)));
      if (!now.waiting && now.height === last) break;
      last = now.height;
    }
    if (Date.now() >= deadline) problems.push('The page took too long to finish drawing: the picture may be missing parts.');
    await sleep(300);
    const marks = await evaluate<{ tiles: number; broken: string[]; empty: boolean }>(
      `({ tiles: document.querySelectorAll('[data-ve-variant]').length, broken: [...document.querySelectorAll('[data-ve-variant-error]')].map((e) => e.getAttribute('data-ve-variant-error') + ': ' + e.textContent.trim().slice(0, 300)), empty: !document.body || !document.body.innerText.trim() && !document.querySelector('img,svg,canvas') })`,
    );
    for (const b of marks?.broken ?? []) problems.push(`A design didn't draw: ${b}`);
    if (marks?.empty) problems.push('The page is blank.');
    const shot = (await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }, sessionId)) as { data: string };
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, Buffer.from(shot.data, 'base64'));
    return { tiles: marks?.tiles ?? 0, problems };
  } finally {
    child.kill();
    setTimeout(() => rmSync(profile, { recursive: true, force: true }), 1000);
  }
}
