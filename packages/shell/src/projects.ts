// Finding the projects in what the developer opened: one project, several side by side, or a monorepo whose
// packages belong together. Any folder with a project file (package.json, pom.xml, go.mod…) is a project; its files
// are its own, without dependencies, build output, or projects inside it.
// Node fs only (no VS Code), so it can be tested.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';
import type { PackageJson, ProjectInfo } from '@visual-editor/contract';

/** Files that make a folder a project. */
const MARKERS = ['package.json', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'go.mod', 'Cargo.toml', 'pyproject.toml', 'composer.json', 'Gemfile'];
const MARKER_PATTERNS = [/\.csproj$/];

/** Folders never read: dependencies, build output, caches, tools' own data. */
export const IGNORED_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', '.next', '.nuxt', '.svelte-kit', '.turbo', '.cache', 'coverage',
  '.parcel-cache', '.vercel', '.netlify', 'target', 'vendor', '.venv', 'venv', '__pycache__', '.idea', '.gradle', 'bin', 'obj',
  '.playground', '.nocode', '.visual-editor', 'dist-test',
]);

/** How deep to look for projects inside the opened folder. */
const MAX_PROJECT_DEPTH = 4;
/** A medium project's upper bound; more files than this are left out (and said so). */
export const MAX_FILES_PER_PROJECT = 20_000;

export type Shape = 'single' | 'several' | 'monorepo' | 'empty';

export interface FoundProject extends ProjectInfo {
  /** The monorepo it belongs to (its root's name), when it's part of one. */
  group?: string;
  /** True when files were left out because there were too many. */
  truncated?: boolean;
}

export interface Workspace {
  /** The folder that was opened. */
  root: string;
  shape: Shape;
  projects: FoundProject[];
}

/** Is this file name one that makes a folder a project (or a monorepo)? Adding or removing one means scanning again. */
export function isProjectFile(name: string): boolean {
  return MARKERS.includes(name) || MARKER_PATTERNS.some((p) => p.test(name)) || name === 'pnpm-workspace.yaml';
}

/** Is a path inside a folder that's never read (node_modules, dist…)? */
export function isIgnoredPath(path: string): boolean {
  return path.split(/[\\/]/).some((part) => IGNORED_DIRS.has(part));
}

function readJson(path: string): PackageJson | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as PackageJson;
  } catch {
    return undefined;
  }
}

function isProjectDir(dir: string, names: string[]): boolean {
  return names.some((n) => MARKERS.includes(n) || MARKER_PATTERNS.some((p) => p.test(n))) && !(names.length === 1 && names[0] === 'package.json' && isEmptyPackage(join(dir, 'package.json')));
}

/** A package.json with nothing in it (some tools write one) doesn't make a project. */
function isEmptyPackage(path: string): boolean {
  const pkg = readJson(path);
  return !pkg || Object.keys(pkg).length === 0;
}

function list(dir: string): { name: string; dir: boolean }[] {
  try {
    return readdirSync(dir, { withFileTypes: true }).map((d) => ({ name: d.name, dir: d.isDirectory() }));
  } catch {
    return [];
  }
}

/** Every folder (up to MAX_PROJECT_DEPTH deep) that is a project, the opened folder included. */
function projectDirs(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string, depth: number) => {
    const entries = list(dir);
    if (isProjectDir(dir, entries.filter((e) => !e.dir).map((e) => e.name))) found.push(dir);
    if (depth >= MAX_PROJECT_DEPTH) return;
    for (const e of entries) if (e.dir && !IGNORED_DIRS.has(e.name) && !e.name.startsWith('.')) walk(join(dir, e.name), depth + 1);
  };
  walk(root, 0);
  return found;
}

