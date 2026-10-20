// A project's contracts: the files found in it by their names (openapi.yaml, swagger.json, *.postman_collection.json,
// *.har, *.schema.json, schema.graphql), and what .visual-editor/contracts.json lists (more files, among them
// TypeScript types, Zod schemas and JSON examples; addresses a backend serves its contract at, like /v3/api-docs; and
// which type an endpoint answers with: "GET /api/orders": "Order[]"). From them: an answer for an endpoint (from its
// example or made from its shape; for GraphQL, shaped by the query), and a check of a real answer. No VS Code APIs.

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { fits } from '../proxy/fakePaths';
import { readContract, readJsonExample, type Contract, type Operation } from './readers';
import { check, exampleOf, type Schema } from './schema';
import { checkGraphql, graphqlAnswer, type GraphqlRequest } from './graphql';

export const CONTRACTS_FILE = '.visual-editor/contracts.json';

export interface ContractsConfig {
  /** More contracts: project files (relative to it) and addresses (http…, or /path on the app's own backend). */
  sources?: string[];
  /** Found files not to use. */
  ignore?: string[];
  /** Which type an endpoint answers with, for contracts that only have types: "GET /api/orders/:id": "Order" (Order[]: a list). */
  map?: Record<string, string>;
}

/** Which part of a contract a fake answers from. */
export interface ContractRef {
  /** An operation's id ("GET /api/orders/:id"); none: the one that fits the call. */
  operation?: string;
  /** Or a named type ("Order", "Order[]"). */
  type?: string;
  /** Which of the operation's answers ("200", "404"); none: the first success. */
  status?: string;
  /** Another set of made-up values (0, 1, 2…). */
  seed?: number;
}

/** A contract in short, for the page. */
export interface ContractInfo {
  source: string;
  kind: string;
  title?: string;
  error?: string;
  /** Found by its name (not listed in contracts.json). */
  found?: boolean;
  operations: { id: string; method: string; path: string; summary?: string; statuses: string[] }[];
  types: string[];
}

const FOUND = /^(openapi|swagger)[\w.-]*\.(ya?ml|json)$|^api(-docs|-spec)?\.(ya?ml)$|\.postman_collection\.json$|\.har$|\.schema\.json$|^schema\.(graphql|gql)$|\.graphqls$/i;
const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt', '.svelte-kit', 'coverage', '.turbo', '.cache', 'vendor', 'target', '.venv', 'venv', '__pycache__']);

export class Contracts {
  list: Contract[] = [];
  config: ContractsConfig = {};
  private found = new Set<string>();

  constructor(
    readonly root: string,
    /** Reads an address (a contract a backend serves). */
    private readonly fetchText: (url: string) => Promise<string | undefined> = defaultFetch,
  ) {}

  get file(): string {
    return join(this.root, CONTRACTS_FILE);
  }

  /** Reads contracts.json, finds contract files, and reads every contract (addresses too). */
  async load(): Promise<void> {
    this.config = {};
    try {
      if (existsSync(this.file)) this.config = JSON.parse(readFileSync(this.file, 'utf8'));
    } catch {
      // Being edited: as if empty until it's valid.
    }
    this.found = new Set(findFiles(this.root));
    const ignore = new Set(this.config.ignore ?? []);
    const listed = (this.config.sources ?? []).filter((s) => !ignore.has(s));
    const files = [...new Set([...[...this.found].filter((f) => !ignore.has(f)), ...listed])];
    const out: Contract[] = [];
    for (const source of files) {
      const c = /^https?:\/\/|^\//.test(source) && !existsSync(join(this.root, source)) ? await this.readAddress(source) : this.readFile(source);
      if (c) out.push(c);
    }
    const mapped = this.mapped(out);
    if (mapped) out.push(mapped);
    this.list = out;
  }

  private readFile(source: string): Contract | undefined {
    const path = isAbsolute(source) ? source : join(this.root, source);
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch (e) {
      return { ...readJsonExample(source, null), types: {}, error: `couldn't read it: ${e instanceof Error ? e.message : String(e)}` };
    }
    const c = readContract(source, text);
    if (c) return c;
    // Listed but not a contract of any known kind: a JSON example.
    if (/\.json$/i.test(source)) {
      try {
        return readJsonExample(source, JSON.parse(text));
      } catch (e) {
        return { ...readJsonExample(source, null), types: {}, error: `not JSON: ${e instanceof Error ? e.message : String(e)}` };
      }
    }
    return { ...readJsonExample(source, null), types: {}, error: 'no contract found in it (OpenAPI, Swagger, Postman, HAR, JSON Schema, TypeScript types, Zod or GraphQL)' };
  }

