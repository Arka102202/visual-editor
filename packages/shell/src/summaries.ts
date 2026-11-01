// Summaries: "what does this do?" for a card, in a few plain sentences. Never written up front: only when the developer
// asks for a card, and then kept up to date by themselves (every card an approved change, or an undo, touches gets its
// summary written or written again). Kept next to the project's memory, with the files each one describes and a
// fingerprint of their code, so a summary whose code changed some other way says it may be out of date. Claude gets a
// card's summary with the card, and with any file of it that it reads.

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Item, Link } from '@visual-editor/contract';

export const SUMMARIES_FILE = '.visual-editor/memory/summaries.json';

export interface Summary {
  /** The card's id. */
  id: string;
  label: string;
  text: string;
  /** When it was written. */
  at: string;
  /** The files it describes (the card's own, and the others that belong to it), and their code's fingerprint then. */
  files: string[];
  hash: string;
}

/** A project's summaries, by card id. */
export class SummaryStore {
  readonly file: string;

  constructor(readonly root: string) {
    this.file = join(root, SUMMARIES_FILE);
  }

  all(): Record<string, Summary> {
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Record<string, Summary>;
      return raw && typeof raw === 'object' ? raw : {};
    } catch {
      return {};
    }
  }

  get(id: string): Summary | undefined {
    return this.all()[id];
  }

  save(list: Summary[]) {
    const all = this.all();
    for (const s of list) all[s.id] = s;
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(all, null, 2) + '\n');
  }

  remove(id: string) {
    const all = this.all();
    delete all[id];
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(all, null, 2) + '\n');
  }
}

/** The files a card is made of: its own, and the others that belong to it (a previewable folder's parts). */
export const filesOf = (item: Item): string[] => [...new Set([item.source?.path, ...(item.preview?.files ?? [])].filter((p): p is string => !!p))];

/** A fingerprint of some files' code as they are now (a missing file counts as empty). */
export function fingerprint(root: string, files: string[]): string {
  const h = createHash('sha256');
  for (const f of [...files].sort()) {
    let text = '';
    try {
      text = readFileSync(join(root, f), 'utf8');
    } catch {
      // gone
    }
    h.update(`${f}\0${text}\0`);
  }
  return h.digest('hex').slice(0, 16);
}

/** Whether a summary's code changed since it was written (it may be out of date). */
export const outOfDate = (root: string, s: Summary) => fingerprint(root, s.files) !== s.hash;

/** What the writer is told about each card: what the map knows (Claude reads the files itself). */
export function summaryPrompt(cards: Item[], links: Link[], all: Item[]): string {
  const label = (id: string) => all.find((i) => i.id === id)?.label ?? id;
  const blocks = cards.map((c) => {
    const out = links.filter((l) => l.from === c.id).map((l) => `${l.kind} ${label(l.to)}`);
    const into = links.filter((l) => l.to === c.id).map((l) => `${label(l.from)} ${l.kind} it`);
    return [
      `## ${c.label} (id ${c.id})`,
      `A ${c.kind}${c.sub ? ` · ${c.sub}` : ''}. Files: ${filesOf(c).join(', ') || 'none'}`,
      ...(c.fields?.length ? [`It takes: ${c.fields.map((f) => `${f.name}${f.value ? ` (${f.value})` : ''}`).join(', ')}`] : []),
      ...(out.length ? [`It: ${out.slice(0, 12).join(', ')}`] : []),
      ...(into.length ? [`Used by: ${into.slice(0, 12).join(', ')}`] : []),
      ...(c.preview ? [`Designs: ${c.preview.variants.map((v) => `${v.name}${v.inUse ? ' (in use)' : ''}`).join(', ')}; states: ${c.preview.states.join(', ')}`] : []),
    ].join('\n');
  });
  return `Write a short summary of each card below for a developer who doesn't want to read the code: what it is for, what it shows, and what happens when someone uses it (clicks, typing, what it loads or saves). Read each card's files to be sure; say only what the code does.

Plain words, 2 to 4 short sentences each, no code, no file names, no lists. Name the other components only when it helps ("Used on the projects page").

${blocks.join('\n\n')}

Answer with JSON only: {"summaries": [{"id": "<the card's id>", "text": "<its summary>"}]}`;
}

/** The writer's answer: each card's summary; a string says what went wrong. */
export function readSummaries(text: string, ids: string[]): Map<string, string> | string {
  const json = /\{[\s\S]*\}/.exec(text)?.[0];
  let raw: { summaries?: { id?: unknown; text?: unknown }[] };
  try {
    raw = JSON.parse(json ?? '');
  } catch {
    return 'The summary writer didn\'t answer with summaries.';
  }
  const out = new Map<string, string>();
  for (const s of raw.summaries ?? []) if (typeof s.id === 'string' && ids.includes(s.id) && typeof s.text === 'string' && s.text.trim()) out.set(s.id, s.text.trim().slice(0, 900));
  return out.size ? out : 'The summary writer didn\'t answer with summaries.';
}

/** The summaries that describe a file (to give Claude with it when it reads the file). */
export function summariesOf(path: string, all: Record<string, Summary>): Summary[] {
  return Object.values(all).filter((s) => s.files.includes(path));
}
