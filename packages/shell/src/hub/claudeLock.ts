// Through Visual Editor only: in a connected folder, Claude Code asks Visual Editor first for every request (its map,
// rules and memory), reads the project's files itself only after that, when the map isn't enough, and changes them only
// through Visual Editor (save_draft, propose_change), so every change reaches Review with its checks. Set in the
// folder's own Claude Code settings (.claude/settings.local.json, which git ignores): a rule that denies its file tools
// inside the project (it holds in every permission mode, auto too), and a check (claudeGuard.ts) run with each of the
// developer's messages (a reminder) and before each tool: it stops writes into the project, and reading the project
// before Visual Editor was asked. Its other settings are kept as they are. No VS Code APIs.

import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

/** Marks the check's command as Visual Editor's, so it's found again (to update or remove). */
export const GUARD_MARK = 'visual-editor-guard';
const FILE_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];
const READ_TOOLS = ['Read', 'Grep', 'Glob'];
/** Visual Editor's own tools, as Claude Code names them. */
const HUB_TOOL = /^mcp__visual-editor__/;
const MATCHER = ['Bash', ...FILE_TOOLS, ...READ_TOOLS, `${HUB_TOOL.source.slice(1)}.*`].join('|');
/** Set for Visual Editor's own checker (it reads the code to trace cases): reading isn't held for it. */
export const FREE_READ_ENV = 'VISUAL_EDITOR_FREE_READ';

/** Said to Claude with each of the developer's messages. */
export const MAP_FIRST_WORDS =
  'Visual Editor: this project is connected to Visual Editor. For every request, ask it first: overview, list_cards and card (and memory, for the rules) tell you what exists, where it is and how it connects. Read files yourself only when the map doesn’t give you what you need. Change files only through save_draft or propose_change, never directly.';
const ASK_FIRST_WORDS =
  'Visual Editor: ask the map first. Before reading this project’s files for this request, call one of Visual Editor’s tools (overview, list_cards, card or memory). If the map doesn’t give you what you need, read the files after that.';

export const REVIEW_ONLY_WORDS =
  'Visual Editor: in this project, changes go to the developer’s Review, not straight into files. Use Visual Editor’s tools instead: save_draft (then submit_draft), or propose_change with each changed file’s whole new content. Reading, searching and running commands that don’t change the project’s files is fine.';

/** The folder as Claude Code may see it (and as it really is, through links like /tmp → /private/tmp). */
function roots(folder: string): string[] {
  let real = folder;
  try {
    real = realpathSync(folder);
  } catch {
    // (A folder that's gone: its own name only.)
  }
  return [...new Set([folder, real])];
}

const settingsFile = (folder: string) => join(folder, '.claude', 'settings.local.json');

interface HookEntry {
  matcher?: string;
  hooks?: { type?: string; command?: string }[];
}
interface Settings {
  permissions?: { deny?: string[]; [k: string]: unknown };
  hooks?: Record<string, HookEntry[] | undefined>;
  [k: string]: unknown;
}

function readSettings(folder: string): Settings {
  try {
    return JSON.parse(readFileSync(settingsFile(folder), 'utf8')) as Settings;
  } catch {
    return {};
  }
}

function writeSettings(folder: string, s: Settings) {
  mkdirSync(dirname(settingsFile(folder)), { recursive: true });
  writeFileSync(settingsFile(folder), `${JSON.stringify(s, null, 2)}\n`);
}

/** The deny rules: Claude's file tools, anywhere in the project ("//" starts a path from the disk's root). */
const denyRules = (folder: string) => roots(folder).map((r) => `Edit(/${r}/**)`);
const ours = (e: HookEntry) => e.hooks?.some((h) => h.command?.includes(GUARD_MARK));

/** Whether Claude Code is locked to Visual Editor in this folder. */
export function locked(folder: string): boolean {
  const s = readSettings(folder);
  return !!s.permissions?.deny?.some((d) => denyRules(folder).includes(d)) && !!s.hooks?.PreToolUse?.some(ours) && !!s.hooks?.UserPromptSubmit?.some(ours);
}

