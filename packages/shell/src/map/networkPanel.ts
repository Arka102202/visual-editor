// The Network panel: every call the app in the Webview makes (through Visual Editor's proxy), and the fakes that answer
// instead of the backend. Calls: method, address, status, time, size, and which fake answered; a click shows the
// request and the answer, and "Fake this" turns a real answer into a case (or makes an empty one, an error, a slow
// one, a dropped connection). Fakes: each endpoint with the case it uses (a switch), its cases (edited here), the
// scenario in use, and the headers the proxy adds (kept secret). Contracts: the project's (found, or listed), each
// operation with an example answer and "Fake from the contract"; calls whose answer differs from the contract are
// marked, with the differences. Plain DOM.

import type { FromMap } from '../mapMessages';
import type { Recorded } from '../proxy/proxy';
import type { FakeCase, FakeEndpoint, Scenarios } from '../proxy/fakes';
import type { ContractInfo, ContractRef } from '../contracts/contracts';
import { endpointId, fits, patternFor } from '../proxy/fakePaths';
import { el } from '../ui/dom';
import { iconButton, tray } from '../ui/buttons';

export const NETWORK_CSS = `
  .nw { display: flex; flex-direction: column; height: 100%; font-size: 12px; }
  .nw-bar { display: flex; align-items: center; gap: 6px; padding: 5px 8px; border-bottom: 1px solid var(--vscode-panel-border, #8883); flex: none; min-width: 0; }
  .nw-bar input { flex: 1; min-width: 70px; font: inherit; font-size: 12px; padding: 3px 7px; border-radius: 4px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, #8884); }
  .nw select { font: inherit; font-size: 12px; padding: 2px 4px; border-radius: 4px; color: var(--vscode-dropdown-foreground); background: var(--vscode-dropdown-background); border: 1px solid var(--vscode-dropdown-border, #8884); max-width: 180px; }
  .nw-bar .views button.on, .nw-bar button.icon.on { background: var(--vscode-toolbar-activeBackground, #8883); }
  .nw-body { flex: 1; min-height: 0; display: flex; flex-direction: column; }
  .nw-list { flex: 1; min-height: 60px; overflow: auto; }
  .nw-list.half { flex: 0 0 42%; border-bottom: 1px solid var(--vscode-panel-border, #8883); }
  .nw-row { display: grid; grid-template-columns: 52px minmax(0, 1fr) 46px 58px auto; gap: 8px; align-items: center; padding: 3px 10px; cursor: pointer; border-bottom: 1px solid color-mix(in srgb, var(--vscode-panel-border, #8883) 55%, transparent); font-family: var(--vscode-editor-font-family, monospace); }
  .nw-row:hover { background: #8881; }
  .nw-row.on { background: var(--vscode-list-activeSelectionBackground, #04395e); color: var(--vscode-list-activeSelectionForeground, inherit); }
  .nw-row .m { font-weight: 700; color: var(--tok-keyword, inherit); }
  .nw-row .u { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .nw-row .s { text-align: right; }
  .nw-row .s.ok { color: var(--vscode-charts-green, #89d185); }
  .nw-row .s.warn { color: var(--vscode-editorWarning-foreground, #cca700); }
  .nw-row .s.bad { color: var(--vscode-errorForeground, #f48771); }
  .nw-row .t { text-align: right; opacity: .65; }
  .nw-row .f { font-family: var(--vscode-font-family, system-ui); font-size: 10px; padding: 0 6px; border-radius: 8px; white-space: nowrap; color: var(--tok-function, #b180d7); background: color-mix(in srgb, var(--tok-function, #b180d7) 16%, transparent); }
  .nw-row.page { opacity: .6; }
  .nw-row .bd { display: flex; gap: 4px; }
  .nw-row .c { font-family: var(--vscode-font-family, system-ui); font-size: 10px; padding: 0 6px; border-radius: 8px; white-space: nowrap; color: var(--vscode-editorWarning-foreground, #cca700); background: color-mix(in srgb, var(--vscode-editorWarning-foreground, #cca700) 16%, transparent); }
  .nw-issues { margin: 0; padding-left: 18px; font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; }
  .nw-issues li { margin: 2px 0; color: var(--vscode-editorWarning-foreground, #cca700); }
  .nw-ok { color: var(--vscode-charts-green, #89d185); }
  .nw-ct .kind { font-size: 10px; padding: 0 6px; border-radius: 8px; margin-right: 6px; color: var(--tok-type, #4ec9b0); background: color-mix(in srgb, var(--tok-type, #4ec9b0) 16%, transparent); }
  .nw-ct .err { color: var(--vscode-errorForeground, #f48771); font-size: 11px; margin-top: 4px; }
  .nw-ct .nw-case select { max-width: 70px; }
  .nw-ct pre { margin: 2px 0 6px 6px; }
  .nw-add { display: flex; gap: 6px; align-items: center; margin-bottom: 8px; }
  .nw-add input, .nw-add select { flex: 1; min-width: 0; font: inherit; font-size: 12px; padding: 3px 7px; border-radius: 4px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, #8884); }
  .nw-add select { flex: 0 1 140px; max-width: 140px; }
  .nw-detail { flex: 1; min-height: 0; overflow: auto; padding: 8px 10px 14px; }
  .nw-detail .title { font-family: var(--vscode-editor-font-family, monospace); font-weight: 600; word-break: break-all; margin-bottom: 6px; }
  .nw-detail .acts { gap: 4px; margin: 4px 0 8px; }
  .nw-detail h4, .nw-fakes h4 { margin: 12px 0 4px; font-size: 11px; letter-spacing: .05em; text-transform: uppercase; opacity: .65; }
  .nw pre { margin: 0; padding: 6px 8px; border-radius: 4px; background: color-mix(in srgb, var(--vscode-foreground) 6%, transparent); font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; white-space: pre-wrap; word-break: break-word; max-height: 360px; overflow: auto; }
  .nw table { border-collapse: collapse; width: 100%; font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; }
  .nw td { padding: 1px 4px; vertical-align: top; word-break: break-all; }
  .nw td.k { color: var(--tok-property, #9cdcfe); width: 34%; white-space: nowrap; }
  .nw-fakes { flex: 1; overflow: auto; padding: 8px 10px 14px; }
  .nw-ep { border-radius: 6px; background: var(--vscode-editorWidget-background, #8881); padding: 6px 8px; margin-bottom: 8px; }
  /* Two lines: the address (cut short; all of it on hover), then the case in use with the endpoint's tools. */
  .nw-ep .head { display: flex; flex-direction: column; gap: 6px; }
  .nw-ep .addr { min-width: 0; font-family: var(--vscode-editor-font-family, monospace); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .nw-ep .ctl { display: flex; gap: 8px; align-items: center; min-width: 0; }
  .nw-ep .ctl select { flex: 1 1 0; min-width: 60px; max-width: none; }
  .nw-ep .ctl .tray { flex: none; }
  .nw-ep .addr b { color: var(--tok-keyword, inherit); }
  .nw-ep .cases { margin-top: 6px; }
  .nw-case { display: flex; gap: 6px; align-items: center; padding: 2px 0 2px 6px; }
  .nw-case .n { font-weight: 600; }
  .nw-case .d { flex: 1; min-width: 0; opacity: .7; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .nw-case.on .n { color: var(--tok-function, #b180d7); }
  .nw-edit { margin: 6px 0 4px 6px; padding: 6px 8px; border-radius: 6px; border: 1px solid var(--vscode-panel-border, #8885); }
  .nw-edit label { display: flex; gap: 6px; align-items: center; margin: 3px 0; }
  .nw-edit label > span { width: 64px; opacity: .7; flex: none; }
  .nw-edit input[type=text], .nw-edit input[type=number] { flex: 1; min-width: 0; font: inherit; font-size: 12px; padding: 2px 6px; border-radius: 4px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, #8884); }
  .nw-edit textarea { width: 100%; box-sizing: border-box; min-height: 110px; font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, #8884); border-radius: 4px; padding: 5px 7px; resize: vertical; }
  .nw-edit .err { color: var(--vscode-errorForeground, #f48771); font-size: 11px; }
  .nw .empty { padding: 12px; opacity: .65; line-height: 1.5; }
  .nw .hint { opacity: .6; font-size: 11px; }
`;

