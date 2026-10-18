// The Review page: proposals on the left (waiting first), the chosen one on the right with why, what changes in
// each file, and Approve / Send back / Reject (or Undo once applied). Plain DOM, no framework.

import type { FromReview, ReviewFile, ReviewItem, ToReview } from '../reviewMessages';
import { addStyles, ago, el } from '../ui/dom';

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
  .warn { border: 1px solid var(--vscode-inputValidation-warningBorder, #d9a400); background: var(--vscode-inputValidation-warningBackground, #d9a40022); border-radius: 6px; padding: 8px 12px; margin-bottom: 14px; }
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
const tryButton = el('button', 'primary', 'Try it with an example');
tryButton.title = 'Makes an example proposal (adding "How to run" to the README) so you can see how review works';
tryButton.addEventListener('click', () => vscode.postMessage({ type: 'try' }));
empty.append(el('h2', undefined, 'Nothing to review'), el('p', undefined, 'Changes proposed by assistants, agents and plugins appear here before they touch your code.'), tryButton);
document.body.append(list, detail, empty);

let current: ToReview | undefined;

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
  if (m.problems.length) {
    const box = el('div', 'problems');
    box.append(el('div', 'group', "Couldn't read"));
    for (const p of m.problems) box.append(el('div', undefined, `${p.file}: ${p.message}`));
    list.append(box);
  }
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

function button(text: string, cls: string | undefined, title: string, message: FromReview): HTMLButtonElement {
  const b = el('button', cls, text);
  b.title = title;
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

  const actions = el('div', 'actions');
  if (item.status === 'proposed') {
    const approve = button('Approve and apply', 'primary', 'Make all of these changes now (they can be undone)', { type: 'approve', id: item.id });
    approve.disabled = item.conflicts.length > 0;
    actions.append(
      approve,
      button('Send back', undefined, `Ask ${item.by.name} to change it, with a note`, { type: 'sendBack', id: item.id }),
      button('Reject', undefined, 'Drop it; nothing changes', { type: 'reject', id: item.id }),
    );
  } else if (item.status === 'applied') {
    const undo = button('Undo', undefined, 'Put the files back as they were', { type: 'undo', id: item.id });
    undo.disabled = item.conflicts.length > 0;
    actions.append(undo);
  }
  if (actions.childElementCount) detail.append(actions);

  for (const f of item.files) detail.append(drawFile(f));

  const history = el('div', 'history');
  history.append(el('div', 'group', 'History'));
  for (const h of item.history) {
    history.append(el('div', undefined, `${new Date(h.at).toLocaleString()} · ${STATUS_WORDS[h.status]}${h.note ? `: “${h.note}”` : ''}`));
  }
  detail.append(history);
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
