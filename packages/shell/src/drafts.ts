// Drafts: changes an assistant is still working on, kept apart from proposals. An agent's worker saves its files as a
// draft, its checker reads and checks the draft (plugin tools see the project as the draft would leave it), and only a
// draft that passed is submitted, which makes it an ordinary proposal for the developer's Review. Nothing in the
// project changes before that. Each draft is a JSON file in the project's .visual-editor/drafts/ folder (kept out of git).
// No VS Code APIs here, so it can be tested on its own.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEvidence, safePath, type Evidence, type FileChange } from './proposals';

export const DRAFTS_DIR = '.visual-editor/drafts';

export interface Draft {
  id: string;
  title: string;
  why: string;
  by: { kind: 'assistant' | 'agent'; name: string };
  createdAt: string;
  updatedAt: string;
  /** 'submitted': it became the proposal `proposal`. */
  status: 'draft' | 'submitted';
  /** Each file as it was when the draft was saved (`before`) and as the draft has it (`after`; null: removed). */
  changes: FileChange[];
  /** Cards it is about. */
  items?: string[];
  proposal?: string;
  /** Its version: one more each time its files change (proof is about one version). */
  revision: number;
  /** Proof: checks run on it and the assistant's notes, each about one version. */
  evidence: Evidence[];
}

/** Reads a draft file's contents; checked like a proposal's (it may have been edited by hand). */
export function parseDraft(text: string, fallbackId: string): Draft | string {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(text);
  } catch {
    return 'It is not valid JSON.';
  }
  if (!raw || typeof raw !== 'object' || typeof raw.title !== 'string' || !Array.isArray(raw.changes)) return 'It is not a draft.';
  const changes: FileChange[] = [];
  for (const c of raw.changes as Record<string, unknown>[]) {
    if (!c || typeof c.path !== 'string' || !safePath(c.path)) return `A change has a path outside the project: ${String(c?.path)}`;
    const before = c.before ?? null;
    const after = c.after ?? null;
    if ((before !== null && typeof before !== 'string') || (after !== null && typeof after !== 'string')) return `The change to ${c.path} is not text.`;
    changes.push({ path: c.path, before, after });
  }
  const by = raw.by as Record<string, unknown> | undefined;
  const now = new Date().toISOString();
  return {
    id: typeof raw.id === 'string' && /^[\w-]+$/.test(raw.id) ? raw.id : fallbackId,
    title: raw.title,
    why: typeof raw.why === 'string' ? raw.why : '',
    by: { kind: by?.kind === 'agent' ? 'agent' : 'assistant', name: typeof by?.name === 'string' ? by.name : 'Assistant' },
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : now,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : now,
    status: raw.status === 'submitted' ? 'submitted' : 'draft',
    changes,
    ...(Array.isArray(raw.items) ? { items: (raw.items as unknown[]).filter((i): i is string => typeof i === 'string') } : {}),
    ...(typeof raw.proposal === 'string' ? { proposal: raw.proposal } : {}),
    revision: typeof raw.revision === 'number' ? raw.revision : 1,
    evidence: Array.isArray(raw.evidence) ? parseEvidence(raw.evidence) : [],
  };
}

/** Drafts saved in one project. */
export class DraftStore {
  readonly dir: string;

  constructor(readonly root: string) {
    this.dir = join(root, DRAFTS_DIR);
  }

  /** All drafts, newest first. */
  list(): Draft[] {
    let names: string[] = [];
    try {
      names = readdirSync(this.dir).filter((n) => n.endsWith('.json'));
    } catch {
      return [];
    }
    const out: Draft[] = [];
    for (const name of names) {
      try {
        const d = parseDraft(readFileSync(join(this.dir, name), 'utf8'), name.slice(0, -5));
        if (typeof d !== 'string') out.push({ ...d, id: name.slice(0, -5) });
      } catch {
        // gone meanwhile
      }
    }
    return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  save(d: Draft) {
    mkdirSync(this.dir, { recursive: true });
    // Drafts are work in progress, not shared: the folder keeps itself out of git (the project's .gitignore is left alone).
    if (!existsSync(join(this.dir, '.gitignore'))) writeFileSync(join(this.dir, '.gitignore'), "# Visual Editor's drafts: work in progress, kept out of git.\n*\n");
    writeFileSync(join(this.dir, `${d.id}.json`), JSON.stringify(d, null, 2) + '\n');
  }
}
