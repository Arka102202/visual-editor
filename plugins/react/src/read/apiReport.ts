// Groups the frontend's API calls by endpoint, finds the component responsible for each,
// spots problems, and writes a proposed fix for each problem.
// Proposals are suggestions only: nothing here changes code.

import type { ApiCaller, ApiEndpoint, ApiIssue, CodePlace, DataUse, FeComponent } from './model';

interface Site {
  key: string;
  path: string;
  line: number;
  written: string;
  client: string;
  clientVar?: string;
  /** Inside a shared hook/function (not written directly in a component). */
  shared: boolean;
  /** Name of the shared function that sends it, e.g. `api.getOrders`. */
  sharedName?: string;
  callers: ApiCaller[];
}

export function buildApiReport(components: FeComponent[]): { apis: ApiEndpoint[]; apiIssues: ApiIssue[] } {
  const byId = new Map(components.map((c) => [c.id, c]));
  const componentFiles = new Set(components.map((c) => c.path));
  const pages = pagesFinder(byId);
  const ts = components.filter((c) => /\.tsx?$/.test(c.path)).length >= components.length / 2;

  // ---- Group calls by endpoint ----
  const endpoints = new Map<string, { method: string; url?: string; written: string; callers: ApiCaller[] }>();
  for (const c of components) {
    for (const d of c.data) {
      if (d.kind !== 'api' || !d.method) continue;
      const id = endpointId(d);
      const e = endpoints.get(id) ?? { method: d.method, url: d.url, written: d.written ?? '', callers: [] };
      const request = { path: d.path, line: d.line };
      if (!e.callers.some((x) => x.component === c.id && x.request.path === request.path && x.request.line === request.line)) {
        e.callers.push({
          component: c.id,
          trigger: d.trigger,
          via: d.via,
          request,
          entry: d.entry ?? request,
          pages: pages(c.id),
          client: d.client ?? 'fetch',
          clientVar: d.clientVar,
          written: d.written ?? '',
        });
      }
      endpoints.set(id, e);
    }
  }

  // Lines that send requests, and the shared API files the project already has.
  const allSites = new Map<string, Site>();
  const siteOf = (caller: ApiCaller): Site => {
    const key = `${caller.request.path}:${caller.request.line}`;
    let site = allSites.get(key);
    if (!site) {
      const shared = !!caller.via && !componentFiles.has(caller.request.path);
      site = {
        key,
        path: caller.request.path,
        line: caller.request.line,
        written: caller.written,
        client: caller.client,
        clientVar: caller.clientVar,
        shared,
        sharedName: caller.via?.split(' → ').pop(),
        callers: [],
      };
      allSites.set(key, site);
    }
    site.callers.push(caller);
    return site;
  };
  const sitesByEndpoint = new Map<string, Site[]>();
  for (const [id, e] of endpoints) {
    const sites: Site[] = [];
    for (const caller of e.callers) {
      const site = siteOf(caller);
      if (!sites.includes(site)) sites.push(site);
    }
    sitesByEndpoint.set(id, sites);
  }
  // The project's own API file: where shared request functions live. Hook files don't count (they're for components).
  const sharedSites = [...allSites.values()].filter((s) => s.shared);
  const apiFile = mostCommon(sharedSites.filter((s) => !/^use[A-Z0-9]/.test(s.sharedName?.split('.').pop() ?? '')).map((s) => s.path));
  const root = components[0]?.path.split('/')[0] === 'src' ? 'src' : (components[0]?.path.split('/').slice(0, -1)[0] ?? 'src');
  const usesQueryLib = components.some((c) => c.data.some((d) => d.kind === 'query' && /useQuery|useSWR/.test(d.label)));
  const envNames = [...endpoints.values()].flatMap((e) => (e.url?.match(/^\{([A-Z0-9_]+)\}/) ?? []).slice(1));

  const name = (c: string) => byId.get(c)?.name ?? c;
  const place = (path: string, line: number, label: string): CodePlace => ({ path, line, label });

  // ---- Endpoints with their issues ----
  const apis: ApiEndpoint[] = [];
  for (const [id, e] of endpoints) {
    const sites = sitesByEndpoint.get(id)!;
    const display = e.url ?? `(dynamic address: ${e.written})`;
    const issues: ApiIssue[] = [];
    const fnName = suggestName(e.method, e.url);
    const file = apiFile ?? `${root}/api/${resourceFileName(e.url)}.${ts ? 'ts' : 'js'}`;

    // 1. Same API handled in several places
    if (sites.length > 1) {
      const existing = sites.find((s) => s.shared);
      const others = sites.filter((s) => s !== existing);
      issues.push({
        kind: 'multiple-handlers',
        severity: 'warning',
        title: `Sent from ${sites.length} different places`,
        message: `${e.method} ${display} is written separately in ${sites.length} places. If the address, headers or error handling ever change, every copy has to be found and changed.`,
        places: sites.map((s) => place(s.path, s.line, `${s.shared ? `in ${s.sharedName}` : 'directly'}, used by ${unique(s.callers.map((x) => name(x.component))).join(', ')}`)),
        proposal: existing
          ? {
              summary: `Reuse the existing ${existing.sharedName} everywhere.`,
              steps: [
                `${existing.sharedName} in ${existing.path} already sends this request.`,
                ...others.map((s) => `In ${s.path}:${s.line + 1}, call ${existing.sharedName}() instead of sending the request directly.`),
              ],
            }
          : {
              summary: `Create one function, ${fnName}(), and use it in all ${sites.length} places.`,
              steps: [
                `Add ${fnName}() to ${file}.`,
                ...sites.map((s) => `In ${s.path}:${s.line + 1}, replace the request with a call to ${fnName}().`),
              ],
              file,
              snippet: functionSnippet(fnName, e.method, e.url, sites[0], ts),
            },
      });
    }

    // 2. Loaded twice on the same screen (a component and one of its parents both load it)
    const loaders = e.callers.filter((c) => c.trigger === 'load');
    for (const child of loaders) {
      const parent = loaders.find((p) => p.component !== child.component && isAncestor(byId, p.component, child.component));
      if (!parent) continue;
      if (issues.some((i) => i.kind === 'double-load')) break;
      const hook = `use${fnName.replace(/^(get|create|update|delete)/, '')}`;
      issues.push({
        kind: 'double-load',
        severity: 'warning',
        title: 'Loaded twice on the same screen',
        message: `${name(parent.component)} loads ${e.method} ${display}, and so does ${name(child.component)}, which is inside it. The same request is sent twice when the screen opens.`,
        places: [
          place(parent.entry.path, parent.entry.line, `${name(parent.component)} (parent) loads it`),
          place(child.entry.path, child.entry.line, `${name(child.component)} (inside it) loads it again`),
        ],
        proposal: {
          summary: `Load it once in ${name(parent.component)} and pass the result down to ${name(child.component)}.`,
          steps: [
            `Keep the request in ${name(parent.component)}.`,
            `Give ${name(child.component)} a new input (prop) for the data and remove its own request.`,
            usesQueryLib
              ? `Or: load it in both through one shared query hook (${hook}) with the same key, so the second one is served from the cache.`
              : `Or: use a caching data hook (for example TanStack Query) so both share one request.`,
          ],
        },
      });
    }

    // 3. Same address written differently
    const shapes = unique(sites.map((s) => s.written).filter(Boolean));
    if (sites.length > 1 && shapes.length > 1) {
      issues.push({
        kind: 'inconsistent-url',
        severity: 'warning',
        title: 'Address written in different ways',
        message: `The same address is built ${shapes.length} different ways: ${shapes.join('  ·  ')}. One of them can easily be missed when the address changes.`,
        places: sites.map((s) => place(s.path, s.line, `written as ${s.written}`)),
        proposal: {
          summary: 'Build the address in one place and use that everywhere.',
          steps: [`Keep a single constant or function for ${display}.`, 'Replace the other ways of writing it with that one.'],
        },
      });
    }

    // 4. Hard-coded server address
    if (e.url && isHardcodedHost(e.url) && sites.some((s) => /https?:\/\//.test(s.written))) {
      const env = envNames[0] ?? 'API_URL';
      issues.push({
        kind: 'hardcoded-host',
        severity: 'warning',
        title: 'Server address is hard-coded',
        message: `${e.url.match(/^https?:\/\/[^/]+/)?.[0]} is written into the code. This works on one computer but breaks on a test or live server.`,
        places: sites.filter((s) => /https?:\/\//.test(s.written)).map((s) => place(s.path, s.line, `written as ${s.written}`)),
        proposal: {
          summary: `Read the server address from configuration (an environment variable like ${env}).`,
          steps: [
            `Add ${env} to your environment file (.env).`,
            `Build the address from it, e.g. \`\${${envNames[0] ? `import.meta.env.${env}` : `process.env.${env}`}}${e.url.replace(/^https?:\/\/[^/]+/, '')}\`.`,
          ],
        },
      });
    }

    // 5. Loads data but shows no error state
    const silent = loaders.filter((c) => !byId.get(c.component)?.states.error);
    if (silent.length) {
      issues.push({
        kind: 'no-error-state',
        severity: 'warning',
        title: 'No error message if it fails',
        message: `${unique(silent.map((c) => name(c.component))).join(', ')} load${silent.length === 1 ? 's' : ''} this but never show${silent.length === 1 ? 's' : ''} anything if the request fails. The user sees an empty or frozen screen.`,
        places: silent.map((c) => place(c.entry.path, c.entry.line, `${name(c.component)} loads it`)),
        proposal: {
          summary: 'Catch the failure and show a short message with a "Try again" button.',
          steps: ['Keep an error value next to the data.', 'Set it when the request fails.', 'When it is set, show a message instead of the normal content.'],
        },
      });
    }

    apis.push({
      id,
      method: e.method,
      url: display,
      resource: resourceOf(e.url),
      callers: e.callers.sort((a, b) => name(a.component).localeCompare(name(b.component))),
      requestSites: sites.length,
      issues,
    });
  }

  // Same path with different bases (e.g. `/api/orders` and `{VITE_API_URL}/orders`)
  const byTail = new Map<string, ApiEndpoint[]>();
  for (const api of apis) {
    if (!api.url.startsWith('/') && !api.url.startsWith('{') && !/^https?:/.test(api.url)) continue;
    const tail = `${api.method} ${api.url.replace(/^(https?:\/\/[^/]+|\{[^}]+\})/, '').replace(/^\/api(?=\/)/, '').replace(/:\w+/g, ':_')}`;
    byTail.set(tail, [...(byTail.get(tail) ?? []), api]);
  }
  for (const group of byTail.values()) {
    if (group.length < 2) continue;
    for (const api of group) {
      const others = group.filter((x) => x !== api);
      api.issues.push({
        kind: 'inconsistent-url',
        severity: 'warning',
        title: 'Same address, different base',
        message: `This looks like the same endpoint as ${others.map((o) => `${o.method} ${o.url}`).join(', ')}, but with a different base address. One of them may be calling the wrong server.`,
        places: [...api.callers.slice(0, 3), ...others.flatMap((o) => o.callers.slice(0, 2))].map((c) =>
          place(c.request.path, c.request.line, `${c.written}`),
        ),
        proposal: {
          summary: 'Use one base address for all requests to this server.',
          steps: ['Pick the correct base address.', 'Create one HTTP client or constant with that base, and use it for every request.'],
        },
      });
    }
  }

  // ---- Problems across all API calls ----
  const apiIssues: ApiIssue[] = [];
  const inline = [...allSites.values()].filter((s) => !s.shared);
  const inlineComponents = unique(inline.flatMap((s) => s.callers.map((c) => c.component)));
  if (inline.length >= 3 && inlineComponents.length >= 2) {
    const file = apiFile ?? `${root}/api/index.${ts ? 'ts' : 'js'}`;
    const planned: string[] = [];
    const reuse: string[] = [];
    for (const a of apis) {
      const sites = sitesByEndpoint.get(a.id) ?? [];
      if (!sites.some((s) => !s.shared)) continue;
      const existing = sites.find((s) => s.shared);
      if (existing) reuse.push(`${existing.sharedName}() already exists for ${a.method} ${a.url}`);
      else planned.push(`${suggestName(a.method, a.url.startsWith('(') ? undefined : a.url)}() for ${a.method} ${a.url}`);
    }
    apiIssues.push({
      kind: 'scattered',
      severity: 'info',
      title: `${inline.length} requests are written directly inside components`,
      message: `Requests are sent straight from ${inlineComponents.length} components instead of one shared place. That makes them hard to find, reuse and change together.`,
      places: inline.map((s) => place(s.path, s.line, `${unique(s.callers.map((c) => name(c.component))).join(', ')}: ${s.written}`)),
      proposal: {
        summary: apiFile ? `Move them into your existing API file, ${apiFile}.` : `Collect them in one API file, ${file}.`,
        steps: [
          ...(planned.length ? [`Create these functions in ${file}:`, ...unique(planned).map((p) => `  • ${p}`)] : []),
          ...(reuse.length ? ['Reuse what already exists:', ...unique(reuse).map((p) => `  • ${p}`)] : []),
          'In each component, call the function instead of sending the request.',
        ],
        file,
      },
    });
  }

  const clients = new Map<string, number>();
  for (const s of allSites.values()) if (s.client !== 'swr' && s.client !== 'http') clients.set(s.client, (clients.get(s.client) ?? 0) + 1);
  if (clients.size > 1) {
    const ranked = [...clients].sort((a, b) => b[1] - a[1]);
    apiIssues.push({
      kind: 'mixed-clients',
      severity: 'info',
      title: `${clients.size} different ways of sending requests`,
      message: `Requests use ${ranked.map(([c, n]) => `${c} (${n})`).join(', ')}. Each handles errors, headers and timeouts differently.`,
      places: [...allSites.values()]
        .filter((s) => s.client !== ranked[0][0] && clients.has(s.client))
        .map((s) => place(s.path, s.line, `uses ${s.client}`)),
      proposal: {
        summary: `Use ${ranked[0][0]} everywhere, since most requests already do.`,
        steps: [`Change the ${ranked.slice(1).map(([c]) => c).join(' and ')} requests to ${ranked[0][0]}.`],
      },
    });
  }

  apis.sort((a, b) => a.resource.localeCompare(b.resource) || a.url.localeCompare(b.url) || methodRank(a.method) - methodRank(b.method));
  return { apis, apiIssues };
}

// ---------------------------------------------------------------------------

function endpointId(d: DataUse): string {
  return `${d.method} ${d.url ? d.url.replace(/:\w+/g, ':_') : `(dynamic) ${d.written}`}`;
}

/** Pages a component appears on: its own routes plus those of every component above it. */
function pagesFinder(byId: Map<string, FeComponent>) {
  const cache = new Map<string, string[]>();
  return (id: string): string[] => {
    if (cache.has(id)) return cache.get(id)!;
    const seen = new Set<string>();
    const found = new Set<string>();
    const stack = [id];
    while (stack.length) {
      const cur = stack.pop()!;
      if (seen.has(cur)) continue;
      seen.add(cur);
      const c = byId.get(cur);
      if (!c) continue;
      for (const r of c.routes) found.add(r);
      for (const u of c.usedBy) if (u.from) stack.push(u.from);
    }
    const out = [...found].sort();
    cache.set(id, out);
    return out;
  };
}

function isAncestor(byId: Map<string, FeComponent>, ancestor: string, child: string): boolean {
  const seen = new Set<string>();
  const stack = [child];
  while (stack.length) {
    const cur = stack.pop()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const u of byId.get(cur)?.usedBy ?? []) {
      if (!u.from) continue;
      if (u.from === ancestor) return true;
      stack.push(u.from);
    }
  }
  return false;
}

function resourceOf(url: string | undefined): string {
  if (!url) return 'Dynamic addresses';
  const m = url.match(/^(https?:\/\/[^/]+|\{[^}]+\})?(.*)$/)!;
  const prefix = m[1] ?? '';
  const statics: string[] = [];
  for (const seg of m[2].split('/').filter(Boolean)) {
    if (seg.startsWith(':') || seg.startsWith('{')) break;
    statics.push(seg);
    if (statics.length === 2 || (statics.length === 1 && !/^(api|v\d+|rest)$/.test(seg))) break;
  }
  return `${prefix}/${statics.join('/')}`;
}

