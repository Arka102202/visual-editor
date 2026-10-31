import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { blocked, guard, lock, locked, MAP_FIRST_WORDS, readsFrom, sessionWords, unlock, writesInto } from '../src/hub/claudeLock';

const root = '/work/app';

test('review only: shell commands that write into the project are stopped; others go ahead', () => {
  const stopped = [
    'echo hi > src/a.ts',
    'cat >> /work/app/README.md',
    "cat > src/x.tsx <<'EOF'\nexport const x = 1;\nEOF",
    'sed -i "" "s/a/b/" src/a.ts',
    "perl -pi -e 's/a/b/' src/a.ts",
    'printf x | tee src/a.ts',
    'cp /tmp/x.ts src/x.ts',
    'mv src/a.ts src/b.ts',
    'rm -rf src/old',
    'touch src/new.ts',
    'cd src && echo x > a.ts',
    'git checkout -- src/a.ts',
    'git stash',
    'git reset --hard',
    'npm install left-pad',
    'npx prettier --write .',
    'npx eslint --fix src',
    `node -e "require('fs').writeFileSync('src/a.ts', 'x')"`,
    `bash -c 'echo x > src/a.ts'`,
    'ls; echo x 2> src/err.log',
  ];
  for (const c of stopped) assert.ok(writesInto(c, root), `should stop: ${c}`);
  const fine = [
    'ls -la src',
    'grep -rn "Theme" src',
    'cat src/a.ts | head -20',
    'npm test 2>&1 | tail -5',
    'npm run build > /dev/null 2>&1',
    'echo x > /tmp/scratch.txt',
    'cp src/a.ts /tmp/a.ts',
    'git status && git diff',
    'git checkout -b try-it',
    'npm install',
    'mkdir -p /tmp/x && rm -rf /tmp/x',
    "cat <<'EOF' | node\nrm -rf src\nEOF",
    'echo "a > b" ',
    'cd /tmp && echo x > a.txt',
  ];
  for (const c of fine) assert.equal(writesInto(c, root), undefined, `should go ahead: ${c}`);
  assert.equal(writesInto('sed -i "" "s/a/b/" src/a.ts', root), 'edits src/a.ts');
});

test('review only: Claude\'s file tools are stopped inside the project only', () => {
  assert.equal(blocked({ tool_name: 'Edit', tool_input: { file_path: '/work/app/src/a.ts' }, cwd: root }, root), 'Edit on /work/app/src/a.ts');
  assert.ok(blocked({ tool_name: 'Write', tool_input: { file_path: 'src/new.ts' }, cwd: root }, root));
  assert.equal(blocked({ tool_name: 'Write', tool_input: { file_path: '/Users/me/.claude/memory/x.md' }, cwd: root }, root), undefined, 'its own memory, outside the project');
  assert.equal(blocked({ tool_name: 'Write', tool_input: { file_path: '/work/apple/x.ts' }, cwd: root }, root), undefined, 'a folder that only starts the same');
  assert.equal(blocked({ tool_name: 'Read', tool_input: { file_path: '/work/app/src/a.ts' } }, root), undefined);
  assert.ok(blocked({ tool_name: 'Bash', tool_input: { command: 'rm src/a.ts' }, cwd: root }, root));
});

test('review only: the lock goes into the folder\'s own Claude Code settings and comes off, keeping the rest', () => {
  const folder = mkdtempSync(join(tmpdir(), 've-lock-'));
  mkdirSync(join(folder, '.claude'));
  const file = join(folder, '.claude', 'settings.local.json');
  writeFileSync(file, JSON.stringify({ enabledPlugins: { 'visual-editor@visual-editor': true }, permissions: { allow: ['Bash(npm test)'] }, hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'mine' }] }] } }));
  assert.equal(locked(folder), false);
  lock(folder, 'node guard.js visual-editor-guard');
  lock(folder, 'node newer-guard.js visual-editor-guard');
  assert.equal(locked(folder), true);
  const s = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(s.enabledPlugins, { 'visual-editor@visual-editor': true });
  assert.deepEqual(s.permissions.allow, ['Bash(npm test)']);
  assert.ok(s.permissions.deny.includes(`Edit(/${folder}/**)`));
  assert.deepEqual(s.hooks.PreToolUse.map((e: { hooks: { command: string }[] }) => e.hooks[0].command), ['mine', `node newer-guard.js visual-editor-guard '${folder}'`], 'one check of ours, the newest');
  assert.match(s.hooks.PreToolUse[1].matcher, /^Bash\|Edit\|Write\|MultiEdit\|NotebookEdit\|Read\|Grep\|Glob\|mcp__visual-editor__\.\*$/);
  assert.deepEqual(s.hooks.UserPromptSubmit, [{ hooks: [{ type: 'command', command: `node newer-guard.js visual-editor-guard '${folder}'` }] }], 'and with each message');
  unlock(folder);
  assert.equal(locked(folder), false);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { enabledPlugins: { 'visual-editor@visual-editor': true }, permissions: { allow: ['Bash(npm test)'] }, hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'mine' }] }] } });
});

