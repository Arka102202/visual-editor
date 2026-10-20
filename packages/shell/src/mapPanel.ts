// The map: an editor tab that draws the shown project's cards and lines. It redraws when files or plugins change,
// and when another project is chosen.

import * as vscode from 'vscode';
import type { MapDefinition } from '@visual-editor/contract';
import { webviewPage } from './webviewPage';
import { join } from 'node:path';
import { cardMarks, type OutsideChanges } from './changes';
import type { CurrentProject } from './currentProject';
import { layoutMap, type Arrange } from './layout';
import { cardColours, lineColours, usedBy } from './styles';
import type { CardLines, CardNeeds, FromMap, MapMeasure, ShowMap, ToMap } from './mapMessages';
import type { ProjectIndex } from './projectIndex';
import type { Review } from './review';
import { forCard } from './memory';
import { previewerFor, render, versionsOf } from './previews';
import { readFile } from 'node:fs/promises';
import type { PreviewTarget } from './previewPanel';
import type { ProjectMemory } from './memoryView';
import { onThemeChange, themeTokenColours } from './themeColours';

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
  /** Opens the Preview tab (set once the preview panel exists). */
  openPreview: ((target: PreviewTarget) => void) | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly subscriptions: vscode.Disposable[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly index: ProjectIndex,
    private readonly current: CurrentProject,
    private readonly review: Review,
    private readonly changes: OutsideChanges,
    private readonly memory: ProjectMemory,
    /** Where the developer's own preview values are kept (this workspace's storage, not the project's files). */
    private readonly values?: vscode.Memento,
  ) {
    this.subscriptions.push(
      index.onChange(() => this.update()),
      current.onChange(() => this.update()),
      review.onChange(() => this.update()),
      changes.onChange(() => this.update()),
      memory.onChange(() => void this.sendCard()),
      onThemeChange(() => void this.sendTheme()),
    );
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
    // The Preview window shows cards drawn by a dev server on this computer.
    panel.webview.html = webviewPage(panel.webview, vscode.Uri.joinPath(dist, 'map.js'), 'Visual Editor', 'frame-src http://127.0.0.1:* http://localhost:* http://*.localhost:*;');
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
      void this.sendTheme();
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
    } else if (m.type === 'goTo') {
      this.focus(m.id);
    } else if (m.type === 'needs') {
      void this.sendNeeds(m.id);
    } else if (m.type === 'draw') {
      void this.sendDrawing(m.id);
    } else if (m.type === 'setValue') {
      void this.setValue(m.id, m.need, m.value);
    } else if (m.type === 'preview') {
      const root = this.current.get()?.project.root;
      if (root) this.openPreview?.({ root, item: m.id, ...(m.versions ? { versions: true } : {}) });
    } else if (m.type === 'addNote') {
      void this.addNote(m.id);
    } else if (m.type === 'window') {
      void this.toggleWindow();
    } else if (m.type === 'clearChanged') {
      const root = this.current.get()?.project.root;
      if (root) this.changes.clear(root);
    } else if (m.type === 'open') {
      const root = this.current.get()?.project.root;
      if (!root) return;
      const line = Math.max(0, (m.line ?? 1) - 1);
      void vscode.window.showTextDocument(vscode.Uri.file(join(root, m.path)), {
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
    const found = previewerFor(state, item);
    const versions = found ? (await versionsOf(found, item, state.project)).length : 0;
    void this.panel?.webview.postMessage({ type: 'card', id: item.id, entries: forCard(this.memory.entries(state.project.root), item), canPreview: !!found, versions } satisfies ToMap);
  }

  /** Where one card's values are kept. */
  private valuesKey(root: string, id: string) {
    return `previewValues:${root}|${id}`;
  }

  /** What a card needs to be drawn, from its plugin, with the developer's own values. */
  private async sendNeeds(id: string) {
    const state = this.current.get();
    const item = state?.items.find((i) => i.id === id);
    if (!this.panel || !state || !item) return;
    const values = this.values?.get<Record<string, unknown>>(this.valuesKey(state.project.root, id)) ?? {};
    const found = previewerFor(state, item);
    let message: CardNeeds;
    try {
      if (!found?.previewer.needs) throw new Error(`No plugin can draw ${item.label} on its own yet.`);
      const needs = await found.previewer.needs(item, { project: state.project });
      message = { type: 'needs', id, needs, values };
    } catch (e) {
      message = { type: 'needs', id, needs: [], values, error: e instanceof Error ? e.message : String(e) };
    }
    void this.panel.webview.postMessage(message satisfies ToMap);
  }

  /** The card drawn by its plugin (the values go into the page from the Preview window). */
  private async sendDrawing(id: string) {
    const state = this.current.get();
    const item = state?.items.find((i) => i.id === id);
    if (!this.panel || !state || !item) return;
    const found = previewerFor(state, item);
    if (!found) {
      void this.panel.webview.postMessage({ type: 'drawing', id, error: `No plugin can draw ${item.label}.` } satisfies ToMap);
      return;
    }
    const root = state.project.root;
    const read = (path: string) => readFile(join(root, path), 'utf8').catch(() => undefined);
    const theme = vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Light || vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.HighContrastLight ? 'light' : 'dark';
    const r = await render(found, { item, project: state.project, situation: 'normal', theme, width: 1024, read });
    const message: ToMap = r.error !== undefined ? { type: 'drawing', id, error: r.error } : 'html' in r.output ? { type: 'drawing', id, html: r.output.html } : { type: 'drawing', id, url: r.output.url };
    void this.panel?.webview.postMessage(message);
  }

  private async setValue(id: string, need: string, value: unknown) {
    const state = this.current.get();
    const root = state?.project.root;
    const item = state?.items.find((i) => i.id === id);
    const found = state && item ? previewerFor(state, item) : undefined;
    // A plugin that keeps values (next to the component's file) keeps them; otherwise this workspace does.
    if (state && item && found?.previewer.keep) {
      try {
        await found.previewer.keep(item, need, value, { project: state.project });
        return;
      } catch {
        // Kept here instead.
      }
    }
    if (!root || !this.values) return;
    const key = this.valuesKey(root, id);
    const all = { ...(this.values.get<Record<string, unknown>>(key) ?? {}) };
    if (value === undefined) delete all[need];
    else all[need] = value;
    await this.values.update(key, Object.keys(all).length ? all : undefined);
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
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.send(), 80);
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
