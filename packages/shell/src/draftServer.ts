// A draft's own app server (dist/draftServer.js, run as a separate Node process with a memory limit): the project's
// own Vite, with its own config, plus one plugin that serves the draft's files in place of the real ones (new files,
// changed files; a removed file can't be loaded). Nothing is copied and nothing on disk changes; Vite only builds the
// files a page asks for, so the project's size barely matters. No file watching and no live reload: a new version of
// the draft gets a new server.
//   node draftServer.js <project root> <draft files .json> <port> <cache folder>
// Prints "READY <address>" when it answers, or "ERROR <why>".

import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [root, filesJson, port, cacheDir] = process.argv.slice(2);

/** How an import may name a file: as written, with an extension, or a folder's index. */
const ENDINGS = ['', '.tsx', '.ts', '.jsx', '.js', '.mjs', '/index.tsx', '/index.ts', '/index.jsx', '/index.js'];

async function main() {
  const files: Record<string, string | null> = JSON.parse(readFileSync(filesJson, 'utf8'));
  const draft = new Map(Object.entries(files).map(([path, text]) => [join(root, path), text]));
  const find = (base: string) => ENDINGS.map((e) => base + e).find((p) => draft.has(p) && draft.get(p) !== null);

  const require = createRequire(join(root, 'package.json'));
  let viteDir: string;
  try {
    viteDir = dirname(require.resolve('vite/package.json'));
  } catch {
    throw new Error('This project has no Vite in node_modules (run its install first).');
  }
  const entry = [join(viteDir, 'dist/node/index.js'), join(viteDir, 'index.cjs')].find((p) => existsSync(p));
  if (!entry) throw new Error(`Couldn't find Vite's code in ${viteDir}.`);
  const vite = (await import(pathToFileURL(entry).href)) as { createServer(config: object): Promise<{ listen(): Promise<unknown> }> };

  const server = await vite.createServer({
    root,
    cacheDir,
    clearScreen: false,
    logLevel: 'warn',
    server: { port: Number(port), strictPort: true, host: '127.0.0.1', hmr: false, watch: null },
    plugins: [
      {
        name: 'visual-editor-draft',
        enforce: 'pre',
        // A new file the draft adds: found by relative imports and by the page's own addresses (/src/…).
        resolveId(source: string, importer?: string) {
          const [path, query] = source.split('?');
          let base: string | undefined;
          if (path.startsWith('.') && importer) base = resolve(dirname(importer.split('?')[0]), path);
          else if (path.startsWith(root)) base = path;
          else if (path.startsWith('/') && !path.startsWith('/@')) base = join(root, path);
          const hit = base && find(base);
          return hit ? hit + (query ? `?${query}` : '') : null;
        },
        // The draft's text in place of the file's.
        load(id: string) {
          const path = id.split('?')[0];
          if (!draft.has(path)) return null;
          const text = draft.get(path);
          if (text === null || text === undefined) throw new Error(`${relative(root, path)} is removed by the draft.`);
          return text;
        },
      },
    ],
  });
  await server.listen();
  console.log(`READY http://127.0.0.1:${port}`);
}

// It never outlives VS Code: when VS Code goes (even if it crashes), the pipe it gave closes, and this stops.
process.stdin.on('close', () => process.exit(0));
process.stdin.resume();

main().catch((e) => {
  console.log(`ERROR ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
