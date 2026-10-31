// A design session's tab: the draft running live in its own app (a card's Playground: every design in every state, or
// one state at a screen size), "What you asked", the versions to go back to, and Done / Discard. It follows the draft:
// each new version shows by itself. You talk to Claude in your own Claude Code chat. Plain DOM, no framework.

import type { FromSession, SessionView, ToSession } from '../sessionMessages';
import { addStyles, ago, el } from '../ui/dom';
import { iconButton, installTips, setIcon, tray, type Icon } from '../ui/buttons';
import { openBypass } from '../ui/bypass';
import { openPlan, type PlanView } from '../ui/planWindow';
import { drawProgress } from '../ui/progress';

declare function acquireVsCodeApi(): { postMessage(message: FromSession): void };
const vscode = acquireVsCodeApi();

addStyles(`
  html, body { height: 100%; }
  body { display: flex; flex-direction: column; margin: 0; padding: 0; overflow: hidden; }
  .top { display: flex; align-items: center; gap: 10px; padding: 8px 14px; border-bottom: 1px solid var(--vscode-panel-border, #8883); min-width: 0; }
  .top h1 { font-size: 14px; margin: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1; min-width: 0; }
  .chip { font-size: 11px; padding: 1px 8px; border-radius: 10px; border: 1px solid currentColor; opacity: .85; white-space: nowrap; }
  .chip.checking { color: var(--vscode-charts-yellow, #cca700); }
  .chip.sent { color: var(--vscode-testing-iconPassed, #73c991); }
  .chip.here { color: var(--vscode-charts-purple, #b180d7); }
  .chip.held { color: var(--vscode-errorForeground, #f48771); }
  /* A coloured chip on a faint wash of its own colour (not the light badge background: its text would barely show). */
  .chip.checking, .chip.sent, .chip.here, .chip.held { opacity: 1; font-weight: 600; background: color-mix(in srgb, currentColor 18%, var(--vscode-editor-background, #1e1e1e)); }
  .body { flex: 1; display: flex; min-height: 0; }
  aside { width: 260px; min-width: 200px; border-right: 1px solid var(--vscode-panel-border, #8883); overflow-y: auto; padding: 10px 14px 20px; }
  .head { font-size: 11px; font-weight: 600; letter-spacing: .05em; text-transform: uppercase; opacity: .6; margin: 12px 0 6px; }
  .head:first-child { margin-top: 2px; }
  .askline { padding: 2px 0 2px 10px; border-left: 2px solid var(--vscode-charts-blue, #3794ff); margin-bottom: 4px; }
  .hint { opacity: .7; font-size: 12px; line-height: 1.45; }
  .heldrow { display: flex; gap: 6px; margin: 6px 0; }
  /* Held back: each failed check in its card, then what can be done, each way next to its button. */
  .failcard { margin: 6px 0; padding: 8px 10px; border-radius: 4px; font-size: 12px; line-height: 1.45; border: 1px solid color-mix(in srgb, var(--vscode-errorForeground, #f48771) 55%, transparent); background: color-mix(in srgb, var(--vscode-errorForeground, #f48771) 8%, var(--vscode-editor-background)); }
  .failtitle { font-weight: 600; color: var(--vscode-errorForeground, #f48771); margin-bottom: 3px; }
  .failwhy { white-space: pre-wrap; max-height: 160px; overflow-y: auto; }
  .failhint { margin-top: 6px; opacity: .8; font-style: italic; }
  .way { display: flex; align-items: flex-start; gap: 8px; margin: 6px 0; font-size: 12px; line-height: 1.45; }
  .way > button, .way > .waymark { flex: none; }
  .waymark { width: 26px; text-align: center; }
  .version { display: flex; align-items: center; gap: 6px; padding: 3px 0; font-size: 12px; }
  .version .v { font-weight: 600; min-width: 28px; }
  .version .when { opacity: .65; flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .version.now .when { opacity: .9; }
  .note { margin: 8px 0; padding: 8px 10px; border-radius: 4px; font-size: 12px; white-space: pre-wrap; max-height: 260px; overflow-y: auto;
    border: 1px solid color-mix(in srgb, var(--vscode-errorForeground, #f48771) 55%, transparent); background: color-mix(in srgb, var(--vscode-errorForeground, #f48771) 10%, var(--vscode-editor-background)); }
  .note.ok { border-color: color-mix(in srgb, var(--vscode-testing-iconPassed, #73c991) 55%, transparent); background: color-mix(in srgb, var(--vscode-testing-iconPassed, #73c991) 10%, var(--vscode-editor-background)); }
  main { flex: 1; display: flex; flex-direction: column; min-width: 0; }
  .bar { display: flex; align-items: center; gap: 6px; padding: 6px 10px; border-bottom: 1px solid var(--vscode-panel-border, #8883); }
  .bar select { background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); border: 1px solid var(--vscode-dropdown-border, #8884); border-radius: 3px; padding: 2px 4px; max-width: 200px; }
  .sep { width: 1px; align-self: stretch; background: var(--vscode-panel-border, #8884); margin: 2px 4px; flex: none; }
  .stage { flex: 1; position: relative; overflow: auto; background: var(--vscode-editorWidget-background, #8881); }
  .stage iframe { border: 0; background: #fff; display: block; }
  .stage.fill iframe { width: 100%; height: 100%; transform-origin: 0 0; }
  .zoomtext { font-size: 12px; opacity: .8; min-width: 38px; text-align: center; font-variant-numeric: tabular-nums; flex: none; }
  .stage:not(.fill) .device { position: absolute; top: 16px; left: 16px; transform-origin: 0 0; box-shadow: 0 0 0 1px #8886, 0 10px 30px #0006; border-radius: 4px; overflow: hidden; }
  .wait { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; opacity: .75; padding: 20px; text-align: center; }
  button.on { background: var(--vscode-toolbar-activeBackground, #8884); }
`);
installTips();

