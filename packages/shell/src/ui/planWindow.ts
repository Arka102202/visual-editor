// The window with a finished change's test cases, before anything runs: what the change means, the checks that apply
// (each with why; untick to skip), the scenarios that try to break it (untick to skip, edit what each expects), room
// for the developer's own, and Run or "send without any checks". Taking anything out needs a reason, kept with the
// change. Shared by the session tab and Review. Plain DOM.

import { addStyles, el } from './dom';
import { iconButton } from './buttons';

/** A plan as the window shows it (from checkPlan.ts's CheckPlan). */
export interface PlanView {
  means: string[];
  looksOnly: boolean;
  checks: { id: string; title: string; why: string; use: boolean; always?: boolean }[];
  cases: { case: string; expected: string; how: 'run' | 'traced'; use: boolean }[];
}

/** What the developer decided (checkPlan.ts's PlanEdits). */
export interface PlanChoice {
  checks: Record<string, boolean>;
  cases: { use: boolean; expected?: string }[];
  added: string[];
  reason?: string;
  skipAll?: boolean;
}

addStyles(`
  .pw-veil { position: fixed; inset: 0; background: #0008; display: flex; align-items: center; justify-content: center; z-index: 100; padding: 16px; }
  .pw-box { background: var(--vscode-editorWidget-background, var(--vscode-editor-background)); color: var(--vscode-foreground); border: 1px solid var(--vscode-panel-border, #8884); border-radius: 6px; width: min(760px, 100%); max-height: min(860px, 100%); display: flex; flex-direction: column; box-shadow: 0 10px 40px #0008; }
  .pw-head { padding: 14px 16px 4px; font-weight: 600; font-size: 14px; }
  .pw-sub { padding: 0 16px 8px; opacity: .75; font-size: 12px; line-height: 1.45; }
  .pw-body { overflow-y: auto; padding: 0 16px 8px; flex: 1; min-height: 0; }
  .pw-h { font-size: 11px; font-weight: 600; letter-spacing: .05em; text-transform: uppercase; opacity: .6; margin: 12px 0 6px; }
  .pw-means { margin: 0; padding-left: 20px; font-size: 13px; line-height: 1.5; }
  .pw-row { display: flex; gap: 8px; align-items: flex-start; padding: 6px 8px; border: 1px solid var(--vscode-panel-border, #8883); border-radius: 4px; margin-bottom: 6px; }
  .pw-row.off { opacity: .55; }
  .pw-row input[type=checkbox] { margin-top: 3px; flex: none; }
  .pw-main { flex: 1; min-width: 0; }
  .pw-title { font-weight: 600; }
  .pw-why { font-size: 12px; opacity: .8; margin-top: 2px; }
  .pw-tag { font-size: 10px; padding: 0 6px; border-radius: 8px; border: 1px solid currentColor; opacity: .75; margin-left: 6px; white-space: nowrap; font-weight: 400; }
  .pw-exp { display: flex; gap: 6px; align-items: center; margin-top: 4px; font-size: 12px; }
  .pw-exp span { opacity: .7; flex: none; }
  .pw-exp input, .pw-add textarea, .pw-reason textarea { flex: 1; width: 100%; box-sizing: border-box; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, #8884); border-radius: 3px; padding: 4px 6px; font: inherit; }
  .pw-add textarea, .pw-reason textarea { resize: vertical; }
  .pw-reason { padding: 8px 16px 0; }
  .pw-foot { display: flex; gap: 8px; justify-content: flex-end; align-items: center; padding: 10px 16px 14px; }
  .pw-foot .hint { flex: 1; font-size: 12px; opacity: .7; }
  .pw-foot button:disabled { opacity: .4; cursor: default; }
`);

