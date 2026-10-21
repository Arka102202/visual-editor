// What the shell and the map page say to each other. Shared by both sides, so they can't drift apart.

import type { Item } from '@visual-editor/contract';
import type { Mark } from './changes';
import type { Layout as PanelLayout } from './ui/frame';
import type { Recorded } from './proxy/proxy';
import type { FakeEndpoint, Scenarios } from './proxy/fakes';
import type { ContractInfo, ContractRef } from './contracts/contracts';
import type { DataCase } from './cases';
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
export type ToMap =
  | ShowMap
  | CardMemory
  | CardLines
  | { type: 'focus'; id: string }
  | { type: 'measure' }
  /** The code colours of the theme on now (type, string, keyword…), for text shown the way the editor colours it. */
  | { type: 'theme'; tokens: Record<string, string> }
  /** How the developer arranged each window's side panels (by window). */
  | { type: 'layouts'; layouts: Record<string, PanelLayout> }
  /** The app's address through Visual Editor's proxy (for Preview), how starting it goes, or why it can't start. */
  | { type: 'app'; url?: string; progress?: string; error?: string }
  /** Open Preview (from the command): at this address of the app. */
  | { type: 'preview'; path?: string }
  /** Calls the app made (new ones as they happen; `all`: these are all of them so far). */
  | { type: 'calls'; calls: Recorded[]; all?: boolean }
  /** The project's fakes, its scenarios, and the names of the headers the proxy adds (their values stay hidden). */
  | { type: 'fakes'; endpoints: FakeEndpoint[]; scenarios: Scenarios; headers: string[] }
  /** The project's contracts (in short), and which type each endpoint answers with (contracts.json's "map"). */
  | { type: 'contracts'; contracts: ContractInfo[]; map: Record<string, string> }
  /** Plugins' Preview panels for the shown project: their scripts, and the facts each one needs. */
  | { type: 'panels'; panels: PluginPanel[] }
  /** A plugin's answer to a panel's question. */
  | { type: 'panelAnswer'; key: string; id: number; answer?: unknown; error?: string }
  /** The Playground for a component: its kept cases, suggested ones, and the pages it's drawn on. */
  | { type: 'playground'; item: Item; file?: string; cases: DataCase[]; example: Record<string, unknown>; suggestions: DataCase[]; pages: string[] }
  /** Its cases were kept (in `file`). */
  | { type: 'casesSaved'; id: string; file: string; cases: DataCase[] }
  /** An example answer made from a contract (asked for with `contractExample`). */
  | { type: 'contractExample'; ref: ContractRef; status?: number; body?: unknown; error?: string };

/** Every line that joins one card to another, on any map (for Focus's side panel). */
export interface CardLines {
  type: 'lines';
  id: string;
  lines: { dir: 'in' | 'out'; kind: string; label?: string; other: Item }[];
  /** The title of each map, by id. */
  maps: Record<string, string>;
}

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
  /** Every line that joins this card to another, on any map, is wanted. */
  | { type: 'lines'; id: string }
  /** Preview wants the app's address (the proxy and dev server start when needed). */
  | { type: 'app' }
  /** Open the developer's own file for a place in the code the browser runs (a console message's). */
  | { type: 'openSource'; url: string; line: number; column: number }
  /** Open the stylesheet a CSS rule comes from, at that rule. */
  | { type: 'openRule'; source: string; selector: string }
  /** The calls so far and the fakes are wanted (the Network panel opened). */
  | { type: 'network' }
  | { type: 'saveFake'; endpoint: FakeEndpoint }
  | { type: 'removeFake'; id: string }
  /** The case an endpoint uses ("pass": the real backend). */
  | { type: 'useCase'; id: string; use: string }
  | { type: 'saveScenarios'; scenarios: Scenarios }
  | { type: 'openFake'; id: string }
  /** Headers the proxy adds to calls: a value sets one, null removes it. */
  | { type: 'setHeaders'; headers: Record<string, string | null> }
  /** Contracts: add a source (a project file, or an address), stop using one, open one, read them all again. */
  | { type: 'addContract'; source: string }
  | { type: 'removeContract'; source: string }
  | { type: 'openContract'; source: string }
  | { type: 'reloadContracts' }
  /** The type an endpoint answers with ("Order[]"); none: forget it. */
  | { type: 'mapType'; operation: string; typeName?: string }
  /** Fake these operations from the contract (a case made for each, and used). */
  | { type: 'fakeFromContract'; operations: string[]; status?: string }
  /** An example answer from the contract, to look at. */
  | { type: 'contractExample'; ref: ContractRef }
  /** Open the code of a card found by its name (and kind), e.g. a component a plugin panel shows. */
  | { type: 'openItem'; label: string; kind?: string }
  /** Open the Playground for a card (a component). */
  | { type: 'playground'; id: string }
  /** Keep a component's cases (Name.variants.json next to it). */
  | { type: 'saveCases'; id: string; cases: DataCase[] }
  /** A plugin panel asks its plugin's VS Code side (PreviewPanel.serve); the answer comes back as panelAnswer. */
  | { type: 'panelAsk'; key: string; id: number; request: unknown }
  /** Open an address in the developer's own browser. */
  | { type: 'openExternal'; url: string }
  /** A window's side panels were arranged: keep it. */
  | { type: 'layout'; key: string; layout: PanelLayout }
  /** Show a card on its own map (switching maps), chosen and in view. */
  | { type: 'goTo'; id: string }
  | { type: 'addNote'; id: string }
  | { type: 'clearChanged' }
  /** Move the tab into its own floating window, or back. */
  | { type: 'window' }
  /** Open a card's code: path relative to the shown project's root. */
  | { type: 'open'; path: string; line?: number };

/** A plugin's Preview panel, as the map page gets it. */
export interface PluginPanel {
  /** "<plugin id>/<panel id>". */
  key: string;
  name: string;
  icon: string;
  /** The panel's script. */
  code: string;
  facts?: unknown;
}