/** Screen sizes to try (width × height, upright), like Preview's. */
const DEVICES: { id: string; icon: Icon; name: string; width: number; height: number }[] = [
  { id: 'phone', icon: 'phone', name: 'Phone', width: 390, height: 844 },
  { id: 'tablet', icon: 'tablet', name: 'Tablet', width: 820, height: 1180 },
  { id: 'laptop', icon: 'laptop', name: 'Laptop', width: 1366, height: 768 },
  { id: 'desktop', icon: 'desktop', name: 'Desktop', width: 1920, height: 1080 },
];

let session: SessionView | undefined;
// What is shown: a card (none: the app's first page), all its designs or one design in one state, at a size.
let card = '';
let mode: 'board' | 'single' | 'page' = 'board';
let design = '';
let stateName = '';
let size: string = 'fill';
let fit = true;
/** How big the page is drawn (1: real size). In Fill it zooms the page inside the frame; at a screen size, the screen. */
let zoom = 1;
const ZOOMS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];

const title = el('h1');
const chip = el('span', 'chip');
const done = iconButton('choose', 'Done: check it (Visual Editor’s checks and the logic check), then send it to Review');
const discard = iconButton('trash', 'Discard this session: its changes are thrown away (nothing in your files changes)');
const forClaude = iconButton('note', 'Claude isn’t connected to Visual Editor here, so it isn’t told about this session: copy a line to paste in your Claude Code chat');
// Several sessions open: Claude works in one (the one looked at last); another can be chosen here.
const workHere = iconButton('focus', 'Work here: make this the session Claude works in (you have others open)');
workHere.addEventListener('click', () => vscode.postMessage({ type: 'workHere' }));
const claudeHere = el('span', 'chip here', 'Claude works here');
claudeHere.title = 'Your messages to Claude go to this session (the one you looked at last)';
forClaude.addEventListener('click', () => vscode.postMessage({ type: 'copyForClaude' }));
done.addEventListener('click', () => vscode.postMessage({ type: 'done' }));
discard.addEventListener('click', () => vscode.postMessage({ type: 'discard' }));
const top = el('div', 'top');
top.append(title, chip, tray(el('div')));
top.insertBefore(claudeHere, chip);
(top.lastElementChild as HTMLElement).append(workHere, forClaude, done, discard);