/**
 * Locks the folder to Review (again: an older check's command is replaced). `guard` runs the check: a shell command,
 * given the folder after it, that must contain GUARD_MARK.
 */
export function lock(folder: string, guard: string) {
  const s = readSettings(folder);
  const deny = new Set(s.permissions?.deny ?? []);
  for (const d of denyRules(folder)) deny.add(d);
  s.permissions = { ...s.permissions, deny: [...deny] };
  const command = `${guard} ${quote(folder)}`;
  const others = (event: string) => (s.hooks?.[event] ?? []).filter((e) => !ours(e));
  s.hooks = {
    ...s.hooks,
    PreToolUse: [...others('PreToolUse'), { matcher: MATCHER, hooks: [{ type: 'command', command }] }],
    UserPromptSubmit: [...others('UserPromptSubmit'), { hooks: [{ type: 'command', command }] }],
  };
  writeSettings(folder, s);
}

/** Takes the lock off (only Visual Editor's parts). */
export function unlock(folder: string) {
  if (!existsSync(settingsFile(folder))) return;
  const s = readSettings(folder);
  const rules = denyRules(folder);
  if (s.permissions?.deny) {
    s.permissions.deny = s.permissions.deny.filter((d) => !rules.includes(d));
    if (!s.permissions.deny.length) delete s.permissions.deny;
    if (!Object.keys(s.permissions).length) delete s.permissions;
  }
  if (s.hooks) {
    for (const event of Object.keys(s.hooks)) {
      const kept = (s.hooks[event] ?? []).filter((e) => !ours(e));
      if (kept.length) s.hooks[event] = kept;
      else delete s.hooks[event];
    }
    if (!Object.keys(s.hooks).length) delete s.hooks;
  }
  writeSettings(folder, s);
}

export function quote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** What Claude Code asks the check about: a message of the developer's, or a tool, what it was given, and where it runs. */
export interface ToolCall {
  hook_event_name?: string;
  session_id?: string;
  tool_name?: string;
  tool_input?: { command?: string; file_path?: string; notebook_path?: string; path?: string; pattern?: string };
  cwd?: string;
}

/** What the check remembers of one Claude Code session: whether Visual Editor was asked since the developer's last message. */
export interface Turn {
  asked: boolean;
}

/**
 * The check's answer to one call: `stop` it (with what to do instead), `say` something to Claude with the developer's
 * message, and the session's `turn` as it is now (to remember). `turn` is what was remembered (undefined: nothing yet);
 * `free`: reading isn't held (Visual Editor's own checker).
 */
export function guard(call: ToolCall, folder: string, turn: Turn | undefined, free = false, session?: OpenSession): { stop?: string; say?: string; turn?: Turn } {
  if (call.hook_event_name === 'UserPromptSubmit') return { say: session ? `${MAP_FIRST_WORDS}\n${sessionWords(session)}` : MAP_FIRST_WORDS, turn: { asked: false } };
  if (HUB_TOOL.test(call.tool_name ?? '')) return { turn: { asked: true } };
  const why = blocked(call, folder);
  if (why) return { stop: `${REVIEW_ONLY_WORDS} (Stopped: ${why}.)` };
  const reading = !free && !turn?.asked ? readsFrom(call, folder) : undefined;
  if (reading) return { stop: `${ASK_FIRST_WORDS} (Held: ${reading}.)` };
  return {};
}

/** Said with each message while a design session is open in the developer's editor. */
/** The design session Claude works in (with its kind's brief), and the others open. */
export interface OpenSession {
  draft: string;
  title: string;
  brief?: string;
  others?: { draft: string; title: string }[];
}

export function sessionWords(s: OpenSession): string {
  const others = s.others?.length
    ? `\nOther sessions are open too: ${s.others.map((o) => `“${o.title}” (draft ${o.draft})`).join(', ')}. If the developer's message is clearly about one of those, work in that draft instead; if it isn't clear which session they mean, ask them before changing anything.`
    : '';
  return `Visual Editor: a design session is open: “${s.title}”, draft ${s.draft}${s.others?.length ? ' (the one the developer looked at last)' : ''}. Put every change for this request into it with save_draft (draft: "${s.draft}"), adding the request as asked; don't call propose_change. It shows live in the session; nothing is checked until the developer is done (they press Done, or say "done" and you call submit_draft with the session's draft id).${others}${s.brief ? `\n${s.brief}` : ''}`;
}

