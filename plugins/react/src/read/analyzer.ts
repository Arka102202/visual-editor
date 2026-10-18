// Builds the component map from source text. Works on any React codebase:
// it finds components by what they do (return JSX), not by folder or file
// naming, and degrades to "unknown" instead of guessing.
// Pure: no VS Code APIs, so it can be unit tested in plain Node.

import type * as t from '@babel/types';
import { forEachChild, line, parseSource, sliceText, walk, type SourceFile } from './ast';
import type { DataUse, FeComponent, FeModel, FeRoute, Issue, PropInfo, RenderRef, Trigger } from './model';
import { buildApiReport } from './apiReport';
import { resolveImport, type Alias } from './resolve';

export type { SourceFile };

/** Files that only exercise components; they'd make everything look "used". */
export const IGNORED_FILE = /(\.(test|spec|stories|story)\.[cm]?[jt]sx?$)|(^|\/)(__tests__|__mocks__|\.storybook)\//;

const QUERY_HOOKS = new Set([
  'useQuery', 'useQueries', 'useInfiniteQuery', 'useSuspenseQuery', 'useMutation',
  'useSWR', 'useSWRInfinite', 'useSWRMutation', 'useLazyQuery', 'useSubscription', 'useLiveQuery',
]);
const STORE_HOOKS = new Set(['useSelector', 'useAppSelector', 'useDispatch', 'useAppDispatch', 'useStore', 'useAtom', 'useAtomValue', 'useSetAtom', 'useRecoilState', 'useRecoilValue', 'useSnapshot']);
const ROUTER_HOOKS = new Set(['useNavigate', 'useParams', 'useLocation', 'useSearchParams', 'useRouter', 'usePathname', 'useMatch', 'useHistory', 'useRouteMatch']);
const STORE_FACTORIES = new Set(['create', 'createStore', 'createWithEqualityFn', 'defineStore', 'createContext', 'atom', 'proxy']);
const LAZY = new Set(['lazy', 'loadable', 'dynamic']);
/** Calls that create a database / backend client: `export const db = createClient(...)`. */
const CLIENT_FACTORIES = /^(createClient|initializeApp|getFirestore|getDatabase|drizzle|createPool|knex|createConnection|createTRPCProxyClient|createTRPCReact|createApi)$/;
const MAX_DEPTH = 4;
/** Hooks whose callbacks run while the screen loads. */
const LOAD_HOOKS = new Set(['useEffect', 'useLayoutEffect', 'useInsertionEffect', 'useQuery', 'useSuspenseQuery', 'useInfiniteQuery', 'useQueries', 'useSWR', 'useSWRInfinite', 'useLiveQuery']);
/** Hooks whose callbacks run on a user action. */
const ACTION_HOOKS = new Set(['useMutation', 'useSWRMutation', 'useLazyQuery']);
/** Function names that are almost always event handlers. */
const ACTION_NAME = /^(handle|on)[A-Z]|^(submit|save|delete|remove|create|update|send|add|post|upload|login|logout|signIn|signOut|register|toggle|confirm|cancel|approve|reject|refresh|retry|reload)(?=[A-Z_]|$)/;
/** HTTP client packages: direct calls (`axios(...)`), verbs (`axios.get`) and instances (`axios.create`). */
const HTTP_PACKAGES = new Set(['axios', 'ky', 'ofetch', 'redaxios', 'got', 'superagent']);
const HTTP_VERBS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head']);

type N = t.Node;
type FnNode = t.Function | t.Class;

interface Binding {
  from: string;
  imported: string;
}

interface CompDef {
  comp: FeComponent;
  node: FnNode;
  propsParam?: string;
  /** Props known by name: drives callback-call detection. */
  propNames: Set<string>;
  facts: Facts;
}

interface FnDef {
  key: string;
  name: string;
  path: string;
  node: t.Function;
  facts: Facts;
}

/** Where a fact happened inside its component/function: when it fires, and the local function around it. */
interface Origin {
  trigger?: Trigger;
  localFn?: string;
}

interface Facts {
  data: (DataUse & Origin)[];
  /** Project functions/hooks this one calls, with the calling line. */
  calls: ({ key: string; name: string; line: number } & Origin)[];
  /** Local names used where the trigger is known: `onClick={save}`, `useEffect(() => load())`. */
  localUses: { name: string; trigger: Trigger }[];
  idents: Set<string>;
  text: string[];
}

interface FileInfo {
  path: string;
  text: string;
  ast?: t.File;
  imports: Map<string, Binding>;
  exports: Map<string, { local?: string; from?: string; imported?: string }>;
  exportAll: string[];
  /** local name → component (includes aliases like `const X = memo(Y)` → Y). */
  components: Map<string, CompDef>;
  aliases: Map<string, string>;
  functions: Map<string, FnDef>;
  /** Objects whose properties are functions, e.g. `export const api = { getUsers() {} }`. */
  objects: Set<string>;
  storeHooks: Set<string>;
  /** Database/backend client instances: `new Dexie()`, `new PrismaClient()`, `createClient()`. */
  clients: Set<string>;
  /** HTTP client instances: `const api = axios.create({ baseURL })`. */
  httpClients: Map<string, { client: string; base?: t.Node }>;
  /** Every variable declared anywhere in the file, for following `const url = …`. */
  localVars: Map<string, t.Node[]>;
  /** Every file-level `const`/`let`, so imports of them can be followed. */
  variables: Set<string>;
  types: Map<string, t.TSInterfaceDeclaration | t.TSTypeAliasDeclaration>;
  constants: Map<string, string | Map<string, string>>;
}

type Resolved = { file: string; local: string } | { pkg: string } | undefined;

export function analyzeProject(sources: SourceFile[], aliases: Alias[]): FeModel {
  const sourceSet = new Set(sources.map((s) => s.path));
  const parseErrors: string[] = [];
  const files = new Map<string, FileInfo>();

  for (const source of sources) {
    if (IGNORED_FILE.test(source.path)) continue;
    const info = emptyInfo(source);
    info.ast = parseSource(source);
    if (!info.ast) parseErrors.push(source.path);
    files.set(source.path, info);
  }

  const project = new Project(files, aliases, sourceSet);
  for (const f of files.values()) project.collectModule(f);
  for (const f of files.values()) project.discover(f);
  for (const f of files.values()) project.analyzeUsage(f);
  project.collectNextRoutes();

  const components = project.finish();
  return {
    components,
    routes: project.routes,
    ...buildApiReport(components),
    stats: { files: files.size, parseErrors },
  };
}

class Project {
  readonly routes: FeRoute[] = [];
  private readonly byId = new Map<string, CompDef>();
  private readonly fnByKey = new Map<string, FnDef>();
  private readonly compByNode = new Map<N, CompDef>();
  private readonly fnByNode = new Map<N, FnDef>();
  /** Components mentioned in a file-level variable, e.g. `const NODE_TYPES = { db: DBNode }`. */
  private readonly heldBy: { target: CompDef; file: string; variable: string; line: number }[] = [];

  constructor(
    private readonly files: Map<string, FileInfo>,
    private readonly aliasList: Alias[],
    private readonly sourceSet: Set<string>,
  ) {}

  private resolveSpec(spec: string, from: string): string {
    return resolveImport(spec, from, this.aliasList, this.sourceSet);
  }

  // ---- Pass 1: imports, exports, types, constants ----

  collectModule(f: FileInfo) {
    const body = f.ast?.program.body ?? [];
    for (const stmt of body) {
      if (stmt.type === 'ImportDeclaration') {
        const from = this.resolveSpec(stmt.source.value, f.path);
        for (const s of stmt.specifiers) {
          const imported =
            s.type === 'ImportDefaultSpecifier' ? 'default' : s.type === 'ImportNamespaceSpecifier' ? '*' : nameOf(s.imported);
          f.imports.set(s.local.name, { from, imported });
        }
      } else if (stmt.type === 'ExportNamedDeclaration') {
        if (stmt.source) {
          const from = this.resolveSpec(stmt.source.value, f.path);
          for (const s of stmt.specifiers) {
            if (s.type === 'ExportSpecifier') f.exports.set(nameOf(s.exported), { from, imported: s.local.name });
            else if (s.type === 'ExportDefaultSpecifier') f.exports.set(s.exported.name, { from, imported: 'default' });
          }
        } else {
          for (const s of stmt.specifiers) {
            if (s.type === 'ExportSpecifier') f.exports.set(nameOf(s.exported), { local: s.local.name });
          }
        }
        if (stmt.declaration) {
          for (const name of declaredNames(stmt.declaration)) f.exports.set(name, { local: name });
          this.collectDeclaration(f, stmt.declaration);
        }
      } else if (stmt.type === 'ExportAllDeclaration') {
        f.exportAll.push(this.resolveSpec(stmt.source.value, f.path));
      } else if (stmt.type === 'ExportDefaultDeclaration') {
        const d = stmt.declaration;
        if (d.type === 'Identifier') f.exports.set('default', { local: d.name });
        else if ((d.type === 'FunctionDeclaration' || d.type === 'ClassDeclaration') && d.id) {
          f.exports.set('default', { local: d.id.name });
        } else {
          const ref = unwrapRef(d as t.Expression);
          if (ref) f.exports.set('default', { local: ref });
          // Anonymous default components are registered in discover().
        }
      } else if (stmt.type === 'ExpressionStatement') {
        // module.exports = Foo
        const e = stmt.expression;
        if (
          e.type === 'AssignmentExpression' &&
          e.left.type === 'MemberExpression' &&
          e.left.object.type === 'Identifier' &&
          e.left.object.name === 'module' &&
          e.right.type === 'Identifier'
        ) {
          f.exports.set('default', { local: e.right.name });
        }
      } else {
        this.collectDeclaration(f, stmt);
      }
    }
  }

