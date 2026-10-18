// How cards and lines are told apart on the map: a colour per kind of card and per kind of line, how much each card
// is used, and which feature area (folder) it belongs to. The same rules for every plugin; plugins never pick colours.
// Colour is never the only clue: every card names its kind, and the legend names every colour.
// No VS Code APIs here, so it can be tested on its own.

import type { Item, Link } from '@visual-editor/contract';

/** A colour in both themes, each step chosen for its own background. */
export interface Tone {
  dark: string;
  light: string;
  /** Kinds past the palette: neutral with a dashed strip, so colours never repeat. */
  dashed?: boolean;
}

/**
 * The map's palette: vivid turquoise, magenta, red and chartreuse, bright on dark. Brighter than chart marks usually
 * are, on purpose: they're strips, tints and labels on cards. Checked for telling apart, every pair, both themes
 * (dark: normal 20.2, colour-blind 15.9; light: 18.2, 16.2, OKLab ΔE ×100) and kept at least 15 from the status marks
 * (yellow proposed, blue changed), so a kind never looks like a status. The most common kind gets NEUTRAL; the next
 * four get the colours in order; any more stay neutral with a dashed strip, never a repeat.
 */
export const NEUTRAL: Tone = { dark: '#7c8580', light: '#8a918c' };
export const PALETTE: Tone[] = [
  { dark: '#22e0d0', light: '#00736a' }, // turquoise
  { dark: '#e040fb', light: '#cc23e7' }, // magenta
  { dark: '#ff5a5f', light: '#fbb6b3' }, // red (soft on white, to stay apart)
  { dark: '#c9f03c', light: '#799305' }, // chartreuse
];
/** Folder boxes: soft tints of the whole vivid family (labelled, so any tint may sit next to any other). */
export const AREA_TINTS: Tone[] = [
  { dark: '#22e0d0', light: '#02968b' }, // turquoise
  { dark: '#ff8a3d', light: '#c85a12' }, // orange
  { dark: '#e040fb', light: '#b500cf' }, // magenta
  { dark: '#c9f03c', light: '#7f9a10' }, // chartreuse
  { dark: '#ff6b9a', light: '#c2325f' }, // rose
  { dark: '#ff9e8a', light: '#c9604a' }, // salmon
  { dark: '#ff4fc8', light: '#c0168f' }, // hot pink
  { dark: '#ff5a5f', light: '#bb0328' }, // red
];

/** A tone for each kind, by how common it is. */
function byCount(kinds: string[]): Record<string, Tone> {
  const counts = new Map<string, number>();
  for (const k of kinds) counts.set(k, (counts.get(k) ?? 0) + 1);
  const order = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k]) => k);
  // A single kind needs no colour to tell it apart.
  if (order.length === 1) return { [order[0]]: NEUTRAL };
  return Object.fromEntries(order.map((k, i) => [k, i === 0 ? NEUTRAL : (PALETTE[i - 1] ?? { ...NEUTRAL, dashed: true })]));
}

export function cardColours(items: Item[]): Record<string, Tone> {
  return byCount(items.map((i) => i.kind));
}

export function lineColours(links: Link[]): Record<string, Tone> {
  return byCount(links.map((l) => l.kind));
}

/** How many other cards point at each card (renders it, calls it…). */
export function usedBy(links: Link[]): Record<string, number> {
  const from = new Map<string, Set<string>>();
  for (const l of links) {
    if (l.from === l.to) continue;
    const set = from.get(l.to) ?? new Set<string>();
    set.add(l.from);
    from.set(l.to, set);
  }
  return Object.fromEntries([...from].map(([id, s]) => [id, s.size]));
}

/**
 * The feature area of a card: the folder of its file, or the folder above when the file sits in a folder of its own
 * name ("shared/Toggle/Toggle.tsx", "shared/Toggle/index.tsx" → "shared").
 */
export function areaOf(item: Item): string {
  const path = item.source?.path;
  if (!path) return '';
  const parts = path.split('/');
  const file = parts.pop()!;
  const base = file.replace(/\.[^.]+$/, '');
  if (parts.length && (base === 'index' || parts[parts.length - 1] === base)) parts.pop();
  return parts.join('/');
}

/** Folder names that say nothing about the feature, left out of area names. */
const GENERIC = new Set(['src', 'app', 'lib', 'components', 'component', 'pages', 'views', 'features', 'modules', 'ui', 'client', 'web', 'frontend']);

/**
 * Areas named shortly, by their feature: generic folders ("src", "components") are left out and at most the last two
 * remain, e.g. "src/pages/Editor/components/InspectorPanel/components" → "Editor › InspectorPanel".
 */
export function areaNames(areas: string[]): Record<string, string> {
  const real = [...new Set(areas.filter(Boolean))];
  return Object.fromEntries(
    real.map((a) => {
      const parts = a.split('/');
      const meaningful = parts.filter((p) => !GENERIC.has(p.toLowerCase()));
      return [a, (meaningful.length ? meaningful.slice(-2) : parts.slice(-1)).join(' › ')];
    }),
  );
}

