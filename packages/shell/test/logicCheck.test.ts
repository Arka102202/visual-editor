import assert from 'node:assert/strict';
import test from 'node:test';
import { logicPrompt, logicText, otherState, overrule, readRun, readSecondLook, readVerdict, runCases, secondLookPrompt, settle, type LogicVerdict } from '../src/hub/logicCheck';

test('logic check: first what the change means, then cases to break it; the developer\'s cases are tried too', () => {
  const prompt = logicPrompt(['Make the dot bigger'], [{ path: 'src/A.tsx', before: 'old', after: 'new' }, { path: 'src/B.tsx', before: null, after: 'b' }, { path: 'src/C.tsx', before: 'c', after: null }], ['Rapid double click']);
  assert.match(prompt, /What the developer asked for, in their words:\n- Make the dot bigger/);
  assert.match(prompt, /The developer's own cases \(try every one[^\n]*\n- Rapid double click/);
  assert.match(prompt, /=== src\/A\.tsx \(changed\)\n--- before\nold\n--- after\nnew/);
  assert.match(prompt, /=== src\/B\.tsx \(new\)\n--- after\nb/);
  assert.match(prompt, /=== src\/C\.tsx \(removed\)\n--- before\nc/);
  assert.match(prompt, /Step 1, what the change means for how things behave[\s\S]*API calls[\s\S]*states that shouldn't be possible but could crash[\s\S]*Step 2, try to break each promise/);
  // Only the developer's cases, against promises worked out before.
  const only = logicPrompt(['Ask before deleting'], [], ['Enter right away'], { means: ['Confirming deletes'] });
  assert.match(only, /1\. Confirming deletes\n\nTry only the developer's cases above/);
  assert.doesNotMatch(only, /Step 1/);
});

test('logic check: the report is read from the reply; any case that broke makes it a problem', () => {
  const reply = 'Here:\n{"looksOnly": false, "means": ["Delete asks first"], "cases": [{"case": "Click Delete", "promise": 1, "expected": "a question", "found": "a question", "ok": true, "by": "checker"}, {"case": "Enter at once", "promise": 1, "expected": "no delete", "found": "deletes", "ok": false, "by": "developer"}], "fixes": [], "verdict": "PASSED"}';
  const r = readVerdict(reply);
  assert.ok(typeof r !== 'string');
  assert.equal(r.passed, false, 'a broken case is a problem, whatever the summary says');
  assert.deepEqual(r.means, ['Delete asks first']);
  assert.deepEqual(r.cases.map((c) => [c.case, c.ok, c.by, c.how, c.promise]), [['Click Delete', true, 'checker', 'traced', 1], ['Enter at once', false, 'developer', 'traced', 1]]);
  assert.deepEqual(r.fixes, ['Enter at once: expected no delete, but deletes.'], 'a fix for each broken case, when none was given');
  assert.match(logicText(['Ask first'], r), /^Asked: Ask first\nWhat it means:\n1\. Delete asks first\nCases tried:\n✓ Click Delete: a question\n✗ Enter at once \(the developer’s case\): expected no delete, but deletes\nTo fix:/);
  const looks = readVerdict('{"looksOnly": true, "means": [], "cases": [{"case": "Click", "expected": "toggles", "found": "toggles", "ok": true}], "verdict": "PASSED"}');
  assert.ok(typeof looks !== 'string' && looks.passed && looks.looksOnly);
  assert.match(logicText(['Bigger'], looks as never), /What it means: looks only; nothing about behaviour should change\./);
  assert.match(readVerdict('{"verdict":"PASSED","cases":[]}') as string, /didn't say which cases it tried/);
  assert.match(readVerdict('Looks good to me') as string, /didn't give a verdict/);
  assert.match(readVerdict('{"verdict":"MAYBE"}') as string, /no clear verdict/);
});

test('logic check: told where cases can be run, it gives steps; only cases that can really run keep them', () => {
  const places = { cards: [{ id: 'react:component:src/T/index.tsx#ThemeToggle', name: 'ThemeToggle', designs: [{ id: 'default', name: 'Default', inUse: true }], states: ['light', 'dark'], shows: { light: 'buttons: "Switch to dark mode"', dark: 'buttons: "Switch to light mode"' } }], pages: [{ path: '/', shows: '<html data-theme="light">' }, { path: '/settings' }] };
  const prompt = logicPrompt(['Bigger'], [], [], undefined, places);
  assert.match(prompt, /Cases can also be run for real[\s\S]*the Playground of ThemeToggle \(card "react:component:src\/T\/index\.tsx#ThemeToggle"\): designs "default" \(Default, in use\); states "light", "dark"\n  when it opens in state "light": buttons: "Switch to dark mode"\n  when it opens in state "dark": buttons: "Switch to light mode"\n- the app's page "\/"\n  when it opens: <html data-theme="light">\n- the app's page "\/settings"\n\("When it opens"/);
  assert.match(prompt, /"run": \{…\} or null/);
  assert.doesNotMatch(logicPrompt(['Bigger'], []), /run for real/, 'nowhere to run: not mentioned');
  const run = readRun({ where: 'playground', card: 'c', state: 'light', api: [{ method: 'get', path: '/api/x' }, { path: 'no method' }], steps: [{ do: 'click', target: { role: 'button', name: 'Switch' } }, { do: 'click', target: {} }, { do: 'fly' }], expect: [{ attr: { target: { selector: 'html' }, name: 'class', value: null } }, { see: '' }] });
  assert.deepEqual(run, { where: 'playground', card: 'c', state: 'light', api: [{ method: 'GET', path: '/api/x' }], steps: [{ do: 'click', target: { role: 'button', name: 'Switch' } }], expect: [{ attr: { target: { selector: 'html' }, name: 'class', value: null } }] });
  assert.equal(readRun({ where: 'app', steps: [], expect: [] }), undefined, 'nothing to look for');
  assert.equal(readRun({ where: 'playground', expect: [{ see: 'x' }] }), undefined, 'no card to start from');
  assert.equal(readRun(null), undefined);
  const v = readVerdict(`{"looksOnly": true, "means": [], "cases": [{"case": "Click in light mode", "expected": "dark", "found": "dark", "ok": true, "run": ${JSON.stringify(run)}}], "verdict": "PASSED"}`);
  assert.ok(typeof v !== 'string' && v.cases[0].run?.card === 'c');
});

test('logic check: cases run for real win over the reading; steps that couldn\'t be done keep the reading', async () => {
  const run = { where: 'app' as const, page: '/', steps: [], expect: [{ see: 'x' }] };
  const v: LogicVerdict = {
    passed: true,
    looksOnly: true,
    means: [],
    fixes: [],
    cases: [
      { case: 'Click in light mode', expected: 'turns dark', found: 'turns dark', ok: true, by: 'checker', how: 'traced', run },
      { case: 'Missing button', expected: 'shown', found: 'shown', ok: true, by: 'checker', how: 'traced', run: { ...run, page: '/gone' } },
      { case: 'Bigger', expected: '48px', found: '48px', ok: true, by: 'checker', how: 'traced' },
    ],
  };
  const out = await runCases(v, async (spec) => (spec.page === '/gone' ? { ok: false, ran: false, found: 'couldn\'t find the button “X” on the page' } : { ok: false, ran: true, found: 'clicked the button “Switch”: “html” has class="light", not "dark"' }));
  assert.equal(out.passed, false, 'the run broke it');
  assert.deepEqual(out.cases.map((c) => [c.ok, c.how]), [[false, 'run'], [true, 'traced'], [true, 'traced']]);
  assert.match(out.cases[1].found, /shown \(couldn't be run: couldn't find the button/);
  assert.deepEqual(out.fixes, ['Click in light mode: run in the app, expected turns dark, but clicked the button “Switch”: “html” has class="light", not "dark".']);
  // A case the reading thought broken, which works when run: it passes, and the old fixes go.
  const fixed = await runCases({ ...v, passed: false, fixes: ['Guessed wrong'], cases: [{ ...v.cases[0], ok: false, found: 'stays light' }] }, async () => ({ ok: true, ran: true, found: 'clicked: “html” has class="dark"' }));
  assert.deepEqual([fixed.passed, fixed.fixes, fixed.cases[0].how], [true, [], 'run']);
});

test('logic check: a case that looks in one state for another state\'s data mixed up the states; it isn\'t the change', () => {
  // ProjectList: order-service and payments are the "default" state's projects; "many" has service-1 … service-12.
  const byState = { default: 'Your projects order-service payments + New project', many: 'Your projects service-1 service-2 service-12 + New project', empty: 'No projects yet' };
  assert.equal(otherState(['order-service', 'payments'], 'many', byState), 'default');
  assert.equal(otherState(['order-service'], 'many', byState), 'default');
  assert.equal(otherState(['service-1'], 'default', byState), 'many');
  assert.equal(otherState(['order-service', 'service-1'], 'empty', byState), undefined, 'not all in one other state');
  assert.equal(otherState(['archived'], 'many', byState), undefined, 'nowhere: the change may have lost it');
  assert.equal(otherState([], 'many', byState), undefined);
});

test('logic check: a second look when the run and the reading disagree; the developer can overrule a case', () => {
  const run = { where: 'playground' as const, card: 'c', design: 'dashboard', state: 'default', steps: [{ do: 'type' as const, target: { selector: 'input[type=search]' }, text: 'pay' }], expect: [{ see: 'payments' }, { notSee: 'order-service' }] };
  const reading: LogicVerdict = { passed: true, looksOnly: false, means: ['Search filters the cards'], fixes: [], cases: [
    { case: 'Search filters the cards', expected: 'only payments', found: 'the grid filters by name', ok: true, by: 'checker', how: 'traced', run },
    { case: 'Delete asks first', expected: 'a dialog', found: 'a dialog', ok: true, by: 'checker', how: 'traced' },
  ] };
  const ran: LogicVerdict = { ...reading, passed: false, fixes: ['Search filters the cards: run in the app, expected only payments, but “order-service” is still shown.'], cases: [{ ...reading.cases[0], ok: false, how: 'run', found: 'typed “pay”: “order-service” is still shown' }, reading.cases[1]] };
  const prompt = secondLookPrompt(['A dashboard'], [{ path: 'src/A.tsx', before: 'a', after: 'b' }], [{ case: 'Search filters the cards', expected: 'only payments', found: ran.cases[0].found, run, after: 'Last edited order-service payments' }]);
  assert.match(prompt, /Case 1: Search filters the cards\nExpected: only payments\nRun: \{"where":"playground"[\s\S]*Found: typed “pay”[\s\S]*The page's text at the end: Last edited order-service payments[\s\S]*=== src\/A\.tsx\nb/);
  // The case's fault: the reading stands (it works), with a note; the fix it made goes.
  const looked = readSecondLook('{"cases": [{"case": "Search filters the cards", "fault": "case", "why": "order-service is also in the Last edited tile"}]}');
  assert.ok(typeof looked !== 'string');
  const fair = settle(ran, reading, looked);
  assert.deepEqual([fair.passed, fair.fixes, fair.cases[0].ok, fair.cases[0].how], [true, [], true, 'traced']);
  assert.match(fair.cases[0].found, /run in the app: typed “pay”: “order-service” is still shown; looked at again, it was the case, not the change: order-service is also in the Last edited tile/);
  // The change's fault: it stays broken, with why.
  const real = settle(ran, reading, new Map([['Search filters the cards', { fault: 'change' as const, why: 'the grid ignores the search' }]]));
  assert.deepEqual([real.passed, real.cases[0].ok], [false, false]);
  assert.match(real.cases[0].found, /looked at again: the grid ignores the search/);
  assert.match(readSecondLook('nope') as string, /couldn't be read/);
  // Overruled by the developer: it passes when nothing else broke.
  const over = overrule(real, [0], 'The tile rightly shows it');
  assert.deepEqual([over.passed, over.cases[0].overruled?.note], [true, 'The tile rightly shows it']);
});