  private collectDeclaration(f: FileInfo, d: N) {
    if (d.type === 'TSInterfaceDeclaration' || d.type === 'TSTypeAliasDeclaration') {
      f.types.set(d.id.name, d);
    } else if (d.type === 'VariableDeclaration') {
      for (const v of d.declarations) {
        if (v.id.type !== 'Identifier' || !v.init) continue;
        const name = v.id.name;
        const init = stripExpr(v.init);
        // const Editor = lazy(() => import('./Editor'))
        const lazyPath = lazyImport(init);
        if (lazyPath) {
          f.imports.set(name, { from: this.resolveSpec(lazyPath, f.path), imported: 'default' });
          continue;
        }
        // const x = require('./x')
        if (init.type === 'CallExpression' && init.callee.type === 'Identifier' && init.callee.name === 'require') {
          const arg = init.arguments[0];
          if (arg?.type === 'StringLiteral') f.imports.set(name, { from: this.resolveSpec(arg.value, f.path), imported: 'default' });
          continue;
        }
        if (/^use/.test(name) && init.type === 'CallExpression' && STORE_FACTORIES.has(calleeRoot(init))) {
          f.storeHooks.add(name);
        }
        // const api = axios.create({ baseURL: ... })
        if (
          init.type === 'CallExpression' &&
          init.callee.type === 'MemberExpression' &&
          init.callee.object.type === 'Identifier' &&
          init.callee.property.type === 'Identifier' &&
          /^(create|extend)$/.test(init.callee.property.name)
        ) {
          const pkg = f.imports.get(init.callee.object.name)?.from.replace(/^pkg:/, '') ?? init.callee.object.name;
          if (HTTP_PACKAGES.has(pkg)) {
            const options = init.arguments[0];
            const base =
              options?.type === 'ObjectExpression'
                ? (options.properties.find(
                    (p) => p.type === 'ObjectProperty' && /^(baseURL|baseUrl|prefixUrl)$/.test(nameOf(p.key)),
                  ) as t.ObjectProperty | undefined)?.value
                : undefined;
            f.httpClients.set(name, { client: pkg, base });
          }
        }
        if (init.type === 'NewExpression' || (init.type === 'CallExpression' && CLIENT_FACTORIES.test(calleeRoot(init)))) {
          f.clients.add(name);
        }
        const value = constantValue(init);
        if (value !== undefined) f.constants.set(name, value);
        f.variables.add(name);
      }
    }
  }

  // ---- Pass 2: find components and top-level functions ----

  discover(f: FileInfo) {
    if (!f.ast) return;
    const program = f.ast.program;

    // Top-level functions and hooks (for following data through hooks/services).
    for (const stmt of program.body) {
      const decl = stmt.type === 'ExportNamedDeclaration' || stmt.type === 'ExportDefaultDeclaration' ? stmt.declaration : stmt;
      if (!decl) continue;
      if (decl.type === 'FunctionDeclaration' && decl.id && !isComponentName(decl.id.name)) {
        this.addFunction(f, decl.id.name, decl);
      } else if (decl.type === 'VariableDeclaration') {
        for (const v of decl.declarations) {
          if (v.id.type !== 'Identifier' || !v.init) continue;
          const init = stripExpr(v.init);
          const fn = functionOf(init);
          if (fn && !isComponentName(v.id.name)) this.addFunction(f, v.id.name, fn);
          // export const api = { getUsers: () => fetch(...) }
          if (init.type === 'ObjectExpression') {
            for (const p of init.properties) {
              if (p.type === 'ObjectMethod' && p.key.type === 'Identifier') this.addFunction(f, `${v.id.name}.${p.key.name}`, p);
              if (p.type === 'ObjectProperty' && p.key.type === 'Identifier') {
                const pf = functionOf(stripExpr(p.value as t.Expression));
                if (pf) this.addFunction(f, `${v.id.name}.${p.key.name}`, pf);
              }
            }
          }
        }
      }
    }

    // Components at any depth.
    const stack: CompDef[] = [];
    const visit = (node: N, parent: N | undefined) => {
      if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && node.init) {
        f.localVars.set(node.id.name, [...(f.localVars.get(node.id.name) ?? []), node.init]);
      }
      const found = this.componentAt(f, node, parent);
      if (found) {
        const def = this.addComponent(f, found.name, found.node, stack[stack.length - 1], found.annotation, found.wrapperTypes);
        stack.push(def);
        forEachChild(found.node, (c) => visit(c, found.node));
        stack.pop();
        return;
      }
      forEachChild(node, (c) => visit(c, node));
    };
    visit(program, undefined);

