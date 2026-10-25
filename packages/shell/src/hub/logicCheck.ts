// The logic check: before any change reaches Review, a separate Claude (that didn't make it) works out what the change
// means for how things behave (its promises: API calls, states, data flow, side effects… or none, for a change of looks
// only), then tries to break each promise with cases (normal, edge, impossible) and reports every case it tried. The
// developer can add cases of their own, which are tried the same way. It runs as Claude Code in the background, with
// reading tools only, on the developer's own login. Cases whose effect shows on a page come with steps (a RunSpec), and
// Visual Editor runs them for real in the draft's own app (caseRunner.ts): what really happened wins over the reading.
// No VS Code APIs.

import { spawn } from 'node:child_process';
import type { CaseResult, Expectation, RunFake, RunSpec, Step, Target } from '../caseRunner';
import type { FileChange } from '../proposals';
import type { AvailableCheck } from './checkPlan';
import { FREE_READ_ENV } from './claudeLock';

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
  /** How to run it in the draft's app, when its effect shows on a page. */
  run?: RunSpec;
  /** The developer said this case is wrong (with why): it doesn't hold the change back. */
  overruled?: { note: string; at: string };
}

/** Where cases can be run in this change: the cards it touches (in the Playground, a design and a state), and the app's pages. */
export interface RunPlaces {
  /** `shows`: what it has on it when it opens, in each state (in the design in use), in a line each. */
  cards: { id: string; name: string; designs: { id: string; name: string; inUse: boolean }[]; states: string[]; shows?: Record<string, string> }[];
  pages: { path: string; shows?: string }[];
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
export function logicPrompt(asked: string[], changes: FileChange[], cases: string[] = [], only?: { means: string[] }, places?: RunPlaces, checks?: AvailableCheck[]): string {
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
  const runnable = places && (places.cards.length || places.pages.length) ? `

Cases can also be run for real, in this change's own app in a browser. Where:
${[
    ...places.cards.map((c) => `- the Playground of ${c.name} (card "${c.id}"): designs ${c.designs.map((d) => `"${d.id}" (${d.name}${d.inUse ? ', in use' : ''})`).join(', ')}; states ${c.states.map((x) => `"${x}"`).join(', ')}${Object.entries(c.shows ?? {}).map(([state, line]) => `\n  when it opens in state "${state}": ${line}`).join('')}`),
    ...places.pages.map((x) => `- the app's page "${x.path}"${x.shows ? `\n  when it opens: ${x.shows}` : ''}`),
  ].join('\n')}
