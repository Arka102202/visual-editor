// Pictures of a page, for proof: the developer's own Chrome (or Edge, Brave, Chromium), started hidden for the picture
// and closed after, driven through a private pipe (no network port). The page is drawn whole: the window is made as
// tall as the page, so tiles that wait until they're near the screen are drawn too. No VS Code APIs.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

/** A hidden browser, driven through a private pipe: its messages, and errors its pages throw. */
function openChrome() {
  const chrome = findChrome();
  if (!chrome) throw new Error('No Chrome, Edge, Brave or Chromium was found to take pictures with (set VISUAL_EDITOR_CHROME to one).');
  const profile = mkdtempSync(join(tmpdir(), 've-picture-'));
  const child = spawn(chrome, ['--headless=new', '--remote-debugging-pipe', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check', '--mute-audio', `--user-data-dir=${profile}`, 'about:blank'], {
    stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'],
  });
  const thrown: string[] = [];
  /** Requests the page is still waiting for, and when the last one ended (for "the page is finished"). */
  const network = { inflight: new Set<string>(), quietSince: Date.now() };
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
        thrown.push(`The page threw: ${String(m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text).split('\n')[0]}`);
      } else if (m.method === 'Network.requestWillBeSent') {
        network.inflight.add(m.params.requestId);
      } else if (m.method === 'Network.loadingFinished' || m.method === 'Network.loadingFailed') {
        network.inflight.delete(m.params.requestId);
        if (!network.inflight.size) network.quietSince = Date.now();
      }
    }
  });
  const send = (method: string, params: object = {}, sessionId?: string) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const id = next++;
      waiting.set(id, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result ?? {})));
      input.write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
    });
  /** A new page to work in. */
  const page = async () => {
    const { targetId } = (await send('Target.createTarget', { url: 'about:blank' })) as { targetId: string };
    const { sessionId } = (await send('Target.attachToTarget', { targetId, flatten: true })) as { sessionId: string };
    await send('Runtime.enable', {}, sessionId);
    await send('Network.enable', {}, sessionId);
    const evaluate = async <T>(expression: string, awaitPromise = false): Promise<T> => ((await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise }, sessionId)) as { result?: { value?: T } }).result?.value as T;
    const size = async (width: number, height: number) => send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }, sessionId);
    return { sessionId, evaluate, size };
  };
  const close = () => {
    child.kill();
    setTimeout(() => rmSync(profile, { recursive: true, force: true }), 1000);
  };
  /** Nothing loading for `ms` (a page's code, its data…). */
  const quiet = (ms: number) => !network.inflight.size && Date.now() - network.quietSince >= ms;
  return { send, page, thrown, quiet, close };
}

/** Opens `url` in a hidden browser and saves a picture of the whole page as PNG at `out`. */
export async function takePicture(url: string, out: string, options: { width?: number; timeoutMs?: number; settleMs?: number } = {}): Promise<Picture> {
  const chrome = openChrome();
  const problems = chrome.thrown;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const deadline = Date.now() + (options.timeoutMs ?? 45_000);
  try {
    const { sessionId, evaluate, size } = await chrome.page();
    const send = chrome.send;
    const width = options.width ?? 1400;
    await size(width, 900);
    await send('Page.navigate', { url }, sessionId);
    // Drawn: loaded, nothing still waiting, and the same height twice in a row (made as tall as the page each time,
    // so tiles drawn only when near the screen are drawn too).
    let last = -1;
    let reloads = 0;
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
      // (Not finished while it still loads anything: a dev server may reload the page once it has prepared its libraries.)
      if (!now?.ready || !chrome.quiet(800)) continue;
      // Still blank once all is quiet: a dev server that prepared its libraries meanwhile wants a reload (the draft's app
      // has no live reload to do it), so the camera reloads, twice at most.
      const blank = await evaluate<boolean>(`!document.body || (!document.body.innerText.trim() && !document.querySelector('img,svg,canvas,[data-ve-variant]'))`);
      if (blank && reloads < 2) {
        reloads++;
        last = -1;
        // (What the broken first load threw isn't the page's: only errors after the reload count.)
        problems.length = 0;
        await send('Page.reload', { ignoreCache: false }, sessionId);
        continue;
      }
      await size(Math.min(WIDEST, Math.max(width, now.width)), Math.min(TALLEST, Math.max(900, now.height)));
      if (!now.waiting && now.height === last) break;
      last = now.height;
    }
    if (Date.now() >= deadline) problems.push('The page took too long to finish drawing: the picture may be missing parts.');
    // (An app's page may still be loading its data: a moment more.)
    await sleep(options.settleMs ?? 300);
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
    chrome.close();
  }
}

export interface Difference {
  /** Pixels that differ (beyond a tiny tolerance), out of all of them. */
  differing: number;
  total: number;
  /** The two pictures aren't the same size (the page grew or shrank). */
  sizes?: { before: [number, number]; after: [number, number] };
}

/**
 * Compares two pictures pixel by pixel (in the hidden browser), and saves a picture of the differences at `out`: the
 * "after" picture faded, with what differs in red.
 */
export async function comparePictures(before: string, after: string, out: string): Promise<Difference> {
  const chrome = openChrome();
  try {
    const { evaluate } = await chrome.page();
    const url = (file: string) => `data:image/png;base64,${readFileSync(file).toString('base64')}`;
    const r = await evaluate<{ differing: number; total: number; a: [number, number]; b: [number, number]; diff: string }>(
      `(async () => {
        const load = (src) => new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = no; i.src = src; });
        const [a, b] = await Promise.all([load(${JSON.stringify(url(before))}), load(${JSON.stringify(url(after))})]);
        const w = Math.max(a.width, b.width), h = Math.max(a.height, b.height);
        const pixels = (img) => { const c = new OffscreenCanvas(w, h); const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, w, h); x.drawImage(img, 0, 0); return x.getImageData(0, 0, w, h).data; };
        const pa = pixels(a), pb = pixels(b);
        const c = new OffscreenCanvas(w, h); const x = c.getContext('2d');
        x.globalAlpha = 0.25; x.drawImage(b, 0, 0); x.globalAlpha = 1;
        const marks = x.getImageData(0, 0, w, h); const m = marks.data;
        let differing = 0;
        for (let i = 0; i < pa.length; i += 4) {
          // (A small tolerance: the same page can be drawn with a hair of difference in anti-aliasing.)
          if (Math.abs(pa[i] - pb[i]) + Math.abs(pa[i + 1] - pb[i + 1]) + Math.abs(pa[i + 2] - pb[i + 2]) > 48) { differing++; m[i] = 255; m[i + 1] = 0; m[i + 2] = 0; m[i + 3] = 255; }
        }
        x.putImageData(marks, 0, 0);
        const blob = await c.convertToBlob({ type: 'image/png' });
        const diff = await new Promise((ok) => { const r = new FileReader(); r.onload = () => ok(r.result); r.readAsDataURL(blob); });
        return { differing, total: w * h, a: [a.width, a.height], b: [b.width, b.height], diff };
      })()`,
      true,
    );
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, Buffer.from(r.diff.split(',')[1], 'base64'));
    const same = r.a[0] === r.b[0] && r.a[1] === r.b[1];
    return { differing: r.differing, total: r.total, ...(same ? {} : { sizes: { before: r.a, after: r.b } }) };
  } finally {
    chrome.close();
  }
}
