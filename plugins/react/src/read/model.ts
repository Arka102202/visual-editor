// The React model: components, routes and API calls, as read from source. Pure: no Node or VS Code imports.

export interface PropInfo {
  name: string;
  /** Type as written in code, when known. */
  type?: string;
  optional: boolean;
  /** A function prop: the component reports something back to its parent (onSave, onClose…). */
  isCallback: boolean;
  /** Where we learned about it: a declared type, or how the component uses it. */
  source: 'type' | 'usage';
}

export type DataKind = 'api' | 'query' | 'db' | 'store' | 'context' | 'router';

export interface DataUse {
  kind: DataKind;
  /** e.g. `GET /api/users`, `db.projects`, `useCanvasStore`, `useQuery ['projects', id]`. */
  label: string;
  /** Workspace-relative file and 0-based line where it happens. */
  path: string;
  line: number;
  /** Set when it happens inside a hook or function the component calls, e.g. `useEditor`. */
  via?: string;
  /** When it fires: while the screen loads (effects, query hooks) or on a user action (click, submit). */
  trigger?: Trigger;
  /** For API calls: the HTTP method, the address, and how it was written. */
  method?: string;
  url?: string;
  written?: string;
  /** For API calls: fetch, axios, ky… */
  client?: string;
  /** For API calls through a shared client instance: its variable name, e.g. `http`. */
  clientVar?: string;
  /** Where the component starts the chain (its own line that leads to the request). */
  entry?: { path: string; line: number };
}

export type Trigger = 'load' | 'action';

export interface RenderRef {
  /** Tag as written, e.g. `Button` or `Modal.Header`. */
  tag: string;
  line: number;
  /** Project component id when resolved. */
  target?: string;
  /** npm package when the tag comes from a library. */
  pkg?: string;
}

export interface UsageRef {
  /** Component id of the parent, or undefined when used outside any component (e.g. a route table). */
  from?: string;
  path: string;
  line: number;
  how: 'renders' | 'references';
}

export type IssueKind = 'unused' | 'no-error-state' | 'no-loading-state' | 'duplicate-name' | 'similar' | 'unknown';

export interface Issue {
  kind: IssueKind;
  message: string;
  /** Another component involved, for duplicates and look-alikes. */
  related?: string;
}

export interface FeComponent {
  /** `path#Name`, unique across the project. */
  id: string;
  name: string;
  path: string;
  line: number;
  kind: 'function' | 'class';
  /** Component defined inside another component. */
  parent?: string;
  props: PropInfo[];
  /** Props spread through (`{...rest}`) so the full input list is open-ended. */
  acceptsRest: boolean;
  renders: RenderRef[];
  usedBy: UsageRef[];
  hooks: string[];
  data: DataUse[];
  states: { loading: boolean; error: boolean; empty: boolean };
  routes: string[];
  isRoot: boolean;
  issues: Issue[];
}

export interface FeRoute {
  path: string;
  /** Component id when resolved. */
  target?: string;
  /** Tag/name as written when it could not be resolved. */
  label: string;
  file: string;
  line: number;
  /** Layout components around it (ids, outer first): routes that wrap it and render it in an <Outlet/>. */
  layouts?: string[];
}

export interface CodePlace {
  path: string;
  line: number;
  label: string;
}

/** One component that triggers a request to an endpoint. */
export interface ApiCaller {
  component: string;
  trigger?: Trigger;
  /** Hooks and functions between the component and the request, e.g. `useOrders → api.getOrders`. */
  via?: string;
  /** The line that sends the request. */
  request: { path: string; line: number };
  /** The component's own line that starts it. */
  entry: { path: string; line: number };
  /** Pages this component appears on. */
  pages: string[];
  client: string;
  /** The shared client instance used, e.g. `http` for `http.get('/me')`. */
  clientVar?: string;
  /** The address exactly as written at the request line. */
  written: string;
}

export type ApiIssueKind =
  | 'multiple-handlers'
  | 'double-load'
  | 'scattered'
  | 'inconsistent-url'
  | 'hardcoded-host'
  | 'mixed-clients'
  | 'no-error-state';

export interface ApiIssue {
  kind: ApiIssueKind;
  severity: 'warning' | 'info';
  title: string;
  /** Plain-language explanation of the problem. */
  message: string;
  places: CodePlace[];
  /** A suggestion only: nothing is changed automatically. */
  proposal: { summary: string; steps: string[]; snippet?: string; file?: string };
}

export interface ApiEndpoint {
  /** `GET /api/orders/:id` with parameter names normalised. */
  id: string;
  method: string;
  url: string;
  /** For grouping, e.g. `/api/orders`. */
  resource: string;
  callers: ApiCaller[];
  /** Distinct lines of code that send this request. */
  requestSites: number;
  issues: ApiIssue[];
}

export interface FeModel {
  components: FeComponent[];
  routes: FeRoute[];
  apis: ApiEndpoint[];
  /** Problems that concern all API calls, not one endpoint (scattered calls, mixed clients). */
  apiIssues: ApiIssue[];
  stats: { files: number; parseErrors: string[] };
}
