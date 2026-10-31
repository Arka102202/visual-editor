// Check plans: when a change is finished (Done in a session, Claude sending it, an agent's checker passing it), a
// check planner (one Claude run, reading only) gets what was asked and the whole change and writes the plan: which of
// Visual Editor's checks apply (each with why) and the scenarios that try to break it (what the change means, each
// case and what it expects, to be run in the app or read in the code). Nothing runs until the developer has looked at
// it: they untick checks or scenarios (with why), edit what a scenario expects, add their own, or skip all checks
// (with why), and press Run. Some checks are always planned (the planner can't drop them; the developer can). No VS
// Code APIs.

import type { ProgressItem } from '../drafts';
import type { FileChange } from '../proposals';
import { describeRun } from '../caseRunner';
import type { PlanView } from '../ui/planWindow';
import { logicPrompt, readVerdict, type LogicCase, type RunPlaces } from './logicCheck';

/** A check Visual Editor can run on a change: a plugin's check, pictures, or comparing the app. */
export interface AvailableCheck {
  /** The plugin tool's name, or "pictures" / "looks_same". */
  id: string;
  title: string;
  /** What it checks, for the planner. */
  description: string;
  /** Always planned (the developer can skip it; the planner can't). */
  always?: boolean;
}

/** Visual Editor's own checks, beside the plugins'. */
export const BUILT_IN_CHECKS: AvailableCheck[] = [
  { id: 'pictures', title: 'Pictures in the Playground', description: 'Draws each previewable component the change touches, every design in every state, as the change leaves it; fails when the page throws errors.' },
  { id: 'looks_same', title: 'Looks the same in the app', description: 'Pictures an app page with and without the change and compares them pixel by pixel. Only for changes that must not change how the app looks (tidying code, making a component previewable): never for a change to a design. Give the page ("page": "/…").' },
];

export interface PlanCheck {
  id: string;
  title: string;
  /** What it checks, for the developer. */
  does?: string;
  /** Why it applies (or doesn't), in plain words. */
  why: string;
  use: boolean;
  always?: boolean;
  /** For "looks the same": the app page to compare. */
  page?: string;
  /** The developer took it out, with why. */
  skipped?: string;
}

/** A scenario: a logic-check case (as the planner read it in the code), and whether it is used. */
export interface PlanCase extends LogicCase {
  use: boolean;
  /** The developer took it out, with why. */
  skipped?: string;
  /** The developer wrote it (it hasn't been read in the code yet). */
  added?: boolean;
}

export interface CheckPlan {
  /** The draft's version it is for. */
  revision: number;
  at: string;
  means: string[];
  looksOnly: boolean;
  checks: PlanCheck[];
  cases: PlanCase[];
  /** What the planner, reading the code, says to fix for its cases that break. */
  fixes: string[];
  /** The developer sent it without any checks, with why. */
  skipAll?: string;
}

/** What the planner is asked: the logic check's two steps (the developer's own cases too), and which checks apply. */
export function planPrompt(asked: string[], changes: FileChange[], available: AvailableCheck[], places?: RunPlaces, cases: string[] = []): string {
  return logicPrompt(asked, changes, cases, undefined, places, available);
}

/** The plan, read from the planner's reply; a string says why it couldn't be read. Always-planned checks stay planned. */
export function readPlan(reply: string, available: AvailableCheck[], revision: number, at = new Date().toISOString()): CheckPlan | string {
  const v = readVerdict(reply);
  if (typeof v === 'string') return v;
  let said: { id?: unknown; use?: unknown; why?: unknown; page?: unknown }[] = [];
  try {
    const raw = JSON.parse(reply.slice(reply.indexOf('{'), reply.lastIndexOf('}') + 1)) as { checks?: unknown };
    if (Array.isArray(raw.checks)) said = raw.checks as typeof said;
  } catch {
    // (readVerdict read it: no checks given.)
  }
  const checks = available.map((a): PlanCheck => {
    const s = said.find((x) => x && x.id === a.id);
    const why = typeof s?.why === 'string' && s.why.trim() ? s.why.trim() : a.always ? 'Always checked.' : 'Not chosen by the planner.';
    const page = typeof s?.page === 'string' && s.page.startsWith('/') ? s.page : undefined;
    // "Looks the same" needs a page to compare.
    const use = a.always || (s?.use === true && (a.id !== 'looks_same' || !!page));
    return { id: a.id, title: a.title, does: a.description, why, use, ...(a.always ? { always: true } : {}), ...(page ? { page } : {}) };
  });
  return { revision, at, means: v.means, looksOnly: v.looksOnly, checks, cases: v.cases.map((c) => ({ ...c, use: true })), fixes: v.fixes };
}

/** What the developer changed in a plan before pressing Run. */
export interface PlanEdits {
  /** Each check by id: used or not. */
  checks: Record<string, boolean>;
  /** Why each check taken out was taken out, by id. */
  checkWhy?: Record<string, string>;
  /** Each of the plan's scenarios (in order): used or not, what it should expect, and (taken out) why. */
  cases: { use: boolean; expected?: string; why?: string }[];
  /** Scenarios of their own: what to try, in plain words, and what it should do (a line alone: just what to try). */
  added: (string | { case: string; expected?: string })[];
  /** Why they took anything out, for all of it (each item's own why wins); why it goes without checks (skipAll). */
  reason?: string;
  /** Send it without any checks (with reason). */
  skipAll?: boolean;
}