/** The most calls kept in the panel. */
const MAX = 500;

/** Quick cases to make from a call. */
const QUICK: { name: string; tip: string; make(body: unknown): FakeCase }[] = [
  { name: 'empty', tip: 'Empty: an empty list (or object), as if there were nothing', make: (b) => ({ status: 200, body: Array.isArray(b) ? [] : b && typeof b === 'object' ? {} : '' }) },
  { name: 'server error', tip: 'Server error: status 500', make: () => ({ status: 500, body: { error: 'Something went wrong' } }) },
  { name: 'not allowed', tip: 'Not logged in: status 401', make: () => ({ status: 401, body: { error: 'Not logged in' } }) },
  { name: 'slow', tip: 'Slow: the real answer, 3 seconds late', make: () => ({ pass: true, delay: 3000 }) },
  { name: 'offline', tip: 'Offline: the connection drops (no answer at all)', make: () => ({ network: true }) },
];

export class NetworkPanel {
  readonly body = el('div', 'nw');
  private readonly bar = el('div', 'nw-bar');
  private readonly content = el('div', 'nw-body');
  private readonly search = el('input');
  private readonly scenarioPick = el('select');
  private calls: Recorded[] = [];
  private endpoints: FakeEndpoint[] = [];
  private scenarios: Scenarios = { scenarios: {} };
  private headers: string[] = [];
  private contracts: ContractInfo[] = [];
  private typeMap: Record<string, string> = {};
  /** Examples asked for (by their ref), and the one shown. */
  private readonly examples = new Map<string, { status?: number; body?: unknown; error?: string }>();
  private shownExample: string | undefined;
  /** Which answer of an operation to use (by its id). */
  private readonly statusOf = new Map<string, string>();
  private view: 'calls' | 'fakes' | 'contracts' | 'headers' = 'calls';
  private fakesSig = '';
  private contractsSig = '';
  /** What's typed in boxes (by their key), kept when the panel is drawn again. */
  private readonly drafts = new Map<string, string>();
  private selected: number | undefined;
  private showPages = false;
  /** The case being edited: endpoint id and case name (a new one has no name yet). */
  private editing: { id: string; name?: string } | undefined;
  /** Called when the count changes (for the panel's tab): calls, and calls answered by fakes. */
  onCounts: ((calls: number, faked: number) => void) | undefined;

  constructor(private readonly post: (m: FromMap) => void) {
    const views = tray(el('div', 'views'));
    const calls = iconButton('api', 'Calls: everything the app called');
    const fakes = iconButton('fake', 'Fakes: what answers instead of the backend');
    const contracts = iconButton('contract', 'Contracts: what the backend promises (OpenAPI, Swagger, Postman, HAR, JSON Schema, TypeScript, Zod, GraphQL); fake from them, and see where answers differ');
    const headers = iconButton('key', 'Headers the proxy adds to every call (a token, a cookie): kept secret, not in the project');
    for (const [b, v] of [[calls, 'calls'], [fakes, 'fakes'], [contracts, 'contracts'], [headers, 'headers']] as const) {
      b.dataset.view = v;
      b.addEventListener('click', () => {
        this.view = v;
        this.render();
      });
      views.append(b);
    }
    this.search.placeholder = 'Find a call';
    this.search.addEventListener('input', () => this.render());
    this.search.addEventListener('keydown', (e) => e.key === 'Escape' && (e.stopPropagation(), (this.search.value = ''), this.render()));
    this.scenarioPick.dataset.tip = 'Scenario: sets the case of many endpoints at once (it wins over each endpoint’s own choice)';
    this.scenarioPick.addEventListener('change', () => this.post({ type: 'saveScenarios', scenarios: { ...this.scenarios, ...(this.scenarioPick.value ? { active: this.scenarioPick.value } : { active: undefined }) } }));
    const pages = iconButton('pages', 'Show page loads too (not only calls)');
    pages.addEventListener('click', () => {
      this.showPages = !this.showPages;
      pages.classList.toggle('on', this.showPages);
      this.render();
    });
    const clear = iconButton('clear', 'Clear the list');
    clear.addEventListener('click', () => {
      this.calls = [];
      this.selected = undefined;
      this.render();
    });
    // The buttons first, then finding a call and the scenario.
    const tools = tray(el('div'));
    tools.append(pages, clear);
    this.bar.append(views, tools, this.search, this.scenarioPick);
    this.body.append(this.bar, this.content);
    this.render();
  }

