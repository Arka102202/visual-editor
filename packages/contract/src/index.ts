// The plugin contract: everything a plugin can give the Visual Editor shell, and what the shell gives back.
// Plugins depend on this package only. It changes rarely and carefully: every change bumps CONTRACT_VERSION, and the
// shell refuses plugins built for a different version (with a clear message), so nothing half-works.
// No VS Code imports here: plugins and the shell's tests use it outside VS Code too.

/** The contract version this package describes. Plugins say which version they were built for. */
export const CONTRACT_VERSION = 8;

/** Something that can be stopped or removed (same shape as VS Code's Disposable). */
export interface Disposable {
  dispose(): void;
}

// ---------------------------------------------------------------------------
// What the shell tells plugins about a project
// ---------------------------------------------------------------------------

/** One project the developer opened (a folder, a package in a monorepo, a service). */
export interface ProjectInfo {
  /** Absolute path of the project's folder. */
  root: string;
  /** Its name: the package name, or the folder name. */
  name: string;
  /** Its package.json, when it has one. */
  packageJson?: PackageJson;
  /** Every file in it, as paths relative to `root` with forward slashes (dependencies and build output left out). */
  files: string[];
}

export interface PackageJson {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
  [key: string]: unknown;
}

/** A file's path (relative to the project's root, forward slashes) and its text. */
export interface SourceFile {
  path: string;
  text: string;
}

// ---------------------------------------------------------------------------
// What plugins give the shell
// ---------------------------------------------------------------------------

/** A plugin's answer to "is this project yours?", in plain words. */
export interface Detection {
  /** Why, e.g. "react is in package.json". Shown to the developer. */
  reason: string;
}

/**
 * Something on a map: a component, a route, a table… Plugins describe items; the shell draws them, the same way for
 * every plugin.
 */
export interface Item {
  /** Unique and lasting across readings, e.g. "react:component:src/Card.tsx#Card". */
  id: string;
  /** The map it belongs on (a MapDefinition id). */
  map: string;
  /** What kind of thing it is, in the plugin's words, e.g. "component", "route", "table". */
  kind: string;
  /** Its name as the developer knows it, e.g. "ProjectCard", "GET /api/orders/:id". */
  label: string;
  /** A short second line, e.g. the file or the route. */
  sub?: string;
  /** Rows shown on the card, e.g. props, columns. */
  fields?: Field[];
  /** Where it is defined, for "Open code". */
  source?: { path: string; line?: number };
  /** Contract 8: it can be shown in Preview: its variants (looks) and the fixed-data states each is shown with. */
  preview?: ItemPreview;
}

/** What Preview can show of a card (a component or page made previewable: docs/variants.md for React). */
export interface ItemPreview {
  /** Its looks, the one in use marked. */
  variants: { id: string; name: string; path: string; inUse: boolean }[];
  /** The fixed-data states every variant is shown with (default, empty, long name…). */
  states: string[];
}

export interface Field {
  name: string;
  /** Shown on the right, e.g. a type. */
  value?: string;
  /** Marks the row, e.g. "callback", "key", "required". */
  tag?: string;
}

/** A line between two items (possibly from different plugins). */
export interface Link {
  from: string;
  to: string;
  /** What the line means, in the plugin's words, e.g. "renders", "calls", "reads". */
  kind: string;
  label?: string;
}

/** What a reader found. */
export interface ReadResult {
  items: Item[];
  links?: Link[];
}

/** Turns files into items and links. */
export interface Reader {
  id: string;
  /** Which files it wants (relative paths). Only those are read and passed in. */
  wants(path: string): boolean;
  read(files: SourceFile[], project: ProjectInfo): ReadResult | Promise<ReadResult>;
}

/** A map view a plugin brings, e.g. "Component Map". */
export interface MapDefinition {
  id: string;
  title: string;
  /** One sentence on what it shows. */
  description?: string;
  /** Contract 3: what each kind of card on it means, in plain words (shown when hovering the legend or a card's kind). */
  kinds?: Record<string, string>;
  /** Contract 3: what each kind of line on it means, in plain words. */
  lines?: Record<string, string>;
}

/** A Visual Editor plugin. Fill only the slots you need; more slots come in later contract versions. */
export interface Plugin {
  /** Short and unique, e.g. "react", "express". */
  id: string;
  /** Shown to the developer, e.g. "React". */
  name: string;
  /** The plugin's own version, e.g. "0.1.0". */
  version: string;
  /** The contract version it was built for (CONTRACT_VERSION when it was built). */
  contract: number;
  /** One sentence on what it adds. */
  description?: string;
  /** "Is this project mine?" Undefined means no. */
  detect(project: ProjectInfo): Detection | undefined | Promise<Detection | undefined>;
  readers?: Reader[];
  maps?: MapDefinition[];
  /** Contract 8: panels the plugin adds to Preview (the running app), e.g. React's App panel. */
  previewPanels?: PreviewPanel[];
}

// ---------------------------------------------------------------------------
// Contract 8: Preview panels
// ---------------------------------------------------------------------------

