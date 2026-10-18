// What the shell and the map page say to each other. Shared by both sides, so they can't drift apart.

import type { Mark } from './changes';
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
  | { type: 'openReview' }
  | { type: 'clearChanged' }
  /** Open a card's code: path relative to the shown project's root. */
  | { type: 'open'; path: string; line?: number };