  /** Calls the app made (`all`: these are all of them so far). */
  addCalls(list: Recorded[], all = false) {
    if (all) {
      this.calls = [...list];
      this.selected = undefined;
    } else this.calls.push(...list);
    if (this.calls.length > MAX) this.calls.splice(0, this.calls.length - MAX);
    this.onCounts?.(this.calls.filter((c) => c.kind === 'api').length, this.calls.filter((c) => c.faked).length);
    if (this.view === 'calls') this.render();
  }

  setFakes(endpoints: FakeEndpoint[], scenarios: Scenarios, headers: string[]) {
    // The same as shown: nothing to draw again (drawing again would take the cursor out of a box being typed in).
    const sig = JSON.stringify([endpoints, scenarios, headers]);
    if (sig === this.fakesSig) return;
    this.fakesSig = sig;
    this.endpoints = endpoints;
    this.scenarios = scenarios;
    this.headers = headers;
    this.render();
  }

  setContracts(list: ContractInfo[], map: Record<string, string>) {
    const sig = JSON.stringify([list, map]);
    if (sig === this.contractsSig) return;
    this.contractsSig = sig;
    this.contracts = list;
    this.typeMap = map;
    this.examples.clear();
    if (this.view === 'contracts' || this.view === 'fakes') this.render();
  }

  /** An example answer from the contract arrived. */
  showExample(m: { ref: ContractRef; status?: number; body?: unknown; error?: string }) {
    this.examples.set(JSON.stringify(m.ref), { status: m.status, body: m.body, error: m.error });
    if (this.view === 'contracts') this.render();
  }

  /** Draws the view again, keeping the box being typed in (its text, the cursor) as it was. */
  private render() {
    const active = document.activeElement as HTMLInputElement | HTMLTextAreaElement | null;
    const typing = active && this.body.contains(active) && active.dataset.keep ? { key: active.dataset.keep, from: active.selectionStart, to: active.selectionEnd } : undefined;
    this.draw();
    if (!typing) return;
    const again = [...this.body.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('[data-keep]')].find((x) => x.dataset.keep === typing.key);
    if (!again) return;
    again.focus();
    try {
      again.setSelectionRange(typing.from, typing.to);
    } catch {
      // Number boxes have no cursor position.
    }
  }

  /** A box whose text is kept when the panel is drawn again (until it's used: then `forget`). */
  private keep<T extends HTMLInputElement | HTMLTextAreaElement>(box: T, key: string): T {
    box.dataset.keep = key;
    const draft = this.drafts.get(key);
    if (draft !== undefined) box.value = draft;
    box.addEventListener('input', () => this.drafts.set(key, box.value));
    return box;
  }

  private forget(prefix: string) {
    for (const k of [...this.drafts.keys()]) if (k.startsWith(prefix)) this.drafts.delete(k);
  }

  private draw() {
    for (const b of this.bar.querySelectorAll<HTMLElement>('.views button')) b.classList.toggle('on', b.dataset.view === this.view);
    this.search.hidden = this.view !== 'calls';
    this.scenarioPick.replaceChildren(
      Object.assign(el('option', undefined, 'No scenario'), { value: '' }),
      ...Object.keys(this.scenarios.scenarios).map((n) => Object.assign(el('option', undefined, `Scenario: ${n}`), { value: n, selected: n === this.scenarios.active })),
    );
    this.scenarioPick.hidden = !Object.keys(this.scenarios.scenarios).length;
    if (this.view === 'calls') this.renderCalls();
    else if (this.view === 'fakes') this.renderFakes();
    else if (this.view === 'contracts') this.renderContracts();
    else this.renderHeaders();
  }

  // ---- Calls ----

