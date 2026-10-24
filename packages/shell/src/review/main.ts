// The Review page: proposals on the left (waiting first), the chosen one on the right with why, how it looks (before
// and after, live from the app, when the proposal has a look), what changes in each file, and Approve / Send back /
// Reject (or Undo once applied). Plain DOM, no framework.

import type { FromReview, ReviewFile, ReviewItem, ToReview } from '../reviewMessages';
import { addStyles, ago, el } from '../ui/dom';
import { iconButton, installTips, tray, type Icon } from '../ui/buttons';

declare function acquireVsCodeApi(): { postMessage(message: FromReview): void };
const vscode = acquireVsCodeApi();

addStyles(`
  body { display: flex; }
  .list { width: 300px; min-width: 220px; border-right: 1px solid var(--vscode-panel-border, #8883); overflow-y: auto; }
  .group { font-size: 11px; font-weight: 600; letter-spacing: .05em; text-transform: uppercase; opacity: .6; padding: 14px 14px 6px; }
  .row { padding: 8px 14px; cursor: pointer; border-left: 3px solid transparent; }
  .row:hover { background: var(--vscode-list-hoverBackground); }
  .row.on { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
  .row.waiting { border-left-color: #d9a400; }
  .row .t { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .row .s { font-size: 11px; opacity: .7; display: flex; gap: 6px; align-items: center; }
  .detail { flex: 1; overflow-y: auto; padding: 20px 28px 40px; min-width: 0; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .meta { font-size: 12px; opacity: .7; display: flex; gap: 8px; align-items: center; margin-bottom: 14px; }
  .why { margin: 0 0 16px; max-width: 760px; }
  .actions { display: flex; gap: 8px; margin: 0 0 18px; position: sticky; top: -20px; padding: 10px 0; background: var(--vscode-editor-background); z-index: 1; }
  /* A light tint of the theme's warning colour, with the editor's own text colour: readable in any theme (the input
     warning colours can be solid, with no matching text colour). */
  .warn { border: 1px solid color-mix(in srgb, var(--vscode-editorWarning-foreground, #cca700) 55%, transparent); background: color-mix(in srgb, var(--vscode-editorWarning-foreground, #cca700) 12%, var(--vscode-editor-background, #1e1e1e)); color: var(--vscode-editor-foreground, var(--vscode-foreground)); border-radius: 6px; padding: 8px 12px; margin-bottom: 14px; }
  .warn b { display: block; margin-bottom: 4px; }
  .file { border: 1px solid var(--vscode-panel-border, #8884); border-radius: 6px; margin-bottom: 14px; overflow: hidden; }
  .file .head { display: flex; gap: 8px; align-items: center; padding: 6px 12px; background: var(--vscode-editorWidget-background, #8881); font-size: 12px; }
  .file .head .p { flex: 1; font-family: var(--vscode-editor-font-family, monospace); cursor: pointer; }
  .file .head .p:hover { text-decoration: underline; }
  .plus { color: var(--vscode-gitDecoration-addedResourceForeground, #3a3); }
  .minus { color: var(--vscode-gitDecoration-deletedResourceForeground, #d44); }
  .code { font-family: var(--vscode-editor-font-family, monospace); font-size: var(--vscode-editor-font-size, 12px); overflow-x: auto; }
  .ln { display: flex; white-space: pre; min-width: max-content; }
  .ln .no { width: 40px; flex: none; text-align: right; padding-right: 8px; opacity: .45; user-select: none; }
  .ln .tx { padding: 0 12px 0 6px; }
  .ln.added { background: var(--vscode-diffEditor-insertedLineBackground, #2ea04326); }
  .ln.removed { background: var(--vscode-diffEditor-removedLineBackground, #f8514926); }
  .ln.added .tx::before { content: '+ '; opacity: .6; }
  .ln.removed .tx::before { content: '- '; opacity: .6; }
  .ln.same .tx::before { content: '  '; }
  .gap { height: 8px; border-top: 1px dashed #8884; }
  .history { font-size: 12px; opacity: .8; margin-top: 22px; }
  .history div { margin: 3px 0; }
  .empty { margin: auto; text-align: center; max-width: 440px; padding: 24px; }
  .empty h2 { font-size: 16px; margin: 0 0 6px; }
  .empty p { opacity: .7; margin: 0 0 16px; }
  .problems { font-size: 12px; padding: 10px 14px; opacity: .8; }
  .try { margin: 18px 14px; }
  .lookhead { font-size: 11px; font-weight: 600; letter-spacing: .05em; text-transform: uppercase; opacity: .6; margin: 0 0 6px; }
  .look { position: relative; height: 420px; min-height: 160px; resize: vertical; overflow: hidden; border: 1px solid var(--vscode-panel-border, #8884); border-radius: 6px; margin-bottom: 18px; background: #fff; }
  .look iframe { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; }
  .look .wait { position: absolute; inset: 0; display: flex; gap: 10px; align-items: center; justify-content: center; text-align: center; padding: 20px; color: #555; font-size: 13px; }
`);

