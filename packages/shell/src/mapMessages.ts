// What the shell and the map page say to each other. Shared by both sides, so they can't drift apart.

import type { Mark } from './changes';
import type { Layout } from './layout';
import type { MemoryEntry } from './memory';

export interface MapProject {
  root: string;
  name: string;
  group?: string;
  /** Cards found in it, to help choose. */
  cards: number;
}

/** Shell → map page: the map, or what's remembered about the chosen card. */
export type ToMap = ShowMap | CardMemory | { type: 'focus'; id: string };

export interface CardMemory {
  type: 'card';
  id: string;
  /** Notes, rules and decisions about it, and changes to it, newest first. */
  entries: MemoryEntry[];
  /** A plugin can show how it looks. */
  canPreview: boolean;
}

export type ShowMap = {
  type: 'show';
  projects: MapProject[];
  /** The root of the project shown. */
  current?: string;
  /** Plugins that understand it, by name. */
  plugins: string[];
  layout: Layout;
  /** Cards to mark: a waiting proposal would change them, or their code changed outside review. */
  marks: Record<string, Mark>;
  /** Waiting proposals in this project. */
  proposed: number;
  /** Files changed outside review in this project. */
  changed: number;
  /** Shown instead of the map when there's nothing to draw. */
  empty?: { title: string; detail: string };
};

/** Map page → shell. */
export type FromMap =
  | { type: 'ready' }
  | { type: 'choose'; root: string }
  | { type: 'openReview'; proposal?: string }
  /** A card was chosen (its notes and history are wanted), or none. */
  | { type: 'card'; id?: string }
  | { type: 'addNote'; id: string }
  | { type: 'preview'; id: string }
  | { type: 'clearChanged' }
  /** Open a card's code: path relative to the shown project's root. */
  | { type: 'open'; path: string; line?: number };