  private renderCalls() {
    const q = this.search.value.trim().toLowerCase();
    const shown = this.calls.map((c, i) => [c, i] as const).filter(([c]) => (this.showPages || c.kind === 'api') && (!q || `${c.method} ${c.url} ${c.status ?? ''}`.toLowerCase().includes(q)));
    const list = el('div', `nw-list${this.selected !== undefined ? ' half' : ''}`);
    if (!shown.length) list.append(el('div', 'empty', this.calls.length ? 'No calls match.' : 'No calls yet. Calls the app makes (through Visual Editor) show here, with what answered them.'));
    for (const [c, i] of shown) {
      const row = el('div', `nw-row${c.kind === 'page' ? ' page' : ''}${i === this.selected ? ' on' : ''}`);
      const status = c.error ? 'failed' : String(c.status ?? '…');
      const cls = c.error || (c.status ?? 0) >= 500 ? 'bad' : (c.status ?? 0) >= 400 ? 'warn' : 'ok';
      row.append(el('span', 'm', c.method), el('span', 'u', c.url), el('span', `s ${cls}`, status), el('span', 't', c.ms !== undefined ? `${c.ms} ms` : ''));
      const badges = el('span', 'bd');
      if (c.faked) badges.append(el('span', 'f', `fake: ${c.faked.case}`));
      const off = c.contract?.issues.length ?? 0;
      if (off) badges.append(el('span', 'c', `${off} off contract`));
      row.append(badges);
      row.dataset.tip = `${c.method} ${c.url}\n${status}${c.ms !== undefined ? ` · ${c.ms} ms` : ''}${c.faked ? `\nAnswered by the fake “${c.faked.case}”` : ''}${c.contract ? `\n${off ? `Differs from the contract in ${off} place${off === 1 ? '' : 's'}` : 'Fits the contract'} (${c.contract.operation})` : ''}`;
      row.addEventListener('click', () => {
        this.selected = this.selected === i ? undefined : i;
        this.render();
      });
      list.append(row);
    }
    const parts: HTMLElement[] = [list];
    const call = this.selected !== undefined ? this.calls[this.selected] : undefined;
    if (call) parts.push(this.detail(call));
    const keep = this.content.querySelector('.nw-list')?.scrollTop ?? 0;
    this.content.replaceChildren(...parts);
    list.scrollTop = keep;
  }

  private detail(c: Recorded): HTMLElement {
    const box = el('div', 'nw-detail');
    box.append(el('div', 'title', `${c.method} ${c.url}`));
    box.append(el('div', 'hint', `${c.error ? `Failed: ${c.error}` : `Status ${c.status}`}${c.ms !== undefined ? ` · ${c.ms} ms` : ''}${c.faked ? ` · answered by the fake “${c.faked.case}”` : ''}`));
    if (c.kind === 'api') {
      const acts = tray(el('div', 'acts'));
      const fake = iconButton('fake', 'Fake this: keep this answer as a case and use it from now on (edit it in Fakes)', { cls: 'primary' });
      fake.addEventListener('click', () => this.fakeFrom(c, `as seen ${new Date(c.at).toLocaleTimeString()}`, this.caseFromAnswer(c)));
      acts.append(fake);
      for (const q of QUICK) {
        const b = iconButton(q.name === 'empty' ? 'clear' : q.name === 'slow' ? 'proposed' : q.name === 'offline' ? 'reject' : 'levelError', `${q.tip}: make this case and use it`);
        b.addEventListener('click', () => this.fakeFrom(c, q.name, q.make(parse(c.responseBody))));
        acts.append(b);
      }
      if (c.contract) {
        const fromContract = iconButton('contract', `From the contract: answer it with what ${c.contract.operation} promises (made from its example or its shape)`);
        fromContract.addEventListener('click', () => this.fakeFromContract([c.contract!.operation]));
        acts.append(fromContract);
      }
      const e = this.endpointFor(c);
      if (e) {
        const open = iconButton('code', `Open its fake (${e.id}.json)`);
        open.addEventListener('click', () => this.post({ type: 'openFake', id: e.id }));
        acts.append(open);
      }
      box.append(acts);
    }
    if (c.contract) {
      box.append(el('h4', undefined, 'Contract'));
      box.append(el('div', 'hint', `${c.contract.operation} · ${c.contract.source}`));
      if (c.contract.issues.length) {
        const ul = el('ul', 'nw-issues');
        for (const issue of c.contract.issues) ul.append(el('li', undefined, issue));
        box.append(ul);
      } else box.append(el('div', 'nw-ok', 'The answer fits the contract.'));
    }
    box.append(el('h4', undefined, 'Answer'), headers(c.responseHeaders ?? {}));
    if (c.responseBody) box.append(el('pre', undefined, pretty(c.responseBody)));
    box.append(el('h4', undefined, 'Request'), headers(c.requestHeaders));
    if (c.requestBody) box.append(el('pre', undefined, pretty(c.requestBody)));
    return box;
  }

  /** A call's address split for fakes: the pattern (/api/orders/:id) and, for another address, its origin. */
  private addressOf(c: Recorded): { path: string; origin?: string } {
    if (/^https?:\/\//.test(c.url)) {
      const u = new URL(c.url);
      return { path: patternFor(u.pathname), origin: u.origin };
    }
    return { path: patternFor(c.url) };
  }

  private endpointFor(c: Recorded): FakeEndpoint | undefined {
    const { origin } = this.addressOf(c);
    const path = /^https?:\/\//.test(c.url) ? new URL(c.url).pathname : c.url.split('?')[0];
    return this.endpoints.find((e) => e.method.toUpperCase() === c.method.toUpperCase() && (e.origin ?? undefined) === origin && fits(e.path, path));
  }

  /** The real answer as a case (status, body, its content type). */
  private caseFromAnswer(c: Recorded): FakeCase {
    const type = c.responseHeaders?.['content-type'];
    return { status: c.status ?? 200, ...(type && !/json/.test(type) ? { headers: { 'content-type': type } } : {}), body: parse(c.responseBody) };
  }

  /** Adds a case to the call's endpoint (made if there's none) and uses it. */
  private fakeFrom(c: Recorded, name: string, made: FakeCase) {
    const existing = this.endpointFor(c);
    const { path, origin } = this.addressOf(c);
    const endpoint: FakeEndpoint = existing
      ? { ...existing, use: name, cases: { ...existing.cases, [name]: made } }
      : { id: endpointId(c.method, path, origin), method: c.method.toUpperCase(), path, ...(origin ? { origin } : {}), use: name, cases: { [name]: made } };
    this.post({ type: 'saveFake', endpoint });
    this.view = 'fakes';
    this.editing = { id: endpoint.id, name };
    this.render();
  }

  // ---- Fakes ----

