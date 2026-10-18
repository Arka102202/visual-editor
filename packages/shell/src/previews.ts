// Previews: which plugin can show a card, rendering it (with a time limit, errors in plain words), and the files as
// they'd be before and after a proposal, so Review can show both without changing anything.
// No VS Code APIs here, so it can be tested on its own.

import type { Item, Plugin, PreviewOutput, Previewer, PreviewRequest } from '@visual-editor/contract';
import type { ProjectState } from './projectIndex';
import type { Proposal } from './proposals';

/** How long a preview may take before the frame says so. */
export const RENDER_TIMEOUT_MS = 15_000;

export const SIZES = { mobile: 375, tablet: 768, desktop: 1280 } as const;
export type Size = keyof typeof SIZES | 'fit';

export interface Found {
  plugin: Plugin;
  previewer: Previewer;
}

/** The first previewer, among the plugins that understand the project, that wants this card. */
export function previewerFor(state: ProjectState, item: Item): Found | undefined {
  for (const { plugin } of state.detected) {
    for (const previewer of plugin.previews ?? []) {
      try {
        if (previewer.wants(item)) return { plugin, previewer };
      } catch {
        // A previewer that fails to answer just doesn't preview.
      }
    }
  }
  return undefined;
}

/** Cards in a project that something can preview. */
export function previewable(state: ProjectState): Set<string> {
  return new Set(state.items.filter((i) => previewerFor(state, i)).map((i) => i.id));
}

/** The previewer's situations, or one called "normal". */
export function situations(found: Found, item: Item): string[] {
  try {
    const list = found.previewer.situations?.(item).filter((s) => typeof s === 'string' && s);
    return list?.length ? list : ['normal'];
  } catch {
    return ['normal'];
  }
}

/** Reads files through `base`, except those in `overrides` (null: as if removed). */
export function overlay(base: (path: string) => Promise<string | undefined>, overrides: Map<string, string | null>) {
  return async (path: string) => (overrides.has(path) ? (overrides.get(path) ?? undefined) : base(path));
}

/** The files a proposal changes, as they were proposed against (before) and as they'd become (after). */
export function proposalSides(p: Proposal): { before: Map<string, string | null>; after: Map<string, string | null> } {
  return {
    before: new Map(p.changes.map((c) => [c.path, c.before])),
    after: new Map(p.changes.map((c) => [c.path, c.after])),
  };
}

/** Cards a proposal touches that something can preview. */
export function previewableFor(state: ProjectState, p: Proposal): Item[] {
  const paths = new Set(p.changes.map((c) => c.path));
  const ids = new Set(p.items ?? []);
  return state.items.filter((i) => (ids.has(i.id) || (i.source && paths.has(i.source.path))) && previewerFor(state, i));
}

export type Rendered = { output: PreviewOutput; error?: undefined } | { output?: undefined; error: string };

/** Asks the previewer for the preview; a failure, a wrong answer or a timeout comes back as a plain sentence. */
export async function render(found: Found, request: PreviewRequest, timeoutMs = RENDER_TIMEOUT_MS): Promise<Rendered> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const output = await Promise.race([
      Promise.resolve().then(() => found.previewer.render(request)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${found.plugin.name} took longer than ${Math.round(timeoutMs / 1000)} s to draw it.`)), timeoutMs);
      }),
    ]);
    if (output && typeof (output as { html?: unknown }).html === 'string') return { output: { html: (output as { html: string }).html } };
    if (output && typeof (output as { url?: unknown }).url === 'string' && isLocalUrl((output as { url: string }).url)) return { output: { url: (output as { url: string }).url } };
    return { error: `${found.plugin.name} gave nothing that can be shown (it should give a page or an address on this computer).` };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Previews only come from this computer (a plugin's dev server), never from the internet. */
export function isLocalUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return (u.protocol === 'http:' || u.protocol === 'https:') && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  } catch {
    return false;
  }
}
