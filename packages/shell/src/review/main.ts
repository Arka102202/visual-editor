// The Review page: proposals on the left (waiting first), the chosen one on the right with why, how it looks (before
// and after, live from the app, when the proposal has a look), what changes in each file, and Approve / Send back /
// Reject (or Undo once applied). Plain DOM, no framework.

import type { FromReview, ReviewFile, ReviewItem, ToReview } from '../reviewMessages';
import { addStyles, ago, el } from '../ui/dom';
import { iconButton, installTips, tray, type Icon } from '../ui/buttons';
import { openBypass } from '../ui/bypass';
import { openPlan } from '../ui/planWindow';
import { drawProgress } from '../ui/progress';

declare function acquireVsCodeApi(): { postMessage(message: FromReview): void };
const vscode = acquireVsCodeApi();

addStyles(`
  .summaries { margin: 12px 0; padding: 10px 12px; border-radius: 4px; font-size: 12px; border: 1px solid color-mix(in srgb, var(--vscode-charts-blue, #3794ff) 50%, transparent); background: color-mix(in srgb, var(--vscode-charts-blue, #3794ff) 8%, var(--vscode-editor-background)); }
  .summaries .head { font-weight: 600; margin-bottom: 4px; }
  .summaries.ended { border-color: color-mix(in srgb, var(--vscode-testing-iconPassed, #73c991) 50%, transparent); background: color-mix(in srgb, var(--vscode-testing-iconPassed, #73c991) 8%, var(--vscode-editor-background)); }
  body { display: flex; }
  .list { width: 300px; min-width: 220px; border-right: 1px solid var(--vscode-panel-border, #8883); overflow-y: auto; }
  .group { font-size: 11px; font-weight: 600; letter-spacing: .05em; text-transform: uppercase; opacity: .6; padding: 14px 14px 6px; }
  .row { padding: 8px 14px; cursor: pointer; border-left: 3px solid transparent; }
  .row:hover { background: var(--vscode-list-hoverBackground); }
  .row.on { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
  .row.waiting { border-left-color: #d9a400; }
  .row.held { border-left-color: var(--vscode-errorForeground, #f48771); }
  .row .t { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .row .s { font-size: 11px; opacity: .7; display: flex; gap: 6px; align-items: center; }
  .detail { flex: 1; overflow-y: auto; padding: 20px 28px 40px; min-width: 0; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .meta { font-size: 12px; opacity: .7; display: flex; gap: 8px; align-items: center; margin-bottom: 14px; }
  .why { margin: 0 0 16px; max-width: 760px; }
  .asked { margin: 0 0 12px; max-width: 760px; }
  .askline { padding: 2px 0 2px 10px; border-left: 2px solid var(--vscode-charts-blue, #3794ff); margin-bottom: 3px; }
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
  .proof { border: 1px solid var(--vscode-panel-border, #8884); border-radius: 6px; margin-bottom: 18px; }
  .proof details + details { border-top: 1px solid var(--vscode-panel-border, #8884); }
  .proof summary { cursor: pointer; padding: 6px 10px; display: flex; gap: 8px; align-items: baseline; }
  .proof summary .by { margin-left: auto; opacity: .65; font-size: 12px; white-space: nowrap; }
  .proof .mark { font-weight: 700; width: 1em; text-align: center; }
  .proof .ok { color: var(--vscode-testing-iconPassed, #73c991); }
  .proof .bad { color: var(--vscode-errorForeground, #f48771); }
  .proof .tryrow { padding-top: 8px; }
  .proof .tryrow + .tryrow { border-top: 1px solid var(--vscode-panel-border, #8884); }
  .proof .trytitle { margin: 0 12px 6px 28px; }
  .logic { padding: 4px 12px 12px 28px; }
  .logichead { font-size: 11px; font-weight: 600; letter-spacing: .05em; text-transform: uppercase; opacity: .6; margin: 10px 0 4px; }
  .logic .means { margin: 0; padding-left: 20px; }
  .logic .means li { margin-bottom: 2px; }
  .logic div.means { padding: 0; opacity: .9; }
  .cases .case { padding: 4px 0; border-top: 1px solid var(--vscode-panel-border, #8883); }
  .cases .case:first-child { border-top: 0; }
  .casewhat { display: flex; gap: 8px; align-items: baseline; }
  .casename { flex: 1; min-width: 0; }
  .tags { display: flex; gap: 4px; flex: none; }
  .tag { font-size: 10px; padding: 0 6px; border-radius: 8px; border: 1px solid var(--vscode-panel-border, #8885); opacity: .8; white-space: nowrap; }
  .tag.yours { border-color: var(--vscode-charts-blue, #3794ff); color: var(--vscode-charts-blue, #3794ff); opacity: 1; }
  .tag.run { border-color: var(--vscode-testing-iconPassed, #73c991); color: var(--vscode-testing-iconPassed, #73c991); opacity: 1; }
  .casefound { padding-left: 22px; opacity: .8; font-size: 12px; }
  .case.broke .casefound { opacity: 1; color: var(--vscode-errorForeground, #f48771); }
  .fixes { margin: 0; padding-left: 20px; }
  .casesadd { display: flex; gap: 6px; align-items: flex-start; }
  .casesinput { flex: 1; min-width: 0; resize: vertical; font: inherit; color: inherit; background: var(--vscode-input-background, #3c3c3c); border: 1px solid var(--vscode-input-border, #8885); border-radius: 4px; padding: 6px 8px; }
  .casesnote { margin-top: 6px; font-size: 12px; opacity: .8; }
  .casesnote.bad { color: var(--vscode-errorForeground, #f48771); opacity: 1; }
  .proof .picturebar { display: flex; gap: 4px; margin: 0 12px 6px 28px; }
  .proof .livebox { position: relative; overflow: hidden; margin: 0 12px 12px 28px; border: 1px solid var(--vscode-panel-border, #8884); border-radius: 4px; background: #fff; }
  .proof .picture.fullview { position: fixed; inset: 0; z-index: 50; display: flex; flex-direction: column; padding: 10px 14px 14px; background: var(--vscode-editor-background, #1e1e1e); }
  .proof .picture.fullview .picturebar { margin: 0 0 8px; }
  .proof .picture.fullview .livebox { flex: 1; margin: 0; height: auto; }
  .proof .picture.fullview .livebox.actual { height: auto !important; resize: none; }
  .proof .livebox.actual { height: 560px !important; resize: vertical; }
  .proof .livebox iframe { position: absolute; top: 0; left: 0; border: 0; transform-origin: 0 0; }
  .proof .picture .warn { margin: 0 12px 12px 28px; }
  .proof .liveprogress { margin: 0 12px 8px 28px; opacity: .75; }
  .proof img { display: block; max-width: calc(100% - 40px); margin: 0 12px 12px 28px; border: 1px solid var(--vscode-panel-border, #8884); border-radius: 4px; background: #fff; }
  .proof pre { margin: 0; padding: 8px 12px 10px 28px; white-space: pre-wrap; font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; max-height: 320px; overflow: auto; }
  .lookhead { font-size: 11px; font-weight: 600; letter-spacing: .05em; text-transform: uppercase; opacity: .6; margin: 0 0 6px; }
  .look { position: relative; height: 420px; min-height: 160px; resize: vertical; overflow: hidden; border: 1px solid var(--vscode-panel-border, #8884); border-radius: 6px; margin-bottom: 18px; background: #fff; }
  .look iframe { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; }
  .look .wait { position: absolute; inset: 0; display: flex; gap: 10px; align-items: center; justify-content: center; text-align: center; padding: 20px; color: #555; font-size: 13px; }
`);