  private renderFakes() {
    const box = el('div', 'nw-fakes');
    if (!this.endpoints.length) {
      box.append(el('div', 'empty', 'No fakes yet. In Calls, pick a call and press “Fake this” (or empty, error, slow, offline). Fakes are kept in .visual-editor/api/ in the project, to commit and share.'));
    }
    for (const e of this.endpoints) box.append(this.endpoint(e));
    // Scenarios: the choices now, kept under a name.
    if (this.endpoints.length) {
      box.append(el('h4', undefined, 'Scenarios'));
      const row = el('div', 'nw-case');
      const name = this.keep(el('input'), 'scenario-name');
      name.type = 'text';
      name.placeholder = 'A name, e.g. server down';
      name.addEventListener('keydown', (e) => e.key === 'Escape' && e.stopPropagation());
      const save = iconButton('choose', 'Keep the cases in use now as a scenario with this name');
      save.addEventListener('click', () => {
        const n = name.value.trim();
        if (!n) return;
        const uses = Object.fromEntries(this.endpoints.map((x) => [x.id, x.use]));
        this.forget('scenario-name');
        this.post({ type: 'saveScenarios', scenarios: { ...this.scenarios, scenarios: { ...this.scenarios.scenarios, [n]: uses } } });
      });
      row.append(name, save);
      box.append(row);
      for (const [n, uses] of Object.entries(this.scenarios.scenarios)) {
        const r = el('div', `nw-case${n === this.scenarios.active ? ' on' : ''}`);
        r.append(el('span', 'n', n), el('span', 'd', Object.entries(uses).map(([id, u]) => `${id}: ${u}`).join(', ')));
        const use = iconButton('choose', n === this.scenarios.active ? 'In use: stop using it' : 'Use this scenario', n === this.scenarios.active ? { cls: 'on' } : {});
        use.addEventListener('click', () => this.post({ type: 'saveScenarios', scenarios: { ...this.scenarios, active: n === this.scenarios.active ? undefined : n } }));
        const del = iconButton('trash', `Remove the scenario “${n}”`);
        del.addEventListener('click', () => {
          const rest = { ...this.scenarios.scenarios };
          delete rest[n];
          this.post({ type: 'saveScenarios', scenarios: { scenarios: rest, ...(this.scenarios.active && this.scenarios.active !== n ? { active: this.scenarios.active } : {}) } });
        });
        r.append(tray(el('div')));
        r.lastElementChild!.append(use, del);
        box.append(r);
      }
    }
    this.content.replaceChildren(box);
  }

  private endpoint(e: FakeEndpoint): HTMLElement {
    const box = el('div', 'nw-ep');
    const head = el('div', 'head');
    const addr = el('span', 'addr');
    addr.append(el('b', undefined, e.method), ` ${e.origin ? e.origin : ''}${e.path}`);
    addr.dataset.tip = `${e.method} ${e.origin ?? ''}${e.path}`;
    const pick = el('select');
    pick.append(Object.assign(el('option', undefined, 'Pass (the real backend)'), { value: 'pass', selected: e.use === 'pass' }));
    for (const n of Object.keys(e.cases)) pick.append(Object.assign(el('option', undefined, n), { value: n, selected: e.use === n }));
    pick.dataset.tip = 'The case it uses now';
    pick.addEventListener('change', () => this.post({ type: 'useCase', id: e.id, use: pick.value }));
    const tools = tray(el('div'));
    const add = iconButton('add', 'Add a case');
    add.addEventListener('click', () => {
      this.editing = { id: e.id };
      this.render();
    });
    const open = iconButton('code', `Open ${e.id}.json`);
    open.addEventListener('click', () => this.post({ type: 'openFake', id: e.id }));
    const del = iconButton('trash', 'Remove this fake (calls go to the real backend)');
    del.addEventListener('click', () => this.post({ type: 'removeFake', id: e.id }));
    tools.append(add, open, del);
    const ctl = el('div', 'ctl');
    ctl.append(pick, tools);
    head.append(addr, ctl);
    box.append(head);
    const cases = el('div', 'cases');
    for (const [n, c] of Object.entries(e.cases)) {
      const row = el('div', `nw-case${e.use === n ? ' on' : ''}`);
      row.append(el('span', 'n', n), el('span', 'd', describe(c)));
      const edit = iconButton('changed', `Change the case “${n}”`);
      edit.addEventListener('click', () => {
        this.editing = this.editing?.id === e.id && this.editing.name === n ? undefined : { id: e.id, name: n };
        this.render();
      });
      const del = iconButton('trash', `Remove the case “${n}”`);
      del.addEventListener('click', () => {
        const rest = { ...e.cases };
        delete rest[n];
        this.post({ type: 'saveFake', endpoint: { ...e, cases: rest, use: e.use === n ? 'pass' : e.use } });
      });
      row.append(tray(el('div')));
      row.lastElementChild!.append(edit, del);
      cases.append(row);
      if (this.editing?.id === e.id && this.editing.name === n) cases.append(this.editor(e, n, c));
    }
    if (this.editing?.id === e.id && !this.editing.name) cases.append(this.editor(e, undefined, { status: 200, body: {} }));
    box.append(cases);
    return box;
  }

