// The Agents section in Visual Editor's side panel: what each plugin gives Claude, as coloured badges (Agent, Skill,
// Tool), each with a pop-over in plain words; an agent at work shows its round and a Stop button. Plain DOM.

import type { AgentsEntry, FromAgents, JobResult, ToAgents } from '../agentsMessages';
import { addStyles, ago, el } from '../ui/dom';
import { iconButton, installTips, tray } from '../ui/buttons';

declare function acquireVsCodeApi(): { postMessage(message: FromAgents): void };
const vscode = acquireVsCodeApi();

/** What each kind is, in plain words (the pop-over says it first). */
const KINDS: Record<AgentsEntry['kind'], { label: string; means: string }> = {
  agent: { label: 'Agent', means: 'Does a job for you: a worker makes the change, a checker tests it (up to 3 rounds), and only a change that passes reaches Review.' },
  skill: { label: 'Skill', means: 'Written know-how Claude reads before it works on something, so it does things your project’s way.' },
  tool: { label: 'Tool', means: 'A quick look-up or check Claude can use while it works. It never changes your files.' },
  helper: { label: 'Helper', means: 'Claude, run by Visual Editor itself for one small job when its step comes (no button). It only reads.' },
};

addStyles(`
  /* A side-panel section: its own background, and it scrolls (the shared page style is a fixed editor page). */
  html, body { height: auto; min-height: 100%; overflow-x: hidden; overflow-y: auto; background: var(--vscode-sideBar-background, transparent); }
  body { padding: 4px 0 10px; font-size: 13px; }
  .status { display: flex; align-items: center; gap: 8px; margin: 4px 12px 8px; padding: 6px 8px; border-radius: 4px; background: color-mix(in srgb, var(--vscode-editorWarning-foreground, #cca700) 14%, transparent); }
  .status span { flex: 1; min-width: 0; }
  .group { display: flex; align-items: baseline; gap: 6px; padding: 8px 12px 2px; font-weight: 600; }
  .group .count { font-weight: 400; opacity: .6; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .row { display: flex; align-items: center; gap: 8px; padding: 3px 12px 3px 20px; cursor: default; outline: none; min-height: 22px; }
  .row:hover, .row:focus-visible { background: var(--vscode-list-hoverBackground); }
  .row .names { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  .row .title { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  /* Its name as Claude shows it in the chat (visual-editor:variant-rules → variant-rules), to match the two. */
  .row .cname, .pop .cname { font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; opacity: .55; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .badge { flex: none; font-size: 10px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; padding: 1px 6px; border-radius: 9px; border: 1px solid var(--c); color: var(--c); background: color-mix(in srgb, var(--c) 16%, transparent); }
  .badge.agent { --c: var(--vscode-charts-purple, #b180d7); }
  .badge.skill { --c: var(--vscode-charts-blue, #3794ff); }
  .badge.tool { --c: var(--vscode-charts-green, #89d185); }
  .badge.helper { --c: var(--vscode-charts-orange, #d18616); }
  .row .buttons { display: flex; gap: 2px; }
  .row .buttons button { padding: 1px 3px; }
  .result { display: flex; align-items: baseline; gap: 6px; padding: 1px 12px 1px 30px; font-size: 12px; cursor: pointer; outline: none; }
  .result:hover, .result:focus-visible { background: var(--vscode-list-hoverBackground); }
  .result .ask { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; opacity: .85; }
  .result .when { flex: none; opacity: .55; font-size: 11px; }
  .mark { flex: none; font-weight: 700; width: 1em; text-align: center; }
  .mark.ok { color: var(--vscode-testing-iconPassed, #73c991); }
  .mark.bad { color: var(--vscode-errorForeground, #f48771); }
  .mark.off { opacity: .6; }
  .resultbox { margin: 2px 12px 6px 30px; padding: 6px 8px; border-left: 2px solid var(--vscode-charts-purple, #b180d7); font-size: 12px; line-height: 1.45; background: color-mix(in srgb, var(--vscode-charts-purple, #b180d7) 7%, transparent); }
  .resultbox .head { margin: 0 0 4px; }
  .resultbox .steps { margin: 0 0 6px; padding-left: 18px; }
  .resultbox .steps li { margin-bottom: 3px; }
  .resultbox .proof { margin-bottom: 6px; opacity: .9; }
  .progress { margin: -2px 12px 4px 20px; padding-left: 8px; font-size: 11px; opacity: .75; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .progress::before { content: '↳ '; }
  .working { flex: none; font-size: 11px; color: var(--vscode-charts-yellow, #cca700); white-space: nowrap; }
  .working::before { content: ''; display: inline-block; width: 7px; height: 7px; margin-right: 5px; border-radius: 50%; background: currentColor; animation: pulse 1.2s ease-in-out infinite; }
  @keyframes pulse { 50% { opacity: .25; } }
  .row { cursor: pointer; }
  .about { margin: 0 12px 6px 20px; padding: 6px 8px; border-left: 2px solid var(--c, #888); background: color-mix(in srgb, var(--c, #888) 8%, transparent); line-height: 1.45; font-size: 12px; }
  .about.agent { --c: var(--vscode-charts-purple, #b180d7); }
  .about.skill { --c: var(--vscode-charts-blue, #3794ff); }
  .about.tool { --c: var(--vscode-charts-green, #89d185); }
  .about.helper { --c: var(--vscode-charts-orange, #d18616); }
  .about p { margin: 0 0 4px; }
  .about p:last-child { margin: 0; }
  .about .means, .pop .means { opacity: .75; }
  .about code { font-family: var(--vscode-editor-font-family, monospace); }
  .pop { position: fixed; z-index: 20; max-width: 300px; padding: 10px 12px; border-radius: 6px; line-height: 1.45; background: var(--vscode-editorHoverWidget-background, #252526); color: var(--vscode-editorHoverWidget-foreground, inherit); border: 1px solid var(--vscode-editorHoverWidget-border, #454545); box-shadow: 0 4px 14px #0006; }
  .pop .head { display: flex; align-items: center; gap: 8px; font-weight: 600; margin-bottom: 6px; }
  .pop p { margin: 0 0 6px; }
  .pop .means { opacity: .75; font-size: 12px; }
  .pop .ask { font-size: 12px; opacity: .85; }
  .pop .ask code { font-family: var(--vscode-editor-font-family, monospace); }
`);
installTips();

