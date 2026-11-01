// Writes cards' summaries (summaries.ts): one small Claude run for several cards at once, one run at a time per
// project. Asked for one card (its drawer on the map), or for every card an approved change or an undo touched (shown
// as it goes in Review, under that change).

import type { Item, Link } from '@visual-editor/contract';
import { fingerprint, filesOf, readSummaries, summaryPrompt, SummaryStore, type Summary } from './summaries';

/** Cards written together in one run (more make more runs). */
export const CARDS_PER_RUN = 10;

/** Summaries being written for a change: each card, and where it is. */
export interface SummaryJob {
  cards: { id: string; label: string; state: 'waiting' | 'running' | 'done' | 'failed' }[];
  /** Why it failed, if it did. */
  error?: string;
  ended: boolean;
}

export interface SummaryHost {
  /** The project's cards and lines now. */
  project(root: string): { items: Item[]; links: Link[] } | undefined;
  /** One Claude run (reading only): its answer, or why it failed. */
  ask(root: string, prompt: string): Promise<{ result: string } | string>;
  /** Something about a project's summaries changed (written, being written): its views follow. */
  changed(root: string): void;
}

export class SummaryWriter {
  /** Each project's runs, one after another. */
  private readonly queue = new Map<string, Promise<unknown>>();
  /** Cards being written now (root#id). */
  private readonly writing = new Set<string>();
  /** Summaries being written for a change, by its proposal id. */
  readonly jobs = new Map<string, SummaryJob>();

  constructor(private readonly host: SummaryHost) {}

  isWriting(root: string, id: string): boolean {
    return this.writing.has(`${root}#${id}`);
  }

  /**
   * Writes (or writes again) the summaries of these cards; `proposal`: for that change (its progress is kept to show).
   * Undefined when they were written, or why not.
   */
  write(root: string, ids: string[], proposal?: string): Promise<string | undefined> {
    const state = this.host.project(root);
    const cards = (state?.items ?? []).filter((i) => ids.includes(i.id) && filesOf(i).length);
    const job: SummaryJob | undefined = proposal ? { cards: cards.map((c) => ({ id: c.id, label: c.label, state: 'waiting' })), ended: !cards.length } : undefined;
    if (proposal && job) this.jobs.set(proposal, job);
    for (const c of cards) this.writing.add(`${root}#${c.id}`);
    this.host.changed(root);
    if (!cards.length) return Promise.resolve(ids.length ? 'Those cards have no files to describe.' : undefined);
    const run = async (): Promise<string | undefined> => {
      let failed: string | undefined;
      for (let i = 0; i < cards.length; i += CARDS_PER_RUN) {
        const batch = cards.slice(i, i + CARDS_PER_RUN);
        const mark = (s: SummaryJob['cards'][number]['state']) => job && (job.cards = job.cards.map((c) => (batch.some((b) => b.id === c.id) ? { ...c, state: s } : c)));
        mark('running');
        this.host.changed(root);
        const now = this.host.project(root) ?? state!;
        const r = await this.host.ask(root, summaryPrompt(batch, now.links, now.items));
        const got = typeof r === 'string' ? r : readSummaries(r.result, batch.map((b) => b.id));
        if (typeof got === 'string') {
          failed = got;
          mark('failed');
        } else {
          const at = new Date().toISOString();
          const saved: Summary[] = batch.filter((b) => got.has(b.id)).map((b) => ({ id: b.id, label: b.label, text: got.get(b.id)!, at, files: filesOf(b), hash: fingerprint(root, filesOf(b)) }));
          new SummaryStore(root).save(saved);
          if (job) job.cards = job.cards.map((c) => (batch.some((b) => b.id === c.id) ? { ...c, state: got.has(c.id) ? 'done' : 'failed' } : c));
        }
        for (const b of batch) this.writing.delete(`${root}#${b.id}`);
        this.host.changed(root);
      }
      if (job) {
        job.ended = true;
        if (failed) job.error = failed;
      }
      this.host.changed(root);
      return failed;
    };
    const next = (this.queue.get(root) ?? Promise.resolve()).then(run, run);
    this.queue.set(root, next.catch(() => undefined));
    return next;
  }
}
