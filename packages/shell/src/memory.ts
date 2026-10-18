// Memory: why the project is the way it is. Every reviewed change is remembered (what, why, who, the developer's
// note), and the developer (later, agents too) can write down rules ("use theme colours, never fixed ones"),
// decisions, and notes on a card. Kept per project in .visual-editor/memory/entries/, one small file each, so it can
// go into git and teammates' entries never clash.
// No VS Code APIs here, so it can be tested on its own.

import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Item } from '@visual-editor/contract';
import { newId, type Proposal } from './proposals';

export const MEMORY_DIR = '.visual-editor/memory/entries';

export type EntryKind = 'change' | 'rule' | 'decision' | 'note';
export type Outcome = 'applied' | 'sent-back' | 'rejected' | 'undone';

export interface MemoryEntry {
  id: string;
  at: string;
  kind: EntryKind;
  /** A change's title, or the rule, decision or note itself. */
  text: string;
  /** More words: a change's why, a decision's reasons. */
  detail?: string;
  /** The developer's note when reviewing. */
  note?: string;
  by: { kind: 'assistant' | 'agent' | 'plugin' | 'developer'; name: string };
  /** For changes: what happened to it, and which proposal it was. */
  outcome?: Outcome;
  proposal?: string;
  /** Files and cards it's about. */
  paths?: string[];
  items?: string[];
}

const KINDS = new Set(['change', 'rule', 'decision', 'note']);
const OUTCOMES = new Set(['applied', 'sent-back', 'rejected', 'undone']);
const BY_KINDS = new Set(['assistant', 'agent', 'plugin', 'developer']);

/** Reads an entry file's contents; it may have been edited by hand or by a tool, so everything is checked. */
export function parseEntry(text: string, id: string): MemoryEntry | undefined {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!raw || typeof raw !== 'object' || !KINDS.has(raw.kind as string) || typeof raw.text !== 'string' || !raw.text.trim()) return undefined;
  const by = raw.by as Record<string, unknown> | undefined;
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined);
  return {
    id,
    at: typeof raw.at === 'string' ? raw.at : new Date(0).toISOString(),
    kind: raw.kind as EntryKind,
    text: raw.text.trim(),
    ...(typeof raw.detail === 'string' && raw.detail ? { detail: raw.detail } : {}),
    ...(typeof raw.note === 'string' && raw.note ? { note: raw.note } : {}),
    by: { kind: BY_KINDS.has(by?.kind as string) ? (by!.kind as MemoryEntry['by']['kind']) : 'developer', name: typeof by?.name === 'string' ? by.name : 'You' },
    ...(OUTCOMES.has(raw.outcome as string) ? { outcome: raw.outcome as Outcome } : {}),
    ...(typeof raw.proposal === 'string' ? { proposal: raw.proposal } : {}),
    ...(strings(raw.paths) ? { paths: strings(raw.paths) } : {}),
    ...(strings(raw.items) ? { items: strings(raw.items) } : {}),
  };
}

/** The memory entry for a reviewed proposal. `touched` are the cards defined in its files. */
export function changeEntry(p: Proposal, outcome: Outcome, touched: string[], note?: string): MemoryEntry {
  const items = [...new Set([...(p.items ?? []), ...touched])];
  return {
    id: newId(),
    at: new Date().toISOString(),
    kind: 'change',
    text: p.title,
    ...(p.why ? { detail: p.why } : {}),
    ...(note ? { note } : {}),
    by: p.by,
    outcome,
    proposal: p.id,
    paths: p.changes.map((c) => c.path),
    ...(items.length ? { items } : {}),
  };
}

/** Entries about a card: notes on it, and changes to it or its file. Newest first. */
export function forCard(entries: MemoryEntry[], item: Item): MemoryEntry[] {
  const path = item.source?.path;
  return entries.filter((e) => e.items?.includes(item.id) || (path !== undefined && e.paths?.includes(path)));
}

/** Rules and decisions as plain text, for assistants and agents to read before they propose anything. */
export function rulesText(entries: MemoryEntry[]): string {
  const rules = entries.filter((e) => e.kind === 'rule');
  const decisions = entries.filter((e) => e.kind === 'decision');
  const lines: string[] = [];
  if (rules.length) lines.push('Rules for this project:', ...rules.map((r) => `- ${r.text}`));
  if (decisions.length) lines.push(...(lines.length ? [''] : []), 'Decisions made:', ...decisions.map((d) => `- ${d.text}${d.detail ? ` (${d.detail})` : ''}`));
  return lines.join('\n');
}

/** Memory kept in one project. */
export class MemoryStore {
  readonly dir: string;

  constructor(readonly root: string) {
    this.dir = join(root, MEMORY_DIR);
  }

  /** All entries, newest first. */
  list(): MemoryEntry[] {
    let names: string[] = [];
    try {
      names = readdirSync(this.dir).filter((n) => n.endsWith('.json'));
    } catch {
      return [];
    }
    const out: MemoryEntry[] = [];
    for (const name of names) {
      try {
        const e = parseEntry(readFileSync(join(this.dir, name), 'utf8'), name.slice(0, -5));
        if (e) out.push(e);
      } catch {
        // Unreadable file: skipped.
      }
    }
    return out.sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id));
  }

  /** Saves a new or edited entry. */
  save(e: MemoryEntry) {
    mkdirSync(this.dir, { recursive: true });
    const { id, ...rest } = e;
    writeFileSync(join(this.dir, `${id}.json`), JSON.stringify(rest, null, 2) + '\n');
  }

  /** A new rule, decision or note by the developer. */
  add(kind: Exclude<EntryKind, 'change'>, text: string, about: { detail?: string; paths?: string[]; items?: string[] } = {}): MemoryEntry {
    const e: MemoryEntry = {
      id: newId(),
      at: new Date().toISOString(),
      kind,
      text: text.trim(),
      ...(about.detail ? { detail: about.detail } : {}),
      by: { kind: 'developer', name: 'You' },
      ...(about.paths?.length ? { paths: about.paths } : {}),
      ...(about.items?.length ? { items: about.items } : {}),
    };
    this.save(e);
    return e;
  }

  remove(id: string) {
    if (/^[\w-]+$/.test(id)) rmSync(join(this.dir, `${id}.json`), { force: true });
  }
}
