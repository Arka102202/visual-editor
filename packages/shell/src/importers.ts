// After a change adds or removes files, a running dev server may still resolve imports to what was there before (Vite
// keeps an importer's resolved path when `Name/index.ts` becomes `Name/index.tsx`, so the page goes blank). Touching
// the files that import them (their time, not their text) makes it read them again. No VS Code APIs.

import { utimesSync } from 'node:fs';
import { posix } from 'node:path';

/**
 * The files that import any of `paths` (relative to the project): by an import that ends in the file's name, or, for an
 * index file, its folder's name. `files` are the project's code files with their text; the changed files themselves
 * are left out.
 */
export function importersOf(paths: string[], files: { path: string; text: string }[]): string[] {
  const names = [...new Set(paths.map((p) => {
    const stem = posix.basename(p).replace(/\.[cm]?[jt]sx?$/, '');
    return stem === 'index' ? posix.basename(posix.dirname(p)) : stem;
  }))].filter((n) => n && n !== '.');
  if (!names.length) return [];
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const named = new RegExp(`(?:from\\s*|import\\s*\\(\\s*|import\\s+)['"](?:[^'"]*/)?(?:${names.map(esc).join('|')})(?:\\.[cm]?[jt]sx?)?['"]`);
  const changed = new Set(paths);
  return files.filter((f) => !changed.has(f.path) && named.test(f.text)).map((f) => f.path);
}

/** Touches files (their modified time only), so a dev server reads them again. */
export function touch(absolute: string[]) {
  const now = new Date();
  for (const path of absolute) {
    try {
      utimesSync(path, now, now);
    } catch {
      // gone meanwhile
    }
  }
}
