import assert from 'node:assert/strict';
import test from 'node:test';
import { applyEdits, asItIs, BUILT_IN_CHECKS, choicesText, planPrompt, planView, progressOf, readPlan, type AvailableCheck } from '../src/hub/checkPlan';

const available: AvailableCheck[] = [{ id: 'check_types', title: 'Check TypeScript', description: 'Type errors.', always: true }, { id: 'check_variant_files', title: 'Check the preview setup', description: 'Preview files.' }, ...BUILT_IN_CHECKS];

test('check plans: the planner is asked which checks apply (always-run ones marked), besides what the change means', () => {
  const prompt = planPrompt(['A dashboard'], [{ path: 'src/A.tsx', before: 'a', after: 'b' }], available, undefined, ['Two at once']);
  assert.match(prompt, /Also choose which of Visual Editor's checks apply[\s\S]*- "check_types" \(Check TypeScript\) \[always run\]: Type errors\.\n- "check_variant_files"[\s\S]*- "looks_same"/);
  assert.match(prompt, /"checks": \[\{"id": a check's id, "use": true or false, "why": "…", "page": "\/…" for looks_same\}\]/);
  assert.match(prompt, /The developer's own cases[^\n]*\n- Two at once/);
});

test('check plans: read from the planner; it can\'t leave out an always-run check; "looks the same" needs a page', () => {
  const reply = JSON.stringify({ looksOnly: false, means: ['Shows the latest project'], cases: [{ case: 'Search', expected: 'filters', found: 'filters', ok: true }], fixes: [], verdict: 'PASSED', checks: [{ id: 'check_types', use: false, why: 'No' }, { id: 'check_variant_files', use: false, why: 'No preview files changed' }, { id: 'pictures', use: true, why: 'It changes how ProjectList looks' }, { id: 'looks_same', use: true, why: 'w' }] });
  const plan = readPlan(reply, available, 3, 't');
  assert.ok(typeof plan !== 'string');
  assert.deepEqual(plan.checks.map((c) => [c.id, c.use, c.why]), [['check_types', true, 'No'], ['check_variant_files', false, 'No preview files changed'], ['pictures', true, 'It changes how ProjectList looks'], ['looks_same', false, 'w']]);
  assert.deepEqual([plan.revision, plan.means, plan.cases.map((c) => [c.case, c.use])], [3, ['Shows the latest project'], [['Search', true]]]);
  assert.match(readPlan('nope', available, 1) as string, /didn't give a verdict/);
});

test('check plans: the developer\'s changes: unticked (with why), expectations edited, their own added, or no checks at all', () => {
  const plan = readPlan(JSON.stringify({ means: ['m'], cases: [{ case: 'A', expected: 'a', found: 'a', ok: true }, { case: 'B', expected: 'b', found: 'b', ok: true }], verdict: 'PASSED', checks: [{ id: 'pictures', use: true }] }), available, 1, 't') as Exclude<ReturnType<typeof readPlan>, string>;
  const same = applyEdits(plan, asItIs(plan));
  assert.deepEqual(same, plan, 'as it is: unchanged');
  assert.equal(choicesText(plan), undefined);
  assert.match(applyEdits(plan, { ...asItIs(plan), checks: { ...asItIs(plan).checks, pictures: false } }) as string, /Say why you took those out/);
  const edited = applyEdits(plan, { checks: { ...asItIs(plan).checks, pictures: false }, cases: [{ use: false }, { use: true, expected: 'B, twice' }], added: ['  C  ', ''], reason: 'Not needed' });
  assert.ok(typeof edited !== 'string');
  const { does, ...pictures } = edited.checks.find((c) => c.id === 'pictures')!;
  assert.deepEqual(pictures, { id: 'pictures', title: 'Pictures in the Playground', why: 'Not chosen by the planner.', use: false, skipped: 'Not needed' });
  assert.match(does ?? '', /^Draws each previewable component/, 'what it does, for the developer');
  assert.deepEqual(edited.cases.map((c) => [c.case, c.use, c.expected, c.by, !!c.added, c.skipped]), [['A', false, 'a', 'checker', false, 'Not needed'], ['B', true, 'B, twice', 'developer', true, undefined], ['C', true, '', 'developer', true, undefined]]);
  assert.equal(choicesText(edited), 'Check skipped: Pictures in the Playground\nScenario skipped: A\nScenario added: B (expects: B, twice)\nScenario added: C\nWhy: Not needed');
  assert.match(applyEdits(plan, { ...asItIs(plan), skipAll: true }) as string, /Say why it should go without any checks/);
  const none = applyEdits(plan, { ...asItIs(plan), skipAll: true, reason: 'Trying it' });
  assert.equal(choicesText(none as typeof plan), 'Sent without any checks, by the developer. Why: Trying it');
});

test('check plans: the window shows how each scenario is tried; a run\'s live list starts with what was approved', () => {
  const reply = JSON.stringify({ means: ['m'], verdict: 'PASSED', checks: [{ id: 'pictures', use: true, why: 'Looks' }], cases: [
    { case: 'Search for pay', expected: 'only payments', found: 'f', ok: true, run: { where: 'playground', card: 'react:component:src/P/index.tsx#ProjectList', state: 'default', steps: [{ do: 'type', target: { role: 'textbox', name: 'Search projects' }, text: 'pay' }], expect: [{ see: 'payments' }, { notSee: 'order-service', within: { selector: '[data-grid]' } }] } },
    { case: 'Empty list', expected: 'a message', found: 'f', ok: true },
  ] });
  const plan = readPlan(reply, available, 1, 't') as Exclude<ReturnType<typeof readPlan>, string>;
  const view = planView(plan);
  assert.equal(view.cases[0].detail, 'In ProjectList\'s Playground (state default): type “pay” into the box “Search projects”; then “payments” is shown, and “order-service” isn\'t shown in “[data-grid]”.');
  assert.deepEqual([view.cases[0].how, view.cases[1].how, view.cases[1].detail], ['run', 'traced', undefined]);
  assert.match(view.checks.find((c) => c.id === 'check_types')?.does ?? '', /Type errors/);
  const run = applyEdits(plan, { ...asItIs(plan), cases: [{ use: true }, { use: false }], added: [{ case: 'Two at once', expected: 'one shows' }], reason: 'Not needed' });
  assert.ok(typeof run !== 'string');
  assert.deepEqual(run.cases.at(-1), { case: 'Two at once', expected: 'one shows', found: '', ok: false, by: 'developer', how: 'traced', use: true, added: true });
  assert.deepEqual(progressOf(run).map((i) => [i.id, i.kind, i.state]), [['check:check_types', 'check', 'waiting'], ['check:pictures', 'check', 'waiting'], ['case:0', 'scenario', 'waiting'], ['case:1', 'scenario', 'waiting'], ['skipped:0', 'scenario', 'skipped']]);
});