("When it opens" is what is really on it now, with this change, in a fresh browser. Each state has its own fixed data:
expect only what that state shows (names in one state aren't in another), and if it starts in another state than your
case needs, add steps to get there first.)
For every case whose effect shows on the page (what is shown, what a click or typing does, what an API answer leads
to), add "run": how to try it there. "expect" is what should be seen if the promise holds (not what the code does), so
the run fails when it's broken. Visual Editor runs it and what really happens replaces what you traced. Leave "run"
out for cases a page can't show. The shape:
{"where": "playground" or "app", "card": its card, "design": a design's id, "state": a state, "page": an app page,
 "api": [{"method": "GET", "path": "/api/x/:id", "status": 500, "body": {…}, "delay": ms, "network": true to fail}],
 "steps": [{"do": "click", "target": T}, {"do": "type", "target": T, "text": "…"}, {"do": "press", "key": "Enter"}, {"do": "wait", "ms": 500}],
 "expect": [{"see": "text", "within": T}, {"notSee": "text", "within": T}, {"attr": {"target": T, "name": "aria-pressed", "value": "true" or null}}]}
where a target T is {"role": "button" or "link" or "textbox" or "checkbox", "name": its label or text}, or {"text": "…"},
or {"selector": "css"} (the page's <html> is {"selector": "html"}). "api" fakes answers for this run only.
"see" and "notSee" look at the whole page unless "within" names the part to look in (e.g. the grid of cards, a dialog):
use "within" whenever the same text can also be somewhere else on the page (a summary, a header, a title, a menu).` : '';
  // (A check plan: which of Visual Editor's checks apply, too.)
  const choose = checks?.length
    ? `

Also choose which of Visual Editor's checks apply to this change, each with why in a few plain words (the developer
reads it before anything runs). The checks:
${checks.map((c) => `- "${c.id}" (${c.title})${c.always ? ' [always run]' : ''}: ${c.description}`).join('\n')}`
    : '';
  return `You check one change to this code project before the developer sees it. You did not make it: try hard to find
where it goes wrong, and be fair.

What the developer asked for, in their words:
${asked.map((a) => `- ${a}`).join('\n')}
${theirs}
The change, each file before and after:
${files.join('\n\n')}

${steps}${runnable}${choose}

Reply with only this JSON, nothing else:
{"looksOnly": true or false,
 "means": ["each promise, in plain words"],
 "cases": [{"case": "what you tried", "promise": its promise's number or null, "expected": "what should happen", "found": "what the code does", "ok": true or false, "by": "checker" or "developer"${runnable ? ', "run": {…} or null' : ''}}],
 "fixes": ["for each case that breaks: the file, what is wrong, what to do"],${choose ? `
 "checks": [{"id": a check's id, "use": true or false, "why": "…", "page": "/…" for looks_same}],` : ''}
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
      ...(readRun(c.run) ? { run: readRun(c.run) } : {}),
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

/** How to run a case, read from the checker's reply (or a kept report); undefined when it isn't one that can run. */
export function readRun(v: unknown): RunSpec | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const r = v as Record<string, unknown>;
  const str = (x: unknown) => (typeof x === 'string' && x.trim() ? x.trim() : undefined);
  const target = (x: unknown): Target | undefined => {
    if (!x || typeof x !== 'object') return undefined;
    const t = x as Record<string, unknown>;
    const role = ['button', 'link', 'textbox', 'checkbox', 'any'].includes(String(t.role)) ? (t.role as Target['role']) : undefined;
    const out: Target = { ...(role ? { role } : {}), ...(str(t.name) ? { name: str(t.name) } : {}), ...(str(t.text) ? { text: str(t.text) } : {}), ...(str(t.selector) ? { selector: str(t.selector) } : {}) };
    return out.name || out.text || out.selector ? out : undefined;
  };
  const steps = (Array.isArray(r.steps) ? r.steps : []).flatMap((x: Record<string, unknown>): Step[] => {
    if (!x || typeof x !== 'object') return [];
    if (x.do === 'click' && target(x.target)) return [{ do: 'click', target: target(x.target)! }];
    if (x.do === 'type' && target(x.target) && typeof x.text === 'string') return [{ do: 'type', target: target(x.target)!, text: x.text }];
    if (x.do === 'press' && str(x.key)) return [{ do: 'press', key: str(x.key)! }];
    if (x.do === 'wait' && typeof x.ms === 'number') return [{ do: 'wait', ms: x.ms }];
    return [];
  });
  const expect = (Array.isArray(r.expect) ? r.expect : []).flatMap((x: Record<string, unknown>): Expectation[] => {
    if (!x || typeof x !== 'object') return [];
    const within = target(x.within);
    if (str(x.see)) return [{ see: str(x.see)!, ...(within ? { within } : {}) }];
    if (str(x.notSee)) return [{ notSee: str(x.notSee)!, ...(within ? { within } : {}) }];
    const a = x.attr as Record<string, unknown> | undefined;
    if (a && target(a.target) && str(a.name)) return [{ attr: { target: target(a.target)!, name: str(a.name)!, value: a.value === null || a.value === undefined ? null : String(a.value) } }];
    return [];
  });
  const api = (Array.isArray(r.api) ? r.api : []).flatMap((x: Record<string, unknown>): RunFake[] =>
    x && str(x.method) && str(x.path)
      ? [{ method: str(x.method)!.toUpperCase(), path: str(x.path)!, ...(typeof x.status === 'number' ? { status: x.status } : {}), ...(x.body !== undefined ? { body: x.body } : {}), ...(typeof x.delay === 'number' ? { delay: x.delay } : {}), ...(x.network === true ? { network: true } : {}) }]
      : [],
  );
  const where = r.where === 'playground' || r.where === 'app' ? r.where : undefined;
  // Nothing to look for, or nowhere to start: it can't be run.
  if (!where || !expect.length || (where === 'playground' && !str(r.card))) return undefined;
  return {
    where,
    ...(str(r.card) ? { card: str(r.card) } : {}),
    ...(str(r.design) ? { design: str(r.design) } : {}),
    ...(str(r.state) ? { state: str(r.state) } : {}),
    ...(str(r.page) ? { page: str(r.page) } : {}),
    ...(api.length ? { api } : {}),
    steps,
    expect,
  };
}

/**
 * Runs the cases that can run, in the draft's app (`run` starts one: its fakes in place, then caseRunner's runCase).
 * What really happened replaces what was traced; a case whose steps couldn't be done there (the checker named something
 * that isn't on the page) keeps its reading, with a note. The verdict follows again.
 */
export async function runCases(v: LogicVerdict, run: (spec: RunSpec) => Promise<CaseResult>): Promise<LogicVerdict> {
  const cases: LogicCase[] = [];
  const newly: LogicCase[] = [];
  for (const c of v.cases) {
    if (!c.run) {
      cases.push(c);
      continue;
    }
    const r = await run(c.run);
    if (!r.ran) {
      cases.push({ ...c, found: `${c.found} (couldn't be run: ${r.found})` });
      continue;
    }
    const ran: LogicCase = { ...c, ok: r.ok, found: r.found, how: 'run' };
    if (c.ok && !r.ok) newly.push(ran);
    cases.push(ran);
  }
  const broke = cases.filter((c) => !c.ok);
  // Fixes the checker gave for cases that, run for real, work after all, can't be told apart from the others: they stay
  // while anything is broken, and go when nothing is.
  const fixes = broke.length ? [...v.fixes, ...newly.map((c) => `${c.case}: run in the app, expected ${c.expected}, but ${c.found}.`)] : [];
  return { ...v, cases, fixes, passed: !broke.length };
}

/**
 * A state whose fixed data has every one of these texts, when the case looked for them in `state` (whose page doesn't
 * show them): the case mixed up the states, it isn't the change. `byState`: each state's page text, with the change.
 * Undefined when they aren't all shown in some other state (then the change may well have lost them).
 */
export function otherState(missing: string[], state: string, byState: Record<string, string>): string | undefined {
  const has = (text: string, t: string) => text.toLowerCase().includes(t.toLowerCase());
  if (!missing.length || missing.some((t) => has(byState[state] ?? '', t))) return undefined;
  return Object.entries(byState).find(([s, text]) => s !== state && missing.every((t) => has(text, t)))?.[0];
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
 * `model`. `cases`/`only`/`places` as for logicPrompt. A string says why it couldn't run.
 */
export async function runLogicCheck(claude: string, root: string, asked: string[], changes: FileChange[], model: string, cases: string[] = [], only?: { means: string[] }, places?: RunPlaces, timeoutMs = 300_000): Promise<LogicVerdict | string> {
  const r = await askClaude(claude, root, model, logicPrompt(asked, changes, cases, only, places), timeoutMs, 'The logic check');
  if (typeof r === 'string') return r;
  const v = readVerdict(r.result);
  if (typeof v === 'string') return v;
  // Whose case it is isn't left to the checker: with no developer's cases, all are its own; with only theirs, all are
  // theirs.
  const by = (c: LogicCase): LogicCase['by'] => (!cases.length ? 'checker' : only ? 'developer' : c.by);
  return { ...v, cases: v.cases.map((c) => ({ ...c, by: by(c) })), ...(r.cost !== undefined ? { cost: r.cost } : {}) };
}

/** Asks Claude Code once, in the project folder, reading only; its answer (and cost), or why there's none. */
export function askClaude(claude: string, root: string, model: string, prompt: string, timeoutMs: number, what: string): Promise<{ result: string; cost?: number } | string> {
  const args = ['-p', '--output-format', 'json', '--model', model, '--allowedTools', 'Read,Grep,Glob', '--disallowedTools', 'Edit,Write,MultiEdit,NotebookEdit,Bash'];
  return new Promise((done) => {
    const child = spawn(process.env.SHELL || '/bin/zsh', ['-lc', `${claude} ${args.map((a) => `'${a}'`).join(' ')}`], { cwd: root, env: { ...process.env, FORCE_COLOR: '0', [FREE_READ_ENV]: '1' } });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill();
      done(`${what} took more than ${Math.round(timeoutMs / 60_000)} minutes and was stopped.`);
    }, timeoutMs);
    child.stdout.on('data', (d: Buffer) => (out += d));
    child.stderr.on('data', (d: Buffer) => (err += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      done(`Claude Code couldn't be started for ${what.toLowerCase()}: ${e.message}`);
    });
    child.on('close', () => {
      clearTimeout(timer);
      try {
        const r = JSON.parse(out) as { result?: string; is_error?: boolean; total_cost_usd?: number };
        if (r.is_error) return done(`${what} couldn't finish: ${(r.result ?? err).trim().slice(0, 300)}`);
        done({ result: r.result ?? '', ...(typeof r.total_cost_usd === 'number' ? { cost: r.total_cost_usd } : {}) });
      } catch {
        done(`${what} couldn't run: ${(err || out).trim().slice(0, 300) || 'no answer from Claude Code'}`);
      }
    });
    child.stdin.end(prompt);
  });
}

/** A case the code reading said works, which broke when it was run: what it did and saw, for a second look. */
export interface Disputed {
  case: string;
  expected: string;
  /** What the run did and found. */
  found: string;
  /** How it was run (its steps and what it looked for). */
  run: RunSpec;
  /** The page's text at the end of the run. */
  after?: string;
}

/** What the checker is asked on a second look: is it the change, or the case? */
export function secondLookPrompt(asked: string[], changes: FileChange[], disputed: Disputed[]): string {
  const cut = (text: string) => (text.length > 12_000 ? `${text.slice(0, 12_000)}\n… (cut here: read the rest of the file yourself)` : text);
  const files = changes.filter((c) => c.after !== null).map((c) => `=== ${c.path}\n${cut(c.after!)}`);
  return `You checked a change and read its code as working for these cases, but when they were run in the app they broke.
Look again, fairly: for each one, is it the change's fault (it does something wrong, or not what was asked), or the
case's (it expected something the change rightly does differently: the text is also elsewhere on the page, the data
is different in that state, the step named the wrong thing…)?

What the developer asked for:
${asked.map((a) => `- ${a}`).join('\n')}

${disputed.map((d, i) => `Case ${i + 1}: ${d.case}
Expected: ${d.expected}
Run: ${JSON.stringify({ where: d.run.where, card: d.run.card, design: d.run.design, state: d.run.state, page: d.run.page, steps: d.run.steps, expect: d.run.expect })}
Found: ${d.found}
The page's text at the end: ${(d.after ?? '(not kept)').slice(0, 2500)}`).join('\n\n')}

The change's files as it leaves them (read others with Read, Grep and Glob if you need):
${files.join('\n\n')}

Reply with only this JSON:
{"cases": [{"case": "the case, as above", "fault": "change" or "case", "why": "in plain words"}]}`;
}

/** The second look's answer: for each case (by its words), whose fault it is and why. A string says why it can't be read. */
export function readSecondLook(reply: string): Map<string, { fault: 'change' | 'case'; why: string }> | string {
  const start = reply.indexOf('{');
  const end = reply.lastIndexOf('}');
  try {
    const raw = JSON.parse(reply.slice(start, end + 1)) as { cases?: { case?: unknown; fault?: unknown; why?: unknown }[] };
    const out = new Map<string, { fault: 'change' | 'case'; why: string }>();
    for (const c of raw.cases ?? []) if (typeof c.case === 'string' && (c.fault === 'change' || c.fault === 'case')) out.set(c.case.trim(), { fault: c.fault, why: typeof c.why === 'string' ? c.why.trim() : '' });
    return out;
  } catch {
    return `The second look's answer couldn't be read: ${reply.trim().slice(0, 200)}`;
  }
}

/** Asks the checker to look again at disputed cases (one short run of Claude Code). */
export async function secondLook(claude: string, root: string, model: string, asked: string[], changes: FileChange[], disputed: Disputed[], timeoutMs = 180_000) {
  const r = await askClaude(claude, root, model, secondLookPrompt(asked, changes, disputed), timeoutMs, 'The second look');
  return typeof r === 'string' ? r : readSecondLook(r.result);
}

/**
 * The verdict after a second look: a case whose fault was the case's own keeps the code reading (it works), with a note
 * of what the run saw and why it doesn't count; one whose fault was the change's stays broken, with why. `before`: the
 * verdict as the code reading had it (same cases, in order).
 */
export function settle(v: LogicVerdict, before: LogicVerdict, looked: Map<string, { fault: 'change' | 'case'; why: string }>): LogicVerdict {
  const cleared: string[] = [];
  const cases = v.cases.map((c, i) => {
    const said = looked.get(c.case.trim());
    if (!said || c.ok || c.how !== 'run') return c;
    if (said.fault === 'change') return { ...c, found: `${c.found} (looked at again: ${said.why})` };
    cleared.push(c.case);
    return { ...before.cases[i], found: `${before.cases[i].found} (run in the app: ${c.found}; looked at again, it was the case, not the change: ${said.why})` };
  });
  const broke = cases.filter((c) => !c.ok && !c.overruled);
  const fixes = broke.length ? v.fixes.filter((f) => !cleared.some((name) => f.startsWith(`${name}: run in the app`))) : [];
  return { ...v, cases, fixes, passed: !broke.length };
}

/** Marks cases as overruled by the developer (by their places in the report), with why; the report passes when nothing else broke. */
export function overrule(r: LogicReport, which: number[], note: string, at = new Date().toISOString()): LogicReport & { passed: boolean } {
  const cases = r.cases.map((c, i) => (which.includes(i) && !c.ok ? { ...c, overruled: { note, at } } : c));
  return { ...r, cases, passed: cases.every((c) => c.ok || !!c.overruled) };
}