    // const Fancy = memo(Plain) → Fancy is Plain.
    for (const stmt of program.body) {
      const decl = stmt.type === 'ExportNamedDeclaration' ? stmt.declaration : stmt;
      if (decl?.type !== 'VariableDeclaration') continue;
      for (const v of decl.declarations) {
        if (v.id.type !== 'Identifier' || !v.init || f.components.has(v.id.name)) continue;
        const ref = unwrapRef(stripExpr(v.init));
        if (ref && ref !== v.id.name && isComponentName(v.id.name)) f.aliases.set(v.id.name, ref);
      }
    }
  }

  private componentAt(
    f: FileInfo,
    node: N,
    parent: N | undefined,
  ): { name: string; node: FnNode; annotation?: t.TSType; wrapperTypes?: t.TSType[] } | undefined {
    if (this.compByNode.has(node)) return undefined;

    if ((node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration') && node.id && isComponentName(node.id.name)) {
      if (node.type === 'ClassDeclaration' ? isComponentClass(node) : containsJsx(node)) return { name: node.id.name, node };
    }

    if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && node.init && isComponentName(node.id.name)) {
      const unwrapped = unwrapFn(stripExpr(node.init));
      if (unwrapped && (unwrapped.fn.type === 'ClassExpression' ? isComponentClass(unwrapped.fn) : containsJsx(unwrapped.fn))) {
        const annotation = node.id.typeAnnotation?.type === 'TSTypeAnnotation' ? node.id.typeAnnotation.typeAnnotation : undefined;
        return { name: node.id.name, node: unwrapped.fn, annotation, wrapperTypes: unwrapped.typeArgs };
      }
    }

    // export default () => <div/>   /   export default function () {...}
    if (node.type === 'ExportDefaultDeclaration' && parent?.type === 'Program') {
      const d = node.declaration;
      const anonymous =
        ((d.type === 'FunctionDeclaration' || d.type === 'ClassDeclaration') && !d.id) ||
        d.type === 'ArrowFunctionExpression' ||
        d.type === 'FunctionExpression' ||
        d.type === 'CallExpression';
      if (anonymous) {
        const unwrapped = d.type === 'FunctionDeclaration' || d.type === 'ClassDeclaration' ? { fn: d as FnNode } : unwrapFn(d as t.Expression);
        if (unwrapped && (unwrapped.fn.type.startsWith('Class') ? isComponentClass(unwrapped.fn as t.Class) : containsJsx(unwrapped.fn))) {
          const name = nameFromPath(f.path);
          f.exports.set('default', { local: name });
          return { name, node: unwrapped.fn };
        }
      }
    }
    return undefined;
  }

  private addComponent(
    f: FileInfo,
    name: string,
    node: FnNode,
    parent: CompDef | undefined,
    annotation?: t.TSType,
    wrapperTypes?: t.TSType[],
  ): CompDef {
    let id = `${f.path}#${name}`;
    for (let i = 2; this.byId.has(id); i++) id = `${f.path}#${name}~${i}`;
    const { props, propsParam, acceptsRest } = this.propsOf(f, node, annotation, wrapperTypes);
    const comp: FeComponent = {
      id,
      name,
      path: f.path,
      line: (node.loc?.start.line ?? 1) - 1,
      kind: node.type === 'ClassDeclaration' || node.type === 'ClassExpression' ? 'class' : 'function',
      parent: parent?.comp.id,
      props,
      acceptsRest,
      renders: [],
      usedBy: [],
      hooks: [],
      data: [],
      states: { loading: false, error: false, empty: false },
      routes: [],
      isRoot: false,
      issues: [],
    };
    const def: CompDef = { comp, node, propsParam, propNames: new Set(props.map((p) => p.name)), facts: emptyFacts() };
    if (!parent) f.components.set(name, def);
    this.byId.set(id, def);
    this.compByNode.set(node, def);
    return def;
  }

  private addFunction(f: FileInfo, name: string, node: t.Function) {
    const def: FnDef = { key: `${f.path}#${name}`, name, path: f.path, node, facts: emptyFacts() };
    f.functions.set(name, def);
    if (name.includes('.')) f.objects.add(name.split('.')[0]);
    this.fnByKey.set(def.key, def);
    this.fnByNode.set(node, def);
  }

  // ---- Props ----

  private propsOf(
    f: FileInfo,
    node: FnNode,
    annotation?: t.TSType,
    wrapperTypes?: t.TSType[],
  ): { props: PropInfo[]; propsParam?: string; acceptsRest: boolean } {
    const props = new Map<string, PropInfo>();
    let acceptsRest = false;
    let propsParam: string | undefined;
    let typeNode: t.TSType | undefined;

    const addUsage = (name: string, optional = false) => {
      if (!props.has(name)) props.set(name, { name, optional, isCallback: /^on[A-Z]/.test(name), source: 'usage' });
    };

    if (node.type === 'ClassDeclaration' || node.type === 'ClassExpression') {
      const sp = node.superTypeParameters;
      if (sp?.type === 'TSTypeParameterInstantiation') typeNode = sp.params[0];
      walk(node, (n) => {
        // this.props.x
        if (n.type === 'MemberExpression' && isThisProps(n.object) && n.property.type === 'Identifier' && !n.computed) {
          addUsage(n.property.name);
        }
        // const { a, b } = this.props
        if (n.type === 'VariableDeclarator' && n.init && isThisProps(n.init) && n.id.type === 'ObjectPattern') {
          for (const name of patternNames(n.id)) addUsage(name.name, name.optional);
        }
      });
    } else {
      const param = node.params[0];
      if (param?.type === 'ObjectPattern' || (param?.type === 'AssignmentPattern' && param.left.type === 'ObjectPattern')) {
        const pattern = (param.type === 'AssignmentPattern' ? param.left : param) as t.ObjectPattern;
        for (const name of patternNames(pattern)) addUsage(name.name, name.optional);
        acceptsRest = pattern.properties.some((p) => p.type === 'RestElement');
        if (pattern.typeAnnotation?.type === 'TSTypeAnnotation') typeNode = pattern.typeAnnotation.typeAnnotation;
      } else if (param?.type === 'Identifier') {
        propsParam = param.name;
        if (param.typeAnnotation?.type === 'TSTypeAnnotation') typeNode = param.typeAnnotation.typeAnnotation;
        walk(node.body, (n) => {
          if (n.type === 'MemberExpression' && n.object.type === 'Identifier' && n.object.name === param.name && !n.computed && n.property.type === 'Identifier') {
            addUsage(n.property.name);
          }
          if (n.type === 'VariableDeclarator' && n.init?.type === 'Identifier' && n.init.name === param.name && n.id.type === 'ObjectPattern') {
            for (const name of patternNames(n.id)) addUsage(name.name, name.optional);
            if (n.id.properties.some((p) => p.type === 'RestElement')) acceptsRest = true;
          }
          if (n.type === 'JSXSpreadAttribute' && n.argument.type === 'Identifier' && n.argument.name === param.name) acceptsRest = true;
        });
      }
      // React.FC<Props>, forwardRef<Ref, Props>, memo<Props>
      if (!typeNode && annotation?.type === 'TSTypeReference' && annotation.typeParameters?.params[0]) {
        typeNode = annotation.typeParameters.params[0];
      }
      if (!typeNode && wrapperTypes?.length) typeNode = wrapperTypes[wrapperTypes.length - 1];
    }

    if (typeNode) {
      const typed = this.typeMembers(f, typeNode, 0);
      for (const p of typed.props) {
        const usage = props.get(p.name);
        props.set(p.name, { ...p, optional: p.optional || !!usage?.optional });
      }
      // The type extends something we can't read (e.g. a library's props): the list is open-ended.
      if (typed.open) acceptsRest = true;
    }

    return { props: [...props.values()], propsParam, acceptsRest };
  }

  /** Members of a props type, following interfaces, aliases, intersections and imports. */
  private typeMembers(f: FileInfo, node: t.TSType | t.TSInterfaceBody, depth: number): { props: PropInfo[]; open: boolean } {
    const out: PropInfo[] = [];
    let open = false;
    if (depth > MAX_DEPTH) return { props: out, open: true };

    const members = (list: t.TSTypeElement[]) => {
      for (const m of list) {
        if (m.type === 'TSPropertySignature' && (m.key.type === 'Identifier' || m.key.type === 'StringLiteral')) {
          const typeAnn = m.typeAnnotation?.typeAnnotation;
          const type = typeAnn ? sliceText(f.text, typeAnn) : undefined;
          const name = nameOf(m.key);
          out.push({
            name,
            type,
            optional: !!m.optional,
            isCallback: typeAnn?.type === 'TSFunctionType' || /^on[A-Z]/.test(name) || /^\(.*\)\s*=>/.test(type ?? ''),
            source: 'type',
          });
        } else if (m.type === 'TSMethodSignature' && m.key.type === 'Identifier') {
          out.push({ name: m.key.name, type: sliceText(f.text, m), optional: !!m.optional, isCallback: true, source: 'type' });
        }
      }
    };

    const fromReference = (name: string, params: t.TSType[] | undefined) => {
      if (name === 'Partial' || name === 'Readonly' || name === 'Required') {
        const inner = params?.[0] ? this.typeMembers(f, params[0], depth + 1) : { props: [], open: true };
        for (const p of inner.props) out.push({ ...p, optional: name === 'Partial' ? true : name === 'Required' ? false : p.optional });
        open ||= inner.open;
        return;
      }
      if (name === 'Omit' || name === 'Pick') {
        const inner = params?.[0] ? this.typeMembers(f, params[0], depth + 1) : { props: [], open: true };
        const keys = new Set(params?.[1] ? literalUnion(params[1]) : []);
        for (const p of inner.props) if (keys.has(p.name) === (name === 'Pick')) out.push(p);
        open ||= inner.open;
        return;
      }
      if (name === 'PropsWithChildren' || name === 'React.PropsWithChildren') {
        if (params?.[0]) {
          const inner = this.typeMembers(f, params[0], depth + 1);
          out.push(...inner.props);
          open ||= inner.open;
        }
        out.push({ name: 'children', type: 'ReactNode', optional: true, isCallback: false, source: 'type' });
        return;
      }
      const decl = this.findType(f, name);
      if (!decl) {
        open = true; // e.g. NodeProps from a library: more inputs than we can list
        return;
      }
      const inner =
        decl.node.type === 'TSInterfaceDeclaration'
          ? this.interfaceMembers(decl.file, decl.node, depth + 1)
          : this.typeMembers(decl.file, decl.node.typeAnnotation, depth + 1);
      out.push(...inner.props);
      open ||= inner.open;
    };

    switch (node.type) {
      case 'TSTypeLiteral':
        members(node.members);
        break;
      case 'TSInterfaceBody':
        members(node.body);
        break;
      case 'TSIntersectionType':
      case 'TSUnionType':
        for (const part of node.types) {
          const inner = this.typeMembers(f, part, depth + 1);
          for (const p of inner.props) {
            if (!out.some((x) => x.name === p.name)) out.push(node.type === 'TSUnionType' ? { ...p, optional: true } : p);
          }
          open ||= inner.open;
        }
        break;
      case 'TSTypeReference':
        fromReference(entityName(node.typeName), node.typeParameters?.params);
        break;
      case 'TSParenthesizedType':
        return this.typeMembers(f, node.typeAnnotation, depth);
      default:
        open = true;
    }
    return { props: out, open };
  }

  private interfaceMembers(f: FileInfo, node: t.TSInterfaceDeclaration, depth: number) {
    const own = this.typeMembers(f, node.body, depth);
    const props = [...own.props];
    let open = own.open;
    for (const h of node.extends ?? []) {
      if (h.expression.type !== 'Identifier') {
        open = true;
        continue;
      }
      const ref: t.TSTypeReference = {
        type: 'TSTypeReference',
        typeName: h.expression,
        typeParameters: h.typeParameters,
      } as t.TSTypeReference;
      const inner = this.typeMembers(f, ref, depth + 1);
      for (const p of inner.props) if (!props.some((x) => x.name === p.name)) props.push(p);
      open ||= inner.open;
    }
    // Own declarations win (interfaces can override inherited members).
    return { props, open };
  }

  private findType(f: FileInfo, name: string): { file: FileInfo; node: t.TSInterfaceDeclaration | t.TSTypeAliasDeclaration } | undefined {
    const local = f.types.get(name);
    if (local) return { file: f, node: local };
    const r = this.resolveBinding(f, name);
    if (r && 'file' in r) {
      const target = this.files.get(r.file);
      const node = target?.types.get(r.local);
      if (target && node) return { file: target, node };
    }
    return undefined;
  }

  // ---- Binding resolution across files ----

  private resolveBinding(f: FileInfo, name: string, depth = 0): Resolved {
    if (depth > 8) return undefined;
    const alias = f.aliases.get(name);
    if (alias) return this.resolveBinding(f, alias, depth + 1);
    if (
      f.components.has(name) ||
      f.functions.has(name) ||
      f.objects.has(name) ||
      f.types.has(name) ||
      f.storeHooks.has(name) ||
      f.clients.has(name) ||
      f.constants.has(name) ||
      f.variables.has(name)
    ) {
      return { file: f.path, local: name };
    }
    const imp = f.imports.get(name);
    if (!imp) return undefined;
    if (imp.from.startsWith('pkg:')) return { pkg: imp.from.slice(4) };
    return this.resolveExport(imp.from, imp.imported, depth + 1);
  }

  private resolveExport(path: string, name: string, depth: number): Resolved {
    if (depth > 8) return undefined;
    const f = this.files.get(path);
    if (!f) return undefined;
    const e = f.exports.get(name);
    if (e?.from) {
      return e.from.startsWith('pkg:') ? { pkg: e.from.slice(4) } : this.resolveExport(e.from, e.imported ?? 'default', depth + 1);
    }
    if (e?.local) return this.resolveBinding(f, e.local, depth + 1);
    if (name !== 'default') {
      for (const from of f.exportAll) {
        if (from.startsWith('pkg:')) continue;
        const r = this.resolveExport(from, name, depth + 1);
        if (r) return r;
      }
    }
    return undefined;
  }

  private componentFor(r: Resolved): CompDef | undefined {
    if (!r || !('file' in r)) return undefined;
    const f = this.files.get(r.file);
    return f?.components.get(r.local);
  }

  // ---- Pass 3: renders, data, references, routes ----

  analyzeUsage(f: FileInfo) {
    if (!f.ast) return;

    interface Ctx {
      comp?: CompDef;
      fn?: FnDef;
      routePrefix: string;
      /** The layout components (ids, outer first) of the routes we're inside: they render the page in an <Outlet/>. */
      routeLayouts?: string[];
      /** File-level variable whose value we're inside. */
      topVar?: string;
      /** When code here runs: on load (effects, query hooks) or on an action (handlers). */
      trigger?: Trigger;
      /** The local function we're inside, e.g. `const load = async () => {…}`. */
      localFn?: string;
    }

    const visit = (node: N, parent: N | undefined, key: string | undefined, ctx: Ctx) => {
      const comp = this.compByNode.get(node);
      if (comp) ctx = { ...ctx, comp, fn: undefined, trigger: undefined, localFn: undefined };
      else if (!ctx.comp) {
        const fn = this.fnByNode.get(node);
        if (fn) ctx = { ...ctx, fn, trigger: undefined, localFn: undefined };
      }
      if (!ctx.comp && !ctx.fn && node.type === 'VariableDeclarator' && node.id.type === 'Identifier') {
        ctx = { ...ctx, topVar: node.id.name };
      }
      const facts = ctx.comp?.facts ?? ctx.fn?.facts;

      switch (node.type) {
        case 'ImportDeclaration':
        case 'ExportAllDeclaration':
        case 'TSInterfaceDeclaration':
        case 'TSTypeAliasDeclaration':
        case 'TSTypeAnnotation':
        case 'TSTypeParameterInstantiation':
          return;
        case 'ExportNamedDeclaration':
          if (node.source) return;
          break;
        case 'JSXElement': {
          const tag = jsxName(node.openingElement.name);
          if (tag === 'Route') {
            const path = this.routeFromJsx(f, node, ctx.routePrefix, ctx.routeLayouts);
            if (path !== undefined) {
              const hasChildren = node.children.some((c) => c.type === 'JSXElement' && jsxName(c.openingElement.name) === 'Route');
              const layout = hasChildren ? this.routeElementComp(f, node.openingElement.attributes.find((a): a is t.JSXAttribute => a.type === 'JSXAttribute' && /^(element|Component|component)$/.test(jsxAttrName(a)))?.value ?? undefined) : undefined;
              const routeLayouts = layout ? [...(ctx.routeLayouts ?? []), layout] : ctx.routeLayouts;
              for (const c of node.children) visit(c, node, 'children', { ...ctx, routePrefix: path, routeLayouts });
              for (const a of node.openingElement.attributes) visit(a, node, 'attributes', ctx);
              return;
            }
          }
          break;
        }
        case 'JSXOpeningElement': {
          const tag = jsxName(node.name);
          if (/^[A-Z]/.test(tag) || tag.includes('.')) this.recordRender(f, ctx.comp, tag, line(node));
          break;
        }
        case 'ObjectExpression': {
          const path = this.routeFromObject(f, node, ctx.routePrefix, ctx.routeLayouts);
          if (path !== undefined) {
            const prop = (k: string) => node.properties.find((p): p is t.ObjectProperty => p.type === 'ObjectProperty' && (p.key.type === 'Identifier' || p.key.type === 'StringLiteral') && nameOf(p.key) === k);
            const layout = prop('children') ? this.routeElementComp(f, (prop('element') ?? prop('Component') ?? prop('component'))?.value as N | undefined) : undefined;
            const routeLayouts = layout ? [...(ctx.routeLayouts ?? []), layout] : ctx.routeLayouts;
            for (const p of node.properties) visit(p, node, 'properties', { ...ctx, routePrefix: path, routeLayouts });
            return;
          }
          break;
        }
        case 'CallExpression':
          if (facts) this.recordCall(f, node, ctx.comp, facts, { trigger: ctx.trigger, localFn: ctx.localFn });
          if (!ctx.comp && !ctx.fn) this.recordRootRender(f, node);
          break;
        case 'Identifier':
          if (facts) facts.idents.add(node.name);
          // Count a local function as running here only when it really runs here: called (`load()`),
          // passed straight to an effect (`useEffect(load)`), or used as a handler (`onClick={load}`).
          // Merely handing it over (`register(load)`) doesn't run it now.
          if (facts && ctx.trigger && runsHere(node, parent, key)) facts.localUses.push({ name: node.name, trigger: ctx.trigger });
          if (isReference(parent, key) && isComponentName(node.name)) {
            const target = this.componentFor(this.resolveBinding(f, node.name));
            // Module-level mentions in the component's own file (export default memo(X)) are not uses.
            const ownFileExport = !ctx.comp && target?.comp.path === f.path;
            if (target && target !== ctx.comp && target.node !== parent && !ownFileExport) {
              if (!ctx.comp && ctx.topVar) {
                // Resolved to the component that uses this variable in finish().
                this.heldBy.push({ target, file: f.path, variable: ctx.topVar, line: line(node) });
              } else {
                target.comp.usedBy.push({ from: ctx.comp?.comp.id, path: f.path, line: line(node), how: 'references' });
              }
            }
          }
          break;
        case 'MemberExpression':
          if (facts && node.property.type === 'Identifier') facts.idents.add(node.property.name);
          break;
        case 'JSXIdentifier':
          if (facts) facts.idents.add(node.name);
          break;
        case 'BinaryExpression':
        case 'UnaryExpression':
        case 'ConditionalExpression':
        case 'LogicalExpression':
          if (facts && node.loc) facts.text.push(sliceText(f.text, node));
          break;
      }

      const inner = ctx.comp || ctx.fn ? childOrigin(node, ctx, this.compByNode.has(node) || this.fnByNode.has(node)) : ctx;
      forEachChild(node, (child, childKey) => visit(child, node, childKey, inner));
    };

    visit(f.ast.program, undefined, undefined, { routePrefix: '' });
  }

  private recordRender(f: FileInfo, owner: CompDef | undefined, tag: string, at: number) {
    const head = tag.split('.')[0];
    const r = this.resolveBinding(f, head);
    const ref: RenderRef = { tag, line: at };
    if (r && 'pkg' in r) ref.pkg = r.pkg;
    else if (!tag.includes('.')) {
      const target = this.componentFor(r);
      // Components nested in the same parent are not in f.components; look them up by scope.
      const nested = !target && owner ? [...this.byId.values()].find((d) => d.comp.parent === owner.comp.id && d.comp.name === tag) : undefined;
      const resolved = target ?? nested;
      if (resolved) {
        ref.target = resolved.comp.id;
        if (resolved !== owner) resolved.comp.usedBy.push({ from: owner?.comp.id, path: f.path, line: at, how: 'renders' });
      }
    }
    if (owner) owner.comp.renders.push(ref);
  }

  private recordCall(f: FileInfo, call: t.CallExpression, owner: CompDef | undefined, facts: Facts, origin: Origin) {
    const callee = call.callee;
    const at = line(call);
    const push = (d: Omit<DataUse, 'path' | 'line'>) => facts.data.push({ ...d, ...origin, path: f.path, line: at });
    const pushApi = (method: string, urlNode: N | undefined, client: string, base?: string, clientVar?: string) => {
      const found = this.urlOf(f, urlNode);
      const url = found === undefined ? undefined : joinUrl(base, found);
      const written = urlNode ? sliceText(f.text, urlNode) : '';
      push({
        kind: 'api',
        label: `${method} ${url ?? `(dynamic address: ${written || '?'})`}`,
        method,
        url,
        written,
        client,
        clientVar,
      });
    };

    if (callee.type === 'Identifier') {
      const name = callee.name;
      const pkg = this.packageOf(f, name);
      // fetch(url, { method }) / ky(url) / ofetch(url)
      if (name === 'fetch' || name === '$fetch' || (pkg && HTTP_PACKAGES.has(pkg) && pkg !== 'axios')) {
        pushApi(optionMethod(call.arguments[1]) ?? 'GET', call.arguments[0], name === 'fetch' ? 'fetch' : (pkg ?? name));
        return;
      }
      // axios(url, config) / axios({ url, method })
      if (pkg === 'axios' || name === 'axios') {
        const first = call.arguments[0];
        const config = first?.type === 'ObjectExpression' ? first : call.arguments[1];
        pushApi(optionMethod(config) ?? 'GET', first, 'axios');
        return;
      }
      // api(url) where api = axios.create(...)
      const instance = this.httpClientOf(f, name);
      if (instance) {
        pushApi(optionMethod(call.arguments[1]) ?? 'GET', call.arguments[0], instance.client, instance.base, name);
        return;
      }
      if (/^use[A-Z0-9]/.test(name) || name === 'use') {
        if (owner && !owner.comp.hooks.includes(name)) owner.comp.hooks.push(name);
        const r = this.resolveBinding(f, name);
        // useSWR('/api/user', fetcher): the key is the address
        if (/^useSWR/.test(name) && looksLikeUrl(this.urlOf(f, call.arguments[0]))) {
          pushApi(name === 'useSWRMutation' ? 'POST' : 'GET', call.arguments[0], 'swr');
        }
        if (QUERY_HOOKS.has(name)) push({ kind: 'query', label: `${name}${queryKey(f, call)}` });
        else if (STORE_HOOKS.has(name)) push({ kind: 'store', label: name });
        else if (ROUTER_HOOKS.has(name)) push({ kind: 'router', label: name });
        else if (name === 'useContext') push({ kind: 'context', label: call.arguments[0] ? sliceText(f.text, call.arguments[0]) : 'context' });
        else if (r && 'file' in r && this.files.get(r.file)?.storeHooks.has(r.local)) push({ kind: 'store', label: name });
        else if (r && 'file' in r) facts.calls.push({ key: `${r.file}#${r.local}`, name, line: at, ...origin });
        else if (/Store$/.test(name)) push({ kind: 'store', label: name });
        return;
      }
      if (owner?.propNames.has(name)) return; // calling a callback prop
      const r = this.resolveBinding(f, name);
      if (r && 'file' in r) facts.calls.push({ key: `${r.file}#${r.local}`, name, line: at, ...origin });
      return;
    }

    if (callee.type === 'MemberExpression' && callee.property.type === 'Identifier') {
      const method = callee.property.name;
      const obj = callee.object;
      if (obj.type === 'Identifier' && obj.name === 'React' && /^use/.test(method)) {
        if (owner && !owner.comp.hooks.includes(method)) owner.comp.hooks.push(method);
        if (method === 'useContext') push({ kind: 'context', label: call.arguments[0] ? sliceText(f.text, call.arguments[0]) : 'context' });
        return;
      }
      if (QUERY_HOOKS.has(method)) {
        push({ kind: 'query', label: `${sliceText(f.text, callee)}${queryKey(f, call)}` });
        return;
      }
      if (HTTP_VERBS.has(method) || method === 'request') {
        const verb = method === 'request' ? (optionMethod(call.arguments[0]) ?? 'GET') : method.toUpperCase();
        if (obj.type === 'Identifier') {
          // axios.get(url) / ky.post(url)
          const pkg = this.packageOf(f, obj.name) ?? (HTTP_PACKAGES.has(obj.name) ? obj.name : undefined);
          if (pkg && HTTP_PACKAGES.has(pkg)) {
            pushApi(verb, call.arguments[0], pkg);
            return;
          }
          // api.get(url) where api = axios.create({ baseURL })
          const instance = this.httpClientOf(f, obj.name);
          if (instance) {
            pushApi(verb, call.arguments[0], instance.client, instance.base, obj.name);
            return;
          }
        }
        // any other client: x.get('/path')
        if (looksLikeUrl(this.urlOf(f, call.arguments[0]))) {
          pushApi(verb, call.arguments[0], 'http');
          return;
        }
      }
      // db.projects.where(...) / supabase.from('x') where the root is a client instance
      const root = memberRoot(callee);
      if (root) {
        const r = this.resolveBinding(f, root.name);
        if (r && 'file' in r && this.files.get(r.file)?.clients.has(r.local)) {
          push({ kind: 'db', label: clientLabel(f, callee, root.name) });
          return;
        }
      }
      // api.getUsers() where api is a project object of functions
      if (obj.type === 'Identifier') {
        const r = this.resolveBinding(f, obj.name);
        if (r && 'file' in r) facts.calls.push({ key: `${r.file}#${r.local}.${method}`, name: `${obj.name}.${method}`, line: at, ...origin });
      }
    }
  }

  /** npm package a local name was imported from. */
  private packageOf(f: FileInfo, name: string): string | undefined {
    const from = f.imports.get(name)?.from;
    return from?.startsWith('pkg:') ? from.slice(4) : undefined;
  }

  /** `api` → { client: 'axios', base: '/api' } when api = axios.create({ baseURL: '/api' }). */
  private httpClientOf(f: FileInfo, name: string): { client: string; base?: string } | undefined {
    const r = this.resolveBinding(f, name);
    if (!r || !('file' in r)) return undefined;
    const target = this.files.get(r.file);
    const found = target?.httpClients.get(r.local);
    if (!target || !found) return undefined;
    return { client: found.client, base: found.base ? this.urlOf(target, found.base) : undefined };
  }

  // ---- Addresses: turn the code that builds a URL into a readable address ----

  /**
   * `'/api/orders'` → `/api/orders`; `` `/orders/${id}` `` → `/orders/:id`;
   * `` `${import.meta.env.VITE_API}/me` `` → `{VITE_API}/me`; follows constants, local variables and
   * helper functions that return a URL. Returns undefined when nothing readable can be built.
   */
  private urlOf(f: FileInfo, node: N | undefined, depth = 0, raw = false): string | undefined {
    if (!node || depth > 5) return undefined;
    const e = isExpression(node) ? stripExpr(node) : node;
    let out: string | undefined;
    if (e.type === 'StringLiteral') out = e.value;
    else if (e.type === 'TemplateLiteral') {
      out = '';
      e.quasis.forEach((q, i) => {
        out += q.value.cooked ?? '';
        if (i < e.expressions.length) out += this.urlPart(f, e.expressions[i] as N, out!, depth);
      });
    } else if (e.type === 'BinaryExpression' && e.operator === '+') {
      const left = this.urlPart(f, e.left as N, '', depth);
      out = left + this.urlPart(f, e.right as N, left, depth);
    } else if (e.type === 'ObjectExpression') {
      const prop = e.properties.find((p) => p.type === 'ObjectProperty' && nameOf(p.key) === 'url') as t.ObjectProperty | undefined;
      return prop ? this.urlOf(f, prop.value, depth + 1) : undefined;
    } else {
      const part = this.urlPart(f, e, '', depth);
      out = part.startsWith('{') && part.endsWith('}') && !/^\{[A-Z0-9_]+\}$/.test(part) ? undefined : part;
    }
    return out === undefined || raw ? out : cleanUrl(out);
  }

  /** One piece of a URL. Unknown pieces become `:name` inside the path, or `{name}` at the start. */
  private urlPart(f: FileInfo, e: N, before: string, depth: number): string {
    const expr = isExpression(e) ? stripExpr(e) : e;
    if (expr.type === 'StringLiteral' || expr.type === 'TemplateLiteral' || expr.type === 'BinaryExpression') {
      const nested = this.urlOf(f, expr, depth + 1, true);
      if (nested !== undefined) return nested;
    }
    const constant = isExpression(expr) ? this.stringOf(f, expr) : undefined;
    if (constant !== undefined) return constant;
    const env = envName(expr);
    if (env) return `{${env}}`;
    if (expr.type === 'CallExpression' && depth < 4) {
      const returned = this.returnedUrl(f, expr, depth + 1);
      if (returned !== undefined) return returned;
    }
    if (expr.type === 'Identifier' && depth < 4) {
      const inits = f.localVars.get(expr.name);
      if (inits?.length === 1) {
        const v = this.urlOf(f, inits[0], depth + 1);
        if (v !== undefined) return v;
      }
    }
    const name = placeholder(expr);
    return before === '' || /^\{[^}]*\}$/.test(before) ? `{${name}}` : before.endsWith('/') ? `:${name}` : `{${name}}`;
  }

  /** The URL a helper function returns: `getOrdersUrl()` → `/api/orders`. */
  private returnedUrl(f: FileInfo, call: t.CallExpression, depth: number): string | undefined {
    const c = call.callee;
    let key: string | undefined;
    if (c.type === 'Identifier') {
      const r = this.resolveBinding(f, c.name);
      if (r && 'file' in r) key = `${r.file}#${r.local}`;
    } else if (c.type === 'MemberExpression' && c.object.type === 'Identifier' && c.property.type === 'Identifier') {
      const r = this.resolveBinding(f, c.object.name);
      if (r && 'file' in r) key = `${r.file}#${r.local}.${c.property.name}`;
    }
    const fn = key ? this.fnByKey.get(key) : undefined;
    if (!fn) return undefined;
    const target = this.files.get(fn.path)!;
    const body = fn.node.body;
    if (body.type !== 'BlockStatement') return this.urlOf(target, body, depth);
    let returned: N | undefined;
    const find = (n: N) => {
      if (returned) return;
      if (n !== fn.node && (n.type === 'ArrowFunctionExpression' || n.type === 'FunctionExpression' || n.type === 'FunctionDeclaration')) return;
      if (n.type === 'ReturnStatement' && n.argument) {
        returned = n.argument;
        return;
      }
      forEachChild(n, find);
    };
    find(body);
    return returned ? this.urlOf(target, returned, depth) : undefined;
  }

  /** createRoot(el).render(<App/>) / ReactDOM.render(<App/>, el) at module level. */
  private recordRootRender(f: FileInfo, call: t.CallExpression) {
    const c = call.callee;
    const isRender =
      (c.type === 'MemberExpression' && c.property.type === 'Identifier' && (c.property.name === 'render' || c.property.name === 'hydrate')) ||
      (c.type === 'Identifier' && (c.name === 'render' || c.name === 'hydrateRoot'));
    if (!isRender) return;
    walk(call, (n) => {
      if (n.type !== 'JSXOpeningElement') return;
      const target = this.componentFor(this.resolveBinding(f, jsxName(n.name).split('.')[0]));
      if (target) target.comp.isRoot = true;
    });
  }

  // ---- Routes ----

  /** The project component a route's element renders (innermost wins: <Guard><Layout/></Guard> → Layout). */
  private routeElementComp(f: FileInfo, value: N | undefined): string | undefined {
    let node = value;
    if (node?.type === 'JSXExpressionContainer') node = node.expression;
    let comp: CompDef | undefined;
    if (node?.type === 'JSXElement') {
      walk(node, (n) => {
        if (n.type === 'JSXOpeningElement') comp = this.componentFor(this.resolveBinding(f, jsxName(n.name).split('.')[0])) ?? comp;
      });
    } else if (node?.type === 'Identifier') comp = this.componentFor(this.resolveBinding(f, node.name));
    return comp?.comp.id;
  }

  private routeFromJsx(f: FileInfo, el: t.JSXElement, prefix: string, layouts?: string[]): string | undefined {
    const attrs = new Map<string, t.JSXAttribute>();
    for (const a of el.openingElement.attributes) if (a.type === 'JSXAttribute') attrs.set(jsxAttrName(a), a);
    const pathAttr = attrs.get('path');
    const isIndex = attrs.has('index');
    // <Route element={<AppLayout/>}> around child routes, with no path of its own: a layout route.
    if (!pathAttr && !isIndex) return attrs.has('element') && el.children.some((c) => c.type === 'JSXElement' && jsxName(c.openingElement.name) === 'Route') ? prefix : undefined;

    const raw = pathAttr ? this.attrString(f, pathAttr) : '';
    const full = joinRoute(prefix, raw);
    const elementAttr = attrs.get('element') ?? attrs.get('component') ?? attrs.get('Component');
    // <Route path="/account"> with only child routes is a prefix, not a page.
    const hasChildRoutes = el.children.some((c) => c.type === 'JSXElement' && jsxName(c.openingElement.name) === 'Route');
    if (elementAttr && !hasChildRoutes) this.addRoute(f, full, elementAttr.value ?? undefined, line(el), layouts);
    else if (elementAttr && pathAttr) this.addRoute(f, full, elementAttr.value ?? undefined, line(el), layouts);
    return full;
  }

  private routeFromObject(f: FileInfo, obj: t.ObjectExpression, prefix: string, layouts?: string[]): string | undefined {
    const props = new Map<string, t.ObjectProperty>();
    for (const p of obj.properties) {
      if (p.type === 'ObjectProperty' && (p.key.type === 'Identifier' || p.key.type === 'StringLiteral')) props.set(nameOf(p.key), p);
    }
    const target = props.get('element') ?? props.get('Component') ?? props.get('component') ?? props.get('lazy');
    const pathProp = props.get('path');
    const isIndex = props.get('index')?.value.type === 'BooleanLiteral';
    if ((!pathProp && !isIndex) || (!target && !props.has('children'))) return undefined;

    const raw = pathProp ? (this.stringOf(f, pathProp.value as t.Expression) ?? sliceText(f.text, pathProp.value)) : '';
    const full = joinRoute(prefix, raw);
    if (target) this.addRoute(f, full, target.value as N, line(obj), layouts);
    return full;
  }

  private addRoute(f: FileInfo, path: string, value: N | undefined, at: number, layouts?: string[]) {
    let label = '?';
    let comp: CompDef | undefined;
    let node = value;
    if (node?.type === 'JSXExpressionContainer') node = node.expression;
    if (node?.type === 'JSXElement') {
      label = jsxName(node.openingElement.name);
      // <Guard><Page/></Guard>: prefer the innermost project component.
      walk(node, (n) => {
        if (n.type === 'JSXOpeningElement') {
          const c = this.componentFor(this.resolveBinding(f, jsxName(n.name).split('.')[0]));
          if (c) comp = c;
        }
      });
    } else if (node?.type === 'Identifier') {
      label = node.name;
      comp = this.componentFor(this.resolveBinding(f, node.name));
    } else if (node && (node.type === 'ArrowFunctionExpression' || node.type === 'FunctionExpression')) {
      // lazy: () => import('./pages/Editor')
      walk(node, (n) => {
        if (n.type === 'CallExpression' && n.callee.type === 'Import' && n.arguments[0]?.type === 'StringLiteral') {
          const from = this.resolveSpec(n.arguments[0].value, f.path);
          label = n.arguments[0].value;
          comp = this.componentFor(this.resolveExport(from, 'default', 0));
        }
      });
    }
    if (comp) {
      label = comp.comp.name;
      if (!comp.comp.routes.includes(path)) comp.comp.routes.push(path);
    }
    this.routes.push({ path, target: comp?.comp.id, label, file: f.path, line: at, ...(layouts?.length ? { layouts } : {}) });
  }

  /** Next.js: app/**\/page.tsx and pages/**.tsx are routes by file location. */
  collectNextRoutes() {
    const usesNext = [...this.files.values()].some((f) =>
      [...f.imports.values(), ...f.exports.values()].some((b) => b.from === 'pkg:next'),
    );
    if (!usesNext) return;
    for (const f of this.files.values()) {
      let route: string | undefined;
      const app = f.path.match(/(?:^|\/)app\/(.*?)\/?page\.[jt]sx?$/);
      const pages = f.path.match(/(?:^|\/)pages\/(.+)\.[jt]sx?$/);
      if (app) route = app[1];
      else if (pages && !/^(api\/|_app$|_document$|_error$)/.test(pages[1])) route = pages[1].replace(/(^|\/)index$/, '');
      if (route === undefined) continue;
      const path = `/${route
        .split('/')
        .filter((p) => p && !/^\(.*\)$/.test(p) && !p.startsWith('@'))
        .map((p) => p.replace(/^\[\[?\.\.\.(\w+)\]?\]$/, '*$1').replace(/^\[(\w+)\]$/, ':$1'))
        .join('/')}`;
      const comp = this.componentFor(this.resolveExport(f.path, 'default', 0));
      if (comp && !comp.comp.routes.includes(path)) comp.comp.routes.push(path);
      // Its layouts: App Router layout files from the app folder down to the page; Pages Router _app.
      const layouts: string[] = [];
      const layoutIn = (dir: string) => ['tsx', 'jsx', 'js', 'ts'].map((ext) => `${dir}/layout.${ext}`).find((p) => this.files.has(p));
      if (app) {
        const parts = f.path.split('/').slice(0, -1);
        const appAt = parts.lastIndexOf('app');
        for (let i = appAt + 1; i <= parts.length; i++) {
          const file = layoutIn(parts.slice(0, i).join('/'));
          const l = file && this.componentFor(this.resolveExport(file, 'default', 0));
          if (l) layouts.push(l.comp.id);
        }
      } else {
        const pagesRoot = f.path.slice(0, f.path.indexOf('pages/') + 'pages/'.length);
        const file = ['tsx', 'jsx', 'js', 'ts'].map((ext) => `${pagesRoot}_app.${ext}`).find((p) => this.files.has(p));
        const l = file && this.componentFor(this.resolveExport(file, 'default', 0));
        if (l) layouts.push(l.comp.id);
      }
      this.routes.push({ path, target: comp?.comp.id, label: comp?.comp.name ?? f.path, file: f.path, line: 0, ...(layouts.length ? { layouts } : {}) });
    }
  }

  private attrString(f: FileInfo, attr: t.JSXAttribute): string {
    const v = attr.value;
    if (!v) return '';
    if (v.type === 'StringLiteral') return v.value;
    if (v.type === 'JSXExpressionContainer' && v.expression.type !== 'JSXEmptyExpression') {
      return this.stringOf(f, v.expression) ?? sliceText(f.text, v.expression);
    }
    return sliceText(f.text, v);
  }

  /** Evaluates simple constant strings: literals, `ROUTES.HOME`, imported consts. */
  private stringOf(f: FileInfo, e: t.Expression, depth = 0): string | undefined {
    e = stripExpr(e);
    if (e.type === 'StringLiteral') return e.value;
    if (e.type === 'TemplateLiteral' && e.expressions.length === 0) return e.quasis[0].value.cooked ?? '';
    if (depth > 4) return undefined;
    const lookup = (name: string) => {
      const r = this.resolveBinding(f, name);
      if (r && 'file' in r) return this.files.get(r.file)?.constants.get(r.local);
      return undefined;
    };
    if (e.type === 'Identifier') {
      const v = lookup(e.name);
      return typeof v === 'string' ? v : undefined;
    }
    if (e.type === 'MemberExpression' && e.object.type === 'Identifier' && e.property.type === 'Identifier' && !e.computed) {
      const v = lookup(e.object.name);
      return v instanceof Map ? v.get(e.property.name) : undefined;
    }
    return undefined;
  }

  // ---- Finish: follow data through hooks, compute states and issues ----

  finish(): FeComponent[] {
    const defs = [...this.byId.values()];
    this.linkHeldComponents(defs);

    for (const def of defs) {
      const c = def.comp;
      const seen = new Set<string>();
      const data: DataUse[] = def.facts.data.map((d) => ({
        ...stripOrigin(d),
        trigger: resolveTrigger(def.facts, d, false),
        entry: { path: d.path, line: d.line },
      }));
      // Follow hooks and helper functions. The innermost known trigger wins:
      // a component calls useOrders() while rendering, and useOrders fetches inside useEffect → "on load".
      const follow = (facts: Facts, isHook: boolean, via: string, depth: number, outer: Trigger | undefined, entry?: DataUse['entry']) => {
        if (depth > MAX_DEPTH) return;
        for (const call of facts.calls) {
          if (seen.has(call.key)) continue;
          seen.add(call.key);
          const fn = this.fnByKey.get(call.key);
          if (!fn) continue;
          const chain = via ? `${via} → ${call.name}` : call.name;
          const trigger = resolveTrigger(facts, call, isHook) ?? outer;
          const start = entry ?? { path: c.path, line: call.line };
          const fnIsHook = /^use[A-Z0-9]/.test(fn.name);
          for (const d of fn.facts.data) {
            data.push({ ...stripOrigin(d), via: chain, trigger: resolveTrigger(fn.facts, d, fnIsHook) ?? trigger, entry: start });
          }
          follow(fn.facts, fnIsHook, chain, depth + 1, trigger, start);
        }
      };
      follow(def.facts, false, '', 0, undefined);
      const unique = new Map<string, DataUse>();
      for (const d of data) {
        const key = `${d.kind}|${d.label}|${d.via ?? ''}|${d.path}:${d.line}`;
        if (!unique.has(key)) unique.set(key, d);
      }
      c.data = [...unique.values()];

      const idents = [...def.facts.idents, ...c.renders.map((r) => r.tag)];
      const text = def.facts.text.join('\n');
      c.states = {
        loading: idents.some((i) => /loading|pending|fetching|spinner|skeleton|suspense/i.test(i)),
        error: idents.some((i) => /error|^err$|failed|failure|errorboundary/i.test(i)),
        empty: /\.length\s*(===?|<|<=)\s*[01]\b|!\s*[\w.?]+\.length\b|\bempty\b|isEmpty|noResults|NoData/i.test(text) ||
          idents.some((i) => /empty|nodata|noresults/i.test(i)),
      };

      // Deduplicate usages (same parent + line).
      const usage = new Map<string, FeComponent['usedBy'][number]>();
      for (const u of c.usedBy) {
        const k = `${u.from ?? u.path}|${u.line}`;
        if (!usage.has(k) || u.how === 'renders') usage.set(k, u);
      }
      c.usedBy = [...usage.values()];
    }

    this.addIssues(defs.map((d) => d.comp));
    return defs.map((d) => d.comp);
  }

  /** `const NODE_TYPES = { db: DBNode }` used by Canvas → Canvas uses DBNode. */
  private linkHeldComponents(defs: CompDef[]) {
    for (const held of this.heldBy) {
      const holders = defs.filter((def) => {
        const f = this.files.get(def.comp.path);
        if (!f || def === held.target) return false;
        if (f.path === held.file) return def.facts.idents.has(held.variable);
        for (const [local, binding] of f.imports) {
          if (!def.facts.idents.has(local) || binding.from !== held.file) continue;
          const r = this.resolveExport(binding.from, binding.imported, 0);
          if (r && 'file' in r && r.local === held.variable) return true;
        }
        return false;
      });
      if (!holders.length) {
        held.target.comp.usedBy.push({ path: held.file, line: held.line, how: 'references' });
      }
      for (const h of holders) {
        held.target.comp.usedBy.push({ from: h.comp.id, path: held.file, line: held.line, how: 'references' });
      }
    }
  }

  private addIssues(components: FeComponent[]) {
    const byName = new Map<string, FeComponent[]>();
    for (const c of components) byName.set(c.name, [...(byName.get(c.name) ?? []), c]);

    for (const c of components) {
      const issues: Issue[] = [];
      if (!c.usedBy.length && !c.routes.length && !c.isRoot && !c.parent) {
        issues.push({ kind: 'unused', message: 'Not used anywhere in the app.' });
      }
      const loads = c.data.filter((d) => d.kind === 'api' || d.kind === 'query');
      if (loads.length) {
        const what = loads[0].label;
        if (!c.states.error) issues.push({ kind: 'no-error-state', message: `Loads data (${what}) but shows no error state.` });
        if (!c.states.loading) issues.push({ kind: 'no-loading-state', message: `Loads data (${what}) but shows no loading state.` });
      }
      const twins = (byName.get(c.name) ?? []).filter((x) => x !== c && !x.parent && !c.parent);
      if (twins.length) {
        const where = twins.slice(0, 3).map((x) => x.path).join(', ') + (twins.length > 3 ? ` and ${twins.length - 3} more` : '');
        issues.push({
          kind: 'duplicate-name',
          message: `${twins.length + 1} components are named ${c.name}. Others: ${where}.`,
          related: twins[0].id,
        });
      }
      const unresolved = c.renders.filter((r) => !r.target && !r.pkg && !r.tag.includes('.'));
      for (const r of unresolved.slice(0, 5)) {
        issues.push({ kind: 'unknown', message: `Could not find where <${r.tag}> comes from.` });
      }
      if (c.acceptsRest) {
        issues.push({ kind: 'unknown', message: 'Some inputs come from a spread ({...rest}) or a library type, so the list may be incomplete.' });
      }
      c.issues = issues;
    }

    // Look-alikes: components that render mostly the same things with mostly the same inputs.
    const signatures = components.map((c) => ({
      c,
      sig: new Set([...c.renders.map((r) => `t:${r.tag}`), ...c.props.map((p) => `p:${p.name}`)]),
    }));
    for (let i = 0; i < signatures.length; i++) {
      const a = signatures[i];
      if (a.sig.size < 5) continue;
      for (let j = i + 1; j < signatures.length; j++) {
        const b = signatures[j];
        if (b.sig.size < 5 || a.c.name === b.c.name) continue;
        let shared = 0;
        for (const x of a.sig) if (b.sig.has(x)) shared++;
        const score = shared / (a.sig.size + b.sig.size - shared);
        if (score < 0.75) continue;
        const pct = Math.round(score * 100);
        if (a.c.issues.filter((x) => x.kind === 'similar').length < 3) {
          a.c.issues.push({ kind: 'similar', message: `Looks ${pct}% like ${b.c.name}. Could they be one component?`, related: b.c.id });
        }
        if (b.c.issues.filter((x) => x.kind === 'similar').length < 3) {
          b.c.issues.push({ kind: 'similar', message: `Looks ${pct}% like ${a.c.name}. Could they be one component?`, related: a.c.id });
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Parsing and AST helpers
// ---------------------------------------------------------------------------

function containsJsx(node: N): boolean {
  let found = false;
  const visit = (n: N) => {
    if (found) return;
    if (n.type === 'JSXElement' || n.type === 'JSXFragment') {
      found = true;
      return;
    }
    // createElement('div') counts too
    if (
      n.type === 'CallExpression' &&
      ((n.callee.type === 'MemberExpression' && n.callee.property.type === 'Identifier' && n.callee.property.name === 'createElement') ||
        (n.callee.type === 'Identifier' && (n.callee.name === 'createElement' || n.callee.name === 'h')))
    ) {
      found = true;
      return;
    }
    forEachChild(n, visit);
  };
  visit(node);
  return found;
}

/** Capitalized, per React's rule. Whether it really is a component is decided by it returning JSX. */
function isComponentName(name: string): boolean {
  return /^[A-Z]/.test(name);
}

function isComponentClass(node: t.Class): boolean {
  const s = node.superClass;
  if (s) {
    const name = s.type === 'Identifier' ? s.name : s.type === 'MemberExpression' && s.property.type === 'Identifier' ? s.property.name : '';
    if (/^(Pure)?Component$/.test(name)) return true;
  }
  return node.body.body.some(
    (m) => m.type === 'ClassMethod' && m.key.type === 'Identifier' && m.key.name === 'render' && containsJsx(m),
  );
}

function stripExpr(e: t.Expression): t.Expression {
  while (
    e.type === 'TSAsExpression' ||
    e.type === 'TSSatisfiesExpression' ||
    e.type === 'TSNonNullExpression' ||
    e.type === 'ParenthesizedExpression' ||
    e.type === 'TypeCastExpression'
  ) {
    e = e.expression;
  }
  return e;
}

function functionOf(e: t.Expression): t.Function | undefined {
  if (e.type === 'ArrowFunctionExpression' || e.type === 'FunctionExpression') return e;
  // useCallback-free wrappers are not plain functions; leave them.
  return undefined;
}

/** Finds the component function inside memo(), forwardRef(), observer(), connect()(), etc. */
function unwrapFn(e: t.Expression, depth = 0): { fn: FnNode; typeArgs?: t.TSType[] } | undefined {
  e = stripExpr(e);
  if (e.type === 'ArrowFunctionExpression' || e.type === 'FunctionExpression' || e.type === 'ClassExpression') return { fn: e };
  if (e.type === 'CallExpression' && depth < 4) {
    if (LAZY.has(calleeRoot(e))) return undefined;
    for (const arg of e.arguments) {
      if (arg.type === 'SpreadElement' || arg.type === 'ArgumentPlaceholder') continue;
      const inner = unwrapFn(arg as t.Expression, depth + 1);
      if (inner) {
        const typeArgs = e.typeParameters?.type === 'TSTypeParameterInstantiation' ? e.typeParameters.params : undefined;
        return { fn: inner.fn, typeArgs: inner.typeArgs ?? typeArgs };
      }
    }
    if (e.callee.type === 'CallExpression') return unwrapFn(e.callee, depth + 1);
  }
  return undefined;
}

/** `memo(Foo)` / `connect(a)(Foo)` / `withRouter(Foo)` → "Foo". */
function unwrapRef(e: t.Expression, depth = 0): string | undefined {
  e = stripExpr(e);
  if (e.type === 'Identifier') return e.name;
  if (e.type === 'CallExpression' && depth < 4 && !LAZY.has(calleeRoot(e))) {
    for (const arg of e.arguments) {
      if (arg.type === 'Identifier' && isComponentName(arg.name)) return arg.name;
      if (arg.type === 'CallExpression') {
        const inner = unwrapRef(arg, depth + 1);
        if (inner) return inner;
      }
    }
  }
  return undefined;
}

function lazyImport(e: t.Expression): string | undefined {
  if (e.type !== 'CallExpression' || !LAZY.has(calleeRoot(e))) return undefined;
  let spec: string | undefined;
  walk(e, (n) => {
    if (!spec && n.type === 'CallExpression' && n.callee.type === 'Import' && n.arguments[0]?.type === 'StringLiteral') {
      spec = n.arguments[0].value;
    }
  });
  return spec;
}

/** `db.projects.where` → the `db` identifier. */
function memberRoot(e: t.MemberExpression): t.Identifier | undefined {
  let o: t.Node = e;
  while (o.type === 'MemberExpression' || o.type === 'CallExpression' || o.type === 'OptionalMemberExpression' || o.type === 'OptionalCallExpression') {
    o = o.type === 'MemberExpression' || o.type === 'OptionalMemberExpression' ? o.object : o.callee;
  }
  return o.type === 'Identifier' ? o : undefined;
}

/** `db.projects.where(...).toArray()` → `db.projects`; `supabase.from('orders')` → `supabase.from('orders')`. */
function clientLabel(f: FileInfo, callee: t.MemberExpression, root: string): string {
  const text = sliceText(f.text, callee);
  const m = text.match(new RegExp(`^${root}\\??\\.(\\w+)(\\(\\s*['"\`][^'"\`]+['"\`]\\s*\\))?`));
  return m ? `${root}.${m[1]}${m[2] ?? ''}` : root;
}

function calleeRoot(call: t.CallExpression): string {
  let c: t.Node = call.callee;
  while (c.type === 'CallExpression') c = c.callee;
  if (c.type === 'Identifier') return c.name;
  if (c.type === 'MemberExpression' && c.property.type === 'Identifier') return c.property.name;
  return '';
}

function constantValue(e: t.Expression): string | Map<string, string> | undefined {
  e = stripExpr(e);
  if (e.type === 'StringLiteral') return e.value;
  if (e.type === 'TemplateLiteral' && !e.expressions.length) return e.quasis[0].value.cooked ?? '';
  if (e.type === 'ObjectExpression') {
    const map = new Map<string, string>();
    for (const p of e.properties) {
      if (p.type !== 'ObjectProperty' || (p.key.type !== 'Identifier' && p.key.type !== 'StringLiteral')) continue;
      const v = constantValue(p.value as t.Expression);
      if (typeof v === 'string') map.set(nameOf(p.key), v);
    }
    return map.size ? map : undefined;
  }
  return undefined;
}

function declaredNames(d: N): string[] {
  if ((d.type === 'FunctionDeclaration' || d.type === 'ClassDeclaration') && d.id) return [d.id.name];
  if (d.type === 'TSInterfaceDeclaration' || d.type === 'TSTypeAliasDeclaration' || d.type === 'TSEnumDeclaration') return [d.id.name];
  if (d.type === 'VariableDeclaration') return d.declarations.flatMap((v) => (v.id.type === 'Identifier' ? [v.id.name] : []));
  return [];
}

function patternNames(p: t.ObjectPattern): { name: string; optional: boolean }[] {
  const out: { name: string; optional: boolean }[] = [];
  for (const prop of p.properties) {
    if (prop.type !== 'ObjectProperty') continue;
    if (prop.key.type !== 'Identifier' && prop.key.type !== 'StringLiteral') continue;
    out.push({ name: nameOf(prop.key), optional: prop.value.type === 'AssignmentPattern' });
  }
  return out;
}

function isThisProps(e: N): boolean {
  return e.type === 'MemberExpression' && e.object.type === 'ThisExpression' && e.property.type === 'Identifier' && e.property.name === 'props';
}

/** Identifier used as a value (not a declaration, key, or property name). */
function isReference(parent: N | undefined, key: string | undefined): boolean {
  if (!parent) return false;
  switch (parent.type) {
    case 'VariableDeclarator':
    case 'FunctionDeclaration':
    case 'ClassDeclaration':
    case 'FunctionExpression':
    case 'ClassExpression':
      return key !== 'id' && key !== 'params';
    case 'MemberExpression':
    case 'OptionalMemberExpression':
      return key === 'object' || !!parent.computed;
    case 'ObjectProperty':
      return key === 'value';
    case 'ObjectMethod':
    case 'ClassMethod':
    case 'ClassProperty':
      return key !== 'key';
    case 'ExportSpecifier':
    case 'ImportSpecifier':
    case 'ImportDefaultSpecifier':
    case 'LabeledStatement':
    case 'BreakStatement':
    case 'ContinueStatement':
    case 'ExportDefaultDeclaration':
      return false;
    case 'ArrowFunctionExpression':
      return key === 'body';
    default:
      return !parent.type.startsWith('TS');
  }
}

function jsxName(n: t.JSXOpeningElement['name']): string {
  if (n.type === 'JSXIdentifier') return n.name;
  if (n.type === 'JSXNamespacedName') return `${n.namespace.name}:${n.name.name}`;
  return `${jsxName(n.object as t.JSXOpeningElement['name'])}.${n.property.name}`;
}

function jsxAttrName(a: t.JSXAttribute): string {
  return a.name.type === 'JSXIdentifier' ? a.name.name : `${a.name.namespace.name}:${a.name.name.name}`;
}

function nameOf(n: t.Identifier | t.StringLiteral | t.Node): string {
  if (n.type === 'Identifier') return n.name;
  if (n.type === 'StringLiteral') return n.value;
  return '';
}

function entityName(n: t.TSEntityName): string {
  if (n.type === 'Identifier') return n.name;
  if (n.type === 'TSQualifiedName') return `${entityName(n.left)}.${n.right.name}`;
  return '';
}

function literalUnion(type: t.TSType): string[] {
  if (type.type === 'TSLiteralType' && type.literal.type === 'StringLiteral') return [type.literal.value];
  if (type.type === 'TSUnionType') return type.types.flatMap(literalUnion);
  return [];
}

/**
 * When a fact fires. Known directly (inside useEffect, onClick…), or through the local function around it:
 * `const load = async () => fetch(...)` used in `useEffect(() => { load() })` → on load.
 * A hook's local function that the hook never calls itself is returned for components to call from events.
 */
function resolveTrigger(facts: Facts, item: Origin, isHook: boolean): Trigger | undefined {
  if (item.trigger) return item.trigger;
  if (!item.localFn) return undefined;
  const uses = facts.localUses.filter((u) => u.name === item.localFn);
  if (uses.some((u) => u.trigger === 'load')) return 'load';
  if (uses.some((u) => u.trigger === 'action')) return 'action';
  return isHook ? 'action' : undefined;
}

function stripOrigin<T extends Origin>(d: T): Omit<T, 'localFn'> {
  const { localFn: _, ...rest } = d;
  return rest;
}

/** Context for the children of a node: does code in there run on load, on an action, or in a local function? */
function childOrigin<C extends Origin>(node: N, ctx: C, isOwner: boolean): C {
  if (isOwner) return ctx;
  switch (node.type) {
    case 'CallExpression': {
      const c = node.callee;
      const name = c.type === 'Identifier' ? c.name : c.type === 'MemberExpression' && c.property.type === 'Identifier' ? c.property.name : '';
      if (LOAD_HOOKS.has(name)) return { ...ctx, trigger: 'load' };
      if (ACTION_HOOKS.has(name)) return { ...ctx, trigger: 'action' };
      return ctx;
    }
    case 'JSXAttribute':
      return /^on[A-Z]/.test(jsxAttrName(node)) ? { ...ctx, trigger: 'action' } : ctx;
    case 'ObjectProperty':
    case 'ObjectMethod': {
      const key = nameOf(node.key);
      if (/^on[A-Z]/.test(key) || key === 'mutationFn') return { ...ctx, trigger: 'action' };
      if (key === 'queryFn') return { ...ctx, trigger: 'load' };
      return ctx;
    }
    case 'VariableDeclarator': {
      if (node.id.type !== 'Identifier' || !node.init) return ctx;
      const init = stripExpr(node.init);
      const isFn =
        init.type === 'ArrowFunctionExpression' ||
        init.type === 'FunctionExpression' ||
        (init.type === 'CallExpression' && /^use(Callback|Memo)$/.test(calleeRoot(init)));
      if (!isFn) return ctx;
      return { ...ctx, localFn: node.id.name, trigger: ACTION_NAME.test(node.id.name) ? 'action' : ctx.trigger };
    }
    case 'FunctionDeclaration':
      return node.id ? { ...ctx, localFn: node.id.name, trigger: ACTION_NAME.test(node.id.name) ? 'action' : ctx.trigger } : ctx;
  }
  return ctx;
}

/** Is this name run at this spot, rather than just mentioned or handed to something else? */
function runsHere(id: t.Identifier, parent: N | undefined, key: string | undefined): boolean {
  if (!parent) return false;
  if (parent.type === 'CallExpression' || parent.type === 'OptionalCallExpression') {
    if (key === 'callee') return true; // load()
    const c = parent.callee;
    const hook = c.type === 'Identifier' ? c.name : c.type === 'MemberExpression' && c.property.type === 'Identifier' ? c.property.name : '';
    return parent.arguments[0] === id && (LOAD_HOOKS.has(hook) || ACTION_HOOKS.has(hook)); // useEffect(load)
  }
  if (parent.type === 'JSXExpressionContainer') return true; // onClick={load}
  if (parent.type === 'ObjectProperty' && key === 'value') return /^on[A-Z]|^(queryFn|mutationFn)$/.test(nameOf(parent.key)); // { onSuccess: load }
  return false;
}

/** `process.env.API_URL` / `import.meta.env.VITE_API` → the variable name. */
function envName(e: N): string | undefined {
  if (e.type !== 'MemberExpression') return undefined;
  const key = e.property.type === 'Identifier' ? e.property.name : e.property.type === 'StringLiteral' ? e.property.value : undefined;
  const o = e.object;
  if (!key || o.type !== 'MemberExpression' || o.property.type !== 'Identifier' || o.property.name !== 'env') return undefined;
  const root = o.object;
  return (root.type === 'Identifier' && root.name === 'process') || root.type === 'MetaProperty' ? key : undefined;
}

/** A readable name for an unknown part of a URL: `order.id` → `id`, `getBase()` → `getBase`. */
function placeholder(e: N): string {
  if (e.type === 'Identifier') return e.name;
  if (e.type === 'MemberExpression' && e.property.type === 'Identifier') return e.property.name;
  if (e.type === 'CallExpression') return placeholder(e.callee);
  return 'value';
}

/** Drops the query string and doubled slashes: `/api//orders?x=1` → `/api/orders`. */
function cleanUrl(url: string): string {
  let out = url.split(/[?#]/)[0].replace(/([^:/]|^)\/{2,}/g, '$1/');
  if (out.length > 1 && out.endsWith('/') && !out.endsWith('://')) out = out.slice(0, -1);
  return out;
}

function joinUrl(base: string | undefined, path: string): string {
  if (!base || /^https?:\/\//.test(path) || path.startsWith('{')) return path;
  return cleanUrl(`${base.replace(/\/$/, '')}/${path.replace(/^\//, '')}`);
}

function looksLikeUrl(url: string | undefined): boolean {
  return !!url && (url.startsWith('/') || /^https?:\/\//.test(url) || /^\{[^}]+\}\//.test(url) || url.includes('/api'));
}

/** `{ method: 'POST' }` → `POST`. */
function optionMethod(arg: N | undefined): string | undefined {
  if (arg?.type !== 'ObjectExpression') return undefined;
  const m = arg.properties.find((p) => p.type === 'ObjectProperty' && nameOf(p.key) === 'method') as t.ObjectProperty | undefined;
  return m?.value.type === 'StringLiteral' ? m.value.value.toUpperCase() : undefined;
}

function isExpression(n: N): n is t.Expression {
  return !/(Statement|Declaration|Specifier|Pattern|^ObjectProperty$|^ObjectMethod$|^JSXAttribute$|^JSXText$)/.test(n.type);
}

function queryKey(f: FileInfo, call: t.CallExpression): string {
  const arg = call.arguments[0];
  if (!arg) return '';
  let text = '';
  if (arg.type === 'ObjectExpression') {
    const key = arg.properties.find((p) => p.type === 'ObjectProperty' && nameOf(p.key) === 'queryKey') as t.ObjectProperty | undefined;
    text = key ? sliceText(f.text, key.value) : '';
  } else if (arg.type !== 'ArrowFunctionExpression' && arg.type !== 'FunctionExpression') {
    text = sliceText(f.text, arg);
  }
  return text ? ` ${text.length > 48 ? `${text.slice(0, 47)}…` : text}` : '';
}

function joinRoute(prefix: string, path: string): string {
  if (!path) return prefix || '/';
  if (path.startsWith('/') || path === '*') return path === '*' && prefix ? `${prefix.replace(/\/$/, '')}/*` : path;
  return `${prefix.replace(/\/$/, '')}/${path}`;
}

function nameFromPath(path: string): string {
  const parts = path.replace(/\.[^.]+$/, '').split('/');
  let base = parts.pop() ?? 'Component';
  if (base === 'index' || base === 'page' || base === 'layout') base = parts.pop() ?? base;
  const pascal = base.replace(/(^|[-_.\s[\]()]+)(\w)/g, (_, __, c: string) => c.toUpperCase());
  return /^[A-Z]/.test(pascal) ? pascal : `Component${pascal}`;
}

function emptyInfo(source: SourceFile): FileInfo {
  return {
    path: source.path,
    text: source.text,
    imports: new Map(),
    exports: new Map(),
    exportAll: [],
    components: new Map(),
    aliases: new Map(),
    functions: new Map(),
    objects: new Set(),
    storeHooks: new Set(),
    clients: new Set(),
    httpClients: new Map(),
    localVars: new Map(),
    variables: new Set(),
    types: new Map(),
    constants: new Map(),
  };
}

function emptyFacts(): Facts {
  return { data: [], calls: [], localUses: [], idents: new Set(), text: [] };
}

