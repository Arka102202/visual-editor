// The window with a finished change's test cases, before anything runs: what the change means, every check that will
// run (what it does, why it's there) and every scenario (what it tries, what it should do, how it's tried). Only the
// buttons needed to change them: don't run one (or put it back), edit what a scenario should do, add a scenario; then
// Run, or skip all checks. Whatever is taken out needs a reason, asked once and kept with the change. Shared by the
// session tab and Review. Plain DOM.

import { addStyles, el } from './dom';
import { iconButton } from './buttons';

/** A plan as the window shows it (from checkPlan.ts's CheckPlan). */
export interface PlanView {
  means: string[];
  looksOnly: boolean;
  checks: { id: string; title: string; why: string; does?: string; use: boolean; always?: boolean }[];
  /** `detail`: how it's tried, in words (its steps in the app), when it's tried in the app. */
  cases: { case: string; expected: string; how: 'run' | 'traced'; use: boolean; detail?: string }[];
}

/** What the developer decided (checkPlan.ts's PlanEdits). */
export interface PlanChoice {
  checks: Record<string, boolean>;
  cases: { use: boolean; expected?: string }[];
  added: (string | { case: string; expected?: string })[];
  reason?: string;
  skipAll?: boolean;
}

addStyles(`
  .pw-veil { position: fixed; inset: 0; background: #0008; display: flex; align-items: center; justify-content: center; z-index: 100; padding: 16px; }
  .pw-box { background: var(--vscode-editorWidget-background, var(--vscode-editor-background)); color: var(--vscode-foreground); border: 1px solid var(--vscode-panel-border, #8884); border-radius: 6px; width: min(820px, 100%); max-height: min(900px, 100%); display: flex; flex-direction: column; box-shadow: 0 10px 40px #0008; }
  .pw-head { padding: 14px 16px 4px; font-weight: 600; font-size: 14px; }
  .pw-sub { padding: 0 16px 8px; opacity: .75; font-size: 12px; line-height: 1.45; }
  .pw-body { overflow-y: auto; padding: 0 16px 8px; flex: 1; min-height: 0; }
  .pw-h { display: flex; align-items: center; gap: 8px; font-size: 11px; font-weight: 600; letter-spacing: .05em; text-transform: uppercase; opacity: .7; margin: 14px 0 6px; }
  .pw-h span { flex: 1; }
  .pw-means { margin: 0; padding-left: 20px; font-size: 13px; line-height: 1.5; }
  .pw-row { display: flex; gap: 8px; align-items: flex-start; padding: 7px 8px; border: 1px solid var(--vscode-panel-border, #8883); border-radius: 4px; margin-bottom: 6px; }
  .pw-row.off { opacity: .5; }
  .pw-row.off .pw-title { text-decoration: line-through; }
  .pw-main { flex: 1; min-width: 0; }
  .pw-title { font-weight: 600; }
  .pw-line { font-size: 12px; opacity: .85; margin-top: 3px; line-height: 1.4; }
  .pw-line b { font-weight: 600; opacity: .8; }
  .pw-tag { font-size: 10px; padding: 0 6px; border-radius: 8px; border: 1px solid currentColor; opacity: .75; margin-left: 6px; white-space: nowrap; font-weight: 400; }
  .pw-tools { display: flex; gap: 2px; flex: none; }
  .pw-row input, .pw-reason textarea { width: 100%; box-sizing: border-box; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, #8884); border-radius: 3px; padding: 4px 6px; font: inherit; font-size: 12px; margin-top: 4px; }
  .pw-reason { padding: 8px 16px 0; }
  .pw-reason textarea { resize: vertical; }
  .pw-foot { display: flex; gap: 8px; justify-content: flex-end; align-items: center; padding: 10px 16px 14px; }
  .pw-foot .hint { flex: 1; font-size: 12px; opacity: .75; }
  .pw-foot button:disabled { opacity: .4; cursor: default; }
`);

