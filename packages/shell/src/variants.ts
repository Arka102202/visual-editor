// A component's data cases for the Playground: the ones kept in Name.variants.json next to it (to commit and share;
// the App panel saves there too), and ones suggested from its props' types (empty, long, many, each option…). Plain
// values: a function prop is {"$action": "name"} (it says when it's called). No VS Code APIs.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Item, Link } from '@visual-editor/contract';
import type { DataCase } from './cases';

export { exampleFor, exampleProps, suggestCases, type DataCase } from './cases';

export interface VariantsFile {
  component: string;
  data: DataCase[];
}

/** Where a component's cases are kept: Name.variants.json next to its file. */
export function variantsPath(item: Item): string | undefined {
  return item.source ? join(dirname(item.source.path), `${item.label}.variants.json`) : undefined;
}

export function readCases(root: string, item: Item): DataCase[] {
  const rel = variantsPath(item);
  if (!rel || !existsSync(join(root, rel))) return [];
  try {
    const data = JSON.parse(readFileSync(join(root, rel), 'utf8'));
    return Array.isArray(data.data) ? data.data.filter((d: DataCase) => d && typeof d.name === 'string' && d.props && typeof d.props === 'object') : [];
  } catch {
    return [];
  }
}

export function writeCases(root: string, item: Item, cases: DataCase[]): string {
  const rel = variantsPath(item);
  if (!rel) throw new Error(`${item.label} has no file, so its cases have nowhere to go.`);
  const file: VariantsFile = { component: item.label, data: cases };
  writeFileSync(join(root, rel), `${JSON.stringify(file, null, 2)}\n`);
  return rel;
}

/** The pages a card is drawn on: routes reached by following lines back from it (a route shows a component…). */
export function pagesOf(item: Item, items: Item[], links: Link[]): string[] {
  const byId = new Map(items.map((i) => [i.id, i]));
  const seen = new Set([item.id]);
  const queue = [item.id];
  const pages: string[] = [];
  while (queue.length && seen.size < 800) {
    const id = queue.shift()!;
    for (const l of links) {
      if (l.to !== id || seen.has(l.from)) continue;
      seen.add(l.from);
      const from = byId.get(l.from);
      if (from?.kind === 'route' && from.label.startsWith('/')) pages.push(from.label);
      else queue.push(l.from);
    }
  }
  // The plainest first: an address without :params can be opened as it is.
  return [...new Set(pages)].sort((a, b) => (a.match(/[:*]/g) ?? []).length - (b.match(/[:*]/g) ?? []).length || a.length - b.length);
}
