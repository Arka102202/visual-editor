// Situations: the same component in different states (normal, loading, empty, error, long text, or the developer's
// own), each with its example props and fake server replies. The logic runs inside the preview page, in the browser:
// `installSituations` is written as-is into `.visual-editor/preview/situations.js` (see situationsModule), so it must
// stay self-contained (no imports, no outside helpers). Kept here so it can be tested in Node.
// From No-Code Map's Playground, where it was proven.

export const GENERATED_JS = '// Written by Visual Editor (React plugin) for previews. Replaced when the plugin updates.';

/** A fake reply for requests whose address (or React Query key) contains `match`. */
export interface RequestRule {
  match: string;
  /** The data to reply with (sent as JSON). */
  reply?: unknown;
  /** HTTP status; 400 and above is an error. Default 200. */
  status?: number;
  /** Milliseconds before replying, or 'forever' to stay loading. */
  wait?: number | 'forever';
}

/** One situation in fixtures.tsx (`export const situations = { … }`). */
export interface Situation {
  label?: string;
  /** Example props for this situation (an object, or `(log) => ({…})`). Default: the playground's props. */
  props?: unknown;
  /** Fake replies for this situation, checked in order. */
  requests?: RequestRule[];
  /** What every other request does: stay loading, fail, refuse (401), or reply with an empty list. Without it, Normal's replies apply. */
  all?: 'loading' | 'error' | 'empty' | 'unauthorized';
}

export interface SituationsResult {
  /** The situation shown. */
  id: string;
  props: Record<string, unknown>;
  /** Every situation this playground has, for the Playground's switch. */
  list: { id: string; label: string }[];
}

/**
 * Picks the situation, builds its props and puts fake replies in front of fetch, XMLHttpRequest (axios…) and React
 * Query. Requests no rule matches go to the real server, as in the app.
 */
