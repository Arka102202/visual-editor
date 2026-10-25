// Cases run for real: the logic check describes a case as steps on a page (click, type, press, wait) and what should be
// seen after; Visual Editor runs them in the draft's own app, in the hidden browser, and reports what really happened.
// Targets are found the way a person would: a button or link by its name, a box by its label, or some text. No VS Code
// APIs.

import { openChrome } from './pictures';
import { endpointId, fits } from './proxy/fakePaths';
import type { Decision } from './proxy/fakes';

/** Something on the page: by role and name (a button "Delete"), by text, or by CSS selector. */
export interface Target {
  role?: 'button' | 'link' | 'textbox' | 'checkbox' | 'any';
  name?: string;
  text?: string;
  selector?: string;
}

export type Step =
  | { do: 'click'; target: Target }
  | { do: 'type'; target: Target; text: string }
  | { do: 'press'; key: string }
  | { do: 'wait'; ms: number };

/** Text to see (or not), on the whole page or `within` one part of it (the grid of cards, a dialog…). */
export type Expectation =
  | { see: string; within?: Target }
  | { notSee: string; within?: Target }
  | { attr: { target: Target; name: string; value: string | null } };

/** A fake API answer for one run: matched by method and path ("*" matches anything there). */
export interface RunFake {
  method: string;
  path: string;
  status?: number;
  body?: unknown;
  /** Milliseconds before it answers. */
  delay?: number;
  /** No answer at all: the network fails. */
  network?: boolean;
}

/** How to run a case: where (the component's Playground, in one design and state, or an app page), then the steps. */
export interface RunSpec {
  where: 'playground' | 'app';
  /** Playground: the card (its id), and the design and state to start from. */
  card?: string;
  design?: string;
  state?: string;
  /** App: the page's address, e.g. "/settings". */
  page?: string;
  api?: RunFake[];
  steps: Step[];
  expect: Expectation[];
}

export interface CaseResult {
  ok: boolean;
  /** What really happened, in words. */
  found: string;
  /** False when the steps couldn't be done (what they name isn't on the page, and the page is fine): nothing was tried. */
  ran: boolean;
  /** When the only thing wrong was text that should have been shown and wasn't: those texts. */
  missing?: string[];
  /** What the page showed at the end (its text, cut), when something was wrong: for a second look. */
  after?: string;
}

