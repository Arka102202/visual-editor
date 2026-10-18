// The Preview tab: how a card looks, drawn by the plugin that understands it, in a frame the shell owns (sizes, light
// and dark, situations). For a proposal it shows Before and After side by side, drawn from the proposed files, before
// anything is applied. It redraws when the code changes.

import * as vscode from 'vscode';
import type { OutsideChanges } from './changes';
import type { CurrentProject } from './currentProject';
import type { FromPreview, Frame, ToPreview } from './previewMessages';
import { overlay, previewerFor, proposalSides, render, situations, SIZES, type Size } from './previews';
import type { PreviewServer } from './previewServer';
import type { ProjectIndex } from './projectIndex';
import type { Review } from './review';
import { vscodeFiles } from './vscodeFiles';
import { webviewPage } from './webviewPage';

export interface PreviewTarget {
  root: string;
  item: string;
  /** Compare Before and After for this proposal. */
  proposal?: string;
}

export class PreviewPanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private ready = false;
  private target: PreviewTarget | undefined;
  private situation: string | undefined;
  private theme: 'light' | 'dark' = vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Light ? 'light' : 'dark';
  private size: Size = 'fit';
  private width = 800;
  /** Each drawing gets a number; an older one finishing late is dropped. */
  private drawing = 0;
  /** Frames the page says are on screen. */
  shownFrames = 0;
  /** The tab was moved into its own floating window. */
  private floating = false;
  /** What the preview pages said lately (newest last). */
  readonly frameMessages: Record<string, unknown>[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly subscriptions: vscode.Disposable[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly index: ProjectIndex,
    private readonly review: Review,
    private readonly changes: OutsideChanges,
    private readonly server: PreviewServer,
    private readonly current: CurrentProject,
  ) {
    // The code changed (or plugins came and went): draw it again, once the changes settle.
    this.subscriptions.push(index.onChange(() => this.later()), review.onChange(() => this.target?.proposal && this.later()));
  }

  /** Opens the Preview tab for a card (or a proposal's Before and After). */
  async show(target: PreviewTarget) {
    if (this.target?.item !== target.item) this.situation = undefined;
    this.target = target;
    this.current.choose(target.root);
    await this.server.start();
    if (!this.panel) {
      const dist = vscode.Uri.joinPath(this.extensionUri, 'dist');
      const panel = vscode.window.createWebviewPanel('visualEditor.preview', 'Preview', { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true }, {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [dist],
      });
      panel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'media', 'icon.svg');
      panel.webview.html = webviewPage(panel.webview, vscode.Uri.joinPath(dist, 'preview.js'), 'Preview', 'frame-src http://127.0.0.1:* http://localhost:* http://*.localhost:*;');
      panel.webview.onDidReceiveMessage((m: FromPreview) => this.receive(m), undefined, this.subscriptions);
      panel.onDidDispose(() => {
        this.panel = undefined;
        this.ready = false;
        this.target = undefined;
      });
      this.panel = panel;
    } else {
      this.panel.reveal(undefined, true);
      void this.draw();
    }
  }

  dispose() {
    if (this.timer) clearTimeout(this.timer);
    this.panel?.dispose();
    for (const s of this.subscriptions) s.dispose();
  }

  private receive(m: FromPreview) {
    if (m.type === 'frame') {
      this.frameMessages.push(m.data);
      if (this.frameMessages.length > 50) this.frameMessages.shift();
      return;
    }
    if (m.type === 'shown') {
      this.shownFrames = m.frames;
      return;
    }
    if (m.type === 'window') return void this.toggleWindow();
    if (m.type === 'ready') this.ready = true;
    else if (m.type === 'situation') this.situation = m.name;
    else if (m.type === 'theme') this.theme = m.theme;
    else if (m.type === 'size') {
      this.size = m.size;
      this.width = Math.max(200, Math.round(m.width));
    }
    void this.draw();
  }

  /** Moves the tab into a floating window (where it can go full screen), or back into the main window. */
  private async toggleWindow() {
    if (!this.panel) return;
    this.panel.reveal(undefined, false);
    await vscode.commands.executeCommand(this.floating ? 'workbench.action.restoreEditorsToMainWindow' : 'workbench.action.moveEditorToNewWindow');
    this.floating = !this.floating;
    void this.draw();
  }

  private later() {
    if (!this.panel || !this.target) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.draw(), 400);
  }

  private post(m: ToPreview) {
    void this.panel?.webview.postMessage(m);
  }

  private async draw() {
    const target = this.target;
    if (!this.panel || !this.ready || !target) return;
    const n = ++this.drawing;
    const state = this.index.snapshot().find((s) => s.project.root === target.root);
    const item = state?.items.find((i) => i.id === target.item);
    const found = state && item ? previewerFor(state, item) : undefined;
    if (!state || !item || !found) {
      this.panel.title = 'Preview';
      return this.post({ type: 'show', title: item?.label ?? 'Preview', situations: [], situation: '', theme: this.theme, size: this.size, frames: [{ error: item ? 'No plugin can preview this card.' : 'This card is gone (its code changed or its plugin was removed).' }], floating: this.floating });
    }
    const list = situations(found, item);
    const situation = this.situation && list.includes(this.situation) ? this.situation : list[0];
    const base = vscodeFiles(target.root, this.changes).read;
    const proposal = target.proposal ? this.review.proposals(target.root).find((p) => p.id === target.proposal) : undefined;
    const sides = proposal ? proposalSides(proposal) : undefined;
    const reads = sides
      ? [
          { label: 'Before', read: overlay(base, sides.before) },
          { label: 'After', read: overlay(base, sides.after) },
        ]
      : [{ label: undefined, read: base }];
    const width = this.size === 'fit' ? this.width : SIZES[this.size];
    this.panel.title = `Preview · ${item.label}`;
    this.post({ type: 'drawing' });
    const frames: Frame[] = await Promise.all(
      reads.map(async ({ label, read }) => {
        const r = await render(found, { item, project: state.project, situation, theme: this.theme, width, read });
        if (r.error !== undefined) return { label, error: r.error };
        return 'html' in r.output ? { label, url: this.server.host(r.output.html), own: true } : { label, url: r.output.url };
      }),
    );
    if (n !== this.drawing) return;
    this.post({
      type: 'show',
      title: item.label,
      sub: proposal ? `${proposal.title} · by ${proposal.by.name}` : `${found.plugin.name} · ${item.kind}`,
      situations: list,
      situation,
      theme: this.theme,
      size: this.size,
      frames,
      floating: this.floating,
    });
  }
}
