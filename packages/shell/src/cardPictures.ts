// Pictures of a card: drawn by its plugin in each situation and size (and each version, when asked), taken by the
// headless browser, and kept in .visual-editor/pictures/ (not committed) so the developer can open them and
// assistants can look at them. No VS Code APIs, so it can be tested.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Item, ProjectInfo } from '@visual-editor/contract';
import type { Pictures } from './pictures';
import { render, situations as situationsOf, SIZES, versionsOf, type Found } from './previews';

export const PICTURES_DIR = '.visual-editor/pictures';
export type PictureSize = keyof typeof SIZES;
/** More than this in one go is almost always a mistake (every situation × every version × every size). */
const MAX_PICTURES = 36;

export interface CardPicture {
  /** "Now", a version's name, or the card's name. */
  label: string;
  situation: string;
  size: PictureSize;
  png?: Buffer;
  width?: number;
  height?: number;
  /** Why there's no picture, or what went wrong on the page (the picture shows it too). */
  error?: string;
  /** Saved here (project-relative), once saved. */
  file?: string;
}

export interface PictureOptions {
  /** Situations to draw it in ("all": every one but the live backend); default: its first. */
  situations?: string[] | 'all';
  sizes?: PictureSize[];
  /** Its other versions too, next to how it is now. */
  versions?: boolean;
  theme?: 'light' | 'dark';
}

export interface PictureContext {
  found: Found;
  item: Item;
  project: ProjectInfo;
  read(path: string): Promise<string | undefined>;
  /** Serves a plugin's own HTML page, returning its address. */
  host(html: string): string;
}

export async function cardPictures(ctx: PictureContext, opts: PictureOptions, pictures: Pictures): Promise<CardPicture[]> {
  const offered = situationsOf(ctx.found, ctx.item).filter((s) => s !== 'live backend');
  const situations = opts.situations === 'all' ? offered : opts.situations?.length ? opts.situations.filter((s) => offered.includes(s)) : offered.slice(0, 1);
  const sizes = opts.sizes?.length ? opts.sizes : (['mobile', 'tablet', 'desktop'] as PictureSize[]);
  const versions = opts.versions ? await versionsOf(ctx.found, ctx.item, ctx.project) : [];
  const sides: { label: string; version?: string }[] = versions.length ? [{ label: 'Now' }, ...versions.map((v) => ({ label: v.label, version: v.id }))] : [{ label: ctx.item.label }];
  const out: CardPicture[] = [];
  for (const situation of situations) {
    for (const side of sides) {
      for (const size of sizes) {
        if (out.length >= MAX_PICTURES) return out;
        const width = SIZES[size];
        const r = await render(ctx.found, { item: ctx.item, project: ctx.project, situation, theme: opts.theme ?? 'light', width, read: ctx.read, ...(side.version ? { version: side.version } : {}) });
        if (r.error !== undefined) {
          out.push({ label: side.label, situation, size, error: r.error });
          continue;
        }
        const url = 'html' in r.output ? ctx.host(r.output.html) : r.output.url;
        try {
          const p = await pictures.take(url, width);
          out.push({ label: side.label, situation, size, png: p.png, width: p.width, height: p.height, ...(p.error ? { error: p.error } : {}) });
        } catch (e) {
          out.push({ label: side.label, situation, size, error: e instanceof Error ? e.message : String(e) });
        }
      }
    }
  }
  return out;
}

const slug = (s: string) => s.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'card';

/** Saves the pictures under .visual-editor/pictures/<card>/ and returns them with where each went. */
export function savePictures(root: string, item: Item, pics: CardPicture[]): CardPicture[] {
  const dir = `${PICTURES_DIR}/${slug(item.label)}`;
  mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, PICTURES_DIR, '.gitignore'), '# Visual Editor pictures of previews: made on this computer, never committed.\n*\n');
  return pics.map((p) => {
    if (!p.png) return p;
    const file = `${dir}/${slug(p.label)}-${slug(p.situation)}-${p.size}.png`;
    writeFileSync(join(root, file), p.png);
    return { ...p, file };
  });
}