const STATUS_WORDS: Record<ReviewItem['status'], string> = {
  proposed: 'waiting for you',
  applied: 'applied',
  rejected: 'rejected',
  'sent-back': 'sent back',
  undone: 'undone',
};

const list = el('div', 'list');
const detail = el('div', 'detail');
const empty = el('div', 'empty');
const TRY_WORDS = 'Try it with an example: makes an example proposal (adding "How to run" to the README) so you can see how review works';
const tryButton = iconButton('example', TRY_WORDS, { cls: 'primary' });
tryButton.addEventListener('click', () => vscode.postMessage({ type: 'try' }));
empty.append(el('h2', undefined, 'Nothing to review'), el('p', undefined, 'Changes proposed by assistants, agents and plugins appear here before they touch your code.'), tryButton);
document.body.append(list, detail, empty);
installTips();

let current: ToReview | undefined;
/** How a proposal looks: kept between redraws, so it doesn't load again each time Review refreshes. */
const looks = new Map<string, HTMLElement>();

function show(m: ToReview) {
  current = m;
  const has = m.items.length > 0;
  list.hidden = !has && !m.problems.length;
  detail.hidden = !has;
  empty.hidden = has;
  list.replaceChildren();
  const waiting = m.items.filter((i) => i.status === 'proposed');
  const done = m.items.filter((i) => i.status !== 'proposed');
  if (waiting.length) list.append(el('div', 'group', `Waiting for you (${waiting.length})`), ...waiting.map(row));
  if (done.length) list.append(el('div', 'group', 'Done'), ...done.map(row));
  // Always at hand, not only when Review is empty.
  const more = iconButton('example', TRY_WORDS, { cls: 'try' });
  more.addEventListener('click', () => vscode.postMessage({ type: 'try' }));
  if (m.problems.length) {
    const box = el('div', 'problems');
    box.append(el('div', 'group', "Couldn't read"));
    for (const p of m.problems) box.append(el('div', undefined, `${p.file}: ${p.message}`));
    list.append(box);
  }
  list.append(more);
  const chosen = m.items.find((i) => i.id === m.selected);
  if (chosen) drawDetail(chosen);
}

function row(item: ReviewItem): HTMLElement {
  const r = el('div', `row${item.status === 'proposed' ? ' waiting' : ''}${item.id === current?.selected ? ' on' : ''}`);
  const s = el('div', 's');
  s.append(el('span', undefined, item.by.name), el('span', undefined, '·'), el('span', undefined, item.status === 'proposed' ? ago(item.createdAt) : STATUS_WORDS[item.status]));
  r.append(el('div', 't', item.title), s);
  r.addEventListener('click', () => vscode.postMessage({ type: 'select', id: item.id }));
  return r;
}

/** An icon button named `name` (shown on hover) that sends `message`. */
function button(icon: Icon, name: string, cls: string | undefined, message: FromReview): HTMLButtonElement {
  const b = iconButton(icon, name, { cls });
  b.addEventListener('click', () => vscode.postMessage(message));
  return b;
}

