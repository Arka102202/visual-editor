// Check plans: when a change is finished (Done in a session, Claude sending it, an agent's checker passing it), a
// check planner (one Claude run, reading only) gets what was asked and the whole change and writes the plan: which of
// Visual Editor's checks apply (each with why) and the scenarios that try to break it (what the change means, each
// case and what it expects, to be run in the app or read in the code). Nothing runs until the developer has looked at
// it: they untick checks or scenarios (with why), edit what a scenario expects, add their own, or skip all checks
// (with why), and press Run. Some checks are always planned (the planner can't drop them; the developer can). No VS
// Code APIs.

import type { FileChange } from '../proposals';
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
    return { id: a.id, title: a.title, why, use, ...(a.always ? { always: true } : {}), ...(page ? { page } : {}) };
  });
  return { revision, at, means: v.means, looksOnly: v.looksOnly, checks, cases: v.cases.map((c) => ({ ...c, use: true })), fixes: v.fixes };
}

/** What the developer changed in a plan before pressing Run. */
export interface PlanEdits {
  /** Each check by id: used or not. */
  checks: Record<string, boolean>;
  /** Each of the plan's scenarios (in order): used or not, and what it should expect. */
  cases: { use: boolean; expected?: string }[];
  /** Scenarios of their own, in plain words. */
  added: string[];
  /** Why they took anything out (needed when they did). */
  reason?: string;
  /** Send it without any checks (with reason). */
  skipAll?: boolean;
}

/** Edits that keep a plan as it is (to run it again, e.g. after bypassing a check that failed). */
export function asItIs(plan: CheckPlan): PlanEdits {
  return { checks: Object.fromEntries(plan.checks.map((c) => [c.id, c.use])), cases: plan.cases.map((c) => ({ use: c.use, expected: c.expected })), added: [] };
}

/** The plan as the developer approved it; a string says what's missing (a reason for what they took out). */
export function applyEdits(plan: CheckPlan, edits: PlanEdits): CheckPlan | string {
  const reason = edits.reason?.trim();
  if (edits.skipAll) return reason ? { ...plan, skipAll: reason } : 'Say why it should go without any checks.';
  const checks = plan.checks.map((c) => {
    const use = edits.checks[c.id] ?? c.use;
    return c.use && !use ? { ...c, use, skipped: reason ?? '' } : { ...c, use };
  });
  const cases = plan.cases.map((c, i) => {
    const e = edits.cases[i];
    if (!e) return c;
    const expected = e.expected?.trim() || c.expected;
    // A changed expectation is the developer's: the code reading (and any run) is redone for it.
    const changed = expected !== c.expected;
    const next: PlanCase = { ...c, use: e.use, expected, ...(changed ? { by: 'developer' as const, added: true, found: '', run: undefined } : {}) };
    return c.use && !e.use ? { ...next, skipped: reason ?? '' } : next;
  });
  const added = edits.added.map((t) => t.trim()).filter(Boolean).map((t): PlanCase => ({ case: t, expected: '', found: '', ok: false, by: 'developer', how: 'traced', use: true, added: true }));
  const tookOut = checks.some((c) => c.skipped !== undefined) || cases.some((c) => c.skipped !== undefined);
  if (tookOut && !reason) return 'Say why you took those out (it is kept with the change).';
  return { ...plan, checks, cases: [...cases, ...added] };
}

/** The developer's choices on a plan, in words (kept in the proof). */
export function choicesText(plan: CheckPlan): string | undefined {
  if (plan.skipAll) return `Sent without any checks, by the developer. Why: ${plan.skipAll}`;
  const lines = [
    ...plan.checks.filter((c) => c.skipped !== undefined).map((c) => `Check skipped: ${c.title}`),
    ...plan.cases.filter((c) => c.skipped !== undefined).map((c) => `Scenario skipped: ${c.case}`),
    ...plan.cases.filter((c) => c.added).map((c) => `Scenario added: ${c.case}${c.expected ? ` (expects: ${c.expected})` : ''}`),
  ];
  const why = [...plan.checks, ...plan.cases].find((x) => x.skipped)?.skipped;
  return lines.length ? `${lines.join('\n')}${why ? `\nWhy: ${why}` : ''}` : undefined;
}
