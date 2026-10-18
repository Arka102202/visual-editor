// Builds every extension (the shell and each plugin) into its own dist/, and the tests into dist-test/.
//   node scripts/build.mjs           build once
//   node scripts/build.mjs --watch   rebuild on change
//   node scripts/build.mjs --test    build the tests only

import * as esbuild from 'esbuild';
import { existsSync, readdirSync } from 'node:fs';
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
const builds = extensions.map((dir) => ({ ...common, entryPoints: [join(dir, 'src/extension.ts')], outfile: join(dir, 'dist/extension.js'), external: ['vscode'] }));

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
  await esbuild.build(tests);
} else if (watch) {
  for (const options of builds) await (await esbuild.context(options)).watch();
  console.log(`watching ${extensions.join(', ')}`);
} else {
  await Promise.all(builds.map((options) => esbuild.build(options)));
  console.log(`built ${extensions.join(', ')}`);
}
