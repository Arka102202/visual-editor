// TypeScript on a project as a draft would leave it, with the project's own TypeScript and settings: its tsconfig (and
// the ones it refers to, as Vite projects split them: tsconfig.json → tsconfig.app.json), the draft's files read in
// place of the real ones (new ones added, removed ones gone). Checked twice, as it is and with the draft, so only the
// problems the draft brings are reported. Pure apart from reading the project's files.

import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

/** The parts of the TypeScript compiler the check uses (the project's own TypeScript, 4 or 5, has them). */
export interface Ts {
  sys: { fileExists(f: string): boolean; readFile(f: string): string | undefined; directoryExists?(d: string): boolean };
  getParsedCommandLineOfConfigFile(file: string, options: object, host: object): Parsed | undefined;
  createProgram(o: { rootNames: string[]; options: object; host?: Host; projectReferences?: readonly unknown[]; oldProgram?: unknown }): unknown;
  getPreEmitDiagnostics(program: unknown): readonly Diagnostic[];
  createCompilerHost(options: object): Host;
  createSourceFile(name: string, text: string, lang: unknown, setParents: boolean): unknown;
  flattenDiagnosticMessageText(text: unknown, newLine: string): string;
}
interface Parsed {
  options: Record<string, unknown>;
  fileNames: string[];
  projectReferences?: readonly { path: string }[];
  raw?: unknown;
}
interface Host {
  fileExists(f: string): boolean;
  directoryExists?(d: string): boolean;
  readFile(f: string): string | undefined;
  getSourceFile(f: string, lang: unknown, onError?: unknown, fresh?: boolean): unknown;
}
interface Diagnostic {
  file?: { fileName: string; getLineAndCharacterOfPosition(at: number): { line: number } };
  start?: number;
  code: number;
  messageText: unknown;
}

export interface TypeProblem {
  /** Relative to the project, forward slashes. */
  file: string;
  line: number;
  code: number;
  message: string;
}

export interface TypeCheck {
  /** The problems the draft brings (not there without it). */
  added: TypeProblem[];
  /** How many problems the project has without the draft (not the draft's). */
  before: number;
  /** The tsconfig files checked. */
  configs: string[];
}

/** `files`: the draft's files by path relative to the project (null: removed by it). */
export function typeCheck(ts: Ts, root: string, files: Record<string, string | null>): TypeCheck {
  const draft = new Map(Object.entries(files).map(([path, text]) => [resolve(root, path), text]));
  // The folders the draft's files are in (and those above them): a folder the draft adds exists for TypeScript too,
  // which asks before it looks for files in it ("Cannot find module" otherwise).
  const folders = new Set<string>();
  for (const [file, text] of draft) {
    if (text === null) continue;
    for (let dir = dirname(file); !folders.has(dir) && dir !== dirname(dir); dir = dirname(dir)) folders.add(dir);
  }
  const configs = projectConfigs(ts, root);
  const before: TypeProblem[] = [];
  const after: TypeProblem[] = [];
  for (const config of configs) {
    const parsed = ts.getParsedCommandLineOfConfigFile(config, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} });
    if (!parsed) continue;
    const options = { ...parsed.options, noEmit: true, incremental: false, composite: false, tsBuildInfoFile: undefined };
    const base = ts.createProgram({ rootNames: parsed.fileNames, options, projectReferences: parsed.projectReferences });
    before.push(...problems(ts, root, ts.getPreEmitDiagnostics(base)));
    // With the draft: its files in place of the real ones; new ones joined to the project when its config covers them.
    const host = ts.createCompilerHost(options);
    const original = host.getSourceFile.bind(host);
    host.fileExists = (f: string) => (draft.has(resolve(f)) ? draft.get(resolve(f)) !== null : ts.sys.fileExists(f));
    host.readFile = (f: string) => (draft.has(resolve(f)) ? (draft.get(resolve(f)) ?? undefined) : ts.sys.readFile(f));
    const onDisk = host.directoryExists?.bind(host) ?? ts.sys.directoryExists?.bind(ts.sys);
    host.directoryExists = (d: string) => folders.has(resolve(d)) || (onDisk ? onDisk(d) : true);
    host.getSourceFile = (f: string, lang: unknown, onError?: unknown, fresh?: boolean) => {
      const text = draft.get(resolve(f));
      if (text === undefined) return original(f, lang, onError, fresh);
      return text === null ? undefined : ts.createSourceFile(f, text, lang, true);
    };
    const covered = (f: string) => isCode(f) && configCovers(config, parsed, f);
    const rootNames = [...parsed.fileNames.filter((f) => draft.get(resolve(f)) !== null), ...[...draft].filter(([f, text]) => text !== null && !parsed.fileNames.some((x) => resolve(x) === f) && covered(f)).map(([f]) => f)];
    const program = ts.createProgram({ rootNames, options, host, projectReferences: parsed.projectReferences, oldProgram: base });
    after.push(...problems(ts, root, ts.getPreEmitDiagnostics(program)));
  }
  // New: not there before (lines may move, so a problem is its file, code and message).
  const key = (p: TypeProblem) => `${p.file}\n${p.code}\n${p.message}`;
  const had = new Map<string, number>();
  for (const p of before) had.set(key(p), (had.get(key(p)) ?? 0) + 1);
  const added = after.filter((p) => {
    const n = had.get(key(p)) ?? 0;
    if (n > 0) {
      had.set(key(p), n - 1);
      return false;
    }
    return true;
  });
  return { added, before: before.length, configs: configs.map((c) => relative(root, c).split('\\').join('/')) };
}

