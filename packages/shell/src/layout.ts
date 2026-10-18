// Where each card goes on the map. Every map a plugin brings gets its own section, one under the other. Inside a
// section, cards with lines between them flow left to right (what renders or calls what); cards without lines sit
// in a tidy grid. Positions are worked out here, so the map panel only draws.
// No VS Code APIs here, so it can be tested on its own.

import type { Item, Link, MapDefinition } from '@visual-editor/contract';
import { AREA_TINTS, areaNames, areaOf, type Tone } from './styles';

/** Flow: cards with lines in columns by depth. Folders: each folder's cards together in a box. */
export type Arrange = 'flow' | 'folders';

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
  /** A folder box's tint. */
  tint?: Tone;
  /** A folder's box (Folders arrangement), drawn as a tinted area with its name. */
  box?: boolean;
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

export function layoutMap(items: Item[], links: Link[], maps: MapDefinition[], arrange: Arrange = 'flow'): Layout {
  if (arrange === 'folders') return byFolder(items, links);
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

/** A column holds at most this many cards; more spill into the next column, so the map stays wide, not tall. */
const MAX_PER_COLUMN = 8;

/**
 * Cards with lines flow in columns by depth: a card sits right of the deepest card pointing at it (loops are cut).
 * In each column, cards are ordered by where the cards pointing at them are, so lines cross less. Cards without any
 * line sit in a grid underneath.
 */
function flow(items: Item[], links: Link[]): PlacedCard[] {
  const linked = new Set(links.flatMap((l) => [l.from, l.to]));
  const alone = items.filter((i) => !linked.has(i.id));
  items = items.filter((i) => linked.has(i.id));
  const out = new Map<string, string[]>();
  const into = new Map<string, string[]>();
  const waiting = new Map<string, number>(items.map((i) => [i.id, 0]));
  for (const l of links) {
    out.set(l.from, [...(out.get(l.from) ?? []), l.to]);
    into.set(l.to, [...(into.get(l.to) ?? []), l.from]);
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
  const order = new Map<string, number>();
  const cards: PlacedCard[] = [];
  let x = 0;
  for (const col of [...columns.keys()].sort((a, b) => a - b)) {
    // Ordered by the average place of the cards pointing at them (keeping name order among equals).
    const place = (i: Item) => {
      const from = (into.get(i.id) ?? []).map((f) => order.get(f)).filter((n): n is number => n !== undefined);
      return from.length ? from.reduce((a, b) => a + b, 0) / from.length : Infinity;
    };
    const list = columns.get(col)!.map((item, n) => ({ item, n, at: place(item) })).sort((a, b) => a.at - b.at || a.n - b.n).map((e) => e.item);
    list.forEach((item, n) => order.set(item.id, n));
    for (let start = 0; start < list.length; start += MAX_PER_COLUMN) {
      let y = 0;
      for (const item of list.slice(start, start + MAX_PER_COLUMN)) {
        const h = cardHeight(item);
        cards.push({ item, x, y, w: CARD_WIDTH, h });
        y += h + GAP_Y;
      }
      x += CARD_WIDTH + GRID_GAP;
    }
    x += GAP_X - GRID_GAP;
  }
  if (alone.length) {
    const top = cards.length ? Math.max(...cards.map((c) => c.y + c.h)) + GAP_X : 0;
    for (const c of grid(alone)) cards.push({ ...c, y: c.y + top });
  }
  return cards;
}

const BOX_PAD = 24;
const BOX_HEAD = 40;
const BOX_GAP = 48;

/** Each folder's cards in a box (a small grid), boxes in rows: the app's parts at a glance. */
function byFolder(items: Item[], links: Link[]): Layout {
  const groups = new Map<string, Item[]>();
  for (const item of [...items].sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id))) {
    const area = areaOf(item);
    groups.set(area, [...(groups.get(area) ?? []), item]);
  }
  const names = areaNames([...groups.keys()]);
  // Bigger areas first, then by name, so the main parts of the app lead.
  const order = [...groups.keys()].sort((a, b) => groups.get(b)!.length - groups.get(a)!.length || a.localeCompare(b));
  const boxes = order.map((area) => {
    const cards = grid(groups.get(area)!);
    const w = Math.max(CARD_WIDTH, ...cards.map((c) => c.x + c.w)) + BOX_PAD * 2;
    const h = Math.max(0, ...cards.map((c) => c.y + c.h)) + BOX_PAD + BOX_HEAD;
    return { area, cards, w, h };
  });
  // Rows about as wide as the whole is tall, so the map is roughly square.
  const total = boxes.reduce((n, b) => n + (b.w + BOX_GAP) * (b.h + BOX_GAP), 0);
  const rowWidth = Math.max(1200, Math.sqrt(total) * 1.3, ...boxes.map((b) => b.w));
  const sections: Section[] = [];
  let x = 0;
  let y = 0;
  let rowH = 0;
  for (const [n, b] of boxes.entries()) {
    if (x > 0 && x + b.w > rowWidth) {
      x = 0;
      y += rowH + BOX_GAP;
      rowH = 0;
    }
    for (const c of b.cards) {
      c.x += x + BOX_PAD;
      c.y += y + BOX_HEAD;
    }
    sections.push({ map: { id: b.area || '(no folder)', title: b.area ? names[b.area] : 'Other', description: b.area || undefined }, box: true, tint: AREA_TINTS[n % AREA_TINTS.length], x, y, w: b.w, h: b.h, cards: b.cards });
    x += b.w + BOX_GAP;
    rowH = Math.max(rowH, b.h);
  }
  const ids = new Set(items.map((i) => i.id));
  return {
    sections,
    links: links.filter((l) => ids.has(l.from) && ids.has(l.to) && l.from !== l.to),
    width: Math.max(0, ...sections.map((s) => s.x + s.w)),
    height: Math.max(0, ...sections.map((s) => s.y + s.h)),
  };
}

