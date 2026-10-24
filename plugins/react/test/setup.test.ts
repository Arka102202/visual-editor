import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '@babel/parser';
import { addTsPath, addViteAlias, HELPER_PATH, setupProject } from '../src/setup';

const viteReads = (text: string) => assert.doesNotThrow(() => parse(text, { sourceType: 'module', plugins: ['typescript'] }), text);

test('setup: the alias is written like the project’s own (archFlow’s resolve(__dirname, …))', () => {
  const vite = `import { defineConfig } from 'vite'\nimport { resolve } from 'path'\n\nexport default defineConfig({\n  plugins: [],\n  resolve: {\n    alias: {\n      '@components': resolve(__dirname, 'src/components'),\n      '@pages':      resolve(__dirname, 'src/pages'),\n    },\n  },\n})\n`;
  const out = addViteAlias(vite)!;
  assert.match(out, /      '@pages':      resolve\(__dirname, 'src\/pages'\),\n      '@visual-editor\/react': resolve\(__dirname, '\.visual-editor\/react\/visual-editor\.tsx'\),\n    \},/);
  viteReads(out);
  // Done once: a second run changes nothing.
  assert.equal(addViteAlias(out), undefined);
});

test('setup: other alias shapes, no aliases, and vite-tsconfig-paths', () => {
  const url = `import { fileURLToPath, URL } from 'node:url'\nimport { defineConfig } from 'vite'\nexport default defineConfig({ resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } } })\n`;
  const a = addViteAlias(url)!;
  assert.match(a, /'@visual-editor\/react': fileURLToPath\(new URL\('\.\/\.visual-editor\/react\/visual-editor\.tsx', import\.meta\.url\)\)/);
  viteReads(a);
  const list = `export default defineConfig({ resolve: { alias: [{ find: '@', replacement: path.resolve(__dirname, './src') }] } })\n`;
  const b = addViteAlias(list)!;
  assert.match(b, /\{ find: '@visual-editor\/react', replacement: path\.resolve\(__dirname, '\.\/\.visual-editor\/react\/visual-editor\.tsx'\) \}/);
  viteReads(b);
  const none = `import { defineConfig } from 'vite'\nimport react from '@vitejs/plugin-react'\n\nexport default defineConfig({\n  plugins: [react()],\n})\n`;
  const c = addViteAlias(none)!;
  assert.match(c, /^import \{ fileURLToPath, URL \} from 'node:url'\n/);
  assert.match(c, /resolve: \{ alias: \{ '@visual-editor\/react': fileURLToPath\(new URL\('\.\/\.visual-editor\/react\/visual-editor\.tsx', import\.meta\.url\)\) \} \},/);
  viteReads(c);
  // The tsconfig is enough when Vite reads it.
  assert.equal(addViteAlias(`import tsconfigPaths from 'vite-tsconfig-paths'\nexport default defineConfig({ plugins: [tsconfigPaths()] })\n`), undefined);
});

test('setup: the TypeScript short name, relative to baseUrl (or ./ without one)', () => {
  const withBase = `{\n  "compilerOptions": {\n    "baseUrl": ".",\n    "paths": {\n      "@pages": ["src/pages"]\n    }\n  },\n  "include": ["src"]\n}\n`;
  const a = addTsPath(withBase, 'tsconfig.app.json')!;
  assert.deepEqual(JSON.parse(a).compilerOptions.paths['@visual-editor/react'], ['.visual-editor/react/visual-editor.tsx']);
  assert.equal(JSON.parse(a).compilerOptions.paths['@pages'][0], 'src/pages');
  const inSrc = addTsPath(`{ "compilerOptions": { "baseUrl": "./src", "paths": { "@/*": ["*"] } } }`, 'tsconfig.json')!;
  assert.deepEqual(JSON.parse(inSrc).compilerOptions.paths['@visual-editor/react'], ['../.visual-editor/react/visual-editor.tsx']);
  const bare = addTsPath(`{\n  "compilerOptions": {\n    "strict": true\n  }\n}\n`, 'tsconfig.json')!;
  assert.deepEqual(JSON.parse(bare).compilerOptions.paths, { '@visual-editor/react': ['./.visual-editor/react/visual-editor.tsx'] });
});

test('setup: the helper is added, updated only to a newer version, and nothing is done twice', () => {
  const v3 = 'export const HELPER_VERSION = 3\n';
  const files: Record<string, string> = { 'tsconfig.json': `{ "compilerOptions": { "paths": { "@visual-editor/react": ["./${HELPER_PATH}"] } } }`, 'vite.config.ts': `export default defineConfig({ resolve: { alias: { '@visual-editor/react': x } } })` };
  const added = setupProject((p) => files[p], v3)!;
  assert.deepEqual(added.changes, [{ path: HELPER_PATH, before: null, after: v3 }]);
  assert.match(added.said, /added its helper \(\.visual-editor\/react\/visual-editor\.tsx, version 3\)/);
  // Older → updated; the same → nothing; a formatter's version of the same → nothing; newer → said.
  assert.match(setupProject((p) => ({ ...files, [HELPER_PATH]: 'export const HELPER_VERSION = 2\n' })[p], v3)!.said, /updated its helper \(version 2 → 3\)/);
  assert.equal(setupProject((p) => ({ ...files, [HELPER_PATH]: v3 })[p], v3), undefined);
  assert.equal(setupProject((p) => ({ ...files, [HELPER_PATH]: 'export const HELPER_VERSION = 3;\n\n' })[p], v3), undefined);
  assert.match(setupProject((p) => ({ ...files, [HELPER_PATH]: 'export const HELPER_VERSION = 4\n' })[p], v3)!.problems![0], /newer than your Visual Editor’s/);
});
