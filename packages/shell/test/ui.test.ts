import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// The house rules for every page Visual Editor draws (see ui/buttons.ts and ui/dom.ts), checked in the code so they
// can't be forgotten: buttons are icons named on hover, never wrap, rows of them scroll sideways, and no scrollbar
// is ever shown.

const code: { path: string; text: string }[] = [];
const walk = (dir: string) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (p.endsWith('.ts')) code.push({ path: p, text: readFileSync(p, 'utf8') });
  }
};
walk('packages/shell/src');
// Every plugin's code too (a folder left behind without its code, e.g. on another branch, is skipped).
for (const group of ['plugins']) for (const name of readdirSync(group)) if (existsSync(join(group, name, 'src'))) walk(join(group, name, 'src'));

test('ui rules: every button is made with iconButton (an icon, named on hover), never with words', () => {
  const offenders = code.filter((f) => !f.path.endsWith('ui/buttons.ts') && /el\(\s*'button'|createElement\(\s*['"]button['"]/.test(f.text)).map((f) => f.path);
  assert.deepEqual(offenders, [], `make these buttons with iconButton() from ui/buttons.ts: ${offenders.join(', ')}`);
});

test('ui rules: no page shows a scrollbar', () => {
  const offenders = code.filter((f) => !f.path.endsWith('ui/dom.ts') && /::-webkit-scrollbar[^{]*\{[^}]*(width|height):\s*[1-9]/.test(f.text)).map((f) => f.path);
  assert.deepEqual(offenders, [], `scrollbars are hidden everywhere (ui/dom.ts); don't style one visible: ${offenders.join(', ')}`);
  const base = code.find((f) => f.path.endsWith('ui/dom.ts'))!.text;
  assert.match(base, /\* \{ scrollbar-width: none; \}/);
  assert.match(base, /\*::-webkit-scrollbar \{ display: none/);
});

test('ui rules: buttons never wrap, and rows of buttons scroll sideways instead', () => {
  const base = code.find((f) => f.path.endsWith('ui/dom.ts'))!.text;
  assert.match(base, /button \{ white-space: nowrap; flex: none; \}/);
  assert.match(base, /\.tray \{ display: flex; flex-wrap: nowrap;[^}]*overflow-x: auto/);
  const offenders = code.filter((f) => /(button|\.buttons|\.actions|\.tray|\.bar)[^{}]*\{[^}]*flex-wrap:\s*wrap/.test(f.text)).map((f) => f.path);
  assert.deepEqual(offenders, [], `a row of buttons wraps here; make it a tray() instead: ${offenders.join(', ')}`);
});
