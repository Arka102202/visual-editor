// The Preview tab: how a card looks, drawn by the plugin that understands it, in a frame the shell owns (sizes, light
// and dark, situations). For a proposal it shows Before and After side by side, drawn from the proposed files, before
// anything is applied. It redraws when the code changes.

import * as vscode from 'vscode';
import type { OutsideChanges } from './changes';
import type { CurrentProject } from './currentProject';
import type { FromPreview, Frame, ToPreview } from './previewMessages';
import { choiceProposal, overlay, previewerFor, proposalSides, render, situations, SIZES, versionsOf, type Found, type Size } from './previews';
import { safePath } from './proposals';
import type { PicturesService } from './picturesService';
import { join } from 'node:path';
import type { Item, ProjectInfo } from '@visual-editor/contract';
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
  /** Show the card's other versions side by side with it. */
  versions?: boolean;
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
  /** The previewer that drew the current preview, to pass on what its pages say. */
  private drawn: { found: Found; item: Item; project: ProjectInfo } | undefined;
  /** What the preview pages said lately (newest last). */
  readonly frameMessages: Record<string, unknown>[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** The situation last drawn (for pictures of what's shown). */
  private shownSituation: string | undefined;
  /** Takes pictures of cards (set once it exists). */
  pictures: PicturesService | undefined;
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
      const d = this.drawn;
      try {
        d?.found.previewer.heard?.(m.data, { item: d.item, project: d.project });
      } catch {
        // A plugin failing to listen doesn't stop the preview.
      }
      return;
    }
    if (m.type === 'shown') {
      this.shownFrames = m.frames;
      return;
    }
    if (m.type === 'window') return void this.toggleWindow();
    if (m.type === 'choose') return void this.choose(m.version);
    if (m.type === 'pictures') return void this.savePictures();
    if (m.type === 'versions' && this.target) this.target = { ...this.target, versions: m.on };
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

  /** A version chosen: the plugin says what changes, the shell shows it in Review (nothing changes before approval). */
  private async choose(version: string) {
    const d = this.drawn;
    const target = this.target;
    if (!d || !target || !d.found.previewer.choose) return;
    const read = vscodeFiles(target.root, this.changes).read;
    try {
      const choice = await d.found.previewer.choose(d.item, version, { project: d.project, read });
      const p = await choiceProposal(choice, d.found.plugin.name, d.item, read, safePath);
      this.review.receiveProposal(target.root, p);
      this.review.show(p.id);
    } catch (e) {
      void vscode.window.showErrorMessage(`Couldn't choose that version: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** Pictures of what's shown (each version too, when side by side), at each size, saved in the project. */
  private async savePictures() {
    const d = this.drawn;
    const target = this.target;
    if (!d || !target || !this.pictures) return;
    const service = this.pictures;
    let saved: { file?: string; error?: string }[] = [];
    try {
      saved = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Taking pictures of ${d.item.label}…` }, () =>
        service.take(target.root, d.item.id, { situations: this.shownSituation ? [this.shownSituation] : undefined, versions: !!target.versions, theme: this.theme }),
      );
    } catch (e) {
      void vscode.window.showErrorMessage(`No pictures: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    const files = saved.filter((p) => p.file).map((p) => p.file!);
    const missed = saved.filter((p) => !p.file);
    const note = missed.length ? ` ${missed.length} couldn't be taken: ${missed[0].error ?? 'unknown reason'}` : '';
    const pick = await vscode.window.showInformationMessage(`Saved ${files.length} picture${files.length === 1 ? '' : 's'} of ${d.item.label} in .visual-editor/pictures.${note}`, ...(files.length ? ['Show', 'Open folder'] : []));
    if (pick === 'Show') await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(join(target.root, files[0])), vscode.ViewColumn.Beside);
    if (pick === 'Open folder') await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(join(target.root, files[0])));
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
      return this.post({ type: 'show', title: item?.label ?? 'Preview', situations: [], situation: '', theme: this.theme, size: this.size, frames: [{ error: item ? 'No plugin can preview this card.' : 'This card is gone (its code changed or its plugin was removed).' }], floating: this.floating, versions: 0, comparing: false });
    }
    this.drawn = { found, item, project: state.project };
    const list = situations(found, item);
    const situation = this.situation && list.includes(this.situation) ? this.situation : list[0];
    this.shownSituation = situation;
    const base = vscodeFiles(target.root, this.changes).read;
    const proposal = target.proposal ? this.review.proposals(target.root).find((p) => p.id === target.proposal) : undefined;
    const sides = proposal ? proposalSides(proposal) : undefined;
    // Versions side by side (not for a proposal: that compares Before and After).
    const versions = proposal ? [] : await versionsOf(found, item, state.project);
    const comparing = !!target.versions && versions.length > 0;
    type Side = { label?: string; read: typeof base; version?: (typeof versions)[number] };
    const reads: Side[] = sides
      ? [
          { label: 'Before', read: overlay(base, sides.before) },
          { label: 'After', read: overlay(base, sides.after) },
        ]
      : comparing
        ? [{ label: 'Now', read: base }, ...versions.map((v) => ({ label: v.label, read: base, version: v }))]
        : [{ label: undefined, read: base }];
    const width = this.size === 'fit' ? this.width : SIZES[this.size];
    this.panel.title = `Preview · ${item.label}`;
    this.post({ type: 'drawing' });
    const frames: Frame[] = await Promise.all(
      reads.map(async ({ label, read, version }) => {
        const r = await render(found, { item, project: state.project, situation, theme: this.theme, width, read, ...(version ? { version: version.id } : {}) });
        const about = version ? { version: version.id, ...(version.notes ? { notes: version.notes } : {}), ...(version.checks ? { checks: version.checks } : {}) } : {};
        if (r.error !== undefined) return { label, ...about, error: r.error };
        return 'html' in r.output ? { label, ...about, url: this.server.host(r.output.html), own: true } : { label, ...about, url: r.output.url };
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
      versions: versions.length,
      comparing,
    });
  }
}