/**
 * A panel in Preview, made of two scripts that talk to each other through the shell:
 *   - `page` runs inside the app's page, before the app's own code (so it can hook in early). It gets
 *     `window.visualEditor` (PreviewPageApi).
 *   - `panel` runs in Visual Editor's window and draws the panel. It calls
 *     `VisualEditor.definePanel('<plugin id>/<panel id>', (api: PreviewPanelApi) => { … })`.
 * Both are plain scripts (bundle them as an IIFE). The panel shows only for projects the plugin detected.
 * The panel shares its window with the shell: give every class name and element id your own prefix (e.g. "ra-"), so
 * the shell's styles never land on your elements, nor yours on the shell's.
 */
export interface PreviewPanel {
  /** Short and unique within the plugin, e.g. "app". */
  id: string;
  /** Its name, shown when hovering its tab, e.g. "App: components, stores, route, storage". */
  name: string;
  /** Its tab's icon: SVG drawing for a 24×24 box, in lines (stroke), like the shell's own icons. */
  icon: string;
  /** The script for the app's page. */
  page: string;
  /** The script for the panel. */
  panel: string;
  /** Facts about the project the panel needs (read in VS Code, sent to the panel as `api.facts`), e.g. where its stores are. */
  facts?(project: ProjectInfo, items: Item[]): unknown | Promise<unknown>;
  /** Work the panel asks for in VS Code (`api.ask`), e.g. reading or writing the project's files. Its answer goes back. */
  serve?(request: unknown, project: ProjectInfo, items: Item[], links: Link[]): unknown | Promise<unknown>;
}

/** What `window.visualEditor` gives a panel's page script. Messages are on a channel: "<plugin id>/<panel id>". */
export interface PreviewPageApi {
  /** Messages from the panel. */
  on(channel: string, handler: (data: unknown) => void): void;
  /** A message to the panel (made of plain values: use `copy` for anything else). */
  send(channel: string, data: unknown): void;
  /**
   * Any value as plain values the panel can show (objects to a depth, functions and elements described, loops cut).
   * `replace` may turn a value into something else first (return undefined to leave it).
   */
  copy(value: unknown, options?: { depth?: number; replace?: (value: unknown) => unknown }): unknown;
  /** Outlines elements in the page with a label (none: removes the outline). */
  highlight(elements: Element[] | null, label?: string): void;
  /** The developer picked an element with Preview's picker (one picker for every panel). */
  onPicked(handler: (element: Element) => void): void;
}

/** What a panel's script gets, in Visual Editor's window. */
export interface PreviewPanelApi {
  /** The panel's own element: fill it. */
  body: HTMLElement;
  /** The facts PreviewPanel.facts gave (and again when they change: onFacts). */
  facts: unknown;
  onFacts(handler: (facts: unknown) => void): void;
  /** A message to the page script. */
  send(data: unknown): void;
  /** Messages from the page script. */
  on(handler: (data: unknown) => void): void;
  /** The page (re)loaded: its page script runs anew. */
  onPage(handler: (url: string) => void): void;
  /** The panel's tab was opened. */
  onShow(handler: () => void): void;
  /** Loads the app's page again (e.g. when the page script doesn't answer: the page was there before the panel). */
  reloadPage(): void;
  /** Asks the plugin's VS Code side (PreviewPanel.serve); resolves with its answer. */
  ask(request: unknown): Promise<unknown>;
  /** Changes the number on the panel's tab. */
  setCount(count: number | undefined): void;
  /** Opens a place in the code the browser ran (a URL, line and column), in the developer's own file (by source maps). */
  openSource(url: string, line: number, column: number): void;
  /** Opens a project file (relative to the project, or absolute) at a line. */
  openFile(path: string, line?: number): void;
  /** Opens the code of a card on the map, found by its name (and kind), e.g. a component. */
  openItem(label: string, kind?: string): void;
  /** The shell's look, so plugin panels match it: buttons (icon only, name on hover) and values. */
  ui: {
    el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K];
    /** An icon button: `icon` is a shell icon's name, or SVG drawing like PreviewPanel.icon. */
    button(icon: string, name: string, options?: { cls?: string }): HTMLButtonElement;
    /** A row of buttons that never wraps (it scrolls sideways). */
    tray(row: HTMLElement): HTMLElement;
    /** A value made by PreviewPageApi.copy, shown like the Console shows values (objects open like a tree). */
    value(value: unknown, key?: string): Node;
  };
}

// ---------------------------------------------------------------------------
// What the shell gives plugins
// ---------------------------------------------------------------------------

/** The shell's API, returned by its extension's activate(). Plugins call register() once. */
export interface ShellApi {
  /** The contract version the shell speaks. */
  contract: number;
  /** Adds a plugin; dispose() removes it again. Throws (with a readable message) when the plugin can't be used. */
  register(plugin: Plugin): Disposable;
}

/** The shell's VS Code extension id, for plugins to find it. */
export const SHELL_EXTENSION_ID = 'arka102202.visual-editor';
