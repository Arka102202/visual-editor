// Fakes: what the proxy answers instead of (or on top of) the real backend, kept in the project so the team shares
// them (.visual-editor/api/, one file per endpoint, plus scenarios.json). Each endpoint has cases; one is in use
// ("pass": the real backend, the default). A case either answers itself (status, headers, body), or passes the call
// on and changes the answer (a delay, some fields, the status), or fails like a dropped connection. A scenario sets
// the case of many endpoints at once, and wins over each endpoint's own choice. No VS Code APIs, so it can be tested.

import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fits } from './fakePaths';

export { endpointId, fits, patternFor } from './fakePaths';

export const FAKES_DIR = '.visual-editor/api';
const SCENARIOS = 'scenarios.json';

/** One way an endpoint answers. */
export interface FakeCase {
  /** Answer itself: the status (200 when not given), headers, and body (JSON, or text). */
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
  /** Or pass the call on to the backend (and change its answer). */
  pass?: boolean;
  /** Fields of a JSON answer to set, by path ("items.0.status": "paid"). With `pass`. */
  patch?: Record<string, unknown>;
  /** Wait this long before answering (ms). */
  delay?: number;
  /** Fail like a dropped connection (no answer at all). */
  network?: boolean;
  /** What it's for, in words. */
  note?: string;
}

/** One endpoint and its cases. */
export interface FakeEndpoint {
  /** Its file name without .json (made from the method and path). */
  id: string;
  method: string;
  /** The address pattern: /api/orders/:id (a :name is one part of the address; * is the rest). */
  path: string;
  /** For calls to another address: that address's origin (http://localhost:8080); none: the app's own. */
  origin?: string;
  /** The case in use: "pass" (the real backend) or a case's name. */
  use: string;
  cases: Record<string, FakeCase>;
}

export interface Scenarios {
  /** The scenario in use (none: each endpoint's own choice). */
  active?: string;
  /** Each scenario: endpoint id → the case it uses. */
  scenarios: Record<string, Record<string, string>>;
}

/** What to do with one call. */
export type Decision =
  | { kind: 'pass'; endpoint?: FakeEndpoint }
  | { kind: 'answer'; endpoint: FakeEndpoint; name: string; status: number; headers: Record<string, string>; body: Buffer; delay: number }
  | { kind: 'change'; endpoint: FakeEndpoint; name: string; status?: number; headers?: Record<string, string>; patch?: Record<string, unknown>; delay: number }
  | { kind: 'fail'; endpoint: FakeEndpoint; name: string; delay: number };

/** Sets fields of a JSON value by path ("items.0.status"); returns the changed value. */
export function patch(value: unknown, fields: Record<string, unknown>): unknown {
  const out = structuredClone(value);
  for (const [path, v] of Object.entries(fields)) {
    const parts = path.split('.');
    let at: unknown = out;
    for (const p of parts.slice(0, -1)) {
      if (at && typeof at === 'object') at = (at as Record<string, unknown>)[p];
      else break;
    }
    if (at && typeof at === 'object') (at as Record<string, unknown>)[parts[parts.length - 1]] = v;
  }
  return out;
}

export class Fakes {
  endpoints: FakeEndpoint[] = [];
  scenarios: Scenarios = { scenarios: {} };

  constructor(readonly root: string) {
    this.load();
  }

  get dir(): string {
    return join(this.root, FAKES_DIR);
  }

  /** Reads every endpoint file and the scenarios (a broken file is skipped). */
  load() {
    this.endpoints = [];
    this.scenarios = { scenarios: {} };
    if (!existsSync(this.dir)) return;
    for (const name of readdirSync(this.dir)) {
      if (!name.endsWith('.json')) continue;
      try {
        const data = JSON.parse(readFileSync(join(this.dir, name), 'utf8'));
        if (name === SCENARIOS) this.scenarios = { scenarios: data.scenarios ?? {}, ...(data.active ? { active: data.active } : {}) };
        else if (data && typeof data.method === 'string' && typeof data.path === 'string') this.endpoints.push({ use: 'pass', cases: {}, ...data, id: name.slice(0, -5) });
      } catch {
        // A file being edited (not valid JSON yet): skipped until it is.
      }
    }
  }

  /** Writes an endpoint's file (made the first time). */
  save(endpoint: FakeEndpoint) {
    mkdirSync(this.dir, { recursive: true });
    const { id, ...data } = endpoint;
    writeFileSync(join(this.dir, `${id}.json`), `${JSON.stringify(data, null, 2)}\n`);
    this.load();
  }

  remove(id: string) {
    const file = join(this.dir, `${id}.json`);
    if (existsSync(file)) unlinkSync(file);
    this.load();
  }

  saveScenarios(s: Scenarios) {
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(join(this.dir, SCENARIOS), `${JSON.stringify(s, null, 2)}\n`);
    this.load();
  }

  /** The endpoint a call is for: the method and path fit (and the origin, for calls to other addresses). */
  find(method: string, path: string, origin?: string): FakeEndpoint | undefined {
    const m = method.toUpperCase();
    const candidates = this.endpoints.filter((e) => (e.method.toUpperCase() === m || e.method === '*') && (e.origin ?? undefined) === (origin ?? undefined) && fits(e.path, path));
    // The most specific pattern wins (fewer :params and *).
    return candidates.sort((a, b) => wild(a.path) - wild(b.path) || b.path.length - a.path.length)[0];
  }

  /** The case an endpoint uses now: the scenario's choice when one is in use, else its own. */
  caseOf(e: FakeEndpoint): string {
    const s = this.scenarios.active ? this.scenarios.scenarios[this.scenarios.active] : undefined;
    return s?.[e.id] ?? e.use ?? 'pass';
  }

  /** What to do with a call. */
  decide(method: string, path: string, origin?: string): Decision {
    const e = this.find(method, path, origin);
    if (!e) return { kind: 'pass' };
    const name = this.caseOf(e);
    const c = name === 'pass' ? undefined : e.cases[name];
    if (!c) return { kind: 'pass', endpoint: e };
    const delay = Math.max(0, Math.min(120_000, c.delay ?? 0));
    if (c.network) return { kind: 'fail', endpoint: e, name, delay };
    if (c.pass) return { kind: 'change', endpoint: e, name, ...(c.status ? { status: c.status } : {}), ...(c.headers ? { headers: c.headers } : {}), ...(c.patch ? { patch: c.patch } : {}), delay };
    const text = typeof c.body === 'string' ? c.body : c.body === undefined ? '' : JSON.stringify(c.body, null, 2);
    const json = typeof c.body !== 'string' && c.body !== undefined;
    return {
      kind: 'answer',
      endpoint: e,
      name,
      status: c.status ?? 200,
      headers: { ...(json || text ? { 'content-type': json ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8' } : {}), ...c.headers },
      body: Buffer.from(text),
      delay,
    };
  }
}

function wild(path: string): number {
  return (path.match(/:\w+|\*/g) ?? []).length;
}
