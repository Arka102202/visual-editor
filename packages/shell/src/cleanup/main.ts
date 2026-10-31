// The clean-up window: the sessions the clean-up helper suggests deleting, each with why (the others aren't listed:
// they stay). 🗑 on a row deletes that one; 🗑 at the bottom deletes them all; a session's name opens it to look at.
// Shown as a window over its own short-lived tab, which closes when the window does. Plain DOM.

import type { CleanupRow, FromCleanup, ToCleanup } from '../cleanupMessages';
import { addStyles, el } from '../ui/dom';
import { iconButton, installTips, tray } from '../ui/buttons';

declare function acquireVsCodeApi(): { postMessage(message: FromCleanup): void };
const vscode = acquireVsCodeApi();

addStyles(`
  html, body { height: 100%; margin: 0; }
  .cu-veil { position: fixed; inset: 0; background: #0008; display: flex; align-items: center; justify-content: center; padding: 16px; }
  .cu-box { background: var(--vscode-editorWidget-background, var(--vscode-editor-background)); color: var(--vscode-foreground); border: 1px solid var(--vscode-panel-border, #8884); border-radius: 6px; width: min(640px, 100%); max-height: min(720px, 100%); display: flex; flex-direction: column; box-shadow: 0 10px 40px #0008; }
  .cu-head { padding: 14px 16px 4px; font-weight: 600; font-size: 14px; }
  .cu-sub { padding: 0 16px 10px; opacity: .75; font-size: 12px; line-height: 1.45; }
  .cu-body { overflow-y: auto; padding: 0 16px 8px; flex: 1; min-height: 0; }
  .cu-row { display: flex; gap: 8px; align-items: flex-start; padding: 8px; border: 1px solid var(--vscode-panel-border, #8883); border-radius: 4px; margin-bottom: 6px; }
  .cu-main { flex: 1; min-width: 0; }
  .cu-title { font-weight: 600; cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .cu-title:hover { text-decoration: underline; }
  .cu-state { font-size: 11px; opacity: .65; margin-top: 2px; }
  .cu-why { font-size: 12px; margin-top: 4px; line-height: 1.4; }
  .cu-why b { color: var(--vscode-errorForeground, #f48771); font-weight: 600; }
  .cu-foot { display: flex; gap: 8px; justify-content: flex-end; align-items: center; padding: 10px 16px 14px; }
  .cu-foot .hint { flex: 1; font-size: 12px; opacity: .75; }
`);
installTips();

const veil = el('div', 'cu-veil');
const box = el('div', 'cu-box');
const head = el('div', 'cu-head');
const body = el('div', 'cu-body');
const hint = el('span', 'hint', 'The other sessions stay.');
const close = iconButton('close', 'Close: delete nothing now (they stay marked in Memory → Sessions)');
const all = iconButton('trash', 'Delete all of them for good', { cls: 'primary' });
const foot = tray(el('div', 'cu-foot'));
foot.append(hint, close, all);
box.append(head, el('div', 'cu-sub', 'The clean-up helper suggests deleting these sessions, each with why. Deleting removes a session’s versions and history; your project’s files don’t change.'), body, foot);
veil.append(box);
document.body.append(veil);

let rows: CleanupRow[] = [];
close.addEventListener('click', () => vscode.postMessage({ type: 'close' }));
all.addEventListener('click', () => vscode.postMessage({ type: 'delete', ids: rows.map((r) => r.id) }));
// A click on the dimmed background closes it too, like any window.
veil.addEventListener('click', (e) => e.target === veil && vscode.postMessage({ type: 'close' }));
document.addEventListener('keydown', (e) => e.key === 'Escape' && vscode.postMessage({ type: 'close' }));

function draw() {
  head.textContent = `Suggested to delete (${rows.length})`;
  all.title = `Delete all ${rows.length} for good`;
  body.replaceChildren(
    ...rows.map((r) => {
      const row = el('div', 'cu-row');
      const main = el('div', 'cu-main');
      const title = el('div', 'cu-title', r.title);
      title.title = 'Open it, to look at it first';
      title.addEventListener('click', () => vscode.postMessage({ type: 'open', id: r.id }));
      const why = el('div', 'cu-why');
      why.append(el('b', undefined, 'Why delete it: '), document.createTextNode(r.why));
      main.append(title, el('div', 'cu-state', r.state), why);
      const del = iconButton('trash', `Delete “${r.title}” for good`);
      del.addEventListener('click', () => vscode.postMessage({ type: 'delete', ids: [r.id] }));
      row.append(main, del);
      return row;
    }),
  );
}

window.addEventListener('message', (e: MessageEvent<ToCleanup>) => {
  if (e.data?.type !== 'show') return;
  rows = e.data.rows;
  draw();
});
vscode.postMessage({ type: 'ready' });