  /** Changing (or making) a case: its name, status, delay, whether it passes the call on, and its body or changes. */
  private editor(e: FakeEndpoint, name: string | undefined, c: FakeCase): HTMLElement {
    const box = el('div', 'nw-edit');
    const field = (label: string, input: HTMLElement) => {
      const l = el('label');
      l.append(el('span', undefined, label), input);
      return l;
    };
    const draft = `case:${e.id}:${name ?? ''}:`;
    const input = (type: string, value: string, placeholder = '') => {
      const i = el('input');
      i.type = type;
      i.value = value;
      i.placeholder = placeholder;
      i.addEventListener('keydown', (ev) => ev.key === 'Escape' && ev.stopPropagation());
      return i;
    };
    const nameBox = this.keep(input('text', name ?? '', 'e.g. empty, admin, expired'), `${draft}name`);
    const kind = el('select');
    for (const [v, t] of [['answer', 'Answers itself'], ['contract', 'From the contract'], ['pass', 'Real answer, changed'], ['network', 'Connection drops']] as const) {
      kind.append(Object.assign(el('option', undefined, t), { value: v, selected: v === (c.network ? 'network' : c.pass ? 'pass' : c.contract ? 'contract' : 'answer') }));
    }
    // From the contract: which operation (or type), and another set of made-up values.
    const from = el('select');
    const ops = this.contracts.flatMap((x) => x.operations.map((o) => o.id));
    const fitting = ops.find((id) => {
      const [m, path] = id.split(' ');
      return m === e.method.toUpperCase() && path === e.path;
    });
    from.append(Object.assign(el('option', undefined, fitting ? `The one that fits (${fitting})` : 'The one that fits the call'), { value: '' }));
    for (const id of ops) from.append(Object.assign(el('option', undefined, id), { value: `op:${id}`, selected: c.contract?.operation === id }));
    for (const t of this.contracts.flatMap((x) => x.types)) {
      for (const v of [t, `${t}[]`]) from.append(Object.assign(el('option', undefined, `Type: ${v}`), { value: `type:${v}`, selected: c.contract?.type === v }));
    }
    from.dataset.tip = 'What in the contract it answers with';
    const seed = this.keep(input('number', c.contract?.seed ? String(c.contract.seed) : '', '0'), `${draft}seed`);
    seed.dataset.tip = 'Another number: other made-up values (names, numbers, which enum value)';
    const fromRow = field('From', from);
    const seedRow = field('Values', seed);
    const status = this.keep(input('number', c.status ? String(c.status) : c.contract?.status ?? '', c.pass ? 'as it is' : '200'), `${draft}status`);
    const delay = this.keep(input('number', c.delay ? String(c.delay) : '', '0'), `${draft}delay`);
    const body = el('textarea');
    body.spellcheck = false;
    body.addEventListener('keydown', (ev) => ev.key === 'Escape' && ev.stopPropagation());
    const bodyLabel = el('div', 'hint');
    const sync = () => {
      const k = kind.value;
      bodyLabel.textContent = k === 'pass' ? 'Fields to set in the real answer, by path: { "items.0.status": "paid" }' : k === 'contract' ? 'Fields to set in the answer made from the contract (if any): { "items.0.status": "paid" }' : k === 'answer' ? 'The answer (JSON, or text)' : '';
      body.hidden = k === 'network';
      status.disabled = k === 'network';
      fromRow.hidden = seedRow.hidden = k !== 'contract';
      status.placeholder = k === 'contract' ? 'its first success' : k === 'pass' ? 'as it is' : '200';
    };
    body.value = c.pass || c.contract ? (c.patch ? JSON.stringify(c.patch, null, 2) : '') : typeof c.body === 'string' ? c.body : c.body === undefined ? '' : JSON.stringify(c.body, null, 2);
    this.keep(body, `${draft}body`);
    kind.addEventListener('change', () => {
      body.value = kind.value === 'pass' || kind.value === 'contract' ? '' : body.value;
      sync();
    });
    const err = el('div', 'err');
    const save = iconButton('choose', 'Keep this case (and use it)', { cls: 'primary' });
    save.addEventListener('click', () => {
      const n = nameBox.value.trim();
      if (!n || n === 'pass') return void (err.textContent = 'Give it a name (not “pass”).');
      const k = kind.value;
      let made: FakeCase;
      if (k === 'network') made = { network: true };
      else if (k === 'pass' || k === 'contract') {
        let patchFields: Record<string, unknown> | undefined;
        if (body.value.trim()) {
          try {
            patchFields = JSON.parse(body.value);
          } catch {
            return void (err.textContent = 'The changes must be JSON: { "items.0.status": "paid" }');
          }
        }
        if (k === 'pass') made = { pass: true, ...(patchFields ? { patch: patchFields } : {}) };
        else {
          const ref: ContractRef = from.value.startsWith('op:') ? { operation: from.value.slice(3) } : from.value.startsWith('type:') ? { type: from.value.slice(5) } : {};
          if (status.value) ref.status = status.value;
          if (Number(seed.value)) ref.seed = Number(seed.value);
          made = { contract: ref, ...(patchFields ? { patch: patchFields } : {}) };
        }
      } else made = { body: parse(body.value) };
      if (status.value && k !== 'network' && k !== 'contract') made.status = Number(status.value);
      if (delay.value) made.delay = Number(delay.value);
      const cases = { ...e.cases };
      if (name && name !== n) delete cases[name];
      cases[n] = made;
      this.editing = undefined;
      this.forget(draft);
      this.post({ type: 'saveFake', endpoint: { ...e, cases, use: n } });
    });
    const cancel = iconButton('close', 'Never mind');
    cancel.addEventListener('click', () => {
      this.editing = undefined;
      this.forget(draft);
      this.render();
    });
    const acts = tray(el('div', 'acts'));
    acts.append(save, cancel);
    box.append(field('Name', nameBox), field('Kind', kind), fromRow, seedRow, field('Status', status), field('Delay ms', delay), bodyLabel, body, err, acts);
    sync();
    return box;
  }

  /** Fakes operations from the contract (the answer each one uses: its chosen status), then shows the fakes. */
  private fakeFromContract(operations: string[]) {
    const status = operations.length === 1 ? this.statusOf.get(operations[0]) : undefined;
    this.post({ type: 'fakeFromContract', operations, ...(status ? { status } : {}) });
    this.view = 'fakes';
    this.render();
  }

  // ---- Contracts ----

