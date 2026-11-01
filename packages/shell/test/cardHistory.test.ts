import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Item } from '@visual-editor/contract';
import { cardFiles, cardHistory, historyText } from '../src/cardHistory';
import { commitText, gitHistory } from '../src/gitHistory';
import type { Job } from '../src/jobs';
import type { MemoryEntry } from '../src/memory';
import { dayWords } from '../src/ui/dom';

const card: Item = { id: 'react:Card', map: 'components', kind: 'component', label: 'Card', source: { path: 'src/Card.tsx' } };

test('git history: the commits that touched a card\'s files (newest first, with their lines), and what isn\'t committed yet; none outside git', async () => {
  const root = mkdtempSync(join(tmpdir(), 've-git-'));
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=Ana', '-c', 'user.email=ana@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: root });
  try {
    assert.equal(await gitHistory(root, ['src/Card.tsx']), undefined, 'not in git: nothing known');
    git('init', '-q');
    mkdirSync(join(root, 'src'));
    assert.deepEqual(await gitHistory(root, ['src/Card.tsx']), { commits: [] }, 'in git, before any commit');
    writeFileSync(join(root, 'src/Card.tsx'), 'a\nb\n');
    writeFileSync(join(root, 'src/Other.tsx'), 'x\n');
    git('add', '.');
    git('commit', '-q', '-m', 'Add the card');
    writeFileSync(join(root, 'src/Card.tsx'), 'a\nB\nc\n');
    git('commit', '-q', '-am', 'Show the date first');
    writeFileSync(join(root, 'src/Other.tsx'), 'y\n');
    git('commit', '-q', '-am', 'Not about the card');

    const clean = await gitHistory(root, ['src/Card.tsx']);
    assert.deepEqual(clean?.commits.map((c) => [c.subject, c.author, c.added, c.removed, c.files]), [['Show the date first', 'Ana', 2, 1, ['src/Card.tsx']], ['Add the card', 'Ana', 2, 0, ['src/Card.tsx']]]);
    assert.equal(clean?.uncommitted, undefined, 'all committed');
    assert.match((await commitText(root, clean!.commits[0].hash, ['src/Card.tsx'])) ?? '', /Show the date first[\s\S]*-b\n\+B\n\+c/);
    assert.equal(await commitText(root, 'not; a hash', []), undefined);

    // Changed by hand and a new file in its folder, not committed: one line for both.
    writeFileSync(join(root, 'src/Card.tsx'), 'a\nB\nc\nd\n');
    writeFileSync(join(root, 'src/Card.mock.ts'), 'm\n');
    utimesSync(join(root, 'src/Card.tsx'), new Date('2026-10-30T10:00:00Z'), new Date('2026-10-30T10:00:00Z'));
    utimesSync(join(root, 'src/Card.mock.ts'), new Date('2026-10-31T10:00:00Z'), new Date('2026-10-31T10:00:00Z'));
    const now = await gitHistory(root, ['src/Card.tsx', 'src/Card.mock.ts']);
    assert.deepEqual(now?.uncommitted, { at: '2026-10-31T10:00:00.000Z', added: 1, removed: 0, files: ['src/Card.tsx', 'src/Card.mock.ts'], created: ['src/Card.mock.ts'] });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('card history: Review\'s changes, agents\' jobs on it, commits and uncommitted changes, newest first, in words; nothing about other cards', () => {
  const by = { kind: 'assistant' as const, name: 'Claude Code' };
  const entries: MemoryEntry[] = [
    { id: '1', at: '2026-10-28T09:00:00.000Z', kind: 'change', text: 'Show the date first', detail: 'People look for the date.', note: 'Nice', by, outcome: 'applied', proposal: 'p1', paths: ['src/Card.tsx'] },
    { id: '2', at: '2026-10-27T09:00:00.000Z', kind: 'change', text: 'Make it red', by, outcome: 'rejected', proposal: 'p2', items: ['react:Card'] },
    { id: '3', at: '2026-10-26T09:00:00.000Z', kind: 'change', text: 'Rename the title', by: { kind: 'developer', name: 'Ana' }, outcome: 'sent-back', proposal: 'p3', paths: ['src/Card.tsx'] },
    { id: '4', at: '2026-10-29T09:00:00.000Z', kind: 'note', text: 'Keep it simple', by, items: ['react:Card'] },
    { id: '5', at: '2026-10-29T09:00:00.000Z', kind: 'change', text: 'Another card', by, outcome: 'applied', paths: ['src/List.tsx'] },
  ];
  const job = (id: string, status: Job['status'], at: string, extra: Partial<Job> = {}): Job => ({ id, agent: 'make-previewable', title: 'Make previewable', request: 'Make Card previewable', status, round: 2, rounds: 3, startedAt: at, until: at, history: [{ at, who: 'Visual Editor', what: 'Started' }], by: 'a button', card: 'react:Card', ...extra });
  const jobs = [job('j1', 'passed', '2026-10-30T09:00:00.000Z', { proposal: 'held-d1' }), job('j2', 'stopped', '2026-10-25T09:00:00.000Z'), job('j3', 'failed', '2026-10-31T09:00:00.000Z', { card: 'react:List' })];
  const git = {
    commits: [{ hash: 'abc1234', author: 'Ana', at: '2026-10-29T12:00:00.000Z', subject: 'Tidy the header', added: 3, removed: 1, files: ['src/Card.tsx'] }],
    uncommitted: { at: '2026-10-31T08:00:00.000Z', added: 2, removed: 0, files: ['src/Card.tsx'], created: [] },
  };
  const h = cardHistory(card, entries, jobs, git);
  assert.deepEqual(h.map((l) => [l.at.slice(0, 10), l.kind, l.text, l.tone]), [
    ['2026-10-31', 'edit', 'Changed since the last commit, not committed yet', undefined],
    ['2026-10-30', 'job', 'Make previewable passed its checks (round 2 of 3) and went to Review', 'good'],
    ['2026-10-29', 'commit', 'Ana committed “Tidy the header”', undefined],
    ['2026-10-28', 'review', 'Claude Code changed it: Show the date first', 'good'],
    ['2026-10-27', 'review', 'Claude Code proposed: Make it red', 'bad'],
    ['2026-10-26', 'review', 'You proposed: Rename the title', undefined],
    ['2026-10-25', 'job', 'Make previewable stopped in round 2 of 3', undefined],
  ]);
  assert.deepEqual(h.map((l) => l.detail), [
    'Card.tsx: +2 −0 lines.',
    'Asked: “Make Card previewable” (by a button).',
    'Card.tsx: +3 −1 lines.',
    'Approved in Review. People look for the date. Your note: “Nice”',
    'Rejected in Review.',
    'Sent back from Review.',
    'Asked: “Make Card previewable” (by a button).',
  ]);
  assert.deepEqual(h.map((l) => l.open), [{ path: 'src/Card.tsx' }, { proposal: 'held-d1' }, { commit: 'abc1234' }, { proposal: 'p1' }, { proposal: 'p2' }, { proposal: 'p3' }, { job: 'j2' }]);
  // For Claude: exact dates; without git, said so.
  assert.equal(historyText(h.slice(3, 4), true)[0], '- 2026-10-28 · Claude Code changed it: Show the date first. Approved in Review. People look for the date. Your note: “Nice”');
  assert.deepEqual(historyText([], false), ['- (The project isn\'t in git: changes made outside Visual Editor aren\'t known.)']);
  // Nothing at all: an empty story (not someone else's).
  assert.deepEqual(cardHistory({ ...card, id: 'react:New', source: { path: 'src/New.tsx' } }, entries, jobs, { commits: [] }), []);
  // New files only: said as made.
  assert.equal(cardHistory(card, [], [], { commits: [], uncommitted: { at: '2026-10-31T08:00:00.000Z', added: 0, removed: 0, files: ['src/Card.tsx'], created: ['src/Card.tsx'] } })[0].text, 'Made, not committed yet');
});

test('card files: where it is defined; a previewable card\'s whole folder (its own, with the files it had before)', () => {
  assert.deepEqual(cardFiles(card), ['src/Card.tsx']);
  const previewable: Item = { ...card, source: { path: 'src/Card/index.tsx' }, preview: { variants: [{ id: 'default', name: 'Default', path: 'src/Card/Card.variant.tsx', inUse: true }], states: [], files: ['src/Card/index.tsx', 'src/Card/Card.mock.ts'] } };
  assert.deepEqual(cardFiles(previewable), ['src/Card']);
  assert.deepEqual(cardFiles({ ...card, source: undefined }), []);
});

test('day words: today and yesterday with the time, a weekday this week, then the date (the year when not this one)', () => {
  const now = new Date(2026, 10, 1, 15, 0);
  assert.equal(dayWords(new Date(2026, 10, 1, 9, 5).toISOString(), now), 'Today 09:05');
  assert.equal(dayWords(new Date(2026, 9, 31, 23, 59).toISOString(), now), 'Yesterday 23:59');
  assert.equal(dayWords(new Date(2026, 9, 28, 12, 0).toISOString(), now), 'Wednesday');
  assert.equal(dayWords(new Date(2026, 9, 3, 12, 0).toISOString(), now), '3 Oct');
  assert.equal(dayWords(new Date(2025, 9, 3, 12, 0).toISOString(), now), '3 Oct 2025');
  assert.equal(dayWords('not a date', now), '');
});
