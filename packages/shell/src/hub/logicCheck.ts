// The logic check: before any change reaches Review, a separate Claude (that didn't make it) works out what the change
// means for how things behave (its promises: API calls, states, data flow, side effects… or none, for a change of looks
// only), then tries to break each promise with cases (normal, edge, impossible) and reports every case it tried. The
// developer can add cases of their own, which are tried the same way. It runs as Claude Code in the background, with
// reading tools only, on the developer's own login. No VS Code APIs.

import { spawn } from 'node:child_process';
import type { FileChange } from '../proposals';

/** One case the checker tried: what it did, what should happen, what the code does. */
export interface LogicCase {
  case: string;
  /** The promise it tests (its number), when it tests one. */
  promise?: number;
  expected: string;
  found: string;
  ok: boolean;
  /** Who thought of it. */
  by: 'checker' | 'developer';
  /** How it was tried: traced through the code (read), or run in the app. */
  how: 'traced' | 'run';
}

export interface LogicReport {
  /** What the change means for how things behave, in plain words (its promises). Empty for a change of looks only. */
  means: string[];
  looksOnly: boolean;
  cases: LogicCase[];
  /** For each case that broke: what to fix. */
  fixes: string[];
}

export interface LogicVerdict extends LogicReport {
  passed: boolean;
  /** In dollars, at pay-per-use prices (shown only to those who pay per use). */
  cost?: number;
}

/** How much of one file the checker is given inline (it can read the rest itself). */
const FILE_LIMIT = 30_000;

/**
 * What the checker is asked: the request, the change, and how to answer. `cases`: the developer's own cases, to try too
 * (with `only`, just those, against the promises already worked out: `means`).
 */
export function logicPrompt(asked: string[], changes: FileChange[], cases: string[] = [], only?: { means: string[] }): string {
  const cut = (text: string) => (text.length > FILE_LIMIT ? `${text.slice(0, FILE_LIMIT)}\n… (cut here: read the rest of the file yourself)` : text);
  const files = changes.map((c) => {
    const what = c.before === null ? 'new' : c.after === null ? 'removed' : 'changed';
    return [`=== ${c.path} (${what})`, ...(c.before !== null ? ['--- before', cut(c.before)] : []), ...(c.after !== null ? ['--- after', cut(c.after)] : [])].join('\n');
  });
  const theirs = cases.length ? `\nThe developer's own cases (try every one, and mark them "by": "developer"):\n${cases.map((c) => `- ${c}`).join('\n')}\n` : '';
  const steps = only
    ? `What this change means (worked out before):
${only.means.length ? only.means.map((m, i) => `${i + 1}. ${m}`).join('\n') : '(looks only: nothing about behaviour should change)'}

Try only the developer's cases above, against these promises.`
    : `Work in two steps.

Step 1, what the change means for how things behave. Look at what it touches and say what it promises, in plain words,
one promise each. Consider only what applies to this change:
- API calls: the right address and method, the right data sent, called at the right moment, called once, errors handled;
- states (loading, empty, error, success…): every one handled and shown, moving between them correctly;
- states that shouldn't be possible but could crash the page: missing or empty data, unknown values, something deleted
  still selected, a page opened straight from its address;
- data flow (props, stores, context): values reach the right places, parents and children stay in step;
- side effects (saving, storage, the page address, the theme…): they happen once, in the right order, and match what's
  shown;
- and everything that worked before keeps working, unless the request was to change it.
If the request is about looks only, say so: then the promise is that nothing about behaviour changes.

Step 2, try to break each promise with cases: the normal one, edge cases, and unusual or impossible ones. Trace each case
through the code (read other files of the project with Read, Grep and Glob when you need to see how something is used)
and say what should happen and what the code does. Also check that the change does nothing that wasn't asked for.
Don't comment on style.`;
  return `You check one change to this code project before the developer sees it. You did not make it: try hard to find
where it goes wrong, and be fair.

What the developer asked for, in their words:
${asked.map((a) => `- ${a}`).join('\n')}
${theirs}
The change, each file before and after:
${files.join('\n\n')}

${steps}

Reply with only this JSON, nothing else:
{"looksOnly": true or false,
 "means": ["each promise, in plain words"],
 "cases": [{"case": "what you tried", "promise": its promise's number or null, "expected": "what should happen", "found": "what the code does", "ok": true or false, "by": "checker" or "developer"}],
 "fixes": ["for each case that breaks: the file, what is wrong, what to do"],
 "verdict": "PASSED" if every case is ok, else "PROBLEMS"}`;
}

