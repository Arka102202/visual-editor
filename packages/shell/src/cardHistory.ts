// A card's history as a story, newest first: changes that went through Review (approved, sent back, rejected,
// undone), agent jobs on it, commits that touched its files, and its changes not committed yet. Each one a line in
// words, for the drawer and for Claude. No VS Code APIs.

import type { Item } from '@visual-editor/contract';
import type { Commit, GitHistory } from './gitHistory';
import type { Job } from './jobs';
import { forCard, type MemoryEntry } from './memory';

export interface HistoryLine {
  at: string;
  kind: 'review' | 'job' | 'commit' | 'edit';
  /** What happened, in a sentence. */
  text: string;
  /** More: why, the developer's note, what was asked, the files. */
  detail?: string;
  /** It went well (approved, passed) or not (rejected, failed). */
  tone?: 'good' | 'bad';
  /** What a click opens. */
  open?: { proposal: string } | { job: string } | { commit: string } | { path: string };
}

/**
 * Where a card's history is: the file it's defined in; for a previewable card, its whole folder (its own: its designs,
 * its data, and the files it had before it was made previewable).
 */
export function cardFiles(item: Item): string[] {
  const path = item.source?.path;
  if (!path) return [];
  const folder = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
  return item.preview && folder ? [folder] : [path];
}

const who = (e: MemoryEntry) => (e.by.kind === 'developer' ? 'You' : e.by.name);
const base = (path: string) => path.split('/').pop() ?? path;
const lines = (added: number, removed: number) => `+${added} −${removed}`;
const filesWords = (files: string[]) => (files.length <= 3 ? files.map(base).join(', ') : `${files.slice(0, 2).map(base).join(', ')} and ${files.length - 2} more`);

function reviewed(e: MemoryEntry): HistoryLine {
  const how = {
    applied: { text: `${who(e)} changed it: ${e.text}`, tone: 'good' as const, after: 'approved in Review' },
    'sent-back': { text: `${who(e)} proposed: ${e.text}`, tone: undefined, after: 'sent back from Review' },
    rejected: { text: `${who(e)} proposed: ${e.text}`, tone: 'bad' as const, after: 'rejected in Review' },
    undone: { text: `${who(e)} changed it: ${e.text}`, tone: undefined, after: 'approved, then undone' },
  }[e.outcome ?? 'applied'];
  const detail = [`${how.after[0].toUpperCase()}${how.after.slice(1)}.`, e.detail, e.note && `Your note: “${e.note}”`].filter(Boolean).join(' ');
  return { at: e.at, kind: 'review', text: how.text, detail, ...(how.tone ? { tone: how.tone } : {}), ...(e.proposal ? { open: { proposal: e.proposal } } : {}) };
}

function job(j: Job): HistoryLine {
  const round = `round ${j.round} of ${j.rounds}`;
  const how: Record<Job['status'], { words: string; tone?: 'good' | 'bad' }> = {
    working: { words: `at work now (${round})` },
    checking: { words: `at work now: being checked (${round})` },
    waiting: { words: 'waiting its turn to start' },
    passed: { words: `passed its checks (${round}) and went to Review`, tone: 'good' },
    failed: { words: `failed: the checker sent it back ${j.rounds} time${j.rounds === 1 ? '' : 's'}`, tone: 'bad' },
    stopped: { words: `stopped in ${round}` },
    'out of time': { words: `ran out of time in ${round}` },
  };
  const { words, tone } = how[j.status];
  const at = j.history.at(-1)?.at ?? j.startedAt;
  return { at, kind: 'job', text: `${j.title} ${words}`, detail: `Asked: “${j.request}” (by ${j.by}).`, ...(tone ? { tone } : {}), open: j.proposal ? { proposal: j.proposal } : { job: j.id } };
}

function commit(c: Commit): HistoryLine {
  return { at: c.at, kind: 'commit', text: `${c.author} committed “${c.subject}”`, detail: `${filesWords(c.files)}: ${lines(c.added, c.removed)} lines.`, open: { commit: c.hash } };
}

/** The card's history, newest first. `git`: undefined when the project isn't in git. */
export function cardHistory(item: Item, entries: MemoryEntry[], jobs: Job[], git: GitHistory | undefined): HistoryLine[] {
  const out: HistoryLine[] = [
    ...forCard(entries, item).filter((e) => e.kind === 'change').map(reviewed),
    ...jobs.filter((j) => j.card === item.id).map(job),
    ...(git?.commits ?? []).map(commit),
  ];
  const u = git?.uncommitted;
  if (u) {
    const all = u.created.length === u.files.length;
    out.push({
      at: u.at,
      kind: 'edit',
      text: all ? 'Made, not committed yet' : 'Changed since the last commit, not committed yet',
      detail: all ? `${filesWords(u.files)} (new).` : `${filesWords(u.files)}: ${lines(u.added, u.removed)} lines${u.created.length ? `, ${u.created.length} new file${u.created.length === 1 ? '' : 's'}` : ''}.`,
      open: { path: u.files[0] },
    });
  }
  return out.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

/** The history in words for Claude (exact dates). */
export function historyText(history: HistoryLine[], git: boolean): string[] {
  const out = history.map((h) => `- ${h.at.slice(0, 10)} · ${h.text}${h.detail ? `. ${h.detail}` : ''}`);
  if (!git) out.push('- (The project isn\'t in git: changes made outside Visual Editor aren\'t known.)');
  return out;
}
