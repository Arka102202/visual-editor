// The project index: for each project, which plugins it suits (their detect), and the cards and lines their readers
// found. Readers get only the files they want. When files change, only the readers that want them run again, and
// file text is cached so unchanged files aren't read twice.
// No VS Code APIs here, so it can be tested on its own.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Disposable, Item, Link, Plugin, Reader, SourceFile } from '@visual-editor/contract';
import { modifiedAt, type FoundProject } from './projects';
import type { PluginRegistry } from './registry';

/** Files bigger than this are left out of readers' input (they're generated or data, not code). */
export const MAX_FILE_BYTES = 1_000_000;

export interface ReaderProblem {
  plugin: string;
  reader: string;
  message: string;
}

export interface ProjectState {
  project: FoundProject;
  /** Plugins that said this project is theirs, with their reason. */
  detected: { plugin: Plugin; reason: string }[];
  items: Item[];
  links: Link[];
  /** How many cards each plugin found, by plugin id. */
  cards: Record<string, number>;
  problems: ReaderProblem[];
}

interface ReaderResult {
  items: Item[];
  links: Link[];
  problem?: ReaderProblem;
}

interface Entry {
  project: FoundProject;
  detected: Map<string, string>;
  /** Keyed by "pluginId/readerId". */
  results: Map<string, ReaderResult>;
}

export class ProjectIndex {
  private entries: Entry[] = [];
  private readonly texts = new Map<string, { at: number; text: string | undefined }>();
  private readonly listeners = new Set<() => void>();
  /** Work runs one piece at a time, in order, so a slow read never overwrites a newer one. */
  private queue: Promise<void> = Promise.resolve();
  private readonly offRegistry: Disposable;

  constructor(private readonly registry: PluginRegistry) {
    this.offRegistry = registry.onChange(() => void this.refresh());
  }

  /** Replaces the projects (a new folder opened, or project files added or removed) and reads everything. */
  setProjects(projects: FoundProject[]): Promise<void> {
    return this.run(async () => {
      this.entries = projects.map((project) => ({ project, detected: new Map(), results: new Map() }));
      for (const entry of this.entries) await this.readProject(entry);
    });
  }

  /** Asks every plugin again and re-reads everything (plugins were added or removed). */
  refresh(): Promise<void> {
    return this.run(async () => {
      for (const entry of this.entries) await this.readProject(entry);
    });
  }

  /**
   * Some files changed, were added or were removed (absolute paths). Only readers that want them run again; a
   * changed package.json asks the plugins again too.
   */
  filesChanged(paths: string[]): Promise<void> {
    return this.run(async () => {
      for (const entry of this.entries) {
        const changed = paths.filter((p) => this.owner(p) === entry).map((p) => toRelative(entry.project.root, p));
        if (!changed.length) continue;
        const files = new Set(entry.project.files);
        for (const rel of changed) {
          if (modifiedAt(join(entry.project.root, rel)) < 0) files.delete(rel);
          else files.add(rel);
        }
        entry.project = { ...entry.project, files: [...files].sort() };
        if (changed.includes('package.json')) {
          entry.project = { ...entry.project, packageJson: readJsonText(this.text(join(entry.project.root, 'package.json'))) };
          await this.readProject(entry);
          continue;
        }
        for (const plugin of this.registry.list()) {
          if (!entry.detected.has(plugin.id)) continue;
          for (const reader of plugin.readers ?? []) {
            if (changed.some((rel) => safeWants(reader, rel))) await this.runReader(entry, plugin, reader);
          }
        }
      }
    });
  }

