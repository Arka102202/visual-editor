// What the shell and the preview page say to each other. Shared by both sides, so they can't drift apart.

import type { Size } from './previews';

export interface Frame {
  /** "Before" / "After" when comparing; none for a single preview. */
  label?: string;
  url?: string;
  /** Served by the shell (a plugin's HTML): kept apart in its own origin. Otherwise a plugin's dev server page. */
  own?: boolean;
  error?: string;
}

/** Shell → preview page. */
export type ToPreview =
  | {
      type: 'show';
      title: string;
      sub?: string;
      situations: string[];
      situation: string;
      theme: 'light' | 'dark';
      size: Size;
      frames: Frame[];
      /** The tab is in its own floating window. */
      floating: boolean;
    }
  | { type: 'drawing' };

/** Preview page → shell. */
export type FromPreview =
  | { type: 'ready' }
  | { type: 'situation'; name: string }
  | { type: 'theme'; theme: 'light' | 'dark' }
  /** `width`: the frame's width in CSS pixels (for Fit, what fits on screen). */
  | { type: 'size'; size: Size; width: number }
  | { type: 'reload' }
  /** Move the tab into its own floating window, or back. */
  | { type: 'window' }
  /** What a preview page said (ready, an error, a callback, its example data…), passed on as is. */
  | { type: 'frame'; data: Record<string, unknown> }
  /** Frames now visible on screen (loaded), so the shell knows the preview really shows. */
  | { type: 'shown'; frames: number };
