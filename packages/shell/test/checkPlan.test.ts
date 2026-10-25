import assert from 'node:assert/strict';
import test from 'node:test';
import { applyEdits, asItIs, BUILT_IN_CHECKS, choicesText, planPrompt, readPlan, type AvailableCheck } from '../src/hub/checkPlan';

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
  assert.deepEqual(edited.checks.find((c) => c.id === 'pictures'), { id: 'pictures', title: 'Pictures in the Playground', why: 'Not chosen by the planner.', use: false, skipped: 'Not needed' });
  assert.deepEqual(edited.cases.map((c) => [c.case, c.use, c.expected, c.by, !!c.added, c.skipped]), [['A', false, 'a', 'checker', false, 'Not needed'], ['B', true, 'B, twice', 'developer', true, undefined], ['C', true, '', 'developer', true, undefined]]);
  assert.equal(choicesText(edited), 'Check skipped: Pictures in the Playground\nScenario skipped: A\nScenario added: B (expects: B, twice)\nScenario added: C\nWhy: Not needed');
  assert.match(applyEdits(plan, { ...asItIs(plan), skipAll: true }) as string, /Say why it should go without any checks/);
  const none = applyEdits(plan, { ...asItIs(plan), skipAll: true, reason: 'Trying it' });
  assert.equal(choicesText(none as typeof plan), 'Sent without any checks, by the developer. Why: Trying it');
});