const pop = el('div', 'pop');
pop.hidden = true;
document.body.append(pop);

/** What an entry is and does, in plain words (in the pop-over, or under its row). */
function aboutOf(e: AgentsEntry): HTMLElement[] {
  const out = [el('p', undefined, e.summary), el('p', 'means', KINDS[e.kind].means)];
  const named = el('p', 'means', e.kind === 'helper' ? 'In Claude’s chat: it doesn’t show there (Visual Editor runs it on its own).' : 'In Claude’s chat it shows as ');
  if (e.kind !== 'helper') named.append(el('code', undefined, e.claudeName));
  out.push(named);
  // An agent's two parts, each its own Claude agent.
  if (e.kind === 'agent') {
    const parts = el('p', 'means', 'Inside it: ');
    parts.append(el('code', undefined, `${e.name}-worker`), document.createTextNode(' makes the change, then '), el('code', undefined, `${e.name}-checker`), document.createTextNode(' checks it.'));
    out.push(parts);
  }
  if (e.job?.running) out.push(el('p', 'ask', `Working now (round ${e.job.round} of ${e.job.rounds}) on: “${e.job.request}”`));
  else if (e.job) out.push(el('p', 'ask', `Last job (${e.job.status}): “${e.job.request}”`));
  if (e.kind === 'agent') {
    const ask = el('p', 'ask', 'To use it, ask Claude: ');
    ask.append(el('code', undefined, `use the ${e.title} agent: …`));
    out.push(ask);
  }
  return out;
}

