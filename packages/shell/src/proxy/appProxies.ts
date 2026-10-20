// The proxies of the open projects: one per project, started when first needed (with the project's dev server behind
// it), its calls written to Visual Editor's output, and everything stopped when Visual Editor closes.

import * as vscode from 'vscode';
import { DevServer } from './devServer';
import { AppProxy, type Recorded } from './proxy';

export class AppProxies implements vscode.Disposable {
  private readonly running = new Map<string, { dev: DevServer; proxy: AppProxy }>();

  constructor(private readonly log: vscode.OutputChannel) {}

  /** A project's proxy (started now if it isn't running), with its dev server behind it; returns the app's address. */
  async open(root: string, progress?: (text: string) => void): Promise<string> {
    let entry = this.running.get(root);
    if (!entry) {
      const dev = new DevServer(root);
      const proxy = new AppProxy(() => dev.ensure());
      proxy.onRecord((r) => this.write(r));
      entry = { dev, proxy };
      this.running.set(root, entry);
    }
    // The dev server first, so a problem with it shows now (not as a broken page).
    await entry.dev.ensure((text) => progress?.(text.trim().split('\n').pop() ?? ''));
    const origin = await entry.proxy.start();
    this.log.appendLine(`App proxy for ${root}: ${origin} → dev server ${entry.dev.origin}${entry.dev.startedByUs ? ' (started by Visual Editor)' : ''}`);
    return origin;
  }

  /** A project's running proxy, if any. */
  get(root: string): AppProxy | undefined {
    return this.running.get(root)?.proxy;
  }

  /** Calls the page made (not every file it loaded), one line each. */
  private write(r: Recorded) {
    if (r.kind === 'file') return;
    this.log.appendLine(`  ${r.kind === 'page' ? 'page' : 'call'} ${r.method} ${r.url} → ${r.error ? `failed: ${r.error}` : r.status} · ${r.ms} ms`);
  }

  dispose() {
    for (const { dev, proxy } of this.running.values()) {
      void proxy.stop();
      void dev.stop();
    }
    this.running.clear();
  }
}
