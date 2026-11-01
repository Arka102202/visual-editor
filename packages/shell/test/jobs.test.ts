import assert from 'node:assert/strict';
import test from 'node:test';
import { current, finished, newJob, nextStep, parseJob, resumable, resumed, started, stopped } from '../src/jobs';

const agent = { name: 'make-previewable', title: 'Make previewable', rounds: 3 };
const at = new Date('2026-11-01T10:00:00.000Z');
const later = new Date('2026-11-01T11:00:00.000Z');

test('jobs: stopped in the middle, it remembers where it was, and resumes there with a new time limit', () => {
  // Stopped at the checker's turn: resumed, the checker's turn again (not the worker's from scratch).
  const checking = { ...newJob(agent, 'Make Card previewable', 'a button', 'j1', at), status: 'checking' as const, round: 2, draft: 'd1' };
  const stop = stopped(checking, 'Stopped.', 'developer', at);
  assert.equal(stop.status, 'stopped');
  assert.equal(stop.stoppedAt, 'checking');
  assert.ok(finished(stop) && resumable(stop));
  assert.match(nextStep(stop), /Stop now/);
  const back = resumed(stop, false, later);
  assert.equal(back.status, 'checking');
  assert.equal(back.round, 2, 'the same round');
  assert.equal(back.draft, 'd1', 'the same draft');
  assert.equal(back.until, new Date(later.getTime() + 20 * 60_000).toISOString(), 'a new time limit from now');
  assert.match(back.history.at(-1)!.what, /^Resumed \(round 2 of 3\)/);
  assert.match(nextStep(back), /Run the checker on draft d1 \(round 2 of 3\)/);
  // Stopped at the worker's turn: the worker's turn again.
  const working = stopped({ ...newJob(agent, 'x', 'a button', 'j2', at), round: 3 }, 'Stopped.', 'developer', at);
  assert.equal(resumed(working, false, later).status, 'working');
  assert.match(nextStep(resumed(working, false, later)), /Run the worker again \(round 3 of 3\)/);
  // Out of time is resumable too; passed and failed aren't.
  const late = current({ ...newJob(agent, 'x', 'a button', 'j3', at), status: 'checking' }, later);
  assert.equal(late.status, 'out of time');
  assert.equal(late.stoppedAt, 'checking');
  assert.ok(resumable(late));
  assert.equal(resumed(late, false, later).status, 'checking');
  assert.ok(!resumable({ ...late, status: 'passed' }) && !resumable({ ...late, status: 'failed' }));
});

test('jobs: one waiting its turn does nothing, keeps no clock, and starts where it should when its turn comes', () => {
  const waiting = { ...newJob(agent, 'Make Card previewable', 'a button', 'w1', at), status: 'waiting' as const };
  assert.ok(!finished(waiting), 'it still counts as at work (it can be stopped)');
  assert.match(nextStep(waiting), /waiting its turn[\s\S]*Do nothing for it now/);
  assert.equal(current(waiting, new Date('2027-01-01T00:00:00.000Z')).status, 'waiting', 'no time limit while it waits');
  const go = started(waiting, later);
  assert.equal(go.status, 'working');
  assert.equal(go.until, new Date(later.getTime() + 20 * 60_000).toISOString(), 'its clock starts when it does');
  // Resumed while every place is taken: it waits, then carries on at the checker's turn where it stopped.
  const stop = stopped({ ...newJob(agent, 'x', 'a button', 'w2', at), status: 'checking' }, 'Stopped.', 'developer', at);
  const queued = resumed(stop, true, later);
  assert.equal(queued.status, 'waiting');
  assert.match(queued.history.at(-1)!.what, /it waits its turn/);
  assert.equal(started(queued, later).status, 'checking');
  // Stopped while waiting: it hadn't started, so resuming starts the worker.
  assert.equal(resumed(stopped(waiting, 'Stopped.', 'developer', at), false, later).status, 'working');
});

test('jobs: what a job keeps for later (how it ran, its card, its Claude conversation, where it stopped) is read back', () => {
  const j = { ...stopped(newJob(agent, 'x', 'a button', 'k1', at), 'Stopped.', 'developer', at), way: 'terminal' as const, card: 'react:component:src/Card.tsx#Card', session: '6f1c2c7e-1f40-4a43-9d8d-0c0a8b3f1a11' };
  const back = parseJob(JSON.stringify(j), 'k1')!;
  assert.deepEqual([back.way, back.card, back.session, back.stoppedAt, back.status], ['terminal', j.card, j.session, 'working', 'stopped']);
  assert.equal(parseJob(JSON.stringify({ ...j, status: 'waiting' }), 'k1')!.status, 'waiting');
  // (Nonsense in the file is left out, not trusted.)
  const odd = parseJob(JSON.stringify({ ...j, way: 'somewhere', stoppedAt: 'elsewhere' }), 'k1')!;
  assert.equal(odd.way, undefined);
  assert.equal(odd.stoppedAt, undefined);
});