/** Opens the window for a plan; `run`: what the developer decided, when they press Run (or send without checks). */
export function openPlan(title: string, plan: PlanView, run: (choice: PlanChoice) => void) {
  document.querySelector('.pw-veil')?.remove();
  const veil = el('div', 'pw-veil');
  const box = el('div', 'pw-box');
  box.append(
    el('div', 'pw-head', `Test cases for “${title}”`),
    el('div', 'pw-sub', 'Nothing has run yet. Untick what doesn’t apply, change what a scenario should expect, add your own, then Run. Whatever you take out needs a reason, kept with the change.'),
  );
  const body = el('div', 'pw-body');
  if (plan.looksOnly || plan.means.length) body.append(el('div', 'pw-h', 'What this change means'));
  if (plan.looksOnly && !plan.means.length) body.append(el('div', 'pw-why', 'Looks only: nothing about how it behaves should change.'));
  else if (plan.means.length) {
    const means = el('ol', 'pw-means');
    for (const m of plan.means) means.append(el('li', undefined, m));
    body.append(means);
  }

  const checkTicks = new Map<string, HTMLInputElement>();
  body.append(el('div', 'pw-h', `Checks (${plan.checks.filter((c) => c.use).length} of ${plan.checks.length})`));
  for (const c of plan.checks) {
    const row = el('label', 'pw-row');
    const tick = el('input');
    tick.type = 'checkbox';
    tick.checked = c.use;
    checkTicks.set(c.id, tick);
    const main = el('div', 'pw-main');
    const name = el('div', 'pw-title', c.title);
    if (c.always) name.append(el('span', 'pw-tag', 'always planned'));
    main.append(name, el('div', 'pw-why', c.why));
    row.append(tick, main);
    row.classList.toggle('off', !c.use);
    tick.addEventListener('change', () => (row.classList.toggle('off', !tick.checked), update()));
    body.append(row);
  }

  const caseTicks: HTMLInputElement[] = [];
  const caseExpects: HTMLInputElement[] = [];
  body.append(el('div', 'pw-h', `Scenarios that try to break it (${plan.cases.length})`));
  if (!plan.cases.length) body.append(el('div', 'pw-why', 'None: no code changed. Add your own below if you want some.'));
  for (const c of plan.cases) {
    const row = el('div', 'pw-row');
    const tick = el('input');
    tick.type = 'checkbox';
    tick.checked = c.use;
    caseTicks.push(tick);
    const main = el('div', 'pw-main');
    const name = el('div', 'pw-title', c.case);
    name.append(el('span', 'pw-tag', c.how === 'run' ? 'tried in the app' : 'read in the code'));
    const exp = el('div', 'pw-exp');
    const input = el('input');
    input.value = c.expected;
    input.title = 'What it should do: change it if the planner got it wrong';
    caseExpects.push(input);
    exp.append(el('span', undefined, 'Should:'), input);
    main.append(name, exp);
    row.append(tick, main);
    row.classList.toggle('off', !c.use);
    tick.addEventListener('change', () => (row.classList.toggle('off', !tick.checked), update()));
    body.append(row);
  }

  body.append(el('div', 'pw-h', 'Your own scenarios'));
  const add = el('div', 'pw-add');
  const added = el('textarea');
  added.rows = 2;
  added.placeholder = 'One per line, e.g. “Two projects edited in the same minute: the tile still shows one of them”';
  add.append(added);
  body.append(add);

  const reason = el('div', 'pw-reason');
  const why = el('textarea');
  why.rows = 2;
  why.placeholder = 'Why take those out? (needed when you untick anything, or send it without checks)';
  reason.append(why);

  const hint = el('span', 'hint');
  const close = iconButton('close', 'Close: nothing runs yet (open it again from the change)');
  const skip = iconButton('overrule', 'Send it without any checks (say why above): it goes to Review marked so');
  const go = iconButton('play', 'Run these checks', { cls: 'primary' });
  const tookOut = () => [...checkTicks.entries()].some(([id, t]) => plan.checks.find((c) => c.id === id)?.use && !t.checked) || caseTicks.some((t, i) => plan.cases[i].use && !t.checked);
  const update = () => {
    const needWhy = tookOut() && !why.value.trim();
    go.disabled = needWhy;
    reason.hidden = !tookOut() && !why.value.trim() && !reason.dataset.shown;
    hint.textContent = needWhy ? 'Say why you took those out, to run.' : '';
  };
  why.addEventListener('input', update);
  close.addEventListener('click', () => veil.remove());
  const choice = (skipAll: boolean): PlanChoice => ({
    checks: Object.fromEntries([...checkTicks].map(([id, t]) => [id, t.checked])),
    cases: caseTicks.map((t, i) => ({ use: t.checked, expected: caseExpects[i].value })),
    added: added.value.split('\n').map((l) => l.trim()).filter(Boolean),
    ...(why.value.trim() ? { reason: why.value.trim() } : {}),
    ...(skipAll ? { skipAll: true } : {}),
  });
  go.addEventListener('click', () => {
    if (go.disabled) return;
    veil.remove();
    run(choice(false));
  });
  skip.addEventListener('click', () => {
    if (!why.value.trim()) {
      reason.dataset.shown = '1';
      reason.hidden = false;
      why.focus();
      return;
    }
    veil.remove();
    run(choice(true));
  });
  const foot = el('div', 'pw-foot');
  foot.append(hint, close, skip, go);
  box.append(body, reason, foot);
  veil.append(box);
  document.body.append(veil);
  update();
}