test('through Visual Editor only: each message, a reminder; reading the project waits until Visual Editor is asked', () => {
  const at = (call: object) => ({ cwd: root, session_id: 's', ...call });
  const prompt = guard(at({ hook_event_name: 'UserPromptSubmit' }), root, { asked: true });
  assert.deepEqual(prompt, { say: MAP_FIRST_WORDS, turn: { asked: false } }, 'a new message: ask again');
  const read = at({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/work/app/src/a.ts' } });
  assert.match(guard(read, root, { asked: false }).stop ?? '', /^Visual Editor: ask the map first\.[\s\S]*\(Held: Read \/work\/app\/src\/a\.ts\.\)$/);
  assert.ok(guard(read, root, undefined).stop, 'nothing remembered: not asked yet');
  assert.deepEqual(guard(at({ tool_name: 'mcp__visual-editor__overview' }), root, { asked: false }), { turn: { asked: true } });
  assert.deepEqual(guard(read, root, { asked: true }), {}, 'asked: reading is free');
  assert.deepEqual(guard(read, root, { asked: false }, true), {}, 'Visual Editor\'s own checker reads freely');
  assert.match(guard(at({ tool_name: 'Write', tool_input: { file_path: 'src/a.ts' } }), root, { asked: true }).stop ?? '', /changes go to the developer’s Review/, 'changes stay stopped, asked or not');
  // What counts as reading the project.
  const reads = (command: string, cwd = root) => readsFrom({ tool_name: 'Bash', tool_input: { command }, cwd }, root);
  assert.ok(reads('ls src/pages/Editor/components/ && cat src/a.tsx'));
  assert.ok(reads('grep -rn "rightPanelTab" src'));
  assert.ok(reads('cat /work/app/src/a.ts', '/tmp'));
  assert.ok(reads('git grep Theme'));
  assert.equal(reads('npm test 2>&1 | tail -5'), undefined, 'running things is fine (tail reads their output)');
  assert.equal(reads('npm run build'), undefined);
  assert.equal(reads('git status'), undefined);
  assert.equal(reads('cat /tmp/notes.txt', '/tmp'), undefined, 'outside the project');
  assert.ok(readsFrom({ tool_name: 'Grep', tool_input: { pattern: 'Theme' }, cwd: root }, root), 'Grep in the project');
  assert.ok(readsFrom({ tool_name: 'Glob', tool_input: { pattern: '**/*.tsx' }, cwd: root }, root));
  assert.equal(readsFrom({ tool_name: 'Read', tool_input: { file_path: '/Users/me/.claude/x.md' }, cwd: root }, root), undefined);
});

test('through Visual Editor only: while a design session is open, each message says to work in its draft', () => {
  const open = { draft: 'd1', title: 'Design session: ProjectCard' };
  const said = guard({ hook_event_name: 'UserPromptSubmit', session_id: 's' }, root, undefined, false, open).say ?? '';
  assert.ok(said.startsWith(MAP_FIRST_WORDS));
  assert.ok(said.endsWith(sessionWords(open)));
  assert.match(said, /save_draft \(draft: "d1"\)[\s\S]*don't call propose_change/);
});

test('through Visual Editor only: with several sessions open, Claude is told them all, and to ask when it isn\'t clear which', () => {
  const said = sessionWords({ draft: 'd2', title: 'New page: Billing', others: [{ draft: 'd1', title: 'New design: ProjectCard' }], brief: 'This session makes a NEW PAGE, Billing, at /billing.' });
  assert.match(said, /draft d2 \(the one the developer looked at last\)/);
  assert.match(said, /Other sessions are open too: “New design: ProjectCard” \(draft d1\)\. If the developer's message is clearly about one of those, work in that draft instead; if it isn't clear which session they mean, ask them/);
  assert.match(said, /\nThis session makes a NEW PAGE, Billing, at \/billing\.$/);
});
