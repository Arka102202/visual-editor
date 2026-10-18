// The plugin contract: everything a plugin can give the Visual Editor shell, and what the shell gives back.
// Plugins depend on this package only. It changes rarely and carefully: every change bumps CONTRACT_VERSION, and the
// shell refuses plugins built for a different version (with a clear message), so nothing half-works.
// No VS Code imports here: plugins and the shell's tests use it outside VS Code too.

/** The contract version this package describes. Plugins say which version they were built for. */
export const CONTRACT_VERSION = 1;

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