function drawDetail(item: ReviewItem) {
  detail.replaceChildren();
  detail.append(el('h1', undefined, item.title));
  const meta = el('div', 'meta');
  const status = el('span', `chip${item.status === 'proposed' ? ' proposed' : ''}`, STATUS_WORDS[item.status]);
  const files = item.files.length;
  meta.append(status, el('span', undefined, `by ${item.by.name} · ${ago(item.createdAt)} · ${files} file${files === 1 ? '' : 's'}`));
  detail.append(meta);
  if (item.why) detail.append(el('p', 'why', item.why));

  if (item.conflicts.length) {
    const warn = el('div', 'warn');
    warn.append(el('b', undefined, item.status === 'applied' ? 'It can no longer be undone automatically:' : 'It no longer fits the code as it is now:'));
    for (const c of item.conflicts) warn.append(el('div', undefined, c));
    detail.append(warn);
  }

  const actions = tray(el('div', 'actions'));
  if (item.status === 'proposed') {
    const approve = button('choose', 'Approve and apply: make all of these changes now (they can be undone)', 'primary', { type: 'approve', id: item.id });
    approve.disabled = item.conflicts.length > 0;
    actions.append(
      approve,
      button('sendBack', `Send back: ask ${item.by.name} to change it, with a note`, undefined, { type: 'sendBack', id: item.id }),
      button('reject', 'Reject: drop it; nothing changes', undefined, { type: 'reject', id: item.id }),
    );
  } else if (item.status === 'applied') {
    const undo = button('undo', 'Undo: put the files back as they were', undefined, { type: 'undo', id: item.id });
    undo.disabled = item.conflicts.length > 0;
    actions.append(undo);
  }
  if (actions.childElementCount) detail.append(actions);

  if (item.look) detail.append(el('div', 'lookhead', 'How it looks: before and after (live, with fixed data)'), drawLook(item.look));
  for (const f of item.files) detail.append(drawFile(f));

  const history = el('div', 'history');
  history.append(el('div', 'group', 'History'));
  for (const h of item.history) {
    history.append(el('div', undefined, `${new Date(h.at).toLocaleString()} · ${STATUS_WORDS[h.status]}${h.note ? `: “${h.note}”` : ''}`));
  }
  detail.append(history);
}

/** The look page in a frame once the app is running; until then, how starting it goes. */
function drawLook(look: string): HTMLElement {
  const app = current?.app;
  const url = app?.url ? `${app.url}${look}` : undefined;
  if (url) {
    let box = looks.get(url);
    if (!box) {
      box = el('div', 'look');
      const frame = el('iframe');
      frame.title = 'How it looks, before and after';
      frame.src = url;
      box.append(frame);
      looks.set(url, box);
    }
    return box;
  }
  const box = el('div', 'look');
  const wait = el('div', 'wait', app?.error ? `The app’s dev server couldn’t start: ${app.error}` : (app?.progress ?? 'Starting the app’s dev server…'));
  if (app?.error) wait.append(button('reload', 'Try again: start the app’s dev server', undefined, { type: 'app' }));
  box.append(wait);
  return box;
}

function drawFile(f: ReviewFile): HTMLElement {
  const box = el('div', 'file');
  const head = el('div', 'head');
  const path = el('span', 'p', f.path);
  path.title = 'Open the file';
  path.addEventListener('click', () => vscode.postMessage({ type: 'open', path: f.path }));
  head.append(path, el('span', 'chip', f.kind === 'new' ? 'new file' : f.kind === 'removed' ? 'removed' : 'changed'));
  if (f.added) head.append(el('span', 'plus', `+${f.added}`));
  if (f.removed) head.append(el('span', 'minus', `−${f.removed}`));
  box.append(head);
  const code = el('div', 'code');
  f.hunks.forEach((h, i) => {
    if (i) code.append(el('div', 'gap'));
    for (const l of h.lines) {
      const line = el('div', `ln ${l.kind}`);
      line.append(el('span', 'no', String(l.kind === 'removed' ? l.old : l.new)), el('span', 'tx', l.text));
      code.append(line);
    }
  });
  box.append(code);
  return box;
}

window.addEventListener('message', (e: MessageEvent<ToReview>) => {
  if (e.data?.type === 'show') show(e.data);
});
vscode.postMessage({ type: 'ready' });