function resourceFileName(url: string | undefined): string {
  const statics = (url ?? '').split('/').filter((s) => s && !s.startsWith(':') && !s.startsWith('{') && !/^(api|v\d+|https?:)$/.test(s) && !s.includes('.'));
  return statics[0] ? camel(statics[0]) : 'requests';
}

/** GET /api/orders → getOrders, GET /api/orders/:id → getOrder, POST /orders → createOrder. */
export function suggestName(method: string, url: string | undefined): string {
  const segs = (url ?? '').split('/').filter(Boolean);
  const endsWithParam = segs.length > 0 && segs[segs.length - 1].startsWith(':');
  const statics = segs.filter((s) => !s.startsWith(':') && !s.startsWith('{') && !/^(api|v\d+|https?:)$/.test(s) && !s.includes('.'));
  const noun = camel(statics[statics.length - 1] ?? 'data');
  const one = pascal(singular(noun));
  const many = pascal(noun);
  switch (method) {
    case 'GET':
      return `get${endsWithParam ? one : many}`;
    case 'POST':
      return `create${one}`;
    case 'PUT':
    case 'PATCH':
      return `update${one}`;
    case 'DELETE':
      return `delete${one}`;
    default:
      return `request${many}`;
  }
}

function functionSnippet(fnName: string, method: string, url: string | undefined, site: Site, ts: boolean): string {
  const params = (url?.match(/:(\w+)/g) ?? []).map((p) => p.slice(1));
  const hasBody = method === 'POST' || method === 'PUT' || method === 'PATCH';
  const args = [...params.map((p) => `${p}${ts ? ': string' : ''}`), ...(hasBody ? [`body${ts ? ': unknown' : ''}`] : [])].join(', ');
  const address = `\`${(url ?? '/address')
    .replace(/:(\w+)/g, '${$1}')
    .replace(/\{(VITE_\w+)\}/g, '${import.meta.env.$1}')
    .replace(/\{([A-Z][A-Z0-9_]*)\}/g, '${process.env.$1}')
    .replace(/\{(\w+)\}/g, '${$1}')}\``;
  const verb = method.toLowerCase();
  // A shared client instance (http.get('/me')): keep using it with the address as the project writes it.
  if (site.clientVar) {
    return `export async function ${fnName}(${args}) {\n  const { data } = await ${site.clientVar}.${verb}(${site.written}${hasBody ? ', body' : ''})\n  return data\n}`;
  }
  if (site.client === 'axios') {
    return `export async function ${fnName}(${args}) {\n  const { data } = await axios.${verb}(${address}${hasBody ? ', body' : ''})\n  return data\n}`;
  }
  if (site.client === 'ky' || site.client === 'ofetch') {
    return `export async function ${fnName}(${args}) {\n  return ${site.client}.${verb}(${address}${hasBody ? ', { json: body }' : ''}).json()\n}`;
  }
  const options =
    method === 'GET'
      ? ''
      : hasBody
        ? `, {\n    method: '${method}',\n    headers: { 'Content-Type': 'application/json' },\n    body: JSON.stringify(body),\n  }`
        : `, { method: '${method}' }`;
  return [
    `export async function ${fnName}(${args}) {`,
    `  const res = await fetch(${address}${options})`,
    `  if (!res.ok) throw new Error(\`${method} ${url ?? ''} failed: \${res.status}\`)`,
    `  return res.json()`,
    `}`,
  ].join('\n');
}

function isHardcodedHost(url: string): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])([:/]|$)/.test(url) || /^https?:\/\/[^/]+:\d+/.test(url);
}

function mostCommon(items: string[]): string | undefined {
  const counts = new Map<string, number>();
  for (const i of items) counts.set(i, (counts.get(i) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function methodRank(m: string): number {
  return ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].indexOf(m) + 1 || 9;
}

function camel(s: string): string {
  return s.replace(/[-_\s]+(\w)/g, (_, c: string) => c.toUpperCase()).replace(/^\w/, (c) => c.toLowerCase());
}

function pascal(s: string): string {
  return s.replace(/^\w/, (c) => c.toUpperCase());
}

function singular(s: string): string {
  if (/ies$/.test(s)) return s.replace(/ies$/, 'y');
  if (/(ss|us)$/.test(s)) return s;
  if (/(ch|sh|x|z)es$/.test(s)) return s.replace(/es$/, '');
  return s.replace(/s$/, '');
}