/** Opens the window for a plan; `run`: what the developer decided, when they press Run (or skip all checks). */
export function openPlan(title: string, plan: PlanView, run: (choice: PlanChoice) => void) {
  document.querySelector('.pw-veil')?.remove();
  const veil = el('div', 'pw-veil');
  const box = el('div', 'pw-box');
  box.append(
    el('div', 'pw-head', `Test cases for “${title}”`),
    el('div', 'pw-sub', 'This is everything that will be checked. Nothing has run yet: take out what doesn’t apply (✕), change what a scenario should do (✏), add your own (＋), then Run (▶).'),
  );
  const body = el('div', 'pw-body');
  if (plan.looksOnly || plan.means.length) body.append(el('div', 'pw-h', 'What this change means'));
  if (plan.looksOnly && !plan.means.length) body.append(el('div', 'pw-line', 'Looks only: nothing about how it behaves should change.'));
  else if (plan.means.length) {
    const means = el('ol', 'pw-means');
    for (const m of plan.means) means.append(el('li', undefined, m));
    body.append(means);
  }

  // A row that can be taken out (✕) and put back (↩).
  const toggleable = (row: HTMLElement, tools: HTMLElement, start: boolean, what: string, onChange: () => void) => {
    let on = start;
    const slot = el('span');
    tools.append(slot);
    const draw = () => {
      row.classList.toggle('off', !on);
      const b = iconButton(on ? 'close' : 'undo', on ? `Don’t run this ${what}` : `Put this ${what} back`);
      b.addEventListener('click', () => {
        on = !on;
        draw();
        onChange();
      });
      slot.replaceChildren(b);
    };
    draw();
    return { get on() { return on; } };
  };

  const checks = new Map<string, { on: boolean }>();
  const shownChecks = plan.checks.filter((c) => c.use || c.always);
  const notPlanned = plan.checks.filter((c) => !c.use && !c.always);
  body.append(el('div', 'pw-h', `Checks that will run (${shownChecks.length})`));
  for (const c of shownChecks) {
    const row = el('div', 'pw-row');
    const main = el('div', 'pw-main');
    const name = el('div', 'pw-title', c.title);
    if (c.always) name.append(el('span', 'pw-tag', 'always planned'));
    main.append(name);
    if (c.does) main.append(el('div', 'pw-line', c.does));
    main.append(el('div', 'pw-line', `Why: ${c.why}`));
    const tools = el('div', 'pw-tools');
    row.append(main, tools);
    checks.set(c.id, toggleable(row, tools, true, 'check', update));
    body.append(row);
  }
  if (notPlanned.length) {
    // Left out by the planner (with why): can be added.
    const h = el('div', 'pw-h');
    h.append(el('span', undefined, `Left out by the planner (${notPlanned.length})`));
    body.append(h);
    for (const c of notPlanned) {
      const row = el('div', 'pw-row');
      const main = el('div', 'pw-main');
      main.append(el('div', 'pw-title', c.title), el('div', 'pw-line', `Left out: ${c.why}`));
      const tools = el('div', 'pw-tools');
      row.append(main, tools);
      let on = false;
      const add = () => {
        tools.replaceChildren();
        const b = iconButton(on ? 'close' : 'add', on ? 'Don’t run this check after all' : 'Run this check too');
        b.addEventListener('click', () => ((on = !on), add(), update()));
        tools.append(b);
        row.classList.toggle('off', !on);
      };
      checks.set(c.id, { get on() { return on; } });
      add();
      body.append(row);
    }
  }

  const cases: { on: boolean; expected: () => string }[] = [];
  const caseHead = el('div', 'pw-h');
  caseHead.append(el('span', undefined, `Scenarios that try to break it (${plan.cases.length})`));
  body.append(caseHead);
  if (!plan.cases.length) body.append(el('div', 'pw-line', 'None from the planner (no code changed). Add your own with ＋ if you want some.'));
  for (const c of plan.cases) {
    const row = el('div', 'pw-row');
    const main = el('div', 'pw-main');
    const name = el('div', 'pw-title', c.case);
    name.append(el('span', 'pw-tag', c.how === 'run' ? 'tried in the app' : 'read in the code'));
    const should = el('div', 'pw-line');
    let expected = c.expected;
    const drawShould = () => {
      should.replaceChildren(el('b', undefined, 'Should: '), document.createTextNode(expected));
    };
    drawShould();
    main.append(name, should);
    if (c.detail) main.append(el('div', 'pw-line', `How: ${c.detail}`));
    const tools = el('div', 'pw-tools');
    const editB = iconButton('note', 'Edit what it should do');
    editB.addEventListener('click', () => {
      const input = el('input');
      input.value = expected;
      should.replaceChildren(el('b', undefined, 'Should: '), input);
      input.focus();
      const done = () => ((expected = input.value.trim() || expected), drawShould(), update());
      input.addEventListener('keydown', (e) => (e.key === 'Enter' ? done() : e.key === 'Escape' ? drawShould() : undefined));
      input.addEventListener('blur', done);
    });
    tools.append(editB);
    row.append(main, tools);
    const t = toggleable(row, tools, c.use, 'scenario', update);
    cases.push({ get on() { return t.on; }, expected: () => expected });
    body.append(row);
  }

  // Their own scenarios: what to try, and what it should do.
  const added: { row: HTMLElement; what: HTMLInputElement; should: HTMLInputElement }[] = [];
  const addB = iconButton('add', 'Add a scenario of your own');
  caseHead.append(addB);
  const addRow = () => {
    const row = el('div', 'pw-row');
    const main = el('div', 'pw-main');
    const what = el('input');
    what.placeholder = 'What to try, e.g. “Two projects edited in the same minute”';
    const should = el('input');
    should.placeholder = 'What it should do, e.g. “The tile still shows one of them”';
    main.append(el('div', 'pw-title', 'Your scenario'), what, should);
    const tools = el('div', 'pw-tools');
    const remove = iconButton('close', 'Remove this scenario');
    const entry = { row, what, should };
    remove.addEventListener('click', () => (row.remove(), added.splice(added.indexOf(entry), 1), update()));
    tools.append(remove);
    row.append(main, tools);
    added.push(entry);
    caseHead.after(...[row]);
    // (New ones come right under the heading, where they're seen.)
    what.focus();
    what.addEventListener('input', update);
  };
  addB.addEventListener('click', addRow);

  const reason = el('div', 'pw-reason');
  const why = el('textarea');
  why.rows = 2;
  why.placeholder = 'Why take those out? (kept with the change)';
  reason.append(why);
  reason.hidden = true;

  const hint = el('span', 'hint');
  const close = iconButton('close', 'Close: nothing runs yet (open it again from the change)');
  const skip = iconButton('overrule', 'Skip all checks: send it without any (say why); it goes to Review marked so');
  const go = iconButton('play', 'Run these checks', { cls: 'primary' });
  const tookOut = () => shownChecks.some((c) => !checks.get(c.id)!.on) || cases.some((c, i) => plan.cases[i].use && !c.on);
  let skipping = false;
  function update() {
    const needWhy = (tookOut() || skipping) && !why.value.trim();
    if (tookOut() || skipping) reason.hidden = false;
    go.disabled = !skipping && needWhy;
    const runs = [...checks.values()].filter((c) => c.on).length + cases.filter((c) => c.on).length + added.filter((a) => a.what.value.trim()).length;
    hint.textContent = skipping ? (why.value.trim() ? 'Press ▶ to send it without any checks.' : 'Say why it goes without checks.') : needWhy ? 'Say why you took those out, then Run.' : `${runs} will run.`;
  }
  why.addEventListener('input', update);
  close.addEventListener('click', () => veil.remove());
  skip.addEventListener('click', () => {
    skipping = !skipping;
    skip.classList.toggle('on', skipping);
    update();
    why.focus();
  });
  go.addEventListener('click', () => {
    if (go.disabled || (skipping && !why.value.trim())) return why.focus();
    veil.remove();
    run({
      checks: Object.fromEntries([...checks].map(([id, c]) => [id, c.on])),
      cases: cases.map((c) => ({ use: c.on, expected: c.expected() })),
      added: added.filter((a) => a.what.value.trim()).map((a) => ({ case: a.what.value.trim(), expected: a.should.value.trim() })),
      ...(why.value.trim() ? { reason: why.value.trim() } : {}),
      ...(skipping ? { skipAll: true } : {}),
    });
  });
  const foot = el('div', 'pw-foot');
  foot.append(hint, close, skip, go);
  box.append(body, reason, foot);
  veil.append(box);
  document.body.append(veil);
  update();
}
