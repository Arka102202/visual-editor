// A run's checks and scenarios, live: each with where it is (waiting, running with a spinner, passed, failed, skipped,
// not run). Shared by Review and the session tab. Plain DOM.

import { addStyles, el } from './dom';

/** One line of the list (drafts.ts's ProgressItem). */
export interface ProgressLine {
  title: string;
  kind: 'check' | 'scenario';
  state: 'waiting' | 'running' | 'passed' | 'failed' | 'done' | 'skipped' | 'not run';
  /** When it started; how long it took (seconds). */
  at?: string;
  took?: number;
}

addStyles(`
  .pg { margin: 8px 0 4px; display: flex; flex-direction: column; gap: 3px; }
  .pg-row { display: flex; align-items: center; gap: 8px; font-size: 12px; line-height: 1.4; }
  .pg-row .pg-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pg-row .pg-kind { font-size: 10px; opacity: .6; flex: none; }
  .pg-row .pg-time { font-size: 11px; opacity: .75; flex: none; font-variant-numeric: tabular-nums; min-width: 64px; text-align: right; }
  .pg-row.waiting, .pg-row.skipped, .pg-row.not-run { opacity: .55; }
  .pg-row.skipped .pg-title { text-decoration: line-through; }
  .pg-mark { width: 14px; flex: none; text-align: center; font-weight: 700; }
  .pg-row.passed .pg-mark, .pg-row.done .pg-mark { color: var(--vscode-testing-iconPassed, #73c991); }
  .pg-row.failed .pg-mark { color: var(--vscode-errorForeground, #f48771); }
  .pg-spin { width: 10px; height: 10px; border: 2px solid currentColor; border-right-color: transparent; border-radius: 50%; display: inline-block; animation: pg-turn .8s linear infinite; }
  @keyframes pg-turn { to { transform: rotate(360deg); } }
`);

const WORDS: Record<ProgressLine['state'], string> = { waiting: 'waiting', running: 'running now', passed: 'passed', failed: 'failed', done: 'done', skipped: 'skipped by you', 'not run': 'not run (stopped earlier)' };

export function drawProgress(items: ProgressLine[]): HTMLElement {
  const box = el('div', 'pg');
  for (const i of items) {
    const row = el('div', `pg-row ${i.state.replace(' ', '-')}`);
    const mark = el('span', 'pg-mark');
    if (i.state === 'running') mark.append(el('span', 'pg-spin'));
    else mark.textContent = { waiting: '○', passed: '✓', done: '✓', failed: '✗', skipped: '–', 'not run': '·' }[i.state];
    row.title = `${i.kind === 'check' ? 'Check' : 'Scenario'}: ${WORDS[i.state]}`;
    // When: how long the running one has gone (counting live), how long the others took.
    const time = el('span', 'pg-time');
    if (i.state === 'running' && i.at) {
      time.dataset.since = i.at;
      time.textContent = `running · ${seconds(Date.now() - Date.parse(i.at))}`;
    } else if (i.took !== undefined) time.textContent = seconds(i.took * 1000);
    row.append(mark, el('span', 'pg-title', i.title), time, el('span', 'pg-kind', i.kind === 'check' ? 'check' : 'scenario'));
    box.append(row);
  }
  return box;
}

const seconds = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
};

// The running one's time counts up by itself.
setInterval(() => {
  for (const t of document.querySelectorAll<HTMLElement>('.pg-time[data-since]')) t.textContent = `running · ${seconds(Date.now() - Date.parse(t.dataset.since!))}`;
}, 1000);