const aside = el('aside');
const main = el('main');
const bar = tray(el('div', 'bar'));
const stage = el('div', 'stage fill');
const device = el('div', 'device');
const iframe = el('iframe');
iframe.title = 'This session, live';
const wait = el('div', 'wait');
device.append(iframe);
stage.append(device, wait);
main.append(bar, stage);
const body = el('div', 'body');
body.append(aside, main);
document.body.append(top, body);

// The bar: board or one state; which card, design and state; screen size and zoom to fit.
const boardButton = iconButton('board', 'Every design in every state (the Playground)');
const singleButton = iconButton('single', 'One design in one state, at a screen size');
boardButton.addEventListener('click', () => ((mode = 'board'), show()));
singleButton.addEventListener('click', () => ((mode = 'single'), show()));
// A page session: the page in the app, at its address (with real data), besides its Playground.
const pageButton = iconButton('preview', 'The page in the app, at its address');
pageButton.addEventListener('click', () => ((mode = 'page'), show()));
const cardSelect = el('select');
cardSelect.title = 'Which component';
cardSelect.addEventListener('change', () => ((card = cardSelect.value), (design = ''), (stateName = ''), show()));
const designSelect = el('select');
designSelect.title = 'Which design';
designSelect.addEventListener('change', () => ((design = designSelect.value), show()));
const stateSelect = el('select');
stateSelect.title = 'Which state (fixed data)';
stateSelect.addEventListener('change', () => ((stateName = stateSelect.value), show()));
const sizeButtons = new Map<string, HTMLButtonElement>();
const fill = iconButton('fill', 'Fill: the page takes all the space');
sizeButtons.set('fill', fill);
fill.addEventListener('click', () => ((size = 'fill'), layout()));
for (const d of DEVICES) {
  const b = iconButton(d.icon, `${d.name}: ${d.width} × ${d.height}`);
  sizeButtons.set(d.id, b);
  b.addEventListener('click', () => ((size = d.id), layout()));
}
const fitButton = iconButton('fitMap', 'Zoom to fit (off: real size, scroll to see it all)', { cls: 'on' });
fitButton.addEventListener('click', () => ((fit = !fit), (zoom = fit ? zoom : 1), layout()));
const reload = iconButton('reload', 'Draw it again');
reload.addEventListener('click', () => {
  const src = iframe.src;
  iframe.src = 'about:blank';
  requestAnimationFrame(() => (iframe.src = src));
});
const viewSep = el('span', 'sep');
const sizeSep = el('span', 'sep');
const sizeGroup = [sizeSep, ...sizeButtons.values(), fitButton];
const zoomOut = iconButton('zoomOut', 'Zoom out');
const zoomIn = iconButton('zoomIn', 'Zoom in');
const zoomText = el('span', 'zoomtext', '100%');
zoomText.title = 'Zoom (double-click: real size)';
zoomText.addEventListener('dblclick', () => ((zoom = 1), (fit = false), layout()));
const step = (by: number) => {
  const now = shownScale();
  zoom = by > 0 ? (ZOOMS.find((z) => z > now + 0.001) ?? ZOOMS[ZOOMS.length - 1]) : ([...ZOOMS].reverse().find((z) => z < now - 0.001) ?? ZOOMS[0]);
  // (Zooming by hand turns zoom to fit off.)
  fit = false;
  layout();
};
zoomOut.addEventListener('click', () => step(-1));
zoomIn.addEventListener('click', () => step(1));
bar.append(boardButton, singleButton, pageButton, viewSep, cardSelect, designSelect, stateSelect, ...sizeGroup, el('span', 'sep'), zoomOut, zoomText, zoomIn, el('span', 'sep'), reload);

window.addEventListener('message', (e: MessageEvent<ToSession>) => {
  if (e.data?.type !== 'show') return;
  const before = session?.revision;
  session = e.data.session;
  if (!session.cards.some((c) => c.id === card)) {
    card = session.cards[0]?.id ?? '';
    design = '';
    stateName = '';
  }
  drawAside();
  show(before !== undefined && before !== session.revision);
});
new ResizeObserver(() => layout()).observe(stage);
vscode.postMessage({ type: 'ready' });

