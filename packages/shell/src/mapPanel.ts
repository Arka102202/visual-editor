// The map: an editor tab that draws the shown project's cards and lines. It redraws when files or plugins change,
// and when another project is chosen.

import * as vscode from 'vscode';
import type { MapDefinition, PluginNudge, ProposedChange } from '@visual-editor/contract';
import { webviewPage } from './webviewPage';
import { isAbsolute, join } from 'node:path';
import { cardMarks, type OutsideChanges } from './changes';
import type { CurrentProject } from './currentProject';
import { layoutMap, type Arrange } from './layout';
import { cardColours, lineColours, usedBy } from './styles';
import type { CardLines, FromMap, MapMeasure, PluginPanel, ShowMap, ToMap } from './mapMessages';
import type { ProjectIndex } from './projectIndex';
import type { Review } from './review';
import { newId, type Proposal } from './proposals';
import { forCard } from './memory';
import type { ProjectMemory } from './memoryView';
import { onThemeChange, themeTokenColours } from './themeColours';
import type { AppProxies } from './proxy/appProxies';

export class MapPanel {
  private panel: vscode.WebviewPanel | undefined;
  private ready = false;
  /** The card whose notes and history the page shows. */
  private card: string | undefined;
  /** The map shown in each project (by root), when the developer chose one. */
  private readonly chosenMap = new Map<string, string>();
  /** A card to focus once its map is drawn. */
  private pendingFocus: string | undefined;
  /** Flow or Folders, when the developer chose (per project and map). */
  private readonly arrangement = new Map<string, Arrange>();
  /** The map last sent to the page. */
  private shownMap: string | undefined;
  /** The tab was moved into its own floating window. */
  private floating = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly subscriptions: vscode.Disposable[] = [];
  /** The plugin panels last sent (to send again only when they change), and what they were made from. */
  private panelsSent = '';
  private panelsFrom: unknown;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly index: ProjectIndex,
    private readonly current: CurrentProject,
    private readonly review: Review,
    private readonly changes: OutsideChanges,
    private readonly memory: ProjectMemory,
    /** Where the windows' panel layouts are kept (for every project: it's how the developer likes to work). */
    private readonly layouts?: vscode.Memento,
    /** Each project's app through the proxy (for Preview). */
    private readonly proxies?: AppProxies,
  ) {
    this.subscriptions.push(
      index.onChange(() => this.update()),
      current.onChange(() => this.update()),
      review.onChange(() => this.update()),
      changes.onChange(() => this.update()),
      memory.onChange(() => void this.sendCard()),
      onThemeChange(() => void this.sendTheme()),
    );
    // Calls the app makes go to the Network panel as they happen (a few at a time); fakes when they change.
    if (proxies) {
      let batch: Parameters<Parameters<typeof proxies.onCall>[0]>[1][] = [];
      let timer: ReturnType<typeof setTimeout> | undefined;
      this.subscriptions.push(
        proxies.onCall((root, r) => {
          if (r.kind === 'file' || root !== this.current.get()?.project.root || !this.ready) return;
          batch.push(r);
          timer ??= setTimeout(() => {
            void this.panel?.webview.postMessage({ type: 'calls', calls: batch } satisfies ToMap);
            batch = [];
            timer = undefined;
          }, 100);
        }),
        proxies.onFakes((root) => {
          if (root === this.current.get()?.project.root) void this.sendNetwork(false);
        }),
      );
    }
  }

  /** Opens the map, or brings it to the front. */
  show() {
    if (this.panel) {
      this.panel.reveal();
      return;
    }
    const dist = vscode.Uri.joinPath(this.extensionUri, 'dist');
    const panel = vscode.window.createWebviewPanel('visualEditor.map', 'Visual Editor', vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [dist],
    });
    panel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'media', 'icon.svg');
    // Preview shows the app through Visual Editor's proxy, on this computer.
    panel.webview.html = webviewPage(panel.webview, vscode.Uri.joinPath(dist, 'map.js'), 'Visual Editor', 'frame-src http://127.0.0.1:* http://localhost:*;');
    panel.webview.onDidReceiveMessage((m: FromMap) => this.receive(m), undefined, this.subscriptions);
    panel.onDidDispose(() => {
      this.panel = undefined;
      this.ready = false;
    });
    this.panel = panel;
  }

  /** Shows the map with one card chosen and in view (its notes and history open), switching to its map first. */
  focus(id: string) {
    const state = this.current.get();
    const item = state?.items.find((i) => i.id === id);
    if (state && item) this.chosenMap.set(state.project.root, item.map);
    this.pendingFocus = id;
    this.show();
    // Sent right after the map it's on; when the page isn't ready yet, its first drawing does it.
    if (this.ready) this.send();
  }

  dispose() {
    if (this.timer) clearTimeout(this.timer);
    this.panel?.dispose();
    for (const s of this.subscriptions) s.dispose();
  }

  /** The map's last measurement (for the performance test). */
  measured: MapMeasure | undefined;
  /** Time spent working out the last map's layout, in ms. */
  layoutMs = 0;

  /** Asks the map to measure how it performs (drawing, panning, zooming); the answer lands in `measured`. */
  measure() {
    this.measured = undefined;
    void this.panel?.webview.postMessage({ type: 'measure' } satisfies ToMap);
  }

  private receive(m: FromMap) {
    if (m.type === 'measured') {
      if (!m.partial) this.measured = m;
      return;
    }
    if (m.type === 'ready') {
      this.ready = true;
      void this.panel?.webview.postMessage({ type: 'layouts', layouts: this.layouts?.get('panelLayouts') ?? {} } satisfies ToMap);
      void this.sendTheme();
      this.panelsSent = '';
      this.panelsFrom = undefined;
      void this.sendPanels();
      this.send();
    } else if (m.type === 'choose') {
      this.current.choose(m.root);
    } else if (m.type === 'chooseMap') {
      const root = this.current.get()?.project.root;
      if (root) this.chosenMap.set(root, m.id);
      this.send();
    } else if (m.type === 'arrange') {
      const key = this.arrangeKey();
      if (key) this.arrangement.set(key, m.arrange);
      this.send();
    } else if (m.type === 'openReview') {
      this.review.show(m.proposal);
    } else if (m.type === 'card') {
      this.card = m.id;
      void this.sendCard();
    } else if (m.type === 'lines') {
      this.sendLines(m.id);
    } else if (m.type === 'app') {
      void this.sendApp();
    } else if (m.type === 'openSource') {
      const root = this.current.get()?.project.root;
      if (root) void this.proxies?.openSource(root, m.url, m.line, m.column);
    } else if (m.type === 'network') {
      void this.sendNetwork(true);
    } else if (m.type === 'saveFake' || m.type === 'removeFake' || m.type === 'useCase' || m.type === 'saveScenarios' || m.type === 'openFake' || m.type === 'setHeaders') {
      const root = this.current.get()?.project.root;
      const p = this.proxies;
      if (!root || !p) return;
      if (m.type === 'saveFake') p.saveFake(root, m.endpoint);
      else if (m.type === 'removeFake') p.removeFake(root, m.id);
      else if (m.type === 'useCase') p.useCase(root, m.id, m.use);
      else if (m.type === 'saveScenarios') p.saveScenarios(root, m.scenarios);
      else if (m.type === 'openFake') void p.openFake(root, m.id);
      else void p.setHeaders(root, m.headers);
    } else if (m.type === 'addContract' || m.type === 'removeContract' || m.type === 'openContract' || m.type === 'reloadContracts' || m.type === 'mapType' || m.type === 'fakeFromContract' || m.type === 'contractExample') {
      const root = this.current.get()?.project.root;
      const p = this.proxies;
      if (!root || !p) return;
      if (m.type === 'addContract') void p.addContract(root, m.source);
      else if (m.type === 'removeContract') void p.removeContract(root, m.source);
      else if (m.type === 'openContract') void p.openContract(root, m.source);
      else if (m.type === 'reloadContracts') void p.reloadContracts(root);
      else if (m.type === 'mapType') void p.mapType(root, m.operation, m.typeName);
      else if (m.type === 'fakeFromContract') void p.fakeFromContract(root, m.operations, m.status);
      else void p.contractExample(root, m.ref).then((r) => this.panel?.webview.postMessage({ type: 'contractExample', ref: m.ref, ...r } satisfies ToMap));
    } else if (m.type === 'panelAsk') {
      void this.panelAsk(m.key, m.id, m.request);
    } else if (m.type === 'openItem') {
      const state = this.current.get();
      const found = state?.items.filter((i) => i.label === m.label && i.source && (!m.kind || i.kind === m.kind || i.map === m.kind)) ?? [];
      const item = found[0] ?? state?.items.find((i) => i.label === m.label && i.source);
      if (!state || !item?.source) return void vscode.window.showInformationMessage(`${m.label} isn't on the map: it may come from a library.`);
      const line = Math.max(0, (item.source.line ?? 1) - 1);
      void vscode.window.showTextDocument(vscode.Uri.file(join(state.project.root, item.source.path)), { selection: new vscode.Range(line, 0, line, 0), viewColumn: vscode.ViewColumn.Beside });
    } else if (m.type === 'openRule') {
      const root = this.current.get()?.project.root;
      if (root) void this.proxies?.openRule(root, m.source, m.selector);
    } else if (m.type === 'openExternal') {
      if (/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(m.url)) void vscode.env.openExternal(vscode.Uri.parse(m.url));
    } else if (m.type === 'layout') {
      void this.layouts?.update('panelLayouts', { ...(this.layouts.get<Record<string, unknown>>('panelLayouts') ?? {}), [m.key]: m.layout });
    } else if (m.type === 'goTo') {
      this.focus(m.id);
    } else if (m.type === 'addNote') {
      void this.addNote(m.id);
    } else if (m.type === 'useVariant') {
      this.useVariant(m.id, m.variant, m.situation);
    } else if (m.type === 'updateHelper') {
      this.updateHelper(m.id);
    } else if (m.type === 'previewFix') {
      const state = this.current.get();
      const item = state?.items.find((i) => i.id === m.id);
      const plugin = item && state?.detected.find(({ plugin: p }) => item.id.startsWith(`${p.id}:`))?.plugin;
      if (state && item && plugin?.previewFix) this.proposeChange(state.project.root, plugin.previewFix(state.project, m.need), item.id);
    } else if (m.type === 'session') {
      void vscode.commands.executeCommand('visualEditor.startSession', { card: m.id });
    } else if (m.type === 'nudge') {
      const nudge = this.nudgesFor(this.current.get())?.find((n) => n.key === m.key);
      // Closed, or its agent started: it doesn't come back for this project.
      const close = () => void this.layouts?.update('closedNudges', [...(this.layouts.get<string[]>('closedNudges') ?? []), m.key]).then(() => this.update());
      if (nudge && m.act === 'run') void vscode.commands.executeCommand<boolean>('visualEditor.runAgent', nudge.agent, undefined, nudge.text).then((started) => started && close());
      else if (nudge) close();
    } else if (m.type === 'window') {
      void this.toggleWindow();
    } else if (m.type === 'clearChanged') {
      const root = this.current.get()?.project.root;
      if (root) this.changes.clear(root);
    } else if (m.type === 'open') {
      const root = this.current.get()?.project.root;
      if (!root) return;
      const line = Math.max(0, (m.line ?? 1) - 1);
      void vscode.window.showTextDocument(vscode.Uri.file(isAbsolute(m.path) ? m.path : join(root, m.path)), {
        selection: new vscode.Range(line, 0, line, 0),
        viewColumn: vscode.ViewColumn.Beside,
      });
    }
  }

  /** Moves the map into a floating window (where it can go full screen), or back into the main window. */
  private async toggleWindow() {
    if (!this.panel) return;
    this.panel.reveal(undefined, false);
    await vscode.commands.executeCommand(this.floating ? 'workbench.action.restoreEditorsToMainWindow' : 'workbench.action.moveEditorToNewWindow');
    this.floating = !this.floating;
    this.send();
  }

  /** "Use this design": the card's plugin works out the change, and it goes to Review as a proposal. */
  private useVariant(id: string, variant: string, situation?: string) {
    const state = this.current.get();
    const item = state?.items.find((i) => i.id === id);
    const plugin = item && state?.detected.find(({ plugin: p }) => item.id.startsWith(`${p.id}:`))?.plugin;
    if (!state || !item) return;
    const choice = plugin?.useVariant?.(item, variant, state.project, situation);
    if (!choice) return void vscode.window.showInformationMessage(`${plugin?.name ?? 'Its plugin'} can't change which variant ${item.label} uses.`);
    this.proposeChange(state.project.root, choice, item.id);
  }

  /** "Update the helper": the card's plugin adds or updates what Preview needs, as a proposal. */
  private updateHelper(id: string) {
    const state = this.current.get();
    const item = state?.items.find((i) => i.id === id);
    const plugin = item && state?.detected.find(({ plugin: p }) => item.id.startsWith(`${p.id}:`))?.plugin;
    if (!state || !item) return;
    // Plugins that keep their files in place do it straight away (as on opening the project); others propose.
    if (plugin?.setup) return void vscode.commands.executeCommand('visualEditor.setUpProject', state.project.root);
    const change = plugin?.updateHelper?.(state.project);
    if (!change) return void vscode.window.showInformationMessage(`${plugin?.name ?? 'Its plugin'} has nothing to add for Preview.`);
    this.proposeChange(state.project.root, change, item.id);
  }

  /** A change a plugin worked out, made in the editor: to Review, as a proposal (a string says why not). */
  private proposeChange(root: string, choice: ProposedChange | string, card: string) {
    if (typeof choice === 'string') return void vscode.window.showInformationMessage(choice);
    const now = new Date().toISOString();
    const p: Proposal = {
      id: newId(),
      title: choice.title,
      why: choice.why,
      by: { kind: 'developer', name: 'You' },
      createdAt: now,
      status: 'proposed',
      changes: choice.changes,
      items: [card],
      ...(choice.look ? { look: choice.look } : {}),
      history: [{ at: now, status: 'proposed' }],
    };
    this.review.proposeHere(root, p);
  }

  private async addNote(id: string) {
    const state = this.current.get();
    const item = state?.items.find((i) => i.id === id);
    if (!state || !item) return;
    const text = await vscode.window.showInputBox({ title: `A note on ${item.label}`, placeHolder: 'e.g. Keep this simple: it shows on every page', ignoreFocusOut: true });
    if (!text?.trim()) return;
    this.memory.add(state.project.root, 'note', text, { items: [id], ...(item.source ? { paths: [item.source.path] } : {}) });
  }

  /** The project and map shown, for remembering Flow or Folders. */
  private arrangeKey(): string | undefined {
    const root = this.current.get()?.project.root;
    if (!root) return undefined;
    return `${root}|${this.shownMap}`;
  }

  private async sendCard() {
    if (!this.panel || !this.ready || !this.card) return;
    const state = this.current.get();
    const item = state?.items.find((i) => i.id === this.card);
    if (!state || !item) return;
    void this.panel?.webview.postMessage({ type: 'card', id: item.id, entries: forCard(this.memory.entries(state.project.root), item) } satisfies ToMap);
  }

  /** A plugin panel's question for its plugin's VS Code side (PreviewPanel.serve). */
  private async panelAsk(key: string, id: number, request: unknown) {
    const state = this.current.get();
    const [pluginId, panelId] = key.split('/');
    const plugin = state?.detected.find((d) => d.plugin.id === pluginId)?.plugin;
    const panel = plugin?.previewPanels?.find((p) => p.id === panelId);
    const post = (m: ToMap) => void this.panel?.webview.postMessage(m);
    if (!state || !panel?.serve) return post({ type: 'panelAnswer', key, id, error: 'Nothing answers that here.' });
    try {
      const mine = (id: string) => id.startsWith(`${pluginId}:`);
      const answer = await panel.serve(request, state.project, state.items.filter((i) => mine(i.id)), state.links.filter((l) => mine(l.from) && mine(l.to)));
      post({ type: 'panelAnswer', key, id, answer });
    } catch (e) {
      post({ type: 'panelAnswer', key, id, error: e instanceof Error ? e.message : String(e) });
    }
  }

  /** Plugins' Preview panels for the shown project, with their facts (sent again only when something changed). */
  private async sendPanels() {
    const state = this.current.get();
    if (!this.panel || !this.ready) return;
    // Worked out again only when the project's cards were read again (or another project is shown).
    if (state && this.panelsFrom === state.items) return;
    this.panelsFrom = state?.items;
    const panels: PluginPanel[] = [];
    for (const { plugin } of state?.detected ?? []) {
      for (const p of plugin.previewPanels ?? []) {
        let facts: unknown;
        try {
          facts = await p.facts?.(state!.project, state!.items.filter((i) => i.id.startsWith(`${plugin.id}:`)));
        } catch (e) {
          facts = { error: e instanceof Error ? e.message : String(e) };
        }
        panels.push({ key: `${plugin.id}/${p.id}`, name: p.name, icon: p.icon, code: p.panel, facts });
      }
    }
    const sig = JSON.stringify(panels.map((p) => [p.key, p.name, p.icon, p.code.length, p.facts]));
    if (sig === this.panelsSent) return;
    this.panelsSent = sig;
    void this.panel.webview.postMessage({ type: 'panels', panels } satisfies ToMap);
  }

  /** The calls so far (when asked), the project's fakes and its contracts, for the Network panel. */
  private async sendNetwork(withCalls: boolean) {
    const root = this.current.get()?.project.root;
    if (!this.panel || !root || !this.proxies) return;
    const post = (m: ToMap) => void this.panel?.webview.postMessage(m);
    if (withCalls) post({ type: 'calls', calls: this.proxies.callsOf(root), all: true });
    const fakes = this.proxies.fakesOf(root);
    post({ type: 'fakes', endpoints: fakes.endpoints, scenarios: fakes.scenarios, headers: Object.keys(await this.proxies.headersOf(root)) });
    const contracts = await this.proxies.contractsOf(root);
    post({ type: 'contracts', contracts: contracts.info(), map: contracts.config.map ?? {} });
  }

  /** The app's address through the proxy, for Preview (starting it, and its dev server, when needed). */
  private async sendApp() {
    const root = this.current.get()?.project.root;
    const post = (m: ToMap) => void this.panel?.webview.postMessage(m);
    if (!root) return post({ type: 'app', error: 'Open a folder with a project first.' });
    if (!this.proxies) return post({ type: 'app', error: 'The app can’t be run from here.' });
    try {
      const url = await this.proxies.open(root, (text) => text && post({ type: 'app', progress: text }));
      post({ type: 'app', url });
    } catch (e) {
      post({ type: 'app', error: e instanceof Error ? e.message : String(e) });
    }
  }

  /** Opens the map with the Webview open (at an address of the app, or where it was). */
  webview(path?: string) {
    this.show();
    const send = () => void this.panel?.webview.postMessage({ type: 'webview', ...(path ? { path } : {}) } satisfies ToMap);
    if (this.ready) send();
    else setTimeout(send, 800);
  }

  /** The code colours of the theme on now, so the page colours types the way the editor does. */
  private async sendTheme() {
    const tokens = await themeTokenColours();
    void this.panel?.webview.postMessage({ type: 'theme', tokens } satisfies ToMap);
  }

  /** Every line that joins a card to another, on any map, with the card at the other end. */
  private sendLines(id: string) {
    const state = this.current.get();
    if (!this.panel || !this.ready || !state) return;
    const found: { dir: 'in' | 'out'; kind: string; label?: string; otherId: string }[] = [];
    for (const l of state.links ?? []) {
      if (l.from === l.to) continue;
      if (l.to === id) found.push({ dir: 'in', kind: l.kind, ...(l.label ? { label: l.label } : {}), otherId: l.from });
      else if (l.from === id) found.push({ dir: 'out', kind: l.kind, ...(l.label ? { label: l.label } : {}), otherId: l.to });
    }
    const wanted = new Set(found.map((f) => f.otherId));
    const items = new Map(state.items.filter((i) => wanted.has(i.id)).map((i) => [i.id, i]));
    const lines = found.flatMap(({ otherId, ...f }) => (items.has(otherId) ? [{ ...f, other: items.get(otherId)! }] : []));
    const maps = Object.fromEntries(state.detected.flatMap((d) => d.plugin.maps ?? []).map((m) => [m.id, m.title]));
    void this.panel.webview.postMessage({ type: 'lines', id, lines, maps } satisfies CardLines);
  }

  private timed<T>(fn: () => T): T {
    const start = performance.now();
    const out = fn();
    this.layoutMs = performance.now() - start;
    return out;
  }

  /** Changes come in bursts; redraw once they settle. */
  private update() {
    if (!this.panel || !this.ready) return;
    void this.sendPanels();
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.send(), 80);
  }

  /** The nudges closed for this project come back (the developer asked). */
  async showClosedHints(root: string) {
    await this.layouts?.update('closedNudges', (this.layouts.get<string[]>('closedNudges') ?? []).filter((k) => !k.startsWith(`${root}#`)));
    this.update();
  }

  /** The plugins' nudges for the project, without the ones the developer closed (kept per project). */
  private nudgesFor(state: ReturnType<CurrentProject['get']>): ShowMap['nudges'] {
    if (!state) return [];
    const closed = new Set(this.layouts?.get<string[]>('closedNudges') ?? []);
    return state.detected.flatMap(({ plugin }) => {
      let nudges: PluginNudge[] = [];
      try {
        nudges = plugin.nudges?.(state.project, state.items) ?? [];
      } catch {
        // (A plugin's mistake doesn't stop the map.)
      }
      return nudges
        .map((n) => ({ key: `${state.project.root}#${plugin.id}:${n.id}`, text: n.text, agent: n.agent, title: plugin.agents?.find((a) => a.name === n.agent)?.title ?? n.agent }))
        .filter((n) => !closed.has(n.key) && plugin.agents?.some((a) => a.name === n.agent));
    });
  }

  private send() {
    this.timer = undefined;
    if (!this.panel || !this.ready) return;
    const states = this.index.snapshot();
    const state = this.current.get();
    const maps = state?.detected.flatMap((d) => d.plugin.maps ?? []) ?? [];
    const proposals = state ? this.review.proposals(state.project.root) : [];
    const changed = state ? this.changes.get(state.project.root) : new Set<string>();
    // The project's maps (those its plugins bring, then any a reader used without listing), shown one at a time.
    const counts = new Map<string, number>();
    for (const i of state?.items ?? []) counts.set(i.map, (counts.get(i.map) ?? 0) + 1);
    const tabs = [...maps.filter((m, n, all) => all.findIndex((x) => x.id === m.id) === n && counts.has(m.id)), ...[...counts.keys()].filter((id) => !maps.some((m) => m.id === id)).map((id) => ({ id, title: id }))].map((m) => ({ ...m, cards: counts.get(m.id) ?? 0 }));
    const chosen = state ? this.chosenMap.get(state.project.root) : undefined;
    const shownMap = tabs.find((t) => t.id === chosen)?.id ?? tabs[0]?.id;
    this.shownMap = shownMap;
    const shownItems = (state?.items ?? []).filter((i) => i.map === shownMap);
    const shownIds = new Set(shownItems.map((i) => i.id));
    const shownLinks = (state?.links ?? []).filter((l) => shownIds.has(l.from) && shownIds.has(l.to));
    // Many cards read better grouped by folder; few read better as a flow. The developer's choice wins.
    const arrange = this.arrangement.get(`${state?.project.root}|${shownMap}`) ?? (shownItems.length > 30 ? 'folders' : 'flow');
    const message: ShowMap = {
      type: 'show',
      projects: states.map((s) => ({ root: s.project.root, name: s.project.name, group: s.project.group, cards: s.items.length })),
      current: state?.project.root,
      plugins: state?.detected.map((d) => d.plugin.name) ?? [],
      maps: tabs,
      map: shownMap,
      layout: this.timed(() => layoutMap(shownItems, shownLinks, maps, arrange)),
      arrange,
      colours: { cards: cardColours(shownItems), lines: lineColours(shownLinks) },
      usedBy: usedBy(shownLinks),
      meanings: meaningsOf(maps.filter((m) => m.id === shownMap)),
      floating: this.floating,
      nudges: this.nudgesFor(state),
      marks: cardMarks(state?.items ?? [], proposals, changed),
      proposed: proposals.filter((p) => p.status === 'proposed').length,
      changed: changed.size,
      empty: !state
        ? { title: 'Open a folder', detail: 'Visual Editor draws the projects in the folder you open.' }
        : !state.detected.length
          ? { title: 'No plugin for this project yet', detail: 'Plugins teach Visual Editor your stack and draw its cards: React, Express, SQL, MongoDB…' }
          : !state.items.length
            ? { title: 'Nothing to draw yet', detail: `${state.detected.map((d) => d.plugin.name).join(', ')} found nothing in this project so far.` }
            : undefined,
    };
    this.panel.title = state ? `Map · ${state.project.name}` : 'Visual Editor';
    void this.panel.webview.postMessage(message);
    if (this.pendingFocus) {
      void this.panel.webview.postMessage({ type: 'focus', id: this.pendingFocus } satisfies ToMap);
      this.pendingFocus = undefined;
    }
    void this.sendCard();
  }
}

/** What the kinds and lines on a map mean: the plugin's words, merged when several plugins share a map. */
function meaningsOf(maps: MapDefinition[]): { cards: Record<string, string>; lines: Record<string, string> } {
  return {
    cards: Object.assign({}, ...maps.map((m) => m.kinds ?? {})),
    lines: Object.assign({}, ...maps.map((m) => m.lines ?? {})),
  };
}