export function installSituations(opts: {
  id: string;
  fixtures: Record<string, unknown>;
  log: (name: string) => (...args: unknown[]) => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  win: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  QueryClient?: any;
}): SituationsResult {
  const { fixtures, log, win } = opts;
  const run = (p: unknown): Record<string, unknown> => {
    const v = typeof p === 'function' ? p(log) : p;
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  };
  const base = run(fixtures.props);

  // "Empty": every list empty. "Long text": every sentence-like text three times longer, every list longer.
  const emptied = (v: unknown, depth = 0): unknown => {
    if (Array.isArray(v)) return [];
    if (v && typeof v === 'object' && depth < 4 && Object.getPrototypeOf(v) === Object.prototype) {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, emptied(x, depth + 1)]));
    }
    return v;
  };
  const wordy = (s: string) => /\s/.test(s.trim()) || /^[A-Z][a-z]{2,}/.test(s);
  const plain = (s: string) => !/^(https?:|data:|#[0-9a-f]{3,8}$|\d{4}-\d\d-\d\d|[\w.+-]+@[\w-]+\.)/i.test(s);
  const lengthened = (v: unknown, depth = 0): unknown => {
    if (typeof v === 'string') return wordy(v) && plain(v) ? `${v} ${v.toLowerCase()} ${v.toLowerCase()}` : v;
    if (Array.isArray(v)) {
      if (!v.length || depth > 3) return v;
      const out: unknown[] = [];
      for (let i = 0; out.length < Math.max(v.length, 12); i++) out.push(lengthened(v[i % v.length], depth + 1));
      return out;
    }
    if (v && typeof v === 'object' && depth < 4 && Object.getPrototypeOf(v) === Object.prototype) {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, lengthened(x, depth + 1)]));
    }
    return v;
  };

  const builtIn: Record<string, { label: string; props?: unknown; all?: 'loading' | 'error' | 'empty' | 'unauthorized'; requests?: RequestRule[] }> = {
    normal: { label: 'Normal' },
    loading: { label: 'Loading', all: 'loading' },
    empty: { label: 'Empty', all: 'empty', props: emptied(base) },
    error: { label: 'Error', all: 'error' },
    long: { label: 'Long text', props: lengthened(base) },
    loggedOut: { label: 'Logged out', all: 'unauthorized' },
    expired: { label: 'Session expired', all: 'unauthorized' },
  };
  // The user's own situations add to these, or change them (same name).
  const own = (fixtures.situations ?? fixtures.scenarios ?? {}) as Record<string, unknown>;
  const all: Record<string, { label: string; props?: unknown; all?: 'loading' | 'error' | 'empty' | 'unauthorized'; requests?: RequestRule[] }> = { ...builtIn };
  for (const [key, value] of Object.entries(own)) {
    const s = (typeof value === 'function' ? { props: value } : (value ?? {})) as { label?: string; props?: unknown; all?: 'loading' | 'error' | 'empty' | 'unauthorized'; requests?: RequestRule[] };
    const label = s.label ?? builtIn[key]?.label ?? key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[-_]+/g, ' ').replace(/^./, (c) => c.toUpperCase());
    all[key] = { ...builtIn[key], ...s, label };
  }
  const id = all[opts.id] ? opts.id : 'normal';
  const chosen = all[id];
  const props = chosen.props === undefined ? base : run(chosen.props);

  // What a request gets: a fake reply, or undefined to let it through.
  // Its own replies first; then its `all`, or else Normal's replies (so "Long text" gets the same data as Normal).
  const answer = (address: string): { body: unknown; status: number; wait: number | 'forever' } | undefined => {
    const find = (rules: RequestRule[] | undefined) => (rules ?? []).find((r) => r && typeof r.match === 'string' && address.includes(r.match));
    const rule = find(chosen.requests);
    if (rule) return { body: rule.reply ?? null, status: rule.status ?? 200, wait: rule.wait ?? 300 };
    if (chosen.all === 'loading') return { body: null, status: 200, wait: 'forever' };
    if (chosen.all === 'error') return { body: { error: 'Server error (made up by Visual Editor)' }, status: 500, wait: 300 };
    if (chosen.all === 'unauthorized') return { body: { error: 'Not logged in (made up by Visual Editor)' }, status: 401, wait: 200 };
    // Empty: the normal reply's shape with every list emptied (a detail page still gets its object); else [].
    if (chosen.all === 'empty') {
      const n = find(all.normal.requests);
      return { body: n ? emptied(n.reply ?? null) : [], status: 200, wait: 300 };
    }
    const normal = id === 'normal' ? undefined : find(all.normal.requests);
    if (normal) return { body: normal.reply ?? null, status: normal.status ?? 200, wait: normal.wait ?? 300 };
    return undefined;
  };
  const after = (wait: number | 'forever') => new Promise<void>((resolve) => (wait === 'forever' ? undefined : setTimeout(resolve, wait)));

  // fetch
  const realFetch = win.fetch?.bind(win);
  if (realFetch) {
    win.fetch = async (input: unknown, init?: unknown) => {
      const address = typeof input === 'string' ? input : input instanceof win.URL ? String(input) : String((input as { url?: string })?.url ?? input);
      const a = answer(address);
      if (!a) return realFetch(input, init);
      await after(a.wait);
      return new win.Response(JSON.stringify(a.body), { status: a.status, headers: { 'Content-Type': 'application/json' } });
    };
  }

  // XMLHttpRequest (axios and older libraries)
  const XHR = win.XMLHttpRequest;
  if (XHR?.prototype) {
    const open = XHR.prototype.open;
    const send = XHR.prototype.send;
    XHR.prototype.open = function (this: { __nocode?: string }, method: string, address: string, ...rest: unknown[]) {
      this.__nocode = String(address);
      return open.call(this, method, address, ...rest);
    };
    XHR.prototype.send = function (this: Record<string, unknown> & { __nocode?: string; dispatchEvent(e: unknown): void }, body?: unknown) {
      const a = this.__nocode ? answer(this.__nocode) : undefined;
      if (!a) return send.call(this, body);
      const text = JSON.stringify(a.body);
      void after(a.wait).then(() => {
        for (const [k, v] of Object.entries({ readyState: 4, status: a.status, statusText: a.status < 400 ? 'OK' : 'Error', responseText: text, response: this.responseType === 'json' ? a.body : text, responseURL: this.__nocode })) {
          Object.defineProperty(this, k, { value: v, configurable: true });
        }
        (this as unknown as { getAllResponseHeaders: () => string }).getAllResponseHeaders = () => 'content-type: application/json\r\n';
        (this as unknown as { getResponseHeader: (h: string) => string | null }).getResponseHeader = (h: string) => (h.toLowerCase() === 'content-type' ? 'application/json' : null);
        for (const type of ['readystatechange', 'load', 'loadend']) {
          this.dispatchEvent(new win.Event(type));
          const handler = this[`on${type}`];
          if (typeof handler === 'function') handler.call(this, new win.Event(type));
        }
      });
    };
  }

  // React Query: every client (the preview's, a custom wrapper's) asks its queries through defaultQueryOptions.
  const proto = opts.QueryClient?.prototype;
  if (proto?.defaultQueryOptions) {
    const real = proto.defaultQueryOptions;
    proto.defaultQueryOptions = function (this: unknown, options: unknown) {
      const o = real.call(this, options) as { queryKey?: unknown };
      if (o && (o as { _nocode?: boolean })._nocode) return o;
      let key = '';
      try {
        key = JSON.stringify(o?.queryKey ?? '');
      } catch {
        key = String(o?.queryKey);
      }
      const a = answer(key);
      if (!a) return o;
      return {
        ...o,
        _nocode: true,
        retry: false,
        queryFn: async () => {
          await after(a.wait);
          if (a.status >= 400) throw new Error(`Request failed with status ${a.status} (made up by Visual Editor)`);
          return a.body;
        },
      };
    };
  }

  return { id, props, list: Object.entries(all).map(([key, s]) => ({ id: key, label: s.label })) };
}

/** `.visual-editor/preview/situations.js`: the function above, for the preview page. */
export function situationsModule(): string {
  return `${GENERATED_JS}\n// @ts-nocheck\n/* eslint-disable */\nexport ${installSituations.toString()}\n`;
}