function drawAside() {
  if (!session) return;
  const s = session;
  title.textContent = s.title;
  chip.className = `chip ${s.status.kind}`;
  // Finished (sent to Review, or discarded): its history, to look at only.
  const ended = s.status.kind === 'sent' || s.status.kind === 'discarded';
  claudeHere.hidden = !s.current || ended;
  // Told by itself: nothing to copy.
  forClaude.hidden = !!s.told || ended;
  workHere.hidden = !!s.current || ended;
  done.hidden = ended;
  discard.hidden = ended;
  chip.textContent = { open: `version ${s.revision}`, planning: 'writing the test cases…', ready: 'test cases ready', checking: 'checking…', sent: 'in Review', held: 'held back', discarded: 'discarded' }[s.status.kind];
  done.disabled = s.status.kind === 'planning' || s.status.kind === 'checking' || ended;
  setIcon(done, 'choose', s.proposal ? 'Done: check it again, then put the changes back into the proposal in Review' : 'Done: write its test cases (you see them, change them, then run them); passing, it goes to Review');
  setIcon(discard, 'trash', s.proposal ? 'Discard this session: the proposal in Review stays as it was' : 'Discard this session: its changes are thrown away (nothing in your files changes)');
  forClaude.disabled = s.status.kind === 'sent';
  discard.disabled = s.status.kind === 'checking' || s.status.kind === 'planning' || s.status.kind === 'sent';
  aside.replaceChildren();
  if (s.status.kind === 'planning') aside.append(el('div', 'note ok', 'Writing the test cases: the check planner reads the change and what you asked (a minute or so). You’ll see them before anything runs.'));
  else if (s.status.kind === 'ready' && s.plan) {
    const plan = s.plan;
    const note = el('div', 'note ok', `Test cases ready: ${plan.checks.filter((c) => c.use).length} checks and ${plan.cases.length} scenarios. Nothing has run yet.`);
    const look = iconButton('preview', 'See the test cases: everything that will be checked (change them, then run them)');
    look.addEventListener('click', () => askPlan(s.title, plan));
    note.append(el('div'), look);
    aside.append(note);
    // As soon as they're written, the window opens (once per plan).
    if (s.checkedAt !== shownFor) {
      shownFor = s.checkedAt;
      askPlan(s.title, plan);
    }
  }
  if (s.status.kind === 'discarded')
    aside.append(el('div', 'note', `Discarded ${new Date(s.status.at).toLocaleString()}. This is its history, to look at only: what you asked and each version. Delete it for good from Memory → Sessions.`));
  if (s.status.kind === 'sent') {
    const note = el('div', 'note ok', s.proposal ? 'The proposal in Review is updated with these changes and their proof. Nothing in your files changes until you approve it there.' : 'Sent to Review with its proof. Nothing in your files changes until you approve it there.');
    const open = iconButton('proposed', 'Open it in Review');
    open.addEventListener('click', () => vscode.postMessage({ type: 'openReview', proposal: (s.status as { proposal: string }).proposal }));
    note.append(el('div'), open);
    aside.append(note);
  } else if (s.status.kind === 'held') {
    const failed = s.failed ?? [];
    aside.append(el('div', 'head', failed.length ? `Held back: ${failed.length === 1 ? '1 check' : `${failed.length} checks`} failed` : 'Not sent'));
    // Each failed check: what it found, in plain words. (Without any: why it stopped, as Visual Editor said it.)
    if (failed.length)
      for (const f of failed) {
        const card = el('div', 'failcard');
        card.append(el('div', 'failtitle', `✗ ${f.title}`), el('div', 'failwhy', f.why));
        const tiny = /(\d[\d,]*) of ([\d,]+) pixels differ/.exec(f.why);
        if (tiny && Number(tiny[1].replace(/,/g, '')) / Number(tiny[2].replace(/,/g, '')) < 0.001)
          card.append(el('div', 'failhint', 'A very small difference: often a clock, an animation or a blinking cursor rather than this change. If so, bypass it.'));
        aside.append(card);
      }
    else aside.append(el('div', 'note', s.status.text));
    // What to do next: each way, with its button.
    aside.append(el('div', 'head', 'What you can do'));
    const way = (button: HTMLElement | undefined, words: string) => {
      const row = el('div', 'way');
      row.append(button ?? el('span', 'waymark', '💬'), el('span', undefined, words));
      aside.append(row);
    };
    way(undefined, failed.length ? 'The change is wrong: tell Claude in your Claude Code chat, e.g. “fix what the checks found”. It sees what failed. Then press Done (✓) again.' : 'Tell Claude in your Claude Code chat, e.g. “fix what stopped it”. It sees why. Then press Done (✓) again.');
    if (failed.length) {
      const bypass = iconButton('overrule', 'Bypass: see the failed checks, and let the wrong ones go (say why)');
      bypass.addEventListener('click', () => askBypass(failed));
      way(bypass, 'The check is wrong, or doesn’t matter for this change: bypass it and say why. It goes to Review marked so.');
    }
    // Or its test cases again: as they are (changed, added to), or new ones written.
    if (s.plan) {
      const plan = s.plan;
      const again = iconButton('preview', 'See its test cases: change them, add your own, and run them again');
      again.addEventListener('click', () => askPlan(s.title, plan));
      way(again, 'Change the test cases (take a check out, with why, or add your own) and run them again.');
    }
    const fresh = iconButton('reload', 'Write new test cases (the check planner reads the change again), then look at them and run them');
    fresh.addEventListener('click', () => vscode.postMessage({ type: 'done' }));
    way(fresh, 'Write new test cases from scratch.');
    // As soon as a check ends with failures, the window opens (once per check).
    if (failed.length && s.checkedAt !== shownFor) {
      shownFor = s.checkedAt;
      askBypass(failed);
    }
  }
  else if (s.status.kind === 'checking') {
    aside.append(el('div', 'note ok', s.status.text));
    if (s.running?.length) aside.append(drawProgress(s.running));
  }
  aside.append(el('div', 'head', 'What you asked'));
  if (s.asked.length) for (const a of s.asked) aside.append(el('div', 'askline', a));
  else
    aside.append(
      el(
        'div',
        'hint',
        s.told
          ? 'Nothing yet. Just tell Claude in your Claude Code chat what you want: it knows this session is open and works in it. Each change shows here by itself.'
          : 'Nothing yet. Claude isn’t connected to Visual Editor here, so it isn’t told about this session: copy the line (the note button above) into your Claude Code chat, then say what you want.',
      ),
    );
  aside.append(el('div', 'head', 'Versions'));
  if (!s.versions.length) aside.append(el('div', 'hint', 'None yet: the first change makes version 1.'));
  for (const v of s.versions) {
    const row = el('div', `version${v.revision === s.revision ? ' now' : ''}`);
    row.append(el('span', 'v', `v${v.revision}`), el('span', 'when', `${v.revision === s.revision ? 'showing · ' : ''}${ago(v.at)} · ${v.files} file${v.files === 1 ? '' : 's'}`));
    // (Not while its checks are written or run: they're for the version shown.)
    if (v.revision !== s.revision && !['sent', 'discarded', 'planning', 'checking'].includes(s.status.kind)) {
      const back = iconButton('undo', `Go back to version ${v.revision} (as a new version: nothing is lost)`);
      back.addEventListener('click', () => vscode.postMessage({ type: 'back', revision: v.revision }));
      row.append(back);
    }
    aside.append(row);
  }
}

