import assert from 'node:assert/strict';
import test from 'node:test';
import { logicPrompt, logicText, readVerdict } from '../src/hub/logicCheck';

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