/** The checker's report, read from its reply (the JSON in it). A string says why it couldn't be read. */
export function readVerdict(reply: string): LogicVerdict | string {
  const start = reply.indexOf('{');
  const end = reply.lastIndexOf('}');
  if (start < 0 || end < start) return `The logic checker didn't give a verdict: ${reply.trim().slice(0, 300) || '(no reply)'}`;
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(reply.slice(start, end + 1));
  } catch {
    return `The logic checker's verdict couldn't be read: ${reply.trim().slice(0, 300)}`;
  }
  const verdict = String(raw.verdict ?? '').toUpperCase();
  if (verdict !== 'PASSED' && verdict !== 'PROBLEMS') return `The logic checker gave no clear verdict: ${reply.trim().slice(0, 300)}`;
  const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  const cases: LogicCase[] = (Array.isArray(raw.cases) ? raw.cases : []).flatMap((c: Record<string, unknown>) => {
    if (!c || !text(c.case)) return [];
    return [{
      case: text(c.case),
      ...(typeof c.promise === 'number' ? { promise: c.promise } : {}),
      expected: text(c.expected),
      found: text(c.found),
      ok: c.ok === true,
      by: c.by === 'developer' ? 'developer' : 'checker',
      how: 'traced',
    } satisfies LogicCase];
  });
  const means = (Array.isArray(raw.means) ? raw.means : []).map(text).filter(Boolean);
  const fixes = (Array.isArray(raw.fixes) ? raw.fixes : []).map(text).filter(Boolean);
  // The verdict follows the cases: any that broke is a problem, whatever the summary says.
  const broke = cases.filter((c) => !c.ok);
  if (!cases.length) return 'The logic checker didn\'t say which cases it tried.';
  if (broke.length && !fixes.length) fixes.push(...broke.map((c) => `${c.case}: expected ${c.expected}, but ${c.found}.`));
  return { passed: !broke.length && verdict === 'PASSED', looksOnly: raw.looksOnly === true, means, cases, fixes };
}

/** The report in words, for the assistant (what breaks and what to fix first). */
export function logicText(asked: string[], r: LogicReport): string {
  const mark = (c: LogicCase) => `${c.ok ? '✓' : '✗'} ${c.case}${c.by === 'developer' ? ' (the developer’s case)' : ''}: ${c.ok ? c.found : `expected ${c.expected}, but ${c.found}`}`;
  return [
    `Asked: ${asked.join(' · ')}`,
    r.looksOnly ? 'What it means: looks only; nothing about behaviour should change.' : `What it means:\n${r.means.map((m, i) => `${i + 1}. ${m}`).join('\n')}`,
    `Cases tried:\n${r.cases.map(mark).join('\n')}`,
    ...(r.fixes.length ? [`To fix:\n${r.fixes.map((f) => `- ${f}`).join('\n')}`] : []),
  ].join('\n');
}

/**
 * Runs the logic check: Claude Code in the project folder (`claude` is the command to run it), reading only, with
 * `model`. `cases`/`only` as for logicPrompt. A string says why it couldn't run.
 */
export function runLogicCheck(claude: string, root: string, asked: string[], changes: FileChange[], model: string, cases: string[] = [], only?: { means: string[] }, timeoutMs = 300_000): Promise<LogicVerdict | string> {
  const args = ['-p', '--output-format', 'json', '--model', model, '--allowedTools', 'Read,Grep,Glob', '--disallowedTools', 'Edit,Write,MultiEdit,NotebookEdit,Bash'];
  return new Promise((done) => {
    const child = spawn(process.env.SHELL || '/bin/zsh', ['-lc', `${claude} ${args.map((a) => `'${a}'`).join(' ')}`], { cwd: root, env: { ...process.env, FORCE_COLOR: '0' } });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill();
      done(`The logic check took more than ${Math.round(timeoutMs / 60_000)} minutes and was stopped.`);
    }, timeoutMs);
    child.stdout.on('data', (d: Buffer) => (out += d));
    child.stderr.on('data', (d: Buffer) => (err += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      done(`Claude Code couldn't be started for the logic check: ${e.message}`);
    });
    child.on('close', () => {
      clearTimeout(timer);
      try {
        const r = JSON.parse(out) as { result?: string; is_error?: boolean; total_cost_usd?: number };
        if (r.is_error) return done(`The logic check couldn't finish: ${(r.result ?? err).trim().slice(0, 300)}`);
        const v = readVerdict(r.result ?? '');
        if (typeof v === 'string') return done(v);
        // Whose case it is isn't left to the checker: with no developer's cases, all are its own; with only theirs, all
        // are theirs.
        const by = (c: LogicCase): LogicCase['by'] => (!cases.length ? 'checker' : only ? 'developer' : c.by);
        done({ ...v, cases: v.cases.map((c) => ({ ...c, by: by(c) })), ...(typeof r.total_cost_usd === 'number' ? { cost: r.total_cost_usd } : {}) });
      } catch {
        done(`The logic check couldn't run: ${(err || out).trim().slice(0, 300) || 'no answer from Claude Code'}`);
      }
    });
    child.stdin.end(logicPrompt(asked, changes, cases, only));
  });
}
