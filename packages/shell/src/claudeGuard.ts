// The check Claude Code runs in a folder locked to Visual Editor (hub/claudeLock.ts), given the call on its input and
// the folder as its argument. With each of the developer's messages it reminds Claude to ask Visual Editor first; before
// a tool, it stops a change to the project's files, or reading them before Visual Editor was asked (exit code 2:
// Claude Code shows Claude the words). It remembers, per session, whether Visual Editor was asked since the last
// message (a small file in the temp folder). Anything else, or a call it can't read, goes ahead.

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FREE_READ_ENV, guard, readNote, type SessionNote, type ToolCall, type Turn } from './hub/claudeLock';

const folder = process.argv[2];
let input = '';
process.stdin.on('data', (d: Buffer) => (input += d));
process.stdin.on('end', () => {
  let call: ToolCall;
  try {
    call = JSON.parse(input) as ToolCall;
  } catch {
    process.exit(0);
  }
  if (!folder) process.exit(0);
  const dir = join(tmpdir(), 'visual-editor-guard');
  const file = join(dir, `${createHash('sha256').update(`${folder}#${call.session_id ?? ''}`).digest('hex').slice(0, 24)}.json`);
  let turn: Turn | undefined;
  try {
    turn = JSON.parse(readFileSync(file, 'utf8')) as Turn;
  } catch {
    turn = undefined;
  }
  // The design session open in a tab of the developer's editor, if one, and the closed ones (session.ts notes them).
  let note: SessionNote = {};
  try {
    note = readNote(JSON.parse(readFileSync(join(folder, '.visual-editor', 'drafts', '.session'), 'utf8')));
  } catch {
    note = {};
  }
  const out = guard(call, folder, turn, process.env[FREE_READ_ENV] === '1', note.open, note.closed);
  if (out.turn) {
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(file, JSON.stringify(out.turn));
    } catch {
      // (Not remembered: reading is held again until Visual Editor is asked.)
    }
  }
  if (out.say) process.stdout.write(`${out.say}\n`);
  if (out.stop) {
    process.stderr.write(`${out.stop}\n`);
    process.exit(2);
  }
  process.exit(0);
});
