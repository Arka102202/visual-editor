// What git knows about some files of a project: the commits that touched them (newest first), and their changes not
// committed yet. Nothing when the project isn't in git (or git isn't there). No VS Code APIs.

import { execFile } from 'node:child_process';
import { statSync } from 'node:fs';
import { join } from 'node:path';

export interface Commit {
  hash: string;
  author: string;
  at: string;
  subject: string;
  /** Lines added and removed in the files asked about. */
  added: number;
  removed: number;
  files: string[];
}

export interface Uncommitted {
  /** When the newest of them was saved. */
  at: string;
  added: number;
  removed: number;
  /** Changed since the last commit (new ones too). */
  files: string[];
  /** New: git doesn't have them yet. */
  created: string[];
}

export interface GitHistory {
  commits: Commit[];
  uncommitted?: Uncommitted;
}

/** git's answer, or undefined when it failed. */
function git(root: string, args: string[]): Promise<string | undefined> {
  return new Promise((done) =>
    execFile('git', ['-C', root, '-c', 'core.quotepath=off', ...args], { maxBuffer: 8 * 1024 * 1024, timeout: 15_000 }, (e, out) => done(e ? undefined : out)),
  );
}

/** "12\t3\tsrc/Card.tsx" (a binary file: "-\t-\t…"). */
function numstat(line: string): { added: number; removed: number; path: string } | undefined {
  const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
  return m ? { added: Number(m[1]) || 0, removed: Number(m[2]) || 0, path: m[3] } : undefined;
}

/** The commits that touched `paths` (relative to `root`), newest first, at most `max`; and what isn't committed yet. */
export async function gitHistory(root: string, paths: string[], max = 15): Promise<GitHistory | undefined> {
  if ((await git(root, ['rev-parse', '--is-inside-work-tree']))?.trim() !== 'true') return undefined;
  if (!paths.length) return { commits: [] };
  // (A repository without commits yet has no log: no commits, and every file is new.)
  const log = (await git(root, ['log', `-n${max}`, '--format=%x1e%H%x1f%an%x1f%aI%x1f%s', '--numstat', '--', ...paths])) ?? '';
  const commits: Commit[] = [];
  for (const block of log.split('\x1e').slice(1)) {
    const [head, ...rest] = block.split('\n');
    const [hash, author, at, subject] = head.split('\x1f');
    const stats = rest.map(numstat).filter((s): s is NonNullable<typeof s> => !!s);
    commits.push({ hash, author, at, subject, added: stats.reduce((n, s) => n + s.added, 0), removed: stats.reduce((n, s) => n + s.removed, 0), files: stats.map((s) => s.path) });
  }
  const diff = ((await git(root, ['diff', '--numstat', 'HEAD', '--', ...paths])) ?? '').split('\n').map(numstat).filter((s): s is NonNullable<typeof s> => !!s);
  const created = ((await git(root, ['ls-files', '--others', '--exclude-standard', '--', ...paths])) ?? '').split('\n').filter(Boolean);
  const files = [...new Set([...diff.map((d) => d.path), ...created])];
  if (!files.length) return { commits };
  const saved = Math.max(...files.map((f) => {
    try {
      return statSync(join(root, f)).mtimeMs;
    } catch {
      // (Deleted: when isn't known; now, then.)
      return Date.now();
    }
  }));
  return { commits, uncommitted: { at: new Date(saved).toISOString(), added: diff.reduce((n, d) => n + d.added, 0), removed: diff.reduce((n, d) => n + d.removed, 0), files, created } };
}

/** A commit as text (its message, then its changes to `paths`), or undefined when git can't show it. */
export async function commitText(root: string, hash: string, paths: string[]): Promise<string | undefined> {
  if (!/^[0-9a-f]{7,40}$/.test(hash)) return undefined;
  return git(root, ['show', '--stat', '--patch', '--format=commit %H%nAuthor: %an%nDate: %aI%n%n%B', hash, '--', ...paths]);
}