  private async readAddress(source: string): Promise<Contract> {
    let text: string | undefined;
    try {
      text = await this.fetchText(source);
    } catch (e) {
      return { ...readJsonExample(source, null), types: {}, error: `couldn't read it: ${e instanceof Error ? e.message : String(e)}` };
    }
    if (text === undefined) return { ...readJsonExample(source, null), types: {}, error: 'no answer from it (is the backend running?)' };
    const json = /^\s*[{[]/.test(text);
    const sdl = !json && /^\s*(type|schema|enum|input|interface|union|scalar|directive|extend)\b/m.test(text) && /\{/.test(text) && !/^\s*(openapi|swagger)\s*:/m.test(text);
    const name = sdl ? `${source}#.graphql` : json ? `${source}#.json` : `${source}#.yaml`;
    const c = readContract(name, text);
    return c ? { ...c, source } : { ...readJsonExample(source, null), types: {}, error: 'what it answered isn’t a contract Visual Editor knows' };
  }

  /** contracts.json's "map": endpoints answered with named types. */
  private mapped(list: Contract[]): Contract | undefined {
    const map = Object.entries(this.config.map ?? {});
    if (!map.length) return undefined;
    const operations: Operation[] = [];
    for (const [id, type] of map) {
      const [method, path] = id.trim().split(/\s+/);
      if (!method || !path) continue;
      operations.push({ id: `${method.toUpperCase()} ${path}`, method: method.toUpperCase(), path, responses: [{ status: '200', schema: typeSchema(type) }] });
    }
    return {
      source: CONTRACTS_FILE,
      kind: 'json-schema',
      title: 'Endpoints and their types',
      operations,
      types: {},
      resolve: (ref) => {
        const name = decodeURIComponent(ref.replace(/^#\/types\//, ''));
        for (const c of list) if (c.types[name]) return c.types[name];
        return undefined;
      },
    };
  }

  saveConfig(config: ContractsConfig) {
    mkdirSync(join(this.root, '.visual-editor'), { recursive: true });
    writeFileSync(this.file, `${JSON.stringify(config, null, 2)}\n`);
  }

  /** Adds a source (a file in the project, or an address) to contracts.json. */
  add(source: string) {
    const s = isAbsolute(source) ? relative(this.root, source) : source.trim();
    const sources = [...new Set([...(this.config.sources ?? []), s])];
    const ignore = (this.config.ignore ?? []).filter((x) => x !== s);
    this.saveConfig({ ...this.config, sources, ignore: ignore.length ? ignore : undefined });
  }

  /** Stops using a source (a found file is then ignored). */
  remove(source: string) {
    const sources = (this.config.sources ?? []).filter((x) => x !== source);
    const ignore = this.found.has(source) ? [...new Set([...(this.config.ignore ?? []), source])] : this.config.ignore;
    this.saveConfig({ ...this.config, sources, ...(ignore?.length ? { ignore } : { ignore: undefined }) });
  }

  /** Sets (or, with no type, removes) the type an endpoint answers with. */
  mapType(operation: string, type: string | undefined) {
    const map = { ...(this.config.map ?? {}) };
    if (type) map[operation] = type;
    else delete map[operation];
    this.saveConfig({ ...this.config, map });
  }

  /** The operation a call is for (the most specific address that fits), in the first contract that has one. */
  find(method: string, path: string): { contract: Contract; operation: Operation } | undefined {
    const m = method.toUpperCase();
    const hits: { contract: Contract; operation: Operation }[] = [];
    for (const contract of this.list) for (const operation of contract.operations) if (operation.method === m && fits(operation.path, path)) hits.push({ contract, operation });
    return hits.sort((a, b) => params(a.operation.path) - params(b.operation.path))[0];
  }

  byId(id: string): { contract: Contract; operation: Operation } | undefined {
    for (const contract of this.list) {
      const operation = contract.operations.find((o) => o.id === id);
      if (operation) return { contract, operation };
    }
    return undefined;
  }

  /** A named type's shape, and the contract it's in ("Order[]": a list of them). */
  typeOf(name: string): { contract: Contract; schema: Schema } | undefined {
    const one = name.replace(/\[\]$/, '');
    const contract = this.list.find((c) => c.types[one]);
    return contract ? { contract, schema: typeSchema(name) } : undefined;
  }

  /**
   * An answer made from the contract: an operation's example (or one made from its shape), a type's, or for GraphQL
   * one shaped by the query. Undefined when the contract has nothing for it.
   */
  answer(ref: ContractRef, call: { method: string; path: string; body?: string }): { status: number; body: unknown } | undefined {
    const seed = ref.seed ?? 0;
    if (ref.type) {
      const t = this.typeOf(ref.type);
      return t ? { status: Number(ref.status) || 200, body: exampleOf(t.schema, t.contract.resolve, '', seed) } : undefined;
    }
    const hit = ref.operation ? this.byId(ref.operation) : this.find(call.method, call.path);
    if (!hit) return undefined;
    if (hit.contract.graphql) return { status: 200, body: graphqlAnswer(hit.contract.graphql, graphqlRequest(call.body)) };
    const responses = hit.operation.responses;
    const r = (ref.status ? responses.find((x) => x.status === ref.status) : undefined) ?? responses.find((x) => /^2/.test(x.status)) ?? responses[0];
    if (!r) return { status: 200, body: {} };
    const status = Number(r.status) || (r.status === 'default' ? 200 : 200);
    if (r.example !== undefined && seed === 0) return { status, body: r.example };
    return { status, body: r.schema ? exampleOf(r.schema, hit.contract.resolve, '', seed) : (r.example ?? {}) };
  }

  /** How a real answer differs from its contract (undefined: no contract has the call). */
  check(method: string, path: string, status: number, body: unknown, requestBody?: string): { operation: string; source: string; issues: string[] } | undefined {
    const hit = this.find(method, path);
    if (!hit) return undefined;
    const base = { operation: hit.operation.id, source: hit.contract.source };
    if (hit.contract.graphql) return { ...base, issues: checkGraphql(hit.contract.graphql, graphqlRequest(requestBody), body) };
    const r = hit.operation.responses.find((x) => x.status === String(status)) ?? hit.operation.responses.find((x) => x.status === `${String(status)[0]}XX`) ?? hit.operation.responses.find((x) => x.status === 'default');
    if (!r) {
      const known = hit.operation.responses.map((x) => x.status).join(', ');
      return { ...base, issues: known ? [`status ${status}: the contract doesn't list it (it lists ${known})`] : [] };
    }
    if (!r.schema) return { ...base, issues: [] };
    return { ...base, issues: check(r.schema, body, hit.contract.resolve) };
  }

  /** The contracts in short, for the page. */
  info(): ContractInfo[] {
    return this.list.map((c) => ({
      source: c.source,
      kind: c.kind,
      ...(c.title ? { title: c.title } : {}),
      ...(c.error ? { error: c.error } : {}),
      ...(this.found.has(c.source) ? { found: true } : {}),
      operations: c.operations.map((o) => ({ id: o.id, method: o.method, path: o.path, ...(o.summary ? { summary: o.summary } : {}), statuses: o.responses.map((r) => r.status) })),
      types: Object.keys(c.types),
    }));
  }
}

/** "Order" or "Order[]" as a shape. */
function typeSchema(type: string): Schema {
  const list = /\[\]$/.test(type.trim());
  const ref: Schema = { $ref: `#/types/${encodeURIComponent(type.trim().replace(/\[\]$/, ''))}` };
  return list ? { type: 'array', items: ref } : ref;
}

function params(path: string): number {
  return (path.match(/:\w+|\*/g) ?? []).length;
}

function graphqlRequest(body: string | undefined): GraphqlRequest {
  try {
    const data = JSON.parse(body ?? '{}');
    return Array.isArray(data) ? data[0] : data;
  } catch {
    return {};
  }
}

/** Contract files in the project, by their names (not in node_modules, build folders and the like). */
function findFiles(root: string): string[] {
  const out: string[] = [];
  let seen = 0;
  const walk = (dir: string, depth: number) => {
    if (depth > 6 || seen > 5000) return;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      seen++;
      if (SKIP.has(name) || (name.startsWith('.') && name !== '.visual-editor')) continue;
      const path = join(dir, name);
      let st;
      try {
        st = statSync(path);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(path, depth + 1);
      else if (FOUND.test(name) && st.size < 20 * 1024 * 1024) out.push(relative(root, path));
    }
  };
  walk(root, 0);
  return out.sort();
}

async function defaultFetch(url: string): Promise<string | undefined> {
  const r = await fetch(url, { signal: AbortSignal.timeout(5000), headers: { accept: 'application/json, application/yaml, text/yaml, */*' } });
  return r.ok ? await r.text() : undefined;
}
