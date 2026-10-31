import assert from 'node:assert/strict';
import test from 'node:test';
import { cleanupPrompt, deletable, readCleanup, type SessionSummary } from '../src/hub/sessionCleanup';

const s = (id: string, state: string, files: number, more: Partial<SessionSummary> = {}): SessionSummary => ({ id, title: `Session ${id}`, state, asked: ['Make it compact'], versions: files ? 2 : 0, files, updatedAt: '2026-10-20T10:00:00.000Z', ...more });
const list = [s('a', 'discarded', 2), s('b', 'sent to Review', 3, { outcome: 'applied' }), s('c', 'being worked on', 4), s('d', 'no changes yet', 0), s('e', 'held back', 2)];

test('clean-up: the helper reads summaries (not code), and is told which it must never suggest', () => {
  const p = cleanupPrompt(list, '2026-10-31');
  assert.match(p, /Today is 2026-10-31/);
  assert.match(p, /- id b: “Session b”\n  state: sent to Review \(its proposal: applied\); last changed 2026-10-20; 2 version\(s\), 3 file\(s\)/);
  assert.match(p, /- id c: [^\n]*\n[^\n]*\n[^\n]*\n  \(unfinished, with work in it: never suggest it\)/);
  assert.match(p, /don't read any files/);
});

test('clean-up: its answer marks only sessions it was shown, never one with work still in it (planted), each with why', () => {
  const answer = 'Here:\n{"delete": [{"id": "a", "why": "a discarded try"}, {"id": "b"}, {"id": "c", "why": "old"}, {"id": "e", "why": "held"}, {"id": "zzz", "why": "?"}, {"id": "d", "why": "empty"}]}';
  const which = readCleanup(answer, list) as Map<string, string>;
  assert.deepEqual([...which], [['a', 'a discarded try'], ['b', 'not needed any more'], ['d', 'empty']], 'c and e have work in them; zzz isn\'t a session');
  assert.deepEqual(list.map((x) => [x.id, deletable(x)]), [['a', true], ['b', true], ['c', false], ['d', true], ['e', false]]);
  assert.deepEqual([...(readCleanup('{"delete": []}', list) as Map<string, string>)], [], 'keeping them all is fine');
  assert.match(readCleanup('I think a and b', list) as string, /didn't answer with a list/);
});
