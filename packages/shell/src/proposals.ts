// Proposals: changes waiting for the developer's OK. Each is a JSON file in the project's .visual-editor/proposals/
// folder, so anything can propose (an assistant through the hub, an agent, a plugin) and nothing changes the code
// without review. Approving applies all its file changes together, or none; an applied change can be undone.
// No VS Code APIs here, so it can be tested on its own (file access is passed in).

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, normalize } from 'node:path';

export const PROPOSALS_DIR = '.visual-editor/proposals';

export type Status = 'proposed' | 'applied' | 'rejected' | 'sent-back' | 'undone';

export interface FileChange {
  /** Relative to the project's root, forward slashes. */
  path: string;
  /** The text it was proposed against; null when the file is new. */
  before: string | null;
  /** The new text; null when the file is to be removed. */
  after: string | null;
}

export interface Proposal {
  id: string;
  title: string;
  /** Why this change, in plain words. */
  why?: string;
  /** Who proposed it. */
  by: { kind: 'assistant' | 'agent' | 'plugin' | 'developer'; name: string };
  createdAt: string;
  status: Status;
  changes: FileChange[];
  /** Cards it touches (beyond those defined in the changed files). */
  items?: string[];
  /** What happened to it, newest last. */
  history: { at: string; status: Status; note?: string }[];
}

/** File access for applying: VS Code's in the editor (so open files update), plain fs in tests. */
export interface Files {
  /** The file's current text, or undefined when it doesn't exist. */
  read(path: string): Promise<string | undefined>;
  write(path: string, text: string): Promise<void>;
  remove(path: string): Promise<void>;
}

const BY_KINDS = new Set(['assistant', 'agent', 'plugin', 'developer']);
const STATUSES = new Set(['proposed', 'applied', 'rejected', 'sent-back', 'undone']);

/** Is a proposed path a safe place inside the project? */
export function safePath(path: string): boolean {
  if (!path || isAbsolute(path) || /^[a-zA-Z]:/.test(path) || path.includes('\0')) return false;
  const parts = normalize(path).split(/[\\/]/);
  return !parts.includes('..') && !['.git', '.visual-editor', 'node_modules'].includes(parts[0]);
}

/** Reads a proposal file's contents; it may come from anywhere, so everything is checked. */
export function parseProposal(text: string, fallbackId: string): Proposal | string {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(text);
  } catch {
    return 'It is not valid JSON.';
  }
  if (!raw || typeof raw !== 'object') return 'It is not a proposal.';
  if (typeof raw.title !== 'string' || !raw.title.trim()) return 'It has no title.';
  if (!Array.isArray(raw.changes) || !raw.changes.length) return 'It changes no files.';
  const changes: FileChange[] = [];
  for (const c of raw.changes as Record<string, unknown>[]) {
    if (!c || typeof c.path !== 'string' || !safePath(c.path)) return `A change has a path outside the project: ${String(c?.path)}`;
    const before = c.before === undefined ? null : c.before;
    const after = c.after === undefined ? null : c.after;
    if ((before !== null && typeof before !== 'string') || (after !== null && typeof after !== 'string')) return `The change to ${c.path} is not text.`;
    if (before === null && after === null) return `The change to ${c.path} does nothing.`;
    changes.push({ path: c.path.split('\\').join('/'), before, after });
  }
  if (new Set(changes.map((c) => c.path)).size !== changes.length) return 'It changes the same file twice.';
  const by = raw.by as Record<string, unknown> | undefined;
  const status = STATUSES.has(raw.status as string) ? (raw.status as Status) : 'proposed';
  const createdAt = typeof raw.createdAt === 'string' ? raw.createdAt : new Date().toISOString();
  return {
    id: typeof raw.id === 'string' && /^[\w-]+$/.test(raw.id) ? raw.id : fallbackId,
    title: raw.title.trim(),
    ...(typeof raw.why === 'string' ? { why: raw.why } : {}),
    by: { kind: BY_KINDS.has(by?.kind as string) ? (by!.kind as Proposal['by']['kind']) : 'assistant', name: typeof by?.name === 'string' ? by.name : 'Assistant' },
    createdAt,
    status,
    changes,
    ...(Array.isArray(raw.items) ? { items: (raw.items as unknown[]).filter((i): i is string => typeof i === 'string') } : {}),
    history: Array.isArray(raw.history) ? (raw.history as Proposal['history']) : [{ at: createdAt, status }],
  };
}