/** A plan as the test cases' window shows it: each check (what it does, why), each scenario (and how it's tried). */
export function planView(plan: CheckPlan): PlanView {
  return {
    means: plan.means,
    looksOnly: plan.looksOnly,
    checks: plan.checks.map((x) => ({ id: x.id, title: x.title, why: x.why, use: x.use, ...(x.does ? { does: x.does } : {}), ...(x.always ? { always: true } : {}) })),
    cases: plan.cases.map((x) => ({ case: x.case, expected: x.expected, how: x.how === 'run' || x.run ? 'run' : 'traced', use: x.use, ...(x.run ? { detail: describeRun(x.run, x.run.card?.split('#').pop()) } : {}) })),
  };
}

/** A run's list, before it starts: each check and scenario the developer approved (waiting), and those they took out. */
export function progressOf(plan: CheckPlan): ProgressItem[] {
  const used = plan.cases.filter((c) => c.use);
  return [
    ...plan.checks.filter((c) => c.use || c.skipped !== undefined).map((c): ProgressItem => ({ id: `check:${c.id}`, title: c.title, kind: 'check', state: c.use ? 'waiting' : 'skipped' })),
    ...used.map((c, i): ProgressItem => ({ id: `case:${i}`, title: c.case, kind: 'scenario', state: 'waiting' })),
    ...plan.cases.filter((c) => !c.use && c.skipped !== undefined).map((c, i): ProgressItem => ({ id: `skipped:${i}`, title: c.case, kind: 'scenario', state: 'skipped' })),
  ];
}

/** Edits that keep a plan as it is (to run it again, e.g. after bypassing a check that failed). */
export function asItIs(plan: CheckPlan): PlanEdits {
  return { checks: Object.fromEntries(plan.checks.map((c) => [c.id, c.use])), cases: plan.cases.map((c) => ({ use: c.use, expected: c.expected })), added: [] };
}

/** The plan as the developer approved it; a string says what's missing (a reason for what they took out). */
export function applyEdits(plan: CheckPlan, edits: PlanEdits): CheckPlan | string {
  const reason = edits.reason?.trim();
  if (edits.skipAll) return reason ? { ...plan, skipAll: reason } : 'Say why it should go without any checks.';
  // Each thing taken out needs its why: its own, or the one for all of it.
  const missing: string[] = [];
  const whyOf = (own: string | undefined, title: string) => {
    const why = own?.trim() || reason;
    if (!why) missing.push(title);
    return why ?? '';
  };
  const checks = plan.checks.map((c) => {
    const use = edits.checks[c.id] ?? c.use;
    return c.use && !use ? { ...c, use, skipped: whyOf(edits.checkWhy?.[c.id], c.title) } : { ...c, use };
  });
  const cases = plan.cases.map((c, i) => {
    const e = edits.cases[i];
    if (!e) return c;
    const expected = e.expected?.trim() || c.expected;
    // A changed expectation is the developer's: the code reading (and any run) is redone for it.
    const changed = expected !== c.expected;
    const next: PlanCase = { ...c, use: e.use, expected, ...(changed ? { by: 'developer' as const, added: true, found: '', run: undefined } : {}) };
    return c.use && !e.use ? { ...next, skipped: whyOf(e.why, c.case) } : next;
  });
  const added = edits.added
    .map((a) => (typeof a === 'string' ? { case: a.trim(), expected: '' } : { case: a.case.trim(), expected: a.expected?.trim() ?? '' }))
    .filter((a) => a.case)
    .map((a): PlanCase => ({ case: a.case, expected: a.expected, found: '', ok: false, by: 'developer', how: 'traced', use: true, added: true }));
  if (missing.length) return `Say why you took ${missing.length === 1 ? `out “${missing[0]}”` : `these out: ${missing.map((m) => `“${m}”`).join(', ')}`} (it is kept with the change).`;
  return { ...plan, checks, cases: [...cases, ...added] };
}

/** The developer's choices on a plan, in words (kept in the proof). */
export function choicesText(plan: CheckPlan): string | undefined {
  if (plan.skipAll) return `Sent without any checks, by the developer. Why: ${plan.skipAll}`;
  // Each thing taken out with its own why.
  const why = (w: string | undefined) => (w ? `. Why: ${w}` : '');
  const lines = [
    ...plan.checks.filter((c) => c.skipped !== undefined).map((c) => `Check skipped: ${c.title}${why(c.skipped)}`),
    ...plan.cases.filter((c) => c.skipped !== undefined).map((c) => `Scenario skipped: ${c.case}${why(c.skipped)}`),
    ...plan.cases.filter((c) => c.added).map((c) => `Scenario added: ${c.case}${c.expected ? ` (expects: ${c.expected})` : ''}`),
  ];
  return lines.length ? lines.join('\n') : undefined;
}
