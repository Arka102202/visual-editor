// Starts a real VS Code with the shell and the Hello plugin on a throwaway project, and runs test-vscode/smoke.ts
// inside it.  npm run test:vscode   (screenshots: SHOTS=<folder>; VS Code elsewhere: VSCODE_PATH=<binary>)

import * as esbuild from 'esbuild';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const repo = resolve('.');
const out = join(repo, 'dist-test/vscode/smoke.js');
await esbuild.build({ entryPoints: ['test-vscode/smoke.ts'], bundle: true, platform: 'node', format: 'cjs', target: 'node20', outfile: out, external: ['vscode'], logLevel: 'warning' });

const temp = mkdtempSync(join(tmpdir(), 've-vscode-'));
const project = join(temp, 'demo');
mkdirSync(project);
writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'demo', scripts: { dev: 'next dev' } }, null, 2));
writeFileSync(join(project, 'README.md'), '# demo\n\nA small project for trying Visual Editor.\n');
const report = join(temp, 'report.txt');
const shots = process.env.SHOTS ? resolve(process.env.SHOTS) : undefined;
if (shots) mkdirSync(shots, { recursive: true });

const code = process.env.VSCODE_PATH ?? '/Applications/Visual Studio Code.app/Contents/MacOS/Electron';
const env = { ...process.env, VISUAL_EDITOR_TEST: '1', VISUAL_EDITOR_REPORT: report, ...(shots ? { VISUAL_EDITOR_SHOTS: shots } : {}) };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(
  code,
  [
    project,
    `--extensionDevelopmentPath=${join(repo, 'packages/shell')}`,
    `--extensionDevelopmentPath=${join(repo, 'plugins/hello')}`,
    `--extensionTestsPath=${out}`,
    `--user-data-dir=${join(temp, 'user')}`,
    `--extensions-dir=${join(temp, 'extensions')}`,
    '--disable-workspace-trust',
    '--skip-welcome',
    '--skip-release-notes',
    '--disable-telemetry',
    '--new-window',
  ],
  { env, stdio: ['ignore', 'pipe', 'pipe'] },
);
// The test asks for screenshots with <name>.want files; this process takes them (it may capture the screen).
const shooter = shots
  ? setInterval(() => {
      for (const f of readdirSync(shots).filter((n) => n.endsWith('.want'))) {
        rmSync(join(shots, f));
        try {
          execFileSync('screencapture', ['-x', join(shots, f.replace(/\.want$/, '.png'))]);
        } catch (e) {
          console.error(`screenshot failed: ${e.message}`);
        }
      }
    }, 200)
  : undefined;
child.stdout.on('data', () => {});
child.stderr.on('data', () => {});
child.on('exit', (status) => {
  if (shooter) clearInterval(shooter);
  let text = '';
  try {
    text = readFileSync(report, 'utf8');
  } catch {
    text = '(no report: the test did not finish)\n';
  }
  process.stdout.write(text);
  process.exit(status ?? 1);
});
