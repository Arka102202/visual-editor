// What the shell and the map page say to each other. Shared by both sides, so they can't drift apart.

import type { Mark } from './changes';
import type { Arrange, Layout } from './layout';
import type { MemoryEntry } from './memory';
import type { Tone } from './styles';

export interface MapProject {
  root: string;
  name: string;
  group?: string;
  /** Cards found in it, to help choose. */
  cards: number;
}

/** Shell → map page: the map, or what's remembered about the chosen card. */
export type ToMap = ShowMap | CardMemory | { type: 'focus'; id: string } | { type: 'measure' };

/** How the map performs (for the performance test): drawing time, and frame times while moving around. */
export interface MapMeasure {
  type: 'measured';
  /** Drawing the last map shown, in ms. */
  drawMs: number;
  /** Frame times in ms while panning and while zooming: average, 95th percentile, worst. */
  pan: { avg: number; p95: number; max: number };
  zoom: { avg: number; p95: number; max: number };
  /** Time spent painting each step (the map's own work, before the screen shows it). */
  paintPan?: { avg: number; p95: number; max: number };
  paintZoom?: { avg: number; p95: number; max: number };
  /** Frame times panning while zoomed in (cards as elements), and how many card elements that took. */
  nearPan?: { avg: number; p95: number; max: number };
  nearCards?: number;
  /** Sent first, before the frame times (which need the screen). */
  partial?: boolean;
  cards: number;
  lines: number;
  /** Elements on the page. */
  elements: number;
}

export interface CardMemory {
  type: 'card';
  id: string;
  /** Notes, rules and decisions about it, and changes to it, newest first. */
  entries: MemoryEntry[];
  /** A plugin can show how it looks. */
  canPreview: boolean;
  /** How many other versions of it there are to compare (contract 5). */
  versions: number;
}

export type ShowMap = {
  type: 'show';
  projects: MapProject[];
  /** The root of the project shown. */
  current?: string;
  /** Plugins that understand it, by name. */
  plugins: string[];
  /** The project's maps (tabs), with how many cards each has; one is shown at a time. */
  maps: { id: string; title: string; description?: string; cards: number }[];
  /** The map shown. */
  map?: string;
  layout: Layout;
  arrange: Arrange;
  /** Colour of each kind of card, and of each kind of line. */
  colours: { cards: Record<string, Tone>; lines: Record<string, Tone> };
  /** How many other cards point at each card. */
  usedBy: Record<string, number>;
  /** What each kind of card and line means, in plain words (from the plugin). */
  meanings: { cards: Record<string, string>; lines: Record<string, string> };
  /** Cards to mark: a waiting proposal would change them, or their code changed outside review. */
  marks: Record<string, Mark>;
  /** Waiting proposals in this project. */
  proposed: number;
  /** Files changed outside review in this project. */
  changed: number;
  /** Shown instead of the map when there's nothing to draw. */
  empty?: { title: string; detail: string };
  /** The tab is in its own floating window. */
  floating: boolean;
};

/** Map page → shell. */
export type FromMap =
  | { type: 'ready' }
  | MapMeasure
  | { type: 'choose'; root: string }
  /** Show another of the project's maps. */
  | { type: 'chooseMap'; id: string }
  | { type: 'arrange'; arrange: Arrange }
  | { type: 'openReview'; proposal?: string }
  /** A card was chosen (its notes and history are wanted), or none. */
  | { type: 'card'; id?: string }
  | { type: 'addNote'; id: string }
  | { type: 'preview'; id: string; versions?: boolean }
  | { type: 'clearChanged' }
  /** Move the tab into its own floating window, or back. */
  | { type: 'window' }
  /** Open a card's code: path relative to the shown project's root. */
  | { type: 'open'; path: string; line?: number };
