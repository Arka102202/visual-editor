// Turns import specifiers into project files. Understands relative paths,
// tsconfig/jsconfig `paths`, and Vite/webpack aliases. Pure: works on file text.

export interface Alias {
  /** `@components` (exact or followed by `/`), or `@/` style prefixes. */
  prefix: string;
  /** Workspace-relative directory or file, no trailing slash. */
  target: string;
}

export const SOURCE_EXTENSIONS = ['.tsx', '.ts', '.jsx', '.js', '.mjs', '.cjs'];

/** Reads aliases from tsconfig*.json / jsconfig.json and vite/webpack configs. */
export function loadAliases(configs: { path: string; text: string }[]): Alias[] {
  const aliases: Alias[] = [];
  const add = (prefix: string, target: string) => {
    prefix = prefix.replace(/\/\*$/, '').replace(/\*$/, '');
    target = normalize(target.replace(/\/\*$/, '').replace(/\*$/, ''));
    if (prefix && !aliases.some((a) => a.prefix === prefix)) aliases.push({ prefix, target });
  };

  for (const config of configs) {
    const dir = dirname(config.path);
    if (/(^|\/)(tsconfig[\w.-]*|jsconfig)\.json$/.test(config.path)) {
      const json = parseJsonc(config.text) as { compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> } } | undefined;
      const options = json?.compilerOptions;
      if (!options?.paths) continue;
      const base = join(dir, options.baseUrl ?? '.');
      for (const [key, targets] of Object.entries(options.paths)) {
        if (targets[0]) add(key, join(base, targets[0]));
      }
    } else {
      // '@components': resolve(__dirname, 'src/components') / path.resolve(...) / path.join(...)
      for (const m of config.text.matchAll(
        /['"]?([@~#$\w][\w@~#$/.-]*)['"]?\s*:\s*(?:path\.)?(?:resolve|join)\(\s*(?:__dirname|process\.cwd\(\))\s*,\s*((?:['"][^'"]*['"]\s*,?\s*)+)\)/g,
      )) {
        const parts = [...m[2].matchAll(/['"]([^'"]*)['"]/g)].map((x) => x[1]);
        add(m[1], join(dir, parts.join('/')));
      }
      // '@': fileURLToPath(new URL('./src', import.meta.url))
      for (const m of config.text.matchAll(/['"]?([@~#$\w][\w@~#$/.-]*)['"]?\s*:\s*fileURLToPath\(\s*new URL\(\s*['"]([^'"]+)['"]/g)) {
        add(m[1], join(dir, m[2]));
      }
    }
  }
  // Longest prefix first so `@components/shared` wins over `@components`.
  return aliases.sort((a, b) => b.prefix.length - a.prefix.length);
}

/**
 * Resolves an import to a project file path, or returns `pkg:<name>` for packages.
 * `files` is the set of all project source paths.
 */
export function resolveImport(spec: string, fromPath: string, aliases: Alias[], files: Set<string>): string {
  let base: string | undefined;
  if (spec.startsWith('.')) {
    base = join(dirname(fromPath), spec);
  } else {
    for (const a of aliases) {
      const p = a.prefix;
      if (spec === p || spec === p.replace(/\/$/, '')) base = a.target;
      else if (p.endsWith('/') ? spec.startsWith(p) : spec.startsWith(`${p}/`)) {
        base = join(a.target, spec.slice(p.endsWith('/') ? p.length : p.length + 1));
      }
      if (base !== undefined) break;
    }
  }
  if (base !== undefined) {
    const found = findFile(base, files);
    if (found) return found;
  }
  return `pkg:${packageName(spec)}`;
}

function findFile(base: string, files: Set<string>): string | undefined {
  if (files.has(base)) return base;
  const noJs = base.replace(/\.(js|jsx|mjs|cjs)$/, ''); // TS projects import './x.js' for x.ts
  for (const stem of [base, noJs]) {
    for (const ext of SOURCE_EXTENSIONS) if (files.has(stem + ext)) return stem + ext;
    for (const ext of SOURCE_EXTENSIONS) if (files.has(`${stem}/index${ext}`)) return `${stem}/index${ext}`;
  }
  return undefined;
}

function packageName(spec: string): string {
  const parts = spec.split('/');
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

/** JSON with comments and trailing commas, as tsconfig allows. */
export function parseJsonc(text: string): unknown {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      out += c;
      if (c === '\\') out += text[++i] ?? '';
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
      out += c;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i++;
    } else {
      out += c;
    }
  }
  try {
    return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
  } catch {
    return undefined;
  }
}

export function dirname(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

export function join(...parts: string[]): string {
  return normalize(parts.filter((p) => p !== '').join('/'));
}

function normalize(path: string): string {
  const out: string[] = [];
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return out.join('/');
}
