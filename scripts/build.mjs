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

const common = { bundle: true, platform: 'node', format: 'cjs', target: 'node20', sourcemap: true, logLevel: 'warning' };
const builds = extensions.flatMap((dir) => [
  { ...common, entryPoints: [join(dir, 'src/extension.ts')], outfile: join(dir, 'dist/extension.js'), external: ['vscode'] },
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