/** The workspace globs of a monorepo root: package.json "workspaces", or pnpm-workspace.yaml. */
export function workspaceGlobs(root: string): string[] | undefined {
  const pkg = readJson(join(root, 'package.json'));
  const ws = pkg?.workspaces as string[] | { packages?: string[] } | undefined;
  if (Array.isArray(ws)) return ws;
  if (ws && Array.isArray(ws.packages)) return ws.packages;
  const pnpm = join(root, 'pnpm-workspace.yaml');
  if (existsSync(pnpm)) {
    const globs = [...readFileSync(pnpm, 'utf8').matchAll(/^\s*-\s*['"]?([^'"\n#]+?)['"]?\s*$/gm)].map((m) => m[1].trim());
    return globs.length ? globs : undefined;
  }
  return undefined;
}

/** Does a path (relative, forward slashes) match a workspace glob like "packages/*", "apps/**" or "tools/cli"? */
export function matchesGlob(path: string, glob: string): boolean {
  if (glob.startsWith('!')) return false;
  const g = glob.replace(/^\.\//, '').replace(/\/$/, '');
  const re = new RegExp(
    '^' +
      g
        .split('/')
        .map((part) => (part === '**' ? '.*' : part.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')))
        .join('/') +
      '$',
  );
  return re.test(path);
}

/** A project's own files: relative paths, forward slashes, without ignored folders or projects inside it. */
export function projectFiles(dir: string, nested: Set<string>): { files: string[]; truncated: boolean } {
  const files: string[] = [];
  let truncated = false;
  const walk = (d: string) => {
    for (const e of list(d)) {
      if (files.length >= MAX_FILES_PER_PROJECT) {
        truncated = true;
        return;
      }
      const full = join(d, e.name);
      if (e.dir) {
        if (!IGNORED_DIRS.has(e.name) && !nested.has(full)) walk(full);
      } else if (e.name !== '.DS_Store') files.push(relative(dir, full).split(sep).join('/'));
    }
  };
  walk(dir);
  return { files: files.sort(), truncated };
}

/** The projects in an opened folder, and its shape. */
export function findWorkspace(root: string): Workspace {
  const dirs = projectDirs(root);
  const globs = workspaceGlobs(root);
  const members = globs ? dirs.filter((d) => d !== root && globs.some((g) => matchesGlob(relative(root, d).split(sep).join('/'), g))) : [];
  const rootName = readJson(join(root, 'package.json'))?.name ?? basename(root);
  const dirSet = new Set(dirs);
  // Code outside every project (or a folder with no project file at all) is read too: the opened folder becomes a
  // project holding those loose files. Just a README beside the projects doesn't count.
  const all = [...dirs];
  if (!dirSet.has(root)) {
    const loose = projectFiles(root, dirSet).files;
    if (!dirs.length || loose.some(isLooseCode)) all.unshift(root);
  }
  const shape: Shape = !dirs.length ? 'empty' : members.length ? 'monorepo' : all.length === 1 ? 'single' : 'several';
  const projects = all.map((dir): FoundProject => {
    const nested = new Set([...dirSet].filter((d) => d !== dir && d.startsWith(dir + sep)));
    const packageJson = readJson(join(dir, 'package.json'));
    const { files, truncated } = projectFiles(dir, nested);
    return {
      root: dir,
      name: packageJson?.name ?? (dir === root ? basename(root) : relative(root, dir).split(sep).join('/')),
      ...(packageJson ? { packageJson } : {}),
      files,
      ...(members.includes(dir) || (shape === 'monorepo' && dir === root) ? { group: rootName } : {}),
      ...(truncated ? { truncated } : {}),
    };
  });
  return { root, shape, projects };
}

/** A loose file worth reading: code or data in a subfolder, or a code file at the top. */
function isLooseCode(path: string): boolean {
  return path.includes('/') ? !/(^|\/)(readme|license|changelog)[^/]*$/i.test(path) : /\.(m?[jt]sx?|c[jt]s|py|go|java|kt|rb|php|cs|rs|prisma|sql|graphql|vue|svelte|html|css|scss)$/.test(path);
}

/** When a file last changed (to re-read only changed files). */
export function modifiedAt(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return -1;
  }
}
