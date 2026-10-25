// The window that opens when a change's checks failed: every failed check with why, a tick to bypass each, and the
// reason (required) for letting the change go anyway. A check can fail for a real problem, or because it has no
// meaning for this particular change: the developer decides, and their reason stays in the proof for everyone to see.
// Shared by the session tab and Review. Plain DOM.

import { addStyles, el } from './dom';
import { iconButton } from './buttons';

export interface FailedCheck {
  title: string;
  /** Why it failed, in a few lines. */
  why: string;
}

addStyles(`
  .bp-veil { position: fixed; inset: 0; background: #0008; display: flex; align-items: center; justify-content: center; z-index: 100; padding: 16px; }
  .bp-box { background: var(--vscode-editorWidget-background, var(--vscode-editor-background)); color: var(--vscode-foreground); border: 1px solid var(--vscode-panel-border, #8884); border-radius: 6px; width: min(640px, 100%); max-height: min(720px, 100%); display: flex; flex-direction: column; box-shadow: 0 10px 40px #0008; }
  .bp-head { padding: 14px 16px 8px; font-weight: 600; font-size: 14px; }
  .bp-sub { padding: 0 16px 10px; opacity: .75; font-size: 12px; line-height: 1.45; }
  .bp-list { overflow-y: auto; padding: 0 16px; flex: 1; min-height: 0; }
  .bp-item { border: 1px solid color-mix(in srgb, var(--vscode-errorForeground, #f48771) 45%, transparent); border-radius: 4px; margin-bottom: 8px; }
  .bp-item label { display: flex; gap: 8px; align-items: flex-start; padding: 8px 10px; cursor: pointer; font-weight: 600; }
  .bp-item pre { margin: 0; padding: 0 10px 10px 32px; white-space: pre-wrap; font-size: 12px; opacity: .85; max-height: 160px; overflow-y: auto; font-family: var(--vscode-editor-font-family, monospace); }
  .bp-reason { margin: 8px 16px 0; }
  .bp-reason textarea { width: 100%; box-sizing: border-box; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, #8884); border-radius: 3px; padding: 6px 8px; font: inherit; resize: vertical; }
  .bp-foot { display: flex; gap: 8px; justify-content: flex-end; align-items: center; padding: 10px 16px 14px; }
  .bp-foot .hint { flex: 1; font-size: 12px; opacity: .7; }
  .bp-foot button:disabled { opacity: .4; cursor: default; }
`);

/**
 * Opens the window. `send`: the checks ticked to bypass, and the reason; it isn't offered until at least one is ticked
 * and a reason is given. Closing it changes nothing (the change stays held back, to fix instead).
 */
export function openBypass(failed: FailedCheck[], send: (titles: string[], reason: string) => void, what = 'This change') {
  document.querySelector('.bp-veil')?.remove();
  const veil = el('div', 'bp-veil');
  const box = el('div', 'bp-box');
  box.append(
    el('div', 'bp-head', `${what} wasn’t sent: ${failed.length} check${failed.length === 1 ? '' : 's'} failed`),
    el('div', 'bp-sub', 'Fix it (ask Claude in your chat), or, if a check is wrong or means nothing for this change, tick it and say why: the change then goes to Review, marked as sent with that check bypassed, with your reason.'),
  );
  const list = el('div', 'bp-list');
  const ticks: HTMLInputElement[] = [];
  for (const f of failed) {
    const item = el('div', 'bp-item');
    const label = el('label');
    const tick = el('input');
    tick.type = 'checkbox';
    tick.value = f.title;
    ticks.push(tick);
    label.append(tick, el('span', undefined, `✗ ${f.title}`));
    item.append(label, el('pre', undefined, f.why.slice(0, 4000)));
    list.append(item);
  }
  const reason = el('div', 'bp-reason');
  const area = el('textarea');
  area.rows = 3;
  area.placeholder = 'Why let it go anyway? e.g. “This check compares the old look, but a new look is the point of this change.”';
  reason.append(area);
  const hint = el('span', 'hint');
  const close = iconButton('close', 'Close: keep it held back, to fix instead');
  const go = iconButton('choose', 'Bypass the ticked checks and send it to Review (your reason is kept with it)', { cls: 'primary' });
  const update = () => {
    const ticked = ticks.filter((t) => t.checked).length;
    go.disabled = !ticked || !area.value.trim();
    hint.textContent = !ticked ? 'Tick the checks to bypass.' : !area.value.trim() ? 'Say why, to send it.' : ticked < ticks.length ? `${ticks.length - ticked} still failing: it stays held back until they're fixed or bypassed too.` : '';
  };
  for (const t of ticks) t.addEventListener('change', update);
  area.addEventListener('input', update);
  close.addEventListener('click', () => veil.remove());
  veil.addEventListener('click', (e) => e.target === veil && veil.remove());
  go.addEventListener('click', () => {
    const titles = ticks.filter((t) => t.checked).map((t) => t.value);
    if (!titles.length || !area.value.trim()) return;
    veil.remove();
    send(titles, area.value.trim());
  });
  const foot = el('div', 'bp-foot');
  foot.append(hint, close, go);
  box.append(list, reason, foot);
  veil.append(box);
  document.body.append(veil);
  update();
  area.focus();
}