/** Why it can't be applied as it stands: files that changed since it was proposed. Empty when it can. */
export async function conflicts(p: Proposal, files: Files): Promise<string[]> {
  const out: string[] = [];
  for (const c of p.changes) {
    const now = await files.read(c.path);
    if (c.before === null && now !== undefined) out.push(`${c.path} already exists.`);
    else if (c.before !== null && now === undefined) out.push(`${c.path} no longer exists.`);
    else if (c.before !== null && !sameText(now!, c.before)) out.push(`${c.path} changed since this was proposed.`);
  }
  return out;
}

/** Applies every change, or none: if one fails, the ones already done are put back. */
export async function apply(p: Proposal, files: Files): Promise<void> {
  await swap(p.changes.map((c) => ({ path: c.path, from: c.before, to: c.after })), files);
}

/** Why it can't be undone: files that changed after it was applied. Empty when it can. */
export async function undoConflicts(p: Proposal, files: Files): Promise<string[]> {
  return conflicts({ ...p, changes: p.changes.map((c) => ({ path: c.path, before: c.after, after: c.before })) }, files);
}

/** Puts the files back as they were before it was applied. */
export async function undo(p: Proposal, files: Files): Promise<void> {
  await swap(p.changes.map((c) => ({ path: c.path, from: c.after, to: c.before })), files);
}

async function swap(steps: { path: string; from: string | null; to: string | null }[], files: Files) {
  const done: typeof steps = [];
  try {
    for (const s of steps) {
      if (s.to === null) await files.remove(s.path);
      else await files.write(s.path, s.to);
      done.push(s);
    }
  } catch (e) {
    for (const s of done.reverse()) {
      try {
        if (s.from === null) await files.remove(s.path);
        else await files.write(s.path, s.from);
      } catch {
        // Best effort: the error below still tells the developer.
      }
    }
    throw e;
  }
}

/** Line endings don't count as a change. */
function sameText(a: string, b: string): boolean {
  return a === b || a.replace(/\r\n/g, '\n') === b.replace(/\r\n/g, '\n');
}

/** Proposals saved in one project. */
export class ProposalStore {
  readonly dir: string;
  /** Files that couldn't be read as proposals, with the reason. */
  problems: { file: string; message: string }[] = [];

  constructor(readonly root: string) {
    this.dir = join(root, PROPOSALS_DIR);
  }

  /** All proposals, newest first. */
  list(): Proposal[] {
    this.problems = [];
    let names: string[] = [];
    try {
      names = readdirSync(this.dir).filter((n) => n.endsWith('.json'));
    } catch {
      return [];
    }
    const out: Proposal[] = [];
    for (const name of names) {
      const id = name.slice(0, -5);
      let text: string;
      try {
        text = readFileSync(join(this.dir, name), 'utf8');
      } catch {
        continue;
      }
      const p = parseProposal(text, id);
      if (typeof p === 'string') this.problems.push({ file: name, message: p });
      // The file name is the id, so saving always lands on the same file.
      else out.push({ ...p, id });
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  get(id: string): Proposal | undefined {
    return this.list().find((p) => p.id === id);
  }

  save(p: Proposal) {
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(join(this.dir, `${p.id}.json`), JSON.stringify(p, null, 2) + '\n');
  }

  /** Records a new status (with an optional note) and saves. */
  mark(p: Proposal, status: Status, note?: string): Proposal {
    const next: Proposal = { ...p, status, history: [...p.history, { at: new Date().toISOString(), status, ...(note ? { note } : {}) }] };
    this.save(next);
    return next;
  }
}

/** A fresh id: time first, so names sort by when they were made. */
export function newId(): string {
  return `${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${Math.random().toString(36).slice(2, 7)}`;
}
