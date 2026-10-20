// Source maps: a place in the code the browser runs (the dev server's built version of a file) back to the place in
// the developer's own file. Dev servers put the map inside the code they serve (a sourceMappingURL comment, usually
// with the map itself as base64). Pure, so it can be tested.

export interface SourceMap {
  version: number;
  sources: string[];
  sourceRoot?: string;
  mappings: string;
}

/** The map inside a served file, when it carries one there (inline); its address otherwise. */
export function mapIn(code: string): { map?: SourceMap; url?: string } {
  const m = /\/\/[#@]\s*sourceMappingURL=(\S+)\s*$/m.exec(code.slice(-200_000));
  if (!m) return {};
  const ref = m[1];
  const inline = /^data:application\/json(?:;charset=[\w-]+)?;base64,(.+)$/.exec(ref);
  if (inline) {
    try {
      return { map: JSON.parse(Buffer.from(inline[1], 'base64').toString('utf8')) as SourceMap };
    } catch {
      return {};
    }
  }
  return { url: ref };
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** One field of a mapping (base64 VLQ), and where the next starts. */
function vlq(s: string, at: number): [number, number] {
  let value = 0;
  let shift = 0;
  let digit: number;
  do {
    digit = B64.indexOf(s[at++]);
    if (digit < 0) return [0, at];
    value += (digit & 31) << shift;
    shift += 5;
  } while (digit & 32);
  return [value & 1 ? -(value >>> 1) : value >>> 1, at];
}

/**
 * Where a place in the served code (1-based line and column) comes from: the source (as the map names it) and its
 * 1-based line and column. The closest mapping at or before the column on that line counts.
 */
export function original(map: SourceMap, line: number, column: number): { source: string; line: number; column: number } | undefined {
  const lines = map.mappings.split(';');
  let source = 0;
  let srcLine = 0;
  let srcCol = 0;
  let best: { source: number; line: number; column: number } | undefined;
  for (let l = 0; l < lines.length && l < line; l++) {
    let genCol = 0;
    for (const segment of lines[l].split(',')) {
      if (!segment) continue;
      let at = 0;
      let d: number;
      [d, at] = vlq(segment, at);
      genCol += d;
      if (at >= segment.length) continue;
      [d, at] = vlq(segment, at);
      source += d;
      [d, at] = vlq(segment, at);
      srcLine += d;
      [d, at] = vlq(segment, at);
      srcCol += d;
      if (l === line - 1 && genCol <= column - 1) best = { source, line: srcLine, column: srcCol };
    }
  }
  if (!best || !map.sources[best.source]) return undefined;
  const name = (map.sourceRoot ? map.sourceRoot.replace(/\/?$/, '/') : '') + map.sources[best.source];
  return { source: name, line: best.line + 1, column: best.column + 1 };
}