/** The check whose failures were shown (the window opens by itself once per check). */
let shownFor: string | undefined;

function askPlan(title: string, plan: PlanView) {
  openPlan(title, plan, (choice) => vscode.postMessage({ type: 'run', choice }));
}

function askBypass(failed: { title: string; why: string }[]) {
  openBypass(failed, (titles, reason) => vscode.postMessage({ type: 'bypass', titles, reason }), 'This session');
}

/** What the frame shows now (`again`: a newer version, drawn again). */
function show(again = false) {
  const s = session;
  if (!s) return;
  const c = s.cards.find((x) => x.id === card);
  // The bar follows what can be chosen.
  cardSelect.replaceChildren(...s.cards.map((x) => new Option(x.label, x.id, false, x.id === card)));
  cardSelect.hidden = s.cards.length < 2;
  if (c && !c.designs.some((d) => d.id === design)) design = (c.designs.find((d) => d.inUse) ?? c.designs[0])?.id ?? '';
  if (c && !c.states.includes(stateName)) stateName = c.states[0] ?? '';
  designSelect.replaceChildren(...(c?.designs ?? []).map((d) => new Option(`${d.name}${d.inUse ? ' (in use)' : ''}`, d.id, false, d.id === design)));
  stateSelect.replaceChildren(...(c?.states ?? []).map((x) => new Option(x, x, false, x === stateName)));
  // The app's page: when there's no component to show yet, or when chosen in a page session.
  const inPage = !c || (mode === 'page' && !!s.page);
  const single = mode === 'single' && !!c && !inPage;
  boardButton.classList.toggle('on', !single && !inPage);
  singleButton.classList.toggle('on', single);
  pageButton.classList.toggle('on', inPage);
  boardButton.hidden = singleButton.hidden = !c;
  pageButton.hidden = !c || !s.page;
  pageButton.dataset.tip = `The page in the app, at ${s.page ?? '/'}`;
  if (inPage) cardSelect.hidden = true;
  viewSep.hidden = !c || (cardSelect.hidden && !single);
  designSelect.hidden = stateSelect.hidden = !single;
  for (const x of sizeGroup) x.hidden = !single && !inPage;
  // (The first thing on the bar needs no line before it.)
  sizeSep.hidden ||= !c && cardSelect.hidden;
  wait.textContent = s.error ? `It can’t be shown: ${s.error}` : s.progress ?? (s.app ? '' : 'Starting…');
  wait.hidden = !wait.textContent;
  device.hidden = !s.app || !!s.error;
  if (!s.app) return;
  const q = new URLSearchParams({ item: c?.id ?? '', ...(single ? { variant: design, state: stateName } : {}), ...(again ? { v: String(s.revision) } : {}) });
  const at = s.page ?? '/';
  const url = !inPage ? `${s.app}/__ve/preview?${q}` : `${s.app}${at}${again ? `${at.includes('?') ? '&' : '?'}ve-v=${s.revision}` : ''}`;
  if (iframe.src !== url) iframe.src = url;
  layout();
}