const STATUS_WORDS: Record<ReviewItem['status'], string> = {
  'awaiting-checks': 'checks to approve',
  proposed: 'waiting for you',
  applied: 'applied',
  rejected: 'rejected',
  'sent-back': 'sent back',
  undone: 'undone',
  'held-back': 'held back by a check',
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

/** The window with a change's test cases, to run them. */
function askPlan(item: ReviewItem) {
  if (item.plan?.view) openPlan(item.title, item.plan.view, (choice) => vscode.postMessage({ type: 'runPlan', id: item.id, choice }));
}

/** The window to bypass a held-back change's failed checks. */
function askBypass(item: ReviewItem) {
  if (item.failed?.length) openBypass(item.failed, (titles, reason) => vscode.postMessage({ type: 'bypass', id: item.id, titles, reason }), `“${item.title}”`);
}

function show(m: ToReview) {
  current = m;
  const has = m.items.length > 0;
  list.hidden = !has && !m.problems.length;
  detail.hidden = !has;
  empty.hidden = has;
  list.replaceChildren();
  const checks = m.items.filter((i) => i.status === 'awaiting-checks');
  const waiting = m.items.filter((i) => i.status === 'proposed');
  const held = m.items.filter((i) => i.status === 'held-back');
  const done = m.items.filter((i) => i.status !== 'proposed' && i.status !== 'held-back' && i.status !== 'awaiting-checks');
  // Finished changes whose test cases wait for you: nothing has run on them yet.
  if (checks.length) list.append(el('div', 'group', `Checks to approve (${checks.length})`), ...checks.map(row));
  if (waiting.length) list.append(el('div', 'group', `Waiting for you (${waiting.length})`), ...waiting.map(row));
  // What a check stopped before it reached you: the checks at work, with why.
  if (held.length) list.append(el('div', 'group', `Held back (${held.length})`), ...held.map(row));
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
  const r = el('div', `row${item.status === 'proposed' ? ' waiting' : item.status === 'held-back' ? ' held' : ''}${item.id === current?.selected ? ' on' : ''}`);
  const s = el('div', 's');
  s.append(el('span', undefined, item.by.name), el('span', undefined, '·'), el('span', undefined, item.status === 'proposed' || item.status === 'held-back' ? ago(item.createdAt) : STATUS_WORDS[item.status]));
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
  if (item.status === 'awaiting-checks' && item.plan) {
    const box = el('div', 'warn');
    const p = item.plan;
    if (p.state === 'writing') box.append(el('b', undefined, 'Its test cases are being written.'), el('div', undefined, 'The check planner is reading the change and what was asked (a minute or so). Nothing has run yet.'));
    else if (p.state === 'running') {
      box.append(el('b', undefined, 'Its checks are running.'), el('div', undefined, `Now: ${p.step ?? '…'}. It reaches Review when they pass; if not, you see what failed.`));
      if (p.items?.length) box.append(drawProgress(p.items));
    }
    else if (p.view) {
      const v = p.view;
      box.append(el('b', undefined, 'Its test cases are ready: nothing has run yet.'), el('div', undefined, `${v.checks.filter((c) => c.use).length} checks and ${v.cases.length} scenarios. Look at them, change them if you like, and run them.`));
      const look = iconButton('preview', 'See the test cases: everything that will be checked (change them, then run them)', { cls: 'primary' });
      look.addEventListener('click', () => askPlan(item));
      box.append(look);
    }
    detail.append(box);
  }
  if (item.status === 'held-back' && item.rerun?.running) {
    const box = el('div', 'warn');
    box.append(el('b', undefined, 'Running its checks again.'), el('div', undefined, `Now: ${item.rerun.running}. It goes to Review if they pass; if not, you see what failed.`));
    if (item.rerun.items?.length) box.append(drawProgress(item.rerun.items));
    detail.append(box);
  } else if (item.status === 'held-back') {
    const warn = el('div', 'warn');
    warn.append(el('b', undefined, 'Held back by a check: it never reached you for approval.'), el('div', undefined, `${item.by.name} was told what to fix. What it tried, and why it was stopped, are below.`));
    detail.append(warn);
  }
  // What was asked comes first: it's what the change is held to.
  if (item.asked?.length) {
    const asked = el('div', 'asked');
    asked.append(el('div', 'lookhead', 'What was asked'));
    for (const a of item.asked) asked.append(el('div', 'askline', `“${a}”`));
    detail.append(asked);
  }
  if (item.why) detail.append(el('p', 'why', item.why));

  if (item.conflicts.length) {
    const warn = el('div', 'warn');
    warn.append(el('b', undefined, item.status === 'applied' ? 'It can no longer be undone automatically:' : 'It no longer fits the code as it is now:'));
    for (const c of item.conflicts) warn.append(el('div', undefined, c));
    detail.append(warn);
  }

  if (item.inSession) {
    const note = el('div', 'warn');
    note.append(el('b', undefined, 'Being changed in a design session.'), el('div', undefined, 'Press Done in the session to bring its changes back here (checked again), or Discard to keep this as it is. Until then nothing can be decided on it.'));
    detail.append(note);
  }
  const actions = tray(el('div', 'actions'));
  if (item.inSession) {
    actions.append(button('brush', 'Open the design session changing it', 'primary', { type: 'session', id: item.id }));
  } else if (item.status === 'proposed') {
    const approve = button('choose', 'Approve and apply: make all of these changes now (they can be undone)', 'primary', { type: 'approve', id: item.id });
    approve.disabled = item.conflicts.length > 0;
    actions.append(
      approve,
      button('sendBack', `Send back: ask ${item.by.name} to change it, with a note`, undefined, { type: 'sendBack', id: item.id }),
      button('reject', 'Reject: drop it; nothing changes', undefined, { type: 'reject', id: item.id }),
      button('brush', 'Continue in a design session: keep changing it with Claude, live; when you’re done, the changes come back into this proposal', undefined, { type: 'session', id: item.id }),
    );
  } else if (item.status === 'awaiting-checks') {
    // Before its checks run: more changes in a design session (they come back into it, with new test cases).
    const busy = item.plan?.state === 'writing' || item.plan?.state === 'running';
    const session = button('brush', busy ? 'Its test cases are being written or run: wait for them to end, then continue it in a design session' : 'Continue in a design session: keep changing it with Claude, live; when you’re done, the changes come back into this proposal and new test cases are written for them', undefined, { type: 'session', id: item.id });
    session.disabled = busy;
    actions.append(session);
  } else if (item.status === 'sent-back' || item.status === 'held-back') {
    // Its checks again, as they are (e.g. after a check that was wrong has been fixed): no new test cases written.
    // While its checks run, nothing else can be done to it (for safety): the buttons say so.
    const running = item.rerun?.running;
    const busy = running ? `Its checks are running (now ${running}): wait for them to finish` : undefined;
    if (item.rerun) {
      // Its test cases, to look at, change or add to, and run again.
      const again = iconButton('preview', busy ?? 'See its test cases: change them, add your own, and run them again');
      again.disabled = !item.rerun.can || !item.rerun.view;
      again.addEventListener('click', () => item.rerun?.view && openPlan(item.title, item.rerun.view, (choice) => vscode.postMessage({ type: 'runPlan', id: item.id, choice })));
      const fresh = button('reload', busy ?? 'Write new test cases (the check planner reads the change again), then look at them and run them', undefined, { type: 'replan', id: item.id });
      fresh.disabled = !!running;
      actions.append(again, fresh);
    }
    if (item.failed?.length) {
      const bypass = iconButton('overrule', busy ?? 'Bypass failed checks: if a check is wrong or means nothing for this change, let it go to Review anyway (say why)');
      bypass.disabled = !!running;
      bypass.addEventListener('click', () => askBypass(item));
      actions.append(bypass);
    }
    const session = button('brush', busy ?? 'Continue in a design session: change it with Claude, live; when you’re done, it comes back here to approve', undefined, { type: 'session', id: item.id });
    session.disabled = !!running;
    actions.append(session);
  } else if (item.status === 'applied') {
    const undo = button('undo', 'Undo: put the files back as they were', undefined, { type: 'undo', id: item.id });
    undo.disabled = item.conflicts.length > 0;
    actions.append(undo);
  }
  if (actions.childElementCount) detail.append(actions);
  // Applied (or undone): the summaries of the cards it touched, written as it goes.
  if (item.summaries) {
    const s = item.summaries;
    const done = s.items.filter((i) => i.state === 'done').length;
    const box = el('div', `summaries${s.ended ? ' ended' : ''}`);
    box.append(
      el('div', 'head', s.ended ? (s.error ? `Summaries: ${done} of ${s.items.length} updated` : `Summaries updated (${done})`) : `${item.status === 'undone' ? 'Undone' : 'Changes applied'}. Now updating the summaries of the cards it touched:`),
      drawProgress(s.items),
    );
    if (s.error) box.append(el('div', 'hint', `${s.error} Ask for those again from each card’s drawer on the map.`));
    detail.append(box);
  }

  // (Waiting for its checks: nothing is checked yet, as planned; its proof comes when they run.)
  if (item.evidence && item.status !== 'awaiting-checks') detail.append(...drawProof(item));
  // Cards it changes that can be tried live, unless a picture in its proof already shows them.
  const pictured = new Set((item.evidence ?? []).flatMap((e) => (e.card ? [e.card] : [])));
  const tryable = (item.cards ?? []).filter((c) => !pictured.has(c.id));
  if (tryable.length) {
    detail.append(el('div', 'lookhead', 'How it looks: try it live'));
    const box = el('div', 'proof');
    for (const c of tryable) {
      const row = el('div', 'tryrow');
      row.append(el('div', 'trytitle', `Playground: ${c.label}`), drawPicture(item, { kind: 'picture', title: `Playground: ${c.label}`, text: '', by: '', at: '', revision: 0, card: c.id }));
      box.append(row);
    }
    detail.append(box);
  }
  if (item.look) detail.append(el('div', 'lookhead', 'How it looks: before and after (live, with fixed data)'), drawLook(item.look));
  for (const f of item.files) detail.append(drawFile(f));

  const history = el('div', 'history');
  history.append(el('div', 'group', 'History'));
  for (const h of item.history) {
    history.append(el('div', undefined, `${new Date(h.at).toLocaleString()} · ${STATUS_WORDS[h.status]}${h.note ? `: “${h.note}”` : ''}`));
  }
  detail.append(history);
}

/**
 * Its proof, from its draft: each check Visual Editor ran (✓ passed, ✗ didn't) and each note from the assistant, open
 * to read in full. Said plainly when nothing was checked or a check didn't pass.
 */
function drawProof(item: ReviewItem): HTMLElement[] {
  const proof = item.evidence ?? [];
  const out: HTMLElement[] = [];
  const failed = proof.filter((e) => e.passed === false && !e.bypassed);
  // Sent with checks that failed, by the developer's choice: always in plain sight.
  const bypassed = proof.filter((e) => e.bypassed);
  if (bypassed.length) {
    const warn = el('div', 'warn');
    warn.append(el('b', undefined, `Sent with ${bypassed.length === 1 ? 'a check' : `${bypassed.length} checks`} bypassed by you:`));
    for (const e of bypassed) warn.append(el('div', undefined, `✗ ${e.title}. Why: ${e.bypassed!.reason}`));
    out.push(warn);
  }
  if (!proof.length || failed.length) {
    const warn = el('div', 'warn');
    warn.append(el('b', undefined, proof.length ? 'Not every check passed:' : 'Nothing was checked:'));
    warn.append(el('div', undefined, proof.length ? failed.map((e) => e.title).join('; ') : `${item.by.name} sent this without proof that it works. Read the changes closely.`));
    out.push(warn);
  }
  if (!proof.length) return out;
  out.push(el('div', 'lookhead', `Proof (${proof.length})`));
  const box = el('div', 'proof');
  for (const e of proof) {
    const entry = el('details');
    const summary = el('summary');
    summary.append(
      el('span', `mark${e.passed === true ? ' ok' : e.passed === false ? ' bad' : ''}`, e.passed === true ? '✓' : e.passed === false ? '✗' : e.kind === 'picture' ? '▣' : '•'),
      el('span', undefined, e.title),
      ...(e.bypassed ? [el('span', 'tag yours', 'bypassed by you')] : []),
      el('span', 'by', e.kind === 'note' ? `said by ${e.by}` : e.kind === 'picture' ? `drawn by ${e.by}` : `checked by ${e.by}`),
    );
    entry.append(summary, e.logic ? drawLogic(item, e.logic) : el('pre', undefined, e.text));
    if (e.logic) entry.open = true;
    // A picture is open from the start: it's the quickest proof to look at. It can also be tried live.
    if (e.src || e.card) entry.append(drawPicture(item, e));
    if (e.src) entry.open = true;
    box.append(entry);
  }
  out.push(box);
  return out;
}

/** Cases typed by the developer and not checked yet, per proposal (kept while Review redraws). */
const typedCases = new Map<string, string>();

/**
 * The logic check's report: what the change means for how things behave (its promises), every case tried to break
 * them (✓ held, ✗ broke), and the developer's own cases, which they can add and have checked.
 */
function drawLogic(item: ReviewItem, r: NonNullable<NonNullable<ReviewItem['evidence']>[number]['logic']>): HTMLElement {
  const box = el('div', 'logic');
  box.append(el('div', 'logichead', 'What this change means'));
  if (r.looksOnly && !r.means.length) box.append(el('div', 'means', 'Looks only: nothing about how it behaves should change.'));
  else {
    const means = el('ol', 'means');
    for (const m of r.means) means.append(el('li', undefined, m));
    box.append(means);
  }
  const broke = r.cases.filter((c) => !c.ok).length;
  box.append(el('div', 'logichead', `Cases tried to break it (${r.cases.length}${broke ? `, ${broke} broke` : ', none broke'})`));
  const cases = el('div', 'cases');
  for (const c of r.cases) {
    const line = el('div', `case${c.ok ? '' : ' broke'}`);
    const what = el('div', 'casewhat');
    what.append(el('span', `mark ${c.ok ? 'ok' : 'bad'}`, c.ok ? '✓' : '✗'), el('span', 'casename', c.case));
    const tags = el('span', 'tags');
    if (c.promise) tags.append(el('span', 'tag', `promise ${c.promise}`));
    if (c.by === 'developer') tags.append(el('span', 'tag yours', 'your case'));
    if (c.overruled) tags.append(el('span', 'tag yours', 'overruled by you'));
    const how = el('span', `tag ${c.how}`, c.how === 'run' ? 'ran in the app' : 'read in the code');
    if (c.how === 'run' && c.run) how.dataset.tip = `Ran in the change's own app (${c.run.where === 'playground' ? `Playground${c.run.state ? `, state “${c.run.state}”` : ''}` : `page ${c.run.page ?? '/'}`}${c.run.api?.length ? `, with ${c.run.api.length} faked API answer${c.run.api.length > 1 ? 's' : ''}` : ''})`;
    tags.append(how);
    what.append(tags);
    line.append(what, el('div', 'casefound', c.ok ? `→ ${c.found}` : `→ ${c.found}  (should: ${c.expected})`));
    if (c.overruled) line.append(el('div', 'casefound', `Overruled: ${c.overruled.note}`));
    // A case that expected the wrong thing: the developer can overrule it (a held-back change then reaches Review).
    if (!c.ok && !c.overruled && (item.status === 'held-back' || item.status === 'proposed')) {
      const index = r.cases.indexOf(c);
      what.append(button('overrule', 'This case is wrong: overrule it (say why). With nothing else broken, the change goes to Review.', undefined, { type: 'overrule', id: item.id, index }));
    }
    cases.append(line);
  }
  box.append(cases);
  if (r.fixes.length) {
    box.append(el('div', 'logichead', 'To fix'));
    const fixes = el('ul', 'fixes');
    for (const f of r.fixes) fixes.append(el('li', undefined, f));
    box.append(fixes);
  }
  // Your own cases: one per line; the logic checker tries each against what the change means.
  box.append(el('div', 'logichead', 'Your cases'));
  const area = el('textarea', 'casesinput');
  area.placeholder = 'One case per line, e.g. “Two quick clicks shouldn’t leave it in the wrong mode”';
  area.value = typedCases.get(item.id) ?? '';
  area.rows = 2;
  area.addEventListener('input', () => typedCases.set(item.id, area.value));
  const check = iconButton('play', 'Check these cases: the logic checker tries each one (uses your plan)');
  const checking = item.checking;
  check.disabled = !!checking?.progress;
  check.addEventListener('click', () => {
    const list = area.value.split('\n').map((l) => l.trim()).filter(Boolean);
    if (!list.length) return area.focus();
    typedCases.delete(item.id);
    vscode.postMessage({ type: 'cases', id: item.id, cases: list });
  });
  const add = el('div', 'casesadd');
  add.append(area, tray(el('div', 'buttons')));
  add.lastElementChild!.append(check);
  box.append(add);
  if (checking?.progress) box.append(el('div', 'casesnote', checking.progress));
  if (checking?.error) box.append(el('div', 'casesnote bad', checking.error));
  return box;
}

/**
 * A picture in the proof, or the same Playground live (running with the proposal's changes on top, in its own app):
 * click the designs, change their states, press their buttons, before approving.
 */
function drawPicture(item: ReviewItem, e: NonNullable<ReviewItem['evidence']>[number]): HTMLElement {
  const live = e.card ? item.live?.[e.card] : undefined;
  const box = el('div', `picture${live?.url && liveFull.has(live.url) ? ' fullview' : ''}`);
  if (e.card) {
    const bar = tray(el('div', 'picturebar'));
    if (live?.url) {
      // Fit (every design at once, like the picture) or actual size (move around by scrolling).
      const actual = liveActual.has(live.url);
      const zoom = iconButton(actual ? 'fitMap' : 'zoomIn', actual ? 'Fit: see every design at once' : 'Actual size: as big as in the app (scroll to move around)');
      const url = live.url;
      zoom.addEventListener('click', () => {
        if (liveActual.has(url)) liveActual.delete(url);
        else liveActual.add(url);
        drawDetail(item);
      });
      // Full screen: it fills the Review tab (Esc, or the button again, brings it back).
      const full = liveFull.has(url);
      const fullButton = iconButton(full ? 'restore' : 'maximize', full ? 'Back to its place in Review (Esc)' : 'Full screen: fill the Review tab with it');
      fullButton.addEventListener('click', () => toggleFull(item, url));
      bar.append(zoom, fullButton);
    }
    if (live) bar.append(button('close', 'Back to the picture: stop showing it live', undefined, { type: 'unlive', id: item.id, card: e.card }));
    else bar.append(button('board', item.status === 'proposed' ? 'Try it live: the Playground running with these changes (nothing changes in your files until you approve)' : 'Try it live: the Playground running as your files are now', undefined, { type: 'live', id: item.id, card: e.card }));
    box.append(bar);
  }
  if (live?.url) {
    let frame = liveFrames.get(live.url);
    if (!frame) {
      frame = el('div', 'livebox');
      const iframe = el('iframe');
      iframe.src = live.url;
      iframe.title = `${e.title}, live`;
      frame.append(iframe);
      liveFrames.set(live.url, frame);
      // The page is as big as its board (the Playground says, once drawn; till then, a usual screen); fitted, it's
      // shrunk to the box's width (clicks still land right).
      const size = { w: 1400, h: 900 };
      const url = live.url;
      let told = false;
      window.addEventListener('message', (m: MessageEvent<{ source?: string; type?: string; w?: number; h?: number }>) => {
        if (m.source !== iframe.contentWindow || m.data?.source !== 've-preview-page' || m.data.type !== 'size' || told) return;
        // (Only its first size: a page as tall as its window would grow with the frame without end.)
        told = true;
        size.w = Math.max(480, Math.min(4000, m.data.w ?? size.w));
        size.h = Math.max(240, Math.min(3000, m.data.h ?? size.h));
        liveFits.get(url)?.();
      });
      const fit = () => {
        const actual = liveActual.has(url);
        const full = liveFull.has(url);
        // Fitted: the whole page in view (in full screen, both ways); at actual size, the box scrolls.
        const scale = actual ? 1 : Math.min(1, frame!.clientWidth / size.w, full ? frame!.clientHeight / size.h : 1);
        // At actual size the page is the box's size and scrolls itself (the wheel lands in it, not in the box). Fitted,
        // it's the picture's size shrunk (in full screen also filling the rest of the box, so no empty band shows).
        iframe.style.width = actual ? '100%' : `${Math.max(size.w, full ? frame!.clientWidth / scale : 0)}px`;
        iframe.style.height = actual ? '100%' : `${Math.max(size.h, full ? frame!.clientHeight / scale : 0)}px`;
        iframe.style.transform = scale < 1 ? `scale(${scale})` : '';
        frame!.style.height = full ? '' : `${Math.round(size.h * scale)}px`;
        frame!.classList.toggle('actual', actual);
      };
      if (e.src) {
        const probe = new Image();
        probe.onload = () => {
          size.w = probe.naturalWidth || size.w;
          size.h = probe.naturalHeight || size.h;
          fit();
        };
        probe.src = e.src;
      }
      new ResizeObserver(fit).observe(frame);
      liveFits.set(url, fit);
    }
    box.append(frame);
    requestAnimationFrame(() => liveFits.get(live.url!)?.());
  } else if (live?.error) {
    const warn = el('div', 'warn');
    warn.append(el('b', undefined, 'It couldn’t be shown live:'), el('div', undefined, live.error));
    box.append(warn);
  } else if (live?.progress) {
    box.append(el('div', 'liveprogress', live.progress));
  }
  if (e.src && !live?.url) {
    const img = el('img');
    img.src = e.src;
    img.alt = e.title;
    box.append(img);
  }
  return box;
}

/** Live Playgrounds: kept between redraws, so they don't load again each time Review refreshes. */
const liveFrames = new Map<string, HTMLElement>();
/** How each fits its box (again when the box or the zoom changes). */
const liveFits = new Map<string, () => void>();
/** Live Playgrounds shown at actual size (the others are fitted). */
const liveActual = new Set<string>();
/** Live Playgrounds filling the Review tab. */
const liveFull = new Set<string>();

function toggleFull(item: ReviewItem, url: string) {
  if (liveFull.has(url)) liveFull.delete(url);
  else {
    liveFull.clear();
    liveFull.add(url);
  }
  drawDetail(item);
}

// Esc brings a full-screen Playground back to its place.
addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || !liveFull.size) return;
  liveFull.clear();
  const item = current?.items.find((i) => i.id === current?.selected);
  if (item) drawDetail(item);
});

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
  if (e.data?.type !== 'show') return;
  show(e.data);
  // Its checks just ended with failures: the window opens by itself.
  const ask = e.data.askBypass ? e.data.items.find((i) => i.id === e.data.askBypass) : undefined;
  if (ask) askBypass(ask);
  const plan = e.data.askPlan ? e.data.items.find((i) => i.id === e.data.askPlan) : undefined;
  if (plan) askPlan(plan);
});
vscode.postMessage({ type: 'ready' });
