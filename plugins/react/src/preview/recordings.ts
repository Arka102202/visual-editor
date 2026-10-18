// Real replies recorded from the developer's own dev backend (in the "live backend" situation, after they agreed),
// kept on this computer in the git-ignored preview folder and used by "normal" afterwards, even with the backend off.
// Only the data is kept: never headers, cookies or tokens. No VS Code APIs, so it can be tested.

import { readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PREVIEW_DIR } from './harness';
import type { ReplyRule } from './replies';

export const RECORDINGS_FILE = 'recordings.json';
/** Replies bigger than this aren't kept (a preview needs a sample, not the whole database). */
const MAX_REPLY_CHARS = 200_000;

interface Recorded {
  reply: unknown;
  at: string;
}

const file = (root: string) => join(root, PREVIEW_DIR, RECORDINGS_FILE);

export function readRecordings(root: string): Record<string, Recorded> {
  try {
    const data = JSON.parse(readFileSync(file(root), 'utf8')) as Record<string, Recorded>;
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

/**
 * Keeps a reply. It's filed under the request's known match when there is one (`/api/orders/` for
 * `/api/orders/1042`), so every order page can use it; otherwise under its own path.
 */
export function record(root: string, address: string, reply: unknown, known: string[]): string | undefined {
  let path: string;
  try {
    path = new URL(address, 'http://x').pathname;
  } catch {
    return undefined;
  }
  const text = JSON.stringify(reply);
  if (text === undefined || text.length > MAX_REPLY_CHARS) return undefined;
  const match = [...known].sort((a, b) => b.length - a.length).find((m) => m.startsWith('/') && path.startsWith(m)) ?? path;
  const all = readRecordings(root);
  all[match] = { reply, at: new Date().toISOString() };
  mkdirSync(dirname(file(root)), { recursive: true });
  writeFileSync(file(root), JSON.stringify(all, null, 2));
  return match;
}

/** Recorded replies first (real data beats worked-out data), then the worked-out ones for everything else. */
export function withRecordings(root: string, workedOut: ReplyRule[]): ReplyRule[] {
  const recorded = Object.entries(readRecordings(root)).map(([match, r]) => ({ match, reply: r.reply }));
  const taken = new Set(recorded.map((r) => r.match));
  return [...recorded, ...workedOut.filter((r) => !taken.has(r.match))].sort((a, b) => b.match.length - a.match.length);
}

export function forgetRecordings(root: string) {
  rmSync(file(root), { force: true });
}