/** Commands that only look at files. */
const READERS = new Set(['cat', 'head', 'tail', 'less', 'more', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'find', 'fd', 'ls', 'tree', 'sed', 'awk', 'wc', 'nl', 'bat', 'cut', 'sort', 'uniq', 'xxd', 'od', 'strings', 'stat', 'file', 'diff']);

/** What this call reads of the project, in words; undefined when it reads nothing of it. */
export function readsFrom(call: ToolCall, folder: string): string | undefined {
  const cwd = call.cwd || folder;
  const inside = insideOf(folder);
  if (READ_TOOLS.includes(call.tool_name ?? '')) {
    const path = call.tool_input?.file_path ?? call.tool_input?.path ?? cwd;
    return inside(resolvePath(cwd, path)) ? `${call.tool_name} ${call.tool_input?.file_path ?? call.tool_input?.pattern ?? path}` : undefined;
  }
  if (call.tool_name !== 'Bash' || !call.tool_input?.command) return undefined;
  let here = cwd;
  let words: string[] = [];
  // (After a pipe, a reader with no files given reads what the command before it printed.)
  let piped = false;
  const look = (): string | undefined => {
    const w = words;
    words = [];
    let i = 0;
    while (i < w.length && (/^\w+=/.test(w[i]) || ['sudo', 'env', 'command', 'time', 'nohup', 'xargs'].includes(w[i]))) i++;
    const cmd = basename(w[i] ?? '');
    if (cmd === 'cd') {
      here = resolvePath(here, w[i + 1] ?? homedir());
      return undefined;
    }
    if (cmd === 'git' && ['grep', 'show', 'ls-files'].includes(w[i + 1] ?? '') && inside(here)) return `git ${w[i + 1]}`;
    if (!READERS.has(cmd)) return undefined;
    const paths = w.slice(i + 1).filter((a) => !a.startsWith('-') && (a.includes('/') || a === '.'));
    if (piped && !paths.length && !['find', 'ls', 'tree', 'fd'].includes(cmd)) return undefined;
    return inside(here) || paths.some((p) => inside(resolvePath(here, p))) ? w.slice(i).join(' ').slice(0, 80) : undefined;
  };
  for (const t of tokens(stripHereDocs(call.tool_input.command))) {
    if ('word' in t) words.push(t.word);
    else if (SEPARATORS.has(t.op)) {
      const r = look();
      if (r) return r;
      piped = t.op === '|';
    }
  }
  return look();
}

/** Why this tool call would change the project's files, in words; undefined when it wouldn't. */
export function blocked(call: ToolCall, folder: string): string | undefined {
  const cwd = call.cwd || folder;
  const inside = insideOf(folder);
  if (FILE_TOOLS.includes(call.tool_name ?? '')) {
    const path = call.tool_input?.file_path ?? call.tool_input?.notebook_path;
    return path && inside(resolvePath(cwd, path)) ? `${call.tool_name} on ${path}` : undefined;
  }
  if (call.tool_name === 'Bash' && call.tool_input?.command) return writesInto(call.tool_input.command, folder, cwd);
  return undefined;
}

function insideOf(folder: string) {
  const all = roots(folder);
  return (path: string) => all.some((r) => path === r || path.startsWith(r.endsWith('/') ? r : `${r}/`));
}

function resolvePath(cwd: string, p: string): string {
  const expanded = p
    .replace(/^~(?=\/|$)/, homedir())
    .replace(/\$\{?(\w+)\}?/g, (m, name: string) => process.env[name] ?? m);
  return isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
}

type Token = { word: string } | { op: string };