  private renderContracts() {
    const box = el('div', 'nw-fakes');
    const add = el('div', 'nw-add');
    const source = this.keep(el('input'), 'contract-source');
    source.type = 'text';
    source.placeholder = 'A file in the project, or an address (/v3/api-docs)';
    source.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') e.stopPropagation();
      if (e.key === 'Enter') go();
    });
    const go = () => {
      if (!source.value.trim()) return;
      this.post({ type: 'addContract', source: source.value.trim() });
      source.value = '';
      this.forget('contract-source');
    };
    const addB = iconButton('add', 'Use this contract too (kept in .visual-editor/contracts.json)', { cls: 'primary' });
    addB.addEventListener('click', go);
    const reload = iconButton('reload', 'Read the contracts again');
    reload.addEventListener('click', () => this.post({ type: 'reloadContracts' }));
    const t = tray(el('div'));
    t.append(addB, reload);
    add.append(source, t);
    box.append(add);
    if (!this.contracts.length) {
      box.append(el('div', 'empty', 'No contracts found. Files named openapi.yaml, swagger.json, *.postman_collection.json, *.har, *.schema.json or schema.graphql are found by themselves. Add others above: TypeScript types, Zod schemas, JSON examples, or an address the backend serves its contract at.'));
    }
    for (const c of this.contracts) box.append(this.contractCard(c));
    const types = this.contracts.flatMap((c) => c.types);
    if (types.length) box.append(...this.typeMapping(types));
    this.content.replaceChildren(box);
  }

  private contractCard(c: ContractInfo): HTMLElement {
    const box = el('div', 'nw-ep nw-ct');
    const head = el('div', 'head');
    const addr = el('span', 'addr');
    const kind = c.error && /^(https?:)?\//.test(c.source) ? 'Address' : (KINDS[c.kind] ?? c.kind);
    addr.append(el('span', 'kind', kind), c.title ? `${c.title} · ${c.source}` : c.source);
    addr.dataset.tip = `${kind}: ${c.source}${c.found ? ' (found by its name)' : ' (listed in contracts.json)'}${c.title ? `\n${c.title}` : ''}\n${c.operations.length} endpoint${c.operations.length === 1 ? '' : 's'}, ${c.types.length} type${c.types.length === 1 ? '' : 's'}`;
    const tools = tray(el('div'));
    if (c.operations.length && c.source !== '.visual-editor/contracts.json') {
      const all = iconButton('fake', `Fake all ${c.operations.length} endpoints from this contract (for a backend that isn’t ready)`);
      all.addEventListener('click', () => this.fakeFromContract(c.operations.map((o) => o.id)));
      tools.append(all);
    }
    const open = iconButton('code', /^https?:/.test(c.source) ? 'Open the address' : `Open ${c.source}`);
    open.addEventListener('click', () => this.post({ type: 'openContract', source: c.source }));
    const del = iconButton('trash', c.found ? 'Don’t use this contract (it was found by its name: it’s ignored from now on)' : 'Don’t use this contract');
    del.addEventListener('click', () => this.post({ type: 'removeContract', source: c.source }));
    if (c.source !== '.visual-editor/contracts.json') tools.append(open, del);
    head.append(addr);
    if (tools.childElementCount) {
      const ctl = el('div', 'ctl');
      ctl.append(tools);
      head.append(ctl);
    }
    box.append(head);
    if (c.error) box.append(el('div', 'err', c.error));
    const rows = el('div', 'cases');
    for (const o of c.operations) {
      const row = el('div', 'nw-case');
      row.append(el('span', 'n', o.method), el('span', 'd', o.path));
      row.dataset.tip = `${o.id}${o.summary ? `\n${o.summary}` : ''}${o.statuses.length ? `\nAnswers: ${o.statuses.join(', ')}` : ''}`;
      if (o.statuses.length > 1) {
        const pick = el('select');
        for (const st of o.statuses) pick.append(Object.assign(el('option', undefined, st), { value: st, selected: st === (this.statusOf.get(o.id) ?? o.statuses.find((x) => /^2/.test(x)) ?? o.statuses[0]) }));
        pick.dataset.tip = 'Which of its answers to show and fake with';
        pick.addEventListener('change', () => {
          this.statusOf.set(o.id, pick.value);
          this.shownExample = undefined;
          this.render();
        });
        row.append(pick);
      }
      const ref: ContractRef = { operation: o.id, ...(this.statusOf.get(o.id) ? { status: this.statusOf.get(o.id) } : {}) };
      const acts = tray(el('div'));
      if (c.kind !== 'graphql') acts.append(this.exampleButton(ref));
      const fake = iconButton('fake', 'Fake it from the contract (a case made from this answer, used now)');
      fake.addEventListener('click', () => this.fakeFromContract([o.id]));
      acts.append(fake);
      row.append(acts);
      rows.append(row);
      if (this.shownExample === JSON.stringify(ref)) rows.append(this.example(ref));
    }
    if (!c.operations.length) {
      for (const name of c.types) {
        const row = el('div', 'nw-case');
        row.append(el('span', 'n', name), el('span', 'd', 'a type'));
        const ref: ContractRef = { type: name };
        row.append(this.exampleButton(ref));
        rows.append(row);
        if (this.shownExample === JSON.stringify(ref)) rows.append(this.example(ref));
      }
    }
    box.append(rows);
    return box;
  }

  private exampleButton(ref: ContractRef): HTMLElement {
    const key = JSON.stringify(ref);
    const b = iconButton('example', this.shownExample === key ? 'Hide the example' : 'Show an example answer made from the contract', this.shownExample === key ? { cls: 'on' } : {});
    b.addEventListener('click', () => {
      this.shownExample = this.shownExample === key ? undefined : key;
      if (this.shownExample && !this.examples.has(key)) this.post({ type: 'contractExample', ref });
      this.render();
    });
    return b;
  }

  private example(ref: ContractRef): HTMLElement {
    const got = this.examples.get(JSON.stringify(ref));
    if (!got) return el('div', 'hint', 'Making an example…');
    if (got.error) return el('div', 'hint', got.error);
    return el('pre', undefined, `${got.status ? `Status ${got.status}\n` : ''}${JSON.stringify(got.body, null, 2)}`);
  }

  /** contracts.json's "map": which type an endpoint answers with (for contracts that only have types). */
  private typeMapping(types: string[]): HTMLElement[] {
    const out: HTMLElement[] = [el('h4', undefined, 'Endpoints answered with a type')];
    out.push(el('div', 'hint', 'For contracts with types only (TypeScript, Zod, JSON Schema): say which type an endpoint answers with, and its answers are checked and can be faked.'));
    for (const [op, type] of Object.entries(this.typeMap)) {
      const row = el('div', 'nw-case');
      row.append(el('span', 'n', op), el('span', 'd', `→ ${type}`));
      row.dataset.tip = `${op} answers with ${type}`;
      const del = iconButton('trash', 'Forget this');
      del.addEventListener('click', () => this.post({ type: 'mapType', operation: op }));
      row.append(del);
      out.push(row);
    }
    const form = el('div', 'nw-add');
    const op = this.keep(el('input'), 'map-op');
    op.type = 'text';
    op.placeholder = 'GET /api/orders/:id';
    op.addEventListener('keydown', (e) => e.key === 'Escape' && e.stopPropagation());
    const pick = el('select');
    for (const t of types) {
      pick.append(Object.assign(el('option', undefined, t), { value: t }));
      pick.append(Object.assign(el('option', undefined, `${t}[] (a list)`), { value: `${t}[]` }));
    }
    pick.dataset.tip = 'The type it answers with';
    const add = iconButton('add', 'This endpoint answers with this type', { cls: 'primary' });
    add.addEventListener('click', () => {
      const v = op.value.trim().replace(/\s+/g, ' ');
      if (!/^[A-Za-z]+ \//.test(v)) return void (op.placeholder = 'A method and an address: GET /api/orders');
      const [m, path] = v.split(' ');
      this.post({ type: 'mapType', operation: `${m.toUpperCase()} ${path}`, typeName: pick.value });
      op.value = '';
      this.forget('map-op');
    });
    form.append(op, pick, add);
    out.push(form);
    return out;
  }

  // ---- Headers ----

  private renderHeaders() {
    const box = el('div', 'nw-fakes');
    box.append(el('div', 'hint', 'Headers the proxy adds to every call the app makes (an Authorization token, a Cookie). Kept in VS Code’s secret storage, never in the project. Their values aren’t shown again.'));
    for (const name of this.headers) {
      const row = el('div', 'nw-case');
      row.append(el('span', 'n', name), el('span', 'd', '•••••• (kept secret)'));
      const del = iconButton('trash', `Stop adding ${name}`);
      del.addEventListener('click', () => this.post({ type: 'setHeaders', headers: { [name]: null } }));
      row.append(del);
      box.append(row);
    }
    const row = el('div', 'nw-edit');
    const name = this.keep(el('input'), 'header-name');
    name.type = 'text';
    name.placeholder = 'Name, e.g. Authorization';
    const value = this.keep(el('input'), 'header-value');
    value.type = 'password';
    value.placeholder = 'Value, e.g. Bearer eyJ…';
    for (const i of [name, value]) i.addEventListener('keydown', (e) => e.key === 'Escape' && e.stopPropagation());
    const add = iconButton('add', 'Add this header to every call', { cls: 'primary' });
    add.addEventListener('click', () => {
      if (!name.value.trim()) return;
      this.post({ type: 'setHeaders', headers: { [name.value.trim()]: value.value } });
      name.value = value.value = '';
      this.forget('header-');
    });
    const l1 = el('label');
    l1.append(el('span', undefined, 'Name'), name);
    const l2 = el('label');
    l2.append(el('span', undefined, 'Value'), value);
    row.append(l1, l2, add);
    box.append(row);
    this.content.replaceChildren(box);
  }
}