/** Fill, or a screen size (zoomed to fit unless off). */
function layout() {
  const d = DEVICES.find((x) => x.id === size);
  const fillNow = !d || (mode === 'board' && !!session?.cards.length);
  stage.classList.toggle('fill', fillNow);
  for (const [id, b] of sizeButtons) b.classList.toggle('on', id === (fillNow ? 'fill' : size));
  fitButton.classList.toggle('on', fit);
  fitButton.hidden = fillNow || (mode === 'board' && !!session?.cards.length);
  if (fillNow || !d) {
    // The frame fills the space; the page inside is drawn smaller or bigger (and still scrolls inside).
    device.style.width = device.style.height = '100%';
    device.style.transform = '';
    iframe.style.width = iframe.style.height = `${100 / zoom}%`;
    iframe.style.transform = zoom === 1 ? '' : `scale(${zoom})`;
    zoomText.textContent = `${Math.round(zoom * 100)}%`;
    return;
  }
  iframe.style.transform = '';
  iframe.style.width = `${d.width}px`;
  iframe.style.height = `${d.height}px`;
  device.style.width = `${d.width}px`;
  device.style.height = `${d.height}px`;
  const scale = shownScale();
  device.style.transform = `scale(${scale})`;
  zoomText.textContent = `${Math.round(scale * 100)}%`;
}

/** The size the page is drawn at now: the zoom, or at a screen size with zoom to fit on, what fits. */
function shownScale(): number {
  const d = DEVICES.find((x) => x.id === size);
  const fillNow = !d || (mode === 'board' && !!session?.cards.length);
  if (fillNow || !d || !fit) return zoom;
  return Math.min(1, (stage.clientWidth - 32) / d.width, (stage.clientHeight - 32) / d.height);
}