  /** Everything known, per project. */
  snapshot(): ProjectState[] {
    return this.entries.map((e) => {
      const results = [...e.results.values()];
      const cards: Record<string, number> = {};
      for (const [key, r] of e.results) {
        const id = key.split('/')[0];
        cards[id] = (cards[id] ?? 0) + r.items.length;
      }
      return {
        project: e.project,
        detected: [...e.detected].flatMap(([id, reason]) => {
          const plugin = this.registry.get(id);
          return plugin ? [{ plugin, reason }] : [];
        }),
        items: results.flatMap((r) => r.items),
        links: results.flatMap((r) => r.links),
        cards,
        problems: results.flatMap((r) => (r.problem ? [r.problem] : [])),
      };
    });
  }

  /** Waits until all pending work is done. */
  idle(): Promise<void> {
    return this.queue;
  }

  /** Called after each change to what's known. */
  onChange(fn: () => void): Disposable {
    this.listeners.add(fn);
    return { dispose: () => this.listeners.delete(fn) };
  }

  dispose() {
    this.offRegistry.dispose();
    this.listeners.clear();
  }

  private run(work: () => Promise<void>): Promise<void> {
    this.queue = this.queue.then(work).then(
      () => this.changed(),
      () => this.changed(),
    );
    return this.queue;
  }

  private changed() {
    for (const fn of this.listeners) fn();
  }

  /** The project a file belongs to: the deepest project root it's inside. */
  private owner(path: string): Entry | undefined {
    let best: Entry | undefined;
    for (const e of this.entries) {
      if (inside(e.project.root, path) && (!best || e.project.root.length > best.project.root.length)) best = e;
    }
    return best;
  }

  private async readProject(entry: Entry) {
    entry.detected.clear();
    entry.results.clear();
    for (const plugin of this.registry.list()) {
      let reason: string | undefined;
      try {
        reason = (await plugin.detect(entry.project))?.reason;
      } catch (e) {
        entry.results.set(`${plugin.id}/detect`, { items: [], links: [], problem: { plugin: plugin.name, reader: 'detect', message: errorText(e) } });
      }
      if (!reason) continue;
      entry.detected.set(plugin.id, reason);
      for (const reader of plugin.readers ?? []) await this.runReader(entry, plugin, reader);
    }
  }

  private async runReader(entry: Entry, plugin: Plugin, reader: Reader) {
    const key = `${plugin.id}/${reader.id}`;
    // A plugin removed while this was waiting: drop what it found.
    if (this.registry.get(plugin.id) !== plugin) {
      entry.results.delete(key);
      return;
    }
    const files: SourceFile[] = [];
    for (const path of entry.project.files) {
      if (!safeWants(reader, path)) continue;
      const text = this.text(join(entry.project.root, path));
      if (text !== undefined) files.push({ path, text });
    }
    try {
      const found = await reader.read(files, entry.project);
      entry.results.set(key, { items: found.items ?? [], links: found.links ?? [] });
    } catch (e) {
      entry.results.set(key, { items: [], links: [], problem: { plugin: plugin.name, reader: reader.id, message: errorText(e) } });
    }
  }

  /** A file's text, read again only when it changed since last time. */
  private text(path: string): string | undefined {
    const at = modifiedAt(path);
    const cached = this.texts.get(path);
    if (cached && cached.at === at) return cached.text;
    let text: string | undefined;
    try {
      const buffer = at < 0 ? undefined : readFileSync(path);
      text = buffer && buffer.length <= MAX_FILE_BYTES ? buffer.toString('utf8') : undefined;
    } catch {
      text = undefined;
    }
    this.texts.set(path, { at, text });
    return text;
  }
}

function safeWants(reader: Reader, path: string): boolean {
  try {
    return reader.wants(path);
  } catch {
    return false;
  }
}

function inside(root: string, path: string): boolean {
  return path === root || path.startsWith(root.endsWith('/') || root.endsWith('\\') ? root : root + '/') || path.startsWith(root + '\\');
}

function toRelative(root: string, path: string): string {
  return path.slice(root.length).replace(/^[\\/]+/, '').split('\\').join('/');
}

function readJsonText(text: string | undefined) {
  try {
    return text ? JSON.parse(text) : undefined;
  } catch {
    return undefined;
  }
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