/** The pop-over for an entry, next to its row: only when the section has room for it (else a click shows it inline). */
function showPop(row: HTMLElement, e: AgentsEntry) {
  if (open.has(e.title)) return;
  pop.replaceChildren();
  const head = el('div', 'head');
  head.append(el('span', `badge ${e.kind}`, KINDS[e.kind].label), el('span', undefined, e.title));
  pop.append(head, ...aboutOf(e));
  pop.hidden = false;
  const r = row.getBoundingClientRect();
  const fitsBelow = r.bottom + 4 + pop.offsetHeight <= innerHeight - 4;
  const fitsAbove = r.top - 4 - pop.offsetHeight >= 4;
  if (!fitsBelow && !fitsAbove) return void (pop.hidden = true);
  pop.style.top = `${fitsBelow ? r.bottom + 4 : r.top - pop.offsetHeight - 4}px`;
  pop.style.left = `${Math.max(4, Math.min(innerWidth - pop.offsetWidth - 4, r.left + 16))}px`;
}

/** Entries whose description is open under their row (a click opens or closes it). */
const open = new Set<string>();
let last: ToAgents | undefined;
/** The pop-over waits for the mouse to rest on a row (about a second), so passing over the list doesn't flash it. */
const POP_DELAY_MS = 900;
let popTimer: ReturnType<typeof setTimeout> | undefined;
const hidePop = () => {
  clearTimeout(popTimer);
  popTimer = undefined;
  pop.hidden = true;
};
addEventListener('scroll', hidePop, true);
document.addEventListener('mouseleave', hidePop);

function draw(m: ToAgents) {
  last = m;
  hidePop();
  document.body.replaceChildren(pop);
  if (m.status) {
    const status = el('div', 'status');
    const action = m.status.action;
    const go = iconButton(action === 'connect' ? 'plug' : 'add', m.status.tip);
    go.addEventListener('click', () => vscode.postMessage({ type: action }));
    status.append(el('span', undefined, m.status.text), go);
    document.body.append(status);
  }
  for (const g of m.groups) {
    const group = el('div', 'group');
    const counts = (['agent', 'skill', 'tool'] as const).map((k) => [k, g.items.filter((i) => i.kind === k).length] as const).filter(([, n]) => n);
    group.append(el('span', undefined, g.name), el('span', 'count', counts.map(([k, n]) => `${n} ${KINDS[k].label.toLowerCase()}${n === 1 ? '' : 's'}`).join(' · ')));
    document.body.append(group);
    for (const e of g.items) {
      const row = el('div', 'row');
      row.tabIndex = 0;
      const names = el('span', 'names');
      names.append(el('span', 'title', e.title), el('span', 'cname', e.kind === 'helper' ? 'runs by itself' : e.claudeName.replace(/^visual-editor:/, '')));
      row.append(el('span', `badge ${e.kind}`, KINDS[e.kind].label), names);
      if (e.job?.running) {
        row.append(el('span', 'working', `${e.job.status} · ${e.job.round}/${e.job.rounds}`));
        const id = e.job.id;
        const watch = iconButton('console', `Watch ${e.title} work: ${/terminal/.test(e.job.by) ? 'its terminal' : 'what it does and says, step by step'}`);
        watch.addEventListener('click', () => vscode.postMessage({ type: 'watch', job: id }));
        const stop = iconButton('stop', `Stop ${e.title}: it stops at its next step`);
        stop.addEventListener('click', () => vscode.postMessage({ type: 'stop', job: id }));
        row.append(tray(el('span', 'buttons')));
        row.lastElementChild!.append(watch, stop);
      } else if (e.kind === 'agent') {
        // Run it: it asks what you want, then works in the background (or in a terminal you can watch and talk to).
        const name = e.name;
        const bg = iconButton('play', `Run ${e.title} in the background: it asks what you want, then works quietly; the result comes to Review`);
        bg.addEventListener('click', () => vscode.postMessage({ type: 'run', agent: name, way: 'background' }));
        const term = iconButton('terminal', `Run ${e.title} in a terminal: watch it work, and talk to it`);
        term.addEventListener('click', () => vscode.postMessage({ type: 'run', agent: name, way: 'terminal' }));
        row.append(tray(el('span', 'buttons')));
        row.lastElementChild!.append(bg, term);
      }
      row.setAttribute('aria-expanded', String(open.has(e.title)));
      row.addEventListener('mouseenter', () => {
        clearTimeout(popTimer);
        popTimer = setTimeout(() => showPop(row, e), POP_DELAY_MS);
      });
      row.addEventListener('mouseleave', hidePop);
      // A click (or Enter) opens its description under it, at any size of the section.
      const toggle = (ev: Event) => {
        if ((ev.target as Element).closest('button')) return;
        if (open.has(e.title)) open.delete(e.title);
        else open.add(e.title);
        if (last) draw(last);
      };
      row.addEventListener('click', toggle);
      row.addEventListener('keydown', (ev) => (ev.key === 'Enter' || ev.key === ' ') && toggle(ev));
      document.body.append(row);
      // What it is, right under its name (above its jobs, however many there are).
      if (open.has(e.title)) {
        const about = el('div', `about ${e.kind}`);
        about.append(...aboutOf(e));
        document.body.append(about);
      }
      // A run from a button: what it's doing now.
      if (e.job?.running && e.job.progress) document.body.append(el('div', 'progress', e.job.progress));
      // Its last results: how each ended; a click opens what happened and the proof.
      for (const r of e.recent ?? []) document.body.append(...drawResult(r));
    }
  }
}