/** A case in a few words. */
function describe(c: FakeCase): string {
  if (c.contract) {
    const what = c.contract.operation ?? c.contract.type ?? 'the one that fits';
    return `from the contract: ${what}${c.contract.status ? `, answer ${c.contract.status}` : ''}${c.contract.seed ? `, values #${c.contract.seed}` : ''}${c.patch ? `, ${Object.keys(c.patch).length} field${Object.keys(c.patch).length === 1 ? '' : 's'} changed` : ''}${c.delay ? `, ${c.delay} ms late` : ''}`;
  }
  if (c.network) return `connection drops${c.delay ? ` after ${c.delay} ms` : ''}`;
  if (c.pass) return `real answer${c.status ? `, status ${c.status}` : ''}${c.patch ? `, ${Object.keys(c.patch).length} field${Object.keys(c.patch).length === 1 ? '' : 's'} changed` : ''}${c.delay ? `, ${c.delay} ms late` : ''}`;
  const body = typeof c.body === 'string' ? c.body : JSON.stringify(c.body ?? '');
  return `${c.status ?? 200}${c.delay ? ` after ${c.delay} ms` : ''} · ${body.length > 60 ? `${body.slice(0, 58)}…` : body}`;
}

/** Contract kinds in a word. */
const KINDS: Record<string, string> = { openapi: 'OpenAPI', swagger: 'Swagger', postman: 'Postman', har: 'HAR', 'json-schema': 'JSON Schema', 'json-example': 'JSON', typescript: 'TypeScript', zod: 'Zod', graphql: 'GraphQL' };

/** JSON when it is JSON, else the text. */
function parse(text: string | undefined): unknown {
  if (text === undefined) return '';
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function pretty(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

function headers(h: Record<string, string>): HTMLElement {
  const table = el('table');
  for (const [k, v] of Object.entries(h)) {
    const tr = el('tr');
    tr.append(el('td', 'k', k), el('td', undefined, /^(authorization|cookie|set-cookie)$/i.test(k) ? '•••••• (hidden)' : v));
    table.append(tr);
  }
  return table;
}