/** What the draft's app answers a call with during a run: its fake for that call, if it has one ("*" any method). */
export function decideFake(fakes: RunFake[], method: string, path: string): Decision | undefined {
  const f = fakes.find((x) => (x.method === '*' || x.method.toUpperCase() === method.toUpperCase()) && fits(x.path, path));
  if (!f) return undefined;
  const endpoint = { id: endpointId(f.method === '*' ? 'any' : f.method, f.path), method: f.method, path: f.path, use: 'case', cases: {} };
  const delay = Math.max(0, Math.min(30_000, f.delay ?? 0));
  if (f.network) return { kind: 'fail', endpoint, name: 'case', delay };
  const text = typeof f.body === 'string' ? f.body : f.body === undefined ? '' : JSON.stringify(f.body);
  const json = typeof f.body !== 'string' && f.body !== undefined;
  return { kind: 'answer', endpoint, name: 'case', status: f.status ?? 200, headers: text ? { 'content-type': json ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8' } : {}, body: Buffer.from(text), delay };
}

/** The address a case starts at, on the draft's app (`origin`). */
export function startUrl(origin: string, spec: RunSpec): string {
  if (spec.where === 'playground') {
    const q = new URLSearchParams({ item: spec.card ?? '', ...(spec.design ? { variant: spec.design } : {}), ...(spec.state ? { state: spec.state } : {}) });
    return `${origin}/__ve/preview?${q}`;
  }
  return `${origin}${(spec.page ?? '/').startsWith('/') ? spec.page ?? '/' : `/${spec.page}`}`;
}

/** Finds a target in the page (run in the page): the innermost visible element that matches. Returns its index in `all`. */
const FIND = `(t) => {
  const visible = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden'; };
  if (t.selector) return document.querySelector(t.selector);
  const kinds = { button: 'button,[role=button],input[type=button],input[type=submit]', link: 'a,[role=link]', textbox: 'input:not([type=button]):not([type=submit]):not([type=checkbox]),textarea,[contenteditable=true],[role=textbox]', checkbox: 'input[type=checkbox],[role=checkbox],[role=switch]' };
  const pool = [...document.querySelectorAll(t.role && t.role !== 'any' ? kinds[t.role] : t.text ? 'body *' : 'button,a,input,textarea,select,[role],label,summary')].filter(visible);
  const said = (e) => [e.getAttribute('aria-label'), e.getAttribute('title'), e.getAttribute('placeholder'), e.value, e.labels && [...e.labels].map((l) => l.textContent).join(' '), e.textContent].filter(Boolean).join(' ').replace(/\\s+/g, ' ').trim().toLowerCase();
  const want = (t.name ?? t.text ?? '').toLowerCase();
  const hits = pool.filter((e) => !want || said(e).includes(want));
  // The innermost match (a button, not the whole page that contains its text).
  return hits.find((e) => !hits.some((o) => o !== e && e.contains(o))) ?? null;
}`;

export type Chrome = ReturnType<typeof openChrome>;

/** Opens a page and waits until it's loaded, quiet and not blank (a dev server that prepared its libraries asks for a reload: once or twice). */
export async function load(chrome: Chrome, url: string, deadline: number) {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const page = await chrome.page();
  await page.size(1280, 900);
  await chrome.send('Page.navigate', { url }, page.sessionId);
  let reloads = 0;
  while (Date.now() < deadline) {
    await sleep(250);
    const ready = await page.evaluate<{ ready: boolean; blank: boolean }>(`({ ready: document.readyState === 'complete', blank: !document.body || (!document.body.innerText.trim() && !document.querySelector('img,svg,canvas,input,button')) })`);
    if (!ready?.ready || !chrome.quiet(500)) continue;
    if (ready.blank && reloads < 2) {
      reloads++;
      chrome.thrown.length = 0;
      await chrome.send('Page.reload', {}, page.sessionId);
      continue;
    }
    break;
  }
  return page;
}

/** What a page has on it, in a line, so a case can name what is really there: its buttons, links and boxes, and the page's own attributes. */
const GLANCE = `(() => {
  const visible = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden'; };
  const name = (e) => (e.getAttribute('aria-label') || e.getAttribute('title') || e.getAttribute('placeholder') || (e.labels && [...e.labels].map((l) => l.textContent).join(' ')) || e.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 40);
  const list = (sel) => [...new Set([...document.querySelectorAll(sel)].filter(visible).map(name).filter(Boolean))].slice(0, 15).map((n) => JSON.stringify(n)).join(', ');
  const html = [...document.documentElement.attributes].filter((a) => !a.name.startsWith('data-ve')).map((a) => a.name + '=' + JSON.stringify(a.value)).join(' ');
  return [
    'buttons: ' + (list('button,[role=button],input[type=button],input[type=submit]') || 'none'),
    'links: ' + (list('a[href],[role=link]') || 'none'),
    'boxes: ' + (list('input:not([type=button]):not([type=submit]):not([type=checkbox]),textarea,select,[role=textbox]') || 'none'),
    '<html ' + html + '>',
    'text: ' + JSON.stringify(document.body.innerText.replace(/\\s+/g, ' ').trim().slice(0, 160)),
  ].join('; ');
})()`;

/**
 * What each page shows when it opens (one hidden browser for all of them): in a line (`line`), and all its text (`text`,
 * up to 20,000 characters). A page that can't be opened says why.
 */
export async function glance(urls: string[], timeoutMs = 20_000): Promise<{ line: string; text: string }[]> {
  const chrome = openChrome();
  try {
    const out: { line: string; text: string }[] = [];
    for (const url of urls) {
      try {
        const page = await load(chrome, url, Date.now() + timeoutMs);
        const line = (await page.evaluate<string>(GLANCE)) ?? 'nothing could be read';
        const text = (await page.evaluate<string>(`document.body ? document.body.innerText.replace(/\\s+/g, ' ').trim().slice(0, 20000) : ''`)) ?? '';
        out.push({ line, text });
      } catch (e) {
        out.push({ line: `couldn't be opened: ${e instanceof Error ? e.message : String(e)}`, text: '' });
      }
    }
    return out;
  } finally {
    chrome.close();
  }
}

/** Runs one case in a hidden browser, from `url`. Errors the page throws during the run make it fail. */
export async function runCase(url: string, spec: RunSpec, timeoutMs = 30_000): Promise<CaseResult> {
  const chrome = openChrome();
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  try {
    const { sessionId, evaluate } = await load(chrome, url, Date.now() + timeoutMs);
    const done: string[] = [];
    const settle = async () => {
      const until = Date.now() + 3000;
      await sleep(120);
      while (Date.now() < until && !chrome.quiet(300)) await sleep(100);
    };
    for (const step of spec.steps) {
      if (step.do === 'wait') {
        await sleep(Math.min(10_000, Math.max(0, step.ms)));
        continue;
      }
      if (step.do === 'press') {
        await chrome.send('Input.dispatchKeyEvent', { type: 'keyDown', key: step.key, ...(step.key.length === 1 ? { text: step.key } : {}) }, sessionId);
        await chrome.send('Input.dispatchKeyEvent', { type: 'keyUp', key: step.key }, sessionId);
        done.push(`pressed ${step.key}`);
        await settle();
        continue;
      }
      const target = JSON.stringify(step.target);
      const found = await evaluate<boolean>(`!!(${FIND})(${target})`);
      if (!found) {
        // A page that broke is the change's fault; a name that isn't there may only be the case's.
        const thrown = [...new Set(chrome.thrown)];
        const before = done.length ? `${done.join(', ')}; then ` : '';
        if (thrown.length) return { ok: false, ran: true, found: `${before}couldn't find ${describe(step.target)}: the page threw ${thrown.slice(0, 2).join('; ')}` };
        const there = await evaluate<string>(GLANCE);
        return { ok: false, ran: false, found: `${before}couldn't find ${describe(step.target)} on the page (${there?.split('; ').slice(0, 2).join('; ') ?? 'it shows nothing'})` };
      }
      if (step.do === 'click') {
        await evaluate(`(() => { const e = (${FIND})(${target}); e.scrollIntoView({ block: 'center' }); e.click(); })()`);
        done.push(`clicked ${describe(step.target)}`);
      } else {
        // Typing into a box the way a person does, so frameworks that watch input events see it.
        await evaluate(`(() => { const e = (${FIND})(${target}); e.focus(); const set = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(e), 'value')?.set; if (set) set.call(e, ${JSON.stringify(step.text)}); else e.textContent = ${JSON.stringify(step.text)}; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); })()`);
        done.push(`typed “${step.text}” into ${describe(step.target)}`);
      }
      await settle();
    }
    // What should be seen now.
    const misses: string[] = [];
    const seen: string[] = [];
    const notShown: string[] = [];
    for (const want of spec.expect) {
      if ('see' in want || 'notSee' in want) {
        const text = 'see' in want ? want.see : want.notSee;
        const where = want.within ? ` in ${describe(want.within)}` : '';
        // The whole page, or the part named: its text (undefined: that part isn't there).
        const there = await evaluate<boolean | null>(
          want.within
            ? `(() => { const e = (${FIND})(${JSON.stringify(want.within)}); return e ? e.innerText.toLowerCase().includes(${JSON.stringify(text.toLowerCase())}) : null; })()`
            : `document.body.innerText.toLowerCase().includes(${JSON.stringify(text.toLowerCase())})`,
        );
        if (there === null) {
          misses.push(`couldn't find ${describe(want.within!)}`);
        } else if ('see' in want ? there : !there) seen.push('see' in want ? `“${text}” is shown${where}` : `“${text}” isn't shown${where}`);
        else {
          misses.push('see' in want ? `“${text}” isn't shown${where}` : `“${text}” is still shown${where}`);
          if ('see' in want && !want.within) notShown.push(text);
        }
      } else {
        const { target, name, value } = want.attr;
        const actual = await evaluate<string | null | undefined>(`(() => { const e = (${FIND})(${JSON.stringify(target)}); return e ? e.getAttribute(${JSON.stringify(name)}) : undefined; })()`);
        if (actual === undefined) misses.push(`couldn't find ${describe(target)}`);
        else if (actual === value) seen.push(`${describe(target)} has ${name}=${JSON.stringify(value)}`);
        else misses.push(`${describe(target)} has ${name}=${JSON.stringify(actual)}, not ${JSON.stringify(value)}`);
      }
    }
    const thrown = [...new Set(chrome.thrown)];
    const did = done.length ? `${done.join(', ')}: ` : '';
    const after = misses.length || thrown.length ? ((await evaluate<string>(`document.body ? document.body.innerText.replace(/\\s+/g, ' ').trim().slice(0, 3000) : ''`)) ?? '') : undefined;
    if (thrown.length) return { ok: false, ran: true, found: `${did}the page threw: ${thrown.slice(0, 2).join('; ')}`, after };
    if (misses.length) return { ok: false, ran: true, found: `${did}${misses.join('; ')}`, ...(notShown.length === misses.length ? { missing: notShown } : {}), after };
    return { ok: true, ran: true, found: `${did}${seen.join('; ') || 'as expected'}` };
  } catch (e) {
    return { ok: false, ran: false, found: `the run couldn't finish: ${e instanceof Error ? e.message : String(e)}` };
  } finally {
    chrome.close();
  }
}

/** A target in words: "the button “Delete”". */
export function describe(t: Target): string {
  if (t.selector) return `“${t.selector}”`;
  const what = t.role && t.role !== 'any' ? (t.role === 'textbox' ? 'the box' : `the ${t.role}`) : 'the text';
  return `${what} “${t.name ?? t.text ?? ''}”`;
}
