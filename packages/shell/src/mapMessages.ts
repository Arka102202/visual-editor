// What the shell and the map page say to each other. Shared by both sides, so they can't drift apart.

import type { Layout } from './layout';

export interface MapProject {
  root: string;
  name: string;
  group?: string;
  /** Cards found in it, to help choose. */
  cards: number;
}

/** Shell → map page. */
export type ToMap = {
  type: 'show';
  projects: MapProject[];
  /** The root of the project shown. */
  current?: string;
  /** Plugins that understand it, by name. */
  plugins: string[];
  layout: Layout;
  /** Shown instead of the map when there's nothing to draw. */
  empty?: { title: string; detail: string };
};

/** Map page → shell. */
export type FromMap =
  | { type: 'ready' }
  | { type: 'choose'; root: string }
  /** Open a card's code: path relative to the shown project's root. */
  | { type: 'open'; path: string; line?: number };
