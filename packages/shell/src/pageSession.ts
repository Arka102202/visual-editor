// A page the tester (a Claude that tries scenarios like a person: tester.ts) works in: a hidden browser on the
// change's own app. It reads the page the way a person would see it, in words: its text, and every control that can be
// clicked or typed into, numbered; it clicks and types by those numbers, presses keys, waits, and takes pictures for
// the tester to look at. Errors the page throws are always said. No VS Code APIs.

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { load, type Chrome } from './caseRunner';
import { openChrome } from './pictures';

/** Numbers every visible control (data-ve-ref) and says what each is; with the page's text. Run in the page. */
const READ = `(() => {
  const visible = (e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const sel = 'a[href],button,input,textarea,select,summary,[role=button],[role=link],[role=checkbox],[role=switch],[role=tab],[role=menuitem],[role=option],[role=textbox],[contenteditable=true],[tabindex]:not([tabindex="-1"])';
  const role = (e) => e.getAttribute('role') || ({ A: 'link', BUTTON: 'button', SELECT: 'select', TEXTAREA: 'textbox', SUMMARY: 'button' })[e.tagName] || (e.tagName === 'INPUT' ? ({ checkbox: 'checkbox', radio: 'radio', button: 'button', submit: 'button', range: 'slider' })[e.type] || 'textbox' : 'element');
  const clean = (t) => (t || '').replace(/\\s+/g, ' ').trim().slice(0, 80);
  const lines = [];
  let n = 0;
  document.querySelectorAll('[data-ve-ref]').forEach((e) => e.removeAttribute('data-ve-ref'));
  for (const e of document.querySelectorAll(sel)) {
    if (!visible(e) || n >= 150) continue;
    n++;
    e.setAttribute('data-ve-ref', String(n));
    const label = clean(e.getAttribute('aria-label') || (e.labels && [...e.labels].map((l) => l.textContent).join(' ')) || e.getAttribute('title') || e.textContent);
    const extra = [
      e.placeholder ? 'placeholder ' + JSON.stringify(clean(e.placeholder)) : '',
      'value' in e && e.value && e.tagName !== 'BUTTON' ? 'value ' + JSON.stringify(clean(String(e.value))) : '',
      e.getAttribute('aria-label') ? 'its label is hidden (screen readers only)' : '',
      e.checked ? 'checked' : '',
      e.disabled ? 'disabled' : '',
      e.getAttribute('aria-expanded') ? 'expanded=' + e.getAttribute('aria-expanded') : '',
      e.getAttribute('aria-pressed') ? 'pressed=' + e.getAttribute('aria-pressed') : '',
    ].filter(Boolean).join(', ');
    lines.push('[' + n + '] ' + role(e) + ' ' + JSON.stringify(label) + (extra ? ' (' + extra + ')' : ''));
  }
  const html = [...document.documentElement.attributes].filter((a) => !a.name.startsWith('data-ve')).map((a) => a.name + '=' + JSON.stringify(a.value)).join(' ');
  return { controls: lines.join('\\n'), text: clean(document.body ? document.body.innerText : '').length ? (document.body.innerText || '').replace(/\\n{3,}/g, '\\n\\n').trim().slice(0, 5000) : '', html };
})()`;

export class PageSession {
  private chrome: Chrome | undefined;
  private page: Awaited<ReturnType<Chrome['page']>> | undefined;
  private shots = 0;

  /** `dir`: where its pictures go. */
  constructor(private readonly dir: string) {}

  private async settle() {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const until = Date.now() + 3000;
    await sleep(150);
    while (Date.now() < until && !this.chrome!.quiet(300)) await sleep(100);
  }

  private errors(): string {
    const thrown = [...new Set(this.chrome?.thrown ?? [])];
    return thrown.length ? `\nErrors on the page: ${thrown.slice(0, 3).join('; ')}` : '';
  }

  async open(url: string): Promise<string> {
    this.chrome ??= openChrome();
    this.page = await load(this.chrome, url, Date.now() + 30_000);
    return `Opened ${url}.\n${await this.read()}`;
  }

  /** The page in words: its own attributes, the controls (numbered), and its text. */
  async read(): Promise<string> {
    if (!this.page) return 'No page is open: open one first.';
    const r = await this.page.evaluate<{ controls: string; text: string; html: string }>(READ);
    return `<html ${r?.html ?? ''}>\nControls (click or type by number):\n${r?.controls || '(none)'}\nText on the page:\n${r?.text || '(none)'}${this.errors()}`;
  }

  private async control(ref: number): Promise<boolean> {
    return !!(await this.page!.evaluate<boolean>(`!!document.querySelector('[data-ve-ref="${Number(ref)}"]')`));
  }

  async click(ref: number): Promise<string> {
    if (!this.page) return 'No page is open.';
    if (!(await this.control(ref))) return `There's no control [${ref}] now: read the page again.`;
    await this.page.evaluate(`(() => { const e = document.querySelector('[data-ve-ref="${Number(ref)}"]'); e.scrollIntoView({ block: 'center' }); e.click(); })()`);
    await this.settle();
    return `Clicked [${ref}].${this.errors()}`;
  }

  /** Types into a box the way a person does (what was there is replaced), so the app's own events see it. */
  async type(ref: number, text: string): Promise<string> {
    if (!this.page) return 'No page is open.';
    if (!(await this.control(ref))) return `There's no control [${ref}] now: read the page again.`;
    await this.page.evaluate(`(() => { const e = document.querySelector('[data-ve-ref="${Number(ref)}"]'); e.focus(); const set = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(e), 'value')?.set; if (set) set.call(e, ${JSON.stringify(text)}); else e.textContent = ${JSON.stringify(text)}; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await this.settle();
    return `Typed ${JSON.stringify(text)} into [${ref}].${this.errors()}`;
  }

  async press(key: string): Promise<string> {
    if (!this.page) return 'No page is open.';
    await this.chrome!.send('Input.dispatchKeyEvent', { type: 'keyDown', key, ...(key.length === 1 ? { text: key } : {}) }, this.page.sessionId);
    await this.chrome!.send('Input.dispatchKeyEvent', { type: 'keyUp', key }, this.page.sessionId);
    await this.settle();
    return `Pressed ${key}.${this.errors()}`;
  }

  async wait(ms: number): Promise<string> {
    await new Promise((r) => setTimeout(r, Math.max(0, Math.min(10_000, ms))));
    return `Waited ${ms} ms.${this.errors()}`;
  }

  /** A picture of what's on screen now: its file (a PNG to look at). */
  async picture(): Promise<string> {
    if (!this.page) return 'No page is open.';
    const shot = (await this.chrome!.send('Page.captureScreenshot', { format: 'png' }, this.page.sessionId)) as { data: string };
    const file = join(this.dir, `tester-${Date.now()}-${++this.shots}.png`);
    writeFileSync(file, Buffer.from(shot.data, 'base64'));
    return file;
  }

  close() {
    this.chrome?.close();
    this.chrome = undefined;
    this.page = undefined;
  }
}
