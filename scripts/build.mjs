// Builds every extension (the shell and each plugin) into its own dist/, and the tests into dist-test/.
//   node scripts/build.mjs           build once
//   node scripts/build.mjs --watch   rebuild on change
//   node scripts/build.mjs --test    build the tests only

import * as esbuild from 'esbuild';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const watch = process.argv.includes('--watch');
const test = process.argv.includes('--test');

/** Every package or plugin folder that is a VS Code extension (it has src/extension.ts). */
const extensions = ['packages', 'plugins'].flatMap((group) =>
  readdirSync(group)
    .map((name) => join(group, name))
    .filter((dir) => existsSync(join(dir, 'src/extension.ts'))),
);

// Markdown is bundled as text (e.g. docs/variants.md, the React plugin's know-how for assistants).
const common = { bundle: true, platform: 'node', format: 'cjs', target: 'node20', sourcemap: true, logLevel: 'warning', loader: { '.md': 'text' } };
const builds = extensions.flatMap((dir) => [
  { ...common, entryPoints: [join(dir, 'src/extension.ts')], outfile: join(dir, 'dist/extension.js'), external: ['vscode'] },
  // Work done off VS Code's own thread (src/worker.ts), e.g. reading a big project, and programs run as their own
  // process (src/draftServer.ts, a draft's app server): dist/<name>.js.
  ...['worker', 'draftServer', 'typesCheck', 'claudeGuard']
    .filter((name) => existsSync(join(dir, `src/${name}.ts`)))
    .map((name) => ({ ...common, entryPoints: [join(dir, `src/${name}.ts`)], outfile: join(dir, `dist/${name}.js`), external: ['vscode'] })),
  // Pages shown inside VS Code (src/<page>/main.ts) run in the browser: dist/<page>.js.
  ...readdirSync(join(dir, 'src'), { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(dir, 'src', d.name, 'main.ts')))
    .map((d) => ({ ...common, platform: 'browser', format: 'iife', target: 'es2022', entryPoints: [join(dir, 'src', d.name, 'main.ts')], outfile: join(dir, 'dist', `${d.name}.js`) })),
]);

const tests = {
  ...common,
  sourcemap: false,
  entryPoints: ['packages', 'plugins'].flatMap((group) =>
    readdirSync(group).flatMap((name) => {
      const dir = join(group, name, 'test');
      return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.test.ts')).map((f) => join(dir, f)) : [];
    }),
  ),
  outdir: 'dist-test',
  outbase: '.',
  // esbuild runs its own program, found next to its package: tests that build code use it from node_modules.
  external: ['vscode', 'esbuild'],
};

if (test) {
  // Start clean: tests built on another branch (or since deleted) must not run.
  rmSync('dist-test', { recursive: true, force: true });
  await esbuild.build(tests);
} else if (watch) {
  for (const options of builds) await (await esbuild.context(options)).watch();
  console.log(`watching ${extensions.join(', ')}`);
} else {
  await Promise.all(builds.map((options) => esbuild.build(options)));
  console.log(`built ${extensions.join(', ')}`);
}
