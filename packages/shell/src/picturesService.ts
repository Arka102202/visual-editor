// Taking pictures of cards in VS Code: finds the browser (or the one set in "visualEditor.browserPath"), keeps it
// open while pictures are being taken and closes it after a minute without use. Used by the Preview tab's camera
// button and by the assistant hub's pictures tool.

import * as vscode from 'vscode';
import { cardPictures, savePictures, type CardPicture, type PictureOptions } from './cardPictures';
import type { OutsideChanges } from './changes';
import { findBrowser, Pictures } from './pictures';
import type { PreviewServer } from './previewServer';
import { previewerFor } from './previews';
import type { ProjectIndex } from './projectIndex';
import { vscodeFiles } from './vscodeFiles';

const IDLE_MS = 60_000;

export class PicturesService implements vscode.Disposable {
  private pictures: Pictures | undefined;
  private idle: ReturnType<typeof setTimeout> | undefined;
  /** One set of pictures at a time: the browser takes them one by one anyway. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly index: ProjectIndex,
    private readonly changes: OutsideChanges,
    private readonly server: PreviewServer,
  ) {}

  /** Pictures of a card, saved in the project's .visual-editor/pictures/. */
  take(root: string, itemId: string, opts: PictureOptions): Promise<CardPicture[]> {
    const run = this.queue.then(() => this.takeNow(root, itemId, opts));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async takeNow(root: string, itemId: string, opts: PictureOptions): Promise<CardPicture[]> {
    const state = this.index.snapshot().find((s) => s.project.root === root);
    const item = state?.items.find((i) => i.id === itemId);
    if (!state || !item) throw new Error(`There's no card "${itemId}" here.`);
    const found = previewerFor(state, item);
    if (!found) throw new Error(`No plugin can draw ${item.label}, so there's nothing to take a picture of.`);
    const configured = vscode.workspace.getConfiguration('visualEditor').get<string>('browserPath') || undefined;
    const browser = findBrowser(configured);
    if (!browser) throw new Error('No Chrome, Edge, Chromium or Brave found to take pictures with. Install one, or set "visualEditor.browserPath" in VS Code settings.');
    if (this.idle) clearTimeout(this.idle);
    this.pictures ??= new Pictures(browser);
    await this.server.start();
    try {
      const pics = await cardPictures({ found, item, project: state.project, read: vscodeFiles(root, this.changes).read, host: (html) => this.server.host(html) }, opts, this.pictures);
      return savePictures(root, item, pics);
    } finally {
      this.idle = setTimeout(() => {
        this.pictures?.close();
        this.pictures = undefined;
      }, IDLE_MS);
    }
  }

  dispose() {
    if (this.idle) clearTimeout(this.idle);
    this.pictures?.close();
  }
}