/** A shell command in words and operators (quotes and escapes taken off; good enough to see what it writes to). */
function tokens(command: string): Token[] {
  const out: Token[] = [];
  let word = '';
  let has = false;
  const end = () => {
    if (has) out.push({ word });
    word = '';
    has = false;
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (c === "'") {
      const j = command.indexOf("'", i + 1);
      word += command.slice(i + 1, j < 0 ? undefined : j);
      has = true;
      i = j < 0 ? command.length : j;
    } else if (c === '"') {
      let j = i + 1;
      while (j < command.length && command[j] !== '"') {
        if (command[j] === '\\' && j + 1 < command.length) j++;
        word += command[j++];
      }
      has = true;
      i = j;
    } else if (c === '\\' && i + 1 < command.length) {
      if (command[i + 1] !== '\n') word += command[i + 1];
      has = true;
      i++;
    } else if (c === '#' && !has) {
      while (i < command.length && command[i] !== '\n') i++;
      i--;
    } else if (/\s/.test(c)) {
      end();
      if (c === '\n') out.push({ op: ';' });
    } else if ('<>|&;()'.includes(c)) {
      // A number right before a redirection is its stream (2>…), not a word.
      if (/^\d$/.test(word) && (c === '>' || c === '<')) {
        word = '';
        has = false;
      } else end();
      const two = command.slice(i, i + 3).match(/^(>>|&>>|&>|>\||>&|<<<|<<|<&|&&|\|\||;;)/)?.[0];
      const op = two ?? c;
      out.push({ op });
      i += op.length - 1;
    } else {
      word += c;
      has = true;
    }
  }
  end();
  return out;
}

