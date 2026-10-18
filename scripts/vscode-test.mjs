// Starts a real VS Code with the shell and the Hello plugin on a throwaway project, and runs test-vscode/smoke.ts
// inside it.  npm run test:vscode
//   SHOTS=<folder>   take screenshots (needs permission to record the screen)
//   CLAUDE=1         also let real Claude Code connect to the hub and propose a change (uses Claude)
//   VSCODE_PATH=…    VS Code elsewhere

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
const requests = join(temp, 'requests');
mkdirSync(requests);
const env = {
  ...process.env,
  VISUAL_EDITOR_TEST: '1',
  VISUAL_EDITOR_REPORT: report,
  VISUAL_EDITOR_REQUESTS: requests,
  ...(shots ? { VISUAL_EDITOR_SHOTS: shots } : {}),
  ...(process.env.CLAUDE === '1' ? { VISUAL_EDITOR_CLAUDE: '1' } : {}),
};
delete env.ELECTRON_RUN_AS_NODE;
// Like VS Code opened from the Dock: without the folder where `claude` is usually installed on its PATH.
env.PATH = (env.PATH ?? '').split(':').filter((p) => !p.endsWith('/.local/bin')).join(':');
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
// The test asks for what only this process can do with <name>.ask files, and waits for <name>.done.
const CLAUDE_PROMPT = `Use the visual-editor MCP tools. Call overview, then memory. Read README.md, then call propose_change to add the
line "Made with Visual Editor." at the end of README.md (give the whole new file). Never edit files yourself. Then reply in one line.`;
let busy = false;
const shooter = setInterval(() => {
  if (busy) return;
  for (const f of readdirSync(requests).filter((n) => n.endsWith('.ask'))) {
    const name = f.slice(0, -4);
    const payload = JSON.parse(readFileSync(join(requests, f), 'utf8') || '{}');
    rmSync(join(requests, f));
    let out = '';
    busy = true;
    try {
      if (name.startsWith('shot-') && shots) execFileSync('screencapture', ['-x', join(shots, `${name.slice(5)}.png`)]);
      if (name === 'claude') {
        const config = JSON.stringify({ mcpServers: { 'visual-editor': { type: 'http', url: payload.url, headers: { Authorization: `Bearer ${payload.token}` } } } });
        out = execFileSync(
          'claude',
          ['-p', '--strict-mcp-config', '--mcp-config', config, '--allowedTools', 'Read mcp__visual-editor__overview mcp__visual-editor__memory mcp__visual-editor__propose_change mcp__visual-editor__list_cards mcp__visual-editor__card', '--disallowedTools', 'Edit Write Bash'],
          // The prompt goes in on stdin: the tool lists above would swallow it as one more name.
          { cwd: payload.cwd, encoding: 'utf8', timeout: 220_000, input: CLAUDE_PROMPT },
        );
      }
    } catch (e) {
      out = `failed: ${e.message}`;
    }
    busy = false;
    writeFileSync(join(requests, `${name}.done`), out);
  }
}, 200);
child.stdout.on('data', () => {});
child.stderr.on('data', () => {});
child.on('exit', (status) => {
  clearInterval(shooter);
  let text = '';
  try {
    text = readFileSync(report, 'utf8');
  } catch {
    text = '(no report: the test did not finish)\n';
  }
  process.stdout.write(text);
  process.exit(status ?? 1);
});
