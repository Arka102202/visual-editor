// The clean-up helper: one small Claude run (reading only, summaries rather than code) that suggests which design
// sessions to delete for good, each with why: discarded tries, empty ones, ones a later session replaced, finished ones
// long done. It only suggests: the developer sees them marked in Memory → Sessions and deletes them with one click.
// An unfinished session with work in it is never suggested, whatever the answer says.

/** A session as the helper reads it. */
export interface SessionSummary {
  id: string;
  title: string;
  /** Where it stands, or how it ended (Memory's words: "being worked on", "sent to Review", "discarded"…). */
  state: string;
  /** Finished: what became of its proposal (applied, rejected…). */
  outcome?: string;
  /** What the developer asked, oldest first. */
  asked: string[];
  versions: number;
  files: number;
  updatedAt: string;
}

const FINISHED = new Set(['sent to Review', 'discarded']);

/** May the helper suggest deleting it? Never an unfinished session with work in it. */
export const deletable = (s: SessionSummary) => FINISHED.has(s.state) || s.files === 0;

export function cleanupPrompt(list: SessionSummary[], today: string): string {
  const lines = list.map((s) =>
    [
      `- id ${s.id}: “${s.title}”`,
      `  state: ${s.state}${s.outcome ? ` (its proposal: ${s.outcome})` : ''}; last changed ${s.updatedAt.slice(0, 10)}; ${s.versions} version(s), ${s.files} file(s)`,
      ...(s.asked.length ? [`  asked: ${s.asked.slice(0, 4).map((a) => `“${a.slice(0, 160)}”`).join(' / ')}${s.asked.length > 4 ? ` (+${s.asked.length - 4} more)` : ''}`] : []),
      ...(deletable(s) ? [] : ['  (unfinished, with work in it: never suggest it)']),
    ].join('\n'),
  );
  return `You help a developer clean up their Visual Editor design sessions. Today is ${today}. Everything you need is below: don't read any files.

Suggest which sessions to delete for good, and keep the rest. Suggest:
- discarded sessions, unless what was asked there was never done in another session;
- sessions with no changes (0 files);
- earlier tries at the same thing, when a later session (or its proposal) replaced them;
- finished sessions whose proposal was applied, rejected or undone more than about two weeks ago, unless what was asked there is unusual enough to want to look at again.
Keep unfinished sessions with work in them (marked so: never suggest those), held-back ones, ones whose test cases wait, and anything from the last two days.

Sessions:
${lines.join('\n')}

Answer with JSON only:
{"delete": [{"id": "<id>", "why": "<why, in at most 12 plain words, e.g. an earlier try, replaced by “Compact: even padding”>"}]}
An empty list is fine.`;
}

/** The helper's answer: which to delete (id → why); a string says what went wrong. */
export function readCleanup(text: string, list: SessionSummary[]): Map<string, string> | string {
  const json = /\{[\s\S]*\}/.exec(text)?.[0];
  let raw: { delete?: { id?: unknown; why?: unknown }[] };
  try {
    raw = JSON.parse(json ?? '');
  } catch {
    return 'The clean-up helper didn\'t answer with a list.';
  }
  if (!Array.isArray(raw.delete)) return 'The clean-up helper didn\'t answer with a list.';
  const byId = new Map(list.map((s) => [s.id, s]));
  const out = new Map<string, string>();
  for (const d of raw.delete) {
    const s = typeof d.id === 'string' ? byId.get(d.id) : undefined;
    // (Only sessions it was shown, and never one with work still in it.)
    if (!s || !deletable(s)) continue;
    out.set(s.id, typeof d.why === 'string' && d.why.trim() ? d.why.trim().slice(0, 120) : 'not needed any more');
  }
  return out;
}
