// Line differences between two texts, grouped into hunks with a little context, for showing a change in review.
// No VS Code APIs here, so it can be tested on its own.

export interface DiffLine {
  kind: 'same' | 'added' | 'removed';
  text: string;
  /** Line number in the old text (same and removed lines). */
  old?: number;
  /** Line number in the new text (same and added lines). */
  new?: number;
}

export interface Hunk {
  lines: DiffLine[];
}

/** Past this many lines × lines, the diff stops looking for the best match and shows old vs new as blocks. */
const MAX_WORK = 4_000_000;

export function lines(text: string | null | undefined): string[] {
  if (text === null || text === undefined || text === '') return [];
  return text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
}

/** Every line, marked same, added or removed (longest common run of lines kept). */
export function diffLines(before: string | null | undefined, after: string | null | undefined): DiffLine[] {
  const a = lines(before);
  const b = lines(after);
  // Equal starts and ends are matched first, so the table is only built for the part that changed.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const out: DiffLine[] = [];
  for (let i = 0; i < start; i++) out.push({ kind: 'same', text: a[i], old: i + 1, new: i + 1 });
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  if (midA.length * midB.length > MAX_WORK) {
    midA.forEach((text, i) => out.push({ kind: 'removed', text, old: start + i + 1 }));
    midB.forEach((text, i) => out.push({ kind: 'added', text, new: start + i + 1 }));
  } else {
    // Longest common subsequence, table from the end so the walk goes forwards.
    const n = midA.length;
    const m = midB.length;
    const table = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) table[i][j] = midA[i] === midB[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && midA[i] === midB[j]) {
        out.push({ kind: 'same', text: midA[i], old: start + i + 1, new: start + j + 1 });
        i++;
        j++;
      } else if (i < n && (j >= m || table[i + 1][j] >= table[i][j + 1])) {
        // Removed lines come before added ones, as in every diff.
        out.push({ kind: 'removed', text: midA[i], old: start + i + 1 });
        i++;
      } else {
        out.push({ kind: 'added', text: midB[j], new: start + j + 1 });
        j++;
      }
    }
  }
  const shift = endB - endA;
  for (let i = endA; i < a.length; i++) out.push({ kind: 'same', text: a[i], old: i + 1, new: i + shift + 1 });
  return out;
}

/** Only the changed parts, each with `context` unchanged lines around it. */
export function hunks(before: string | null | undefined, after: string | null | undefined, context = 3): Hunk[] {
  const all = diffLines(before, after);
  const keep = new Array<boolean>(all.length).fill(false);
  all.forEach((l, i) => {
    if (l.kind === 'same') return;
    for (let k = Math.max(0, i - context); k <= Math.min(all.length - 1, i + context); k++) keep[k] = true;
  });
  const result: Hunk[] = [];
  let current: DiffLine[] | undefined;
  all.forEach((l, i) => {
    if (keep[i]) (current ??= []).push(l);
    else if (current) {
      result.push({ lines: current });
      current = undefined;
    }
  });
  if (current) result.push({ lines: current });
  return result;
}

/** How many lines were added and removed. */
export function counts(before: string | null | undefined, after: string | null | undefined): { added: number; removed: number } {
  const all = diffLines(before, after);
  return { added: all.filter((l) => l.kind === 'added').length, removed: all.filter((l) => l.kind === 'removed').length };
}