/** The tsconfig files that hold the project's code: tsconfig.json, or the ones it refers to (Vite's app config…). */
function projectConfigs(ts: Ts, root: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const visit = (file: string, depth: number) => {
    if (seen.has(file) || depth > 4 || !ts.sys.fileExists(file)) return;
    seen.add(file);
    const parsed = ts.getParsedCommandLineOfConfigFile(file, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} });
    if (!parsed) return;
    // A config for build tools (vite.config.ts and the like) isn't the app's code.
    if (parsed.fileNames.some((f) => !/(^|[\\/])(vite|vitest|eslint|tailwind|postcss)\.config\.[cm]?[jt]s$/.test(f))) out.push(file);
    for (const ref of parsed.projectReferences ?? []) {
      const path = ref.path.endsWith('.json') ? ref.path : join(ref.path, 'tsconfig.json');
      visit(isAbsolute(path) ? path : resolve(dirname(file), path), depth + 1);
    }
  };
  visit(join(root, 'tsconfig.json'), 0);
  return out;
}

/** Whether a new file would be part of a config's project: under one of its include folders. */
function configCovers(config: string, parsed: Parsed, file: string): boolean {
  const spec = parsed.raw as { include?: string[]; files?: string[] } | undefined;
  if (!spec?.include && spec?.files) return false;
  const rel = relative(dirname(config), file).split('\\').join('/');
  if (rel.startsWith('../') || rel.includes('node_modules/')) return false;
  return (spec?.include ?? ['']).some((pattern) => {
    const dir = pattern.replace(/\/?\*.*$/, '').replace(/^\.\//, '');
    return dir === '' || dir === '.' || rel === dir || rel.startsWith(`${dir}/`);
  });
}

const isCode = (f: string) => /\.(tsx?|mts|cts)$/.test(f) && !f.endsWith('.d.ts');

function problems(ts: Ts, root: string, diagnostics: readonly Diagnostic[]): TypeProblem[] {
  return diagnostics.map((d) => {
    const at = d.file && d.start !== undefined ? d.file.getLineAndCharacterOfPosition(d.start) : undefined;
    return {
      file: d.file ? relative(root, d.file.fileName).split('\\').join('/') : '(settings)',
      line: at ? at.line + 1 : 0,
      code: d.code,
      message: ts.flattenDiagnosticMessageText(d.messageText, ' '),
    };
  });
}
