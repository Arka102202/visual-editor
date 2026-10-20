// Builds every extension (the shell and each plugin) into its own dist/, and the tests into dist-test/.
//   node scripts/build.mjs           build once
//   node scripts/build.mjs --watch   rebuild on change
//   node scripts/build.mjs --test    build the tests only

import * as esbuild from 'esbuild';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

const watch = process.argv.includes('--watch');
const test = process.argv.includes('--test');

/** Every package or plugin folder that is a VS Code extension (it has src/extension.ts). */
const extensions = ['packages', 'plugins'].flatMap((group) =>
  readdirSync(group)
    .map((name) => join(group, name))
    .filter((dir) => existsSync(join(dir, 'src/extension.ts'))),
);

const common = { bundle: true, platform: 'node', format: 'cjs', target: 'node20', sourcemap: true, logLevel: 'warning' };
const builds = extensions.flatMap((dir) => [
  // TypeScript 5 (for reading a project's types) runs in the worker only: it stays out of the extension itself.
  { ...common, entryPoints: [join(dir, 'src/extension.ts')], outfile: join(dir, 'dist/extension.js'), external: ['vscode', 'typescript-5'] },
  // Work done off VS Code's own thread (src/worker.ts), e.g. reading a big project: dist/worker.js.
  ...(existsSync(join(dir, 'src/worker.ts')) ? [{ ...common, entryPoints: [join(dir, 'src/worker.ts')], outfile: join(dir, 'dist/worker.js'), external: ['vscode'] }] : []),
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
  external: ['vscode'],
};

/**
 * TypeScript 5 bundled into an extension (to read a project's types when it has none of its own) looks for its
 * built-in declarations (lib.es2020.d.ts, lib.dom.d.ts…) next to the bundle: they're copied into dist/ts-lib.
 */
function copyTypeScriptLibs() {
  const from = 'node_modules/typescript-5/lib';
  const uses = (dir) =>
    readdirSync(dir, { withFileTypes: true }).some((d) =>
      d.isDirectory() ? uses(join(dir, d.name)) : /\.tsx?$/.test(d.name) && readFileSync(join(dir, d.name), 'utf8').includes("require('typescript-5')"),
    );
  for (const dir of extensions) {
    if (!existsSync(from) || !uses(join(dir, 'src'))) continue;
    const to = join(dir, 'dist/ts-lib');
    mkdirSync(to, { recursive: true });
    for (const name of readdirSync(from)) if (/^lib\..*\.d\.ts$/.test(name) && statSync(join(from, name)).isFile()) copyFileSync(join(from, name), join(to, name));
  }
}

if (test) {
  // Start clean: tests built on another branch (or since deleted) must not run.
  rmSync('dist-test', { recursive: true, force: true });
  await esbuild.build(tests);
} else if (watch) {
  for (const options of builds) await (await esbuild.context(options)).watch();
  copyTypeScriptLibs();
  console.log(`watching ${extensions.join(', ')}`);
} else {
  await Promise.all(builds.map((options) => esbuild.build(options)));
  copyTypeScriptLibs();
  console.log(`built ${extensions.join(', ')}`);
}