/** How a job ended: a mark and its colour. */
const ENDED: Record<string, { mark: string; cls: string; words: string }> = {
  passed: { mark: '✓', cls: 'ok', words: 'passed' },
  failed: { mark: '✗', cls: 'bad', words: 'didn’t pass' },
  stopped: { mark: '■', cls: 'off', words: 'stopped' },
  'out of time': { mark: '⏱', cls: 'off', words: 'ran out of time' },
};

/** A finished job: one line (mark, what was asked, round, when), and, opened, its steps, proof and Review. */
function drawResult(r: JobResult): HTMLElement[] {
  const ended = ENDED[r.status] ?? { mark: '•', cls: 'off', words: r.status };
  const line = el('div', 'result');
  line.tabIndex = 0;
  line.append(el('span', `mark ${ended.cls}`, ended.mark), el('span', 'ask', r.request), el('span', 'when', ago(r.at)));
  const key = `job ${r.id}`;
  const toggle = () => {
    if (open.has(key)) open.delete(key);
    else open.add(key);
    if (last) draw(last);
  };
  line.addEventListener('click', toggle);
  line.addEventListener('keydown', (ev) => (ev.key === 'Enter' || ev.key === ' ') && toggle());
  if (!open.has(key)) return [line];
  const box = el('div', 'resultbox');
  box.append(el('p', 'head', `It ${ended.words} in round ${r.round} of ${r.rounds}${r.inReview ? `: ${r.inReview}` : ''}. Started from ${r.by}.`));
  const steps = el('ol', 'steps');
  for (const s of r.steps) {
    const li = el('li');
    li.append(el('b', undefined, `${s.who}: `), document.createTextNode(s.what));
    steps.append(li);
  }
  box.append(steps);
  if (r.proof?.length) {
    const proof = el('div', 'proof');
    for (const p of r.proof) proof.append(el('div', undefined, `${p.mark} ${p.title}`));
    box.append(proof);
  }
  if (r.proposal) {
    const id = r.proposal;
    const inReview = iconButton('proposed', 'Open it in Review: the change, its proof and the pictures, live');
    inReview.addEventListener('click', () => vscode.postMessage({ type: 'review', proposal: id }));
    box.append(tray(el('div', 'buttons')));
    box.lastElementChild!.append(inReview);
  }
  return [line, box];
}

addEventListener('message', (e: MessageEvent<ToAgents>) => {
  if (e.data?.type === 'show') draw(e.data);
});
vscode.postMessage({ type: 'ready' });
