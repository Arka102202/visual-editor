// Where each card goes on the map. Every map a plugin brings gets its own section, one under the other. Inside a
// section, cards with lines between them flow left to right (what renders or calls what); cards without lines sit
// in a tidy grid. Positions are worked out here, so the map panel only draws.
// No VS Code APIs here, so it can be tested on its own.

import type { Item, Link, MapDefinition } from '@visual-editor/contract';

export const CARD_WIDTH = 240;
const CARD_HEAD = 56;
const FIELD_ROW = 22;
/** Cards show this many rows; the rest are summed up as "+ N more". */
export const MAX_FIELDS = 8;
const GAP_X = 120;
const GAP_Y = 28;
const GRID_GAP = 32;
const SECTION_HEAD = 44;
const SECTION_GAP = 80;

export interface PlacedCard {
  item: Item;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Section {
  map: MapDefinition;
  x: number;
  y: number;
  w: number;
  h: number;
  cards: PlacedCard[];
}

export interface Layout {
  sections: Section[];
  /** Only lines whose both ends are on this map. */
  links: Link[];
  width: number;
  height: number;
}

export function cardHeight(item: Item): number {
  const n = item.fields?.length ?? 0;
  return CARD_HEAD + Math.min(n, MAX_FIELDS) * FIELD_ROW + (n > MAX_FIELDS ? FIELD_ROW : 0) + (n ? 8 : 0);
}

export function layoutMap(items: Item[], links: Link[], maps: MapDefinition[]): Layout {
  const byMap = new Map<string, Item[]>();
  for (const item of [...items].sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id))) {
    const list = byMap.get(item.map) ?? [];
    list.push(item);
    byMap.set(item.map, list);
  }
  const known = new Map(maps.map((m) => [m.id, m]));
  const ids = new Set(items.map((i) => i.id));
  const shown = links.filter((l) => ids.has(l.from) && ids.has(l.to) && l.from !== l.to);

  const sections: Section[] = [];
  let y = 0;
  let width = 0;
  // Maps in the order plugins listed them, then any a reader used without listing.
  const order = [...maps.map((m) => m.id).filter((id) => byMap.has(id)), ...[...byMap.keys()].filter((id) => !known.has(id)).sort()];
  for (const id of order) {
    const sectionItems = byMap.get(id)!;
    const inside = new Set(sectionItems.map((i) => i.id));
    const sectionLinks = shown.filter((l) => inside.has(l.from) && inside.has(l.to));
    const cards = sectionLinks.length ? flow(sectionItems, sectionLinks) : grid(sectionItems);
    const w = Math.max(CARD_WIDTH, ...cards.map((c) => c.x + c.w));
    const h = Math.max(0, ...cards.map((c) => c.y + c.h));
    for (const c of cards) c.y += y + SECTION_HEAD;
    sections.push({ map: known.get(id) ?? { id, title: id }, x: 0, y, w, h: h + SECTION_HEAD, cards });
    width = Math.max(width, w);
    y += SECTION_HEAD + h + SECTION_GAP;
  }
  return { sections, links: shown, width, height: Math.max(0, y - SECTION_GAP) };
}

/** Cards in rows, about 3 wide for every 2 tall. */
function grid(items: Item[]): PlacedCard[] {
  const cols = Math.max(1, Math.ceil(Math.sqrt(items.length * 1.5)));
  const cards: PlacedCard[] = [];
  let y = 0;
  for (let i = 0; i < items.length; i += cols) {
    const row = items.slice(i, i + cols);
    const rowH = Math.max(...row.map(cardHeight));
    row.forEach((item, c) => cards.push({ item, x: c * (CARD_WIDTH + GRID_GAP), y, w: CARD_WIDTH, h: cardHeight(item) }));
    y += rowH + GRID_GAP;
  }
  return cards;
}

/** Columns by depth: a card sits one column right of the deepest card pointing at it (loops are cut). */
function flow(items: Item[], links: Link[]): PlacedCard[] {
  const out = new Map<string, string[]>();
  const waiting = new Map<string, number>(items.map((i) => [i.id, 0]));
  for (const l of links) {
    out.set(l.from, [...(out.get(l.from) ?? []), l.to]);
    waiting.set(l.to, waiting.get(l.to)! + 1);
  }
  const rank = new Map<string, number>(items.map((i) => [i.id, 0]));
  const done = new Set<string>();
  const queue = items.filter((i) => !waiting.get(i.id)).map((i) => i.id);
  while (done.size < items.length) {
    // Everything left is in a loop: cut it at the first card still waiting.
    if (!queue.length) queue.push(items.find((i) => !done.has(i.id))!.id);
    const id = queue.shift()!;
    if (done.has(id)) continue;
    done.add(id);
    for (const next of out.get(id) ?? []) {
      if (done.has(next)) continue;
      rank.set(next, Math.max(rank.get(next)!, rank.get(id)! + 1));
      waiting.set(next, waiting.get(next)! - 1);
      if (!waiting.get(next)) queue.push(next);
    }
  }

  const columns = new Map<number, Item[]>();
  for (const i of items) columns.set(rank.get(i.id)!, [...(columns.get(rank.get(i.id)!) ?? []), i]);
  const cards: PlacedCard[] = [];
  for (const [col, list] of columns) {
    let y = 0;
    for (const item of list) {
      const h = cardHeight(item);
      cards.push({ item, x: col * (CARD_WIDTH + GAP_X), y, w: CARD_WIDTH, h });
      y += h + GAP_Y;
    }
  }
  return cards;
}