/** A here-document's text is input, not commands (its redirection, on the first line, still counts). */
function stripHereDocs(command: string): string {
  return command.replace(/(<<-?\s*(['"]?)(\w+)\2[^\n]*)\n[\s\S]*?\n\s*\3[ \t]*(?=\n|$)/g, '$1');
}

const SEPARATORS = new Set([';', '&&', '||', '|', '&', '(', ')', ';;']);
const WRITES = new Set(['>', '>>', '>|', '&>', '&>>']);
/** Paths that are never the project's. */
const NOWHERE = /^\/dev\/(null|stdout|stderr|tty|fd\/\d+)$/;

/** Why a shell command would change files in the project, in words; undefined when it wouldn't. */
export function writesInto(command: string, folder: string, cwd = folder): string | undefined {
  const inside = insideOf(folder);
  const into = (p: string) => !NOWHERE.test(p) && inside(resolvePath(cwd, p));
  const list = tokens(stripHereDocs(command));
  let words: string[] = [];
  let here = cwd;
  const check = (): string | undefined => {
    const w = words;
    words = [];
    if (!w.length) return undefined;
    // Leading settings (A=b), and words that run the rest (sudo, env, command, time, nohup, xargs).
    let i = 0;
    while (i < w.length && (/^\w+=/.test(w[i]) || ['sudo', 'env', 'command', 'builtin', 'exec', 'time', 'nohup', 'xargs', 'nice'].includes(w[i]))) i++;
    const cmd = basename(w[i] ?? '');
    const args = w.slice(i + 1);
    const plain = args.filter((a) => !a.startsWith('-'));
    const projectHere = inside(resolvePath(cwd, here));
    const intoHere = (p: string) => !NOWHERE.test(p) && inside(resolvePath(here, p));
    const any = (paths: string[], what: string) => {
      const hit = paths.find(intoHere);
      return hit ? `${what} ${hit}` : undefined;
    };
    if (cmd === 'cd') {
      here = resolvePath(here, args[0] ?? homedir());
      return undefined;
    }
    if (['sh', 'bash', 'zsh', 'dash', 'eval'].includes(cmd)) {
      const at = args.indexOf('-c');
      const inner = cmd === 'eval' ? args.join(' ') : at >= 0 ? args[at + 1] : undefined;
      return inner ? writesInto(inner, folder, here) : undefined;
    }
    if (cmd === 'sed' || cmd === 'gsed') {
      if (!args.some((a) => /^-[a-zA-Z]*i|^--in-place/.test(a))) return undefined;
      const scripted = args.some((a) => a === '-e' || a === '-f' || a === '--expression');
      // (macOS's `sed -i ''`: the empty word is the backup's ending, not the script.)
      const files = args.filter((a, n) => a !== '' && !a.startsWith('-') && !['-e', '-f', '--expression'].includes(args[n - 1] ?? ''));
      return any(scripted ? files : files.slice(1), 'edits');
    }
    if (cmd === 'perl' || cmd === 'ruby') {
      if (!args.some((a) => /^-[a-zA-Z]*i/.test(a))) return undefined;
      return any(args.filter((a, n) => !a.startsWith('-') && !/^-[a-zA-Z]*e$/.test(args[n - 1] ?? '')), 'edits');
    }
    if (cmd === 'tee') return any(plain, 'writes to');
    if (cmd === 'cp' || cmd === 'install' || cmd === 'rsync') return any(plain.slice(-1), 'copies into');
    if (['mv', 'rm', 'rmdir', 'unlink', 'touch', 'truncate', 'shred', 'ln'].includes(cmd)) return any(plain, cmd === 'mv' ? 'moves' : cmd === 'rm' || cmd === 'rmdir' || cmd === 'unlink' || cmd === 'shred' ? 'removes' : 'changes');
    if (cmd === 'dd') return any(args.filter((a) => a.startsWith('of=')).map((a) => a.slice(3)), 'writes to');
    if (cmd === 'git' && projectHere) {
      const sub = args.find((a) => !a.startsWith('-'));
      const branchOnly = (sub === 'checkout' && args.includes('-b')) || (sub === 'switch' && args.includes('-c'));
      const resetFiles = sub === 'reset' && args.some((a) => ['--hard', '--merge', '--keep'].includes(a));
      if (resetFiles || (!branchOnly && ['checkout', 'switch', 'restore', 'stash', 'apply', 'am', 'clean', 'rm', 'mv', 'merge', 'rebase', 'pull', 'cherry-pick', 'revert'].includes(sub ?? ''))) return `git ${sub} (changes the project's files)`;
      return undefined;
    }
    if (cmd === 'patch' && projectHere) return 'patch (changes the project\'s files)';
    if (['npm', 'pnpm', 'yarn', 'bun'].includes(cmd) && projectHere) {
      const sub = plain[0];
      if (['add', 'remove', 'rm', 'uninstall', 'un', 'unlink', 'upgrade', 'update', 'up'].includes(sub ?? '') || (['install', 'i'].includes(sub ?? '') && plain.length > 1)) return `${cmd} ${sub} (changes package.json)`;
    }
    // Tools that rewrite files when asked (prettier --write, eslint --fix…).
    if (projectHere && args.some((a) => a === '--write' || a === '--fix' || (a === '-w' && ['prettier', 'gofmt', 'rustfmt'].includes(cmd)))) return `${[cmd, ...args].join(' ').slice(0, 80)} (rewrites files)`;
    // Code given inline that writes files.
    if (['node', 'python', 'python3', 'ruby', 'deno', 'bun', 'perl'].includes(cmd) && projectHere) {
      const code = args.find((_, n) => ['-e', '-c', '--eval', '-p'].includes(args[n - 1] ?? '')) ?? '';
      if (/writeFile|appendFile|createWriteStream|copyFile|renameSync|unlink|rmSync|rmdir|\.write_text|\.write_bytes|shutil\.|os\.(remove|rename|unlink)|open\([^)]*['"][wax]\+?['"]/.test(code)) return `${cmd} code that writes files`;
    }
    return undefined;
  };
  for (let n = 0; n < list.length; n++) {
    const t = list[n];
    if ('word' in t) {
      words.push(t.word);
      continue;
    }
    if (WRITES.has(t.op)) {
      const target = list[n + 1];
      if (target && 'word' in target) {
        n++;
        if (into(resolvePath(here, target.word))) return `writes to ${target.word}`;
      }
      continue;
    }
    if (t.op === '>&' || t.op === '<&' || t.op === '<' || t.op === '<<' || t.op === '<<<') {
      // (Streams joined, or input: not a file written. A here-document's text isn't a command.)
      const next = list[n + 1];
      if (next && 'word' in next) n++;
      continue;
    }
    if (SEPARATORS.has(t.op)) {
      const why = check();
      if (why) return why;
    }
  }
  return check();
}
