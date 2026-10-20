// Exact data shapes from TypeScript: the project's own TypeScript (the version and settings it compiles with), or
// the TypeScript 5 bundled with the plugin when it has none with a compiler interface (plain JS, or TypeScript 7), is
// asked for the real type of each prop, context and API reply, and the type becomes a shape: every field, unions like
// 'admin' | 'user', enums, dates, lists. Where there's no type (any, unknown), the usage-based shapes fill in. No VS
// Code APIs, so it can be tested.

import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type * as TS from 'typescript-5';
import { weight, type Shape } from './shape';

type Ts = typeof TS;

/** The project's own TypeScript, when it has one with the compiler interface (TypeScript 5 and earlier). */
export function loadTypeScript(root: string): Ts | undefined {
  try {
    const ts = createRequire(join(root, 'package.json'))('typescript') as Ts;
    return typeof ts.createProgram === 'function' ? ts : undefined;
  } catch {
    return undefined;
  }
}

/** The plugin's own TypeScript 5, bundled with it (loaded only when first needed: it's big). */
let bundled: Ts | undefined;

/** The project's TypeScript, or the plugin's own TypeScript 5. */
export function typeScriptFor(root: string): Ts {
  return loadTypeScript(root) ?? (bundled ??= require('typescript-5') as Ts);
}

/**
 * Where the bundled TypeScript's built-in declarations (Date, Promise, the DOM…) are: copied next to the bundle
 * (dist/ts-lib) when built, or in node_modules when running from source (tests).
 */
function bundledLibs(): string | undefined {
  const copied = join(__dirname, 'ts-lib');
  if (existsSync(join(copied, 'lib.es5.d.ts'))) return copied;
  try {
    return dirname(require.resolve('typescript-5/lib/lib.es5.d.ts'));
  } catch {
    return undefined;
  }
}

/**
 * One project's types, built when first needed and rebuilt (reusing what didn't change) after edits. Only the files
 * asked about (and what they import) are read, never the whole project: a preview of one component in a project of
 * 10,000 reads a few hundred.
 */
export class TypeView {
  private program: TS.Program | undefined;
  private stale = true;
  /** The files asked about so far (absolute paths). */
  private readonly wanted = new Set<string>();

  constructor(
    private readonly ts: Ts,
    readonly root: string,
  ) {}

  /** Files changed: the next question rebuilds the program (TypeScript reuses the unchanged files). */
  invalidate() {
    this.stale = true;
  }

  get checker(): TS.TypeChecker {
    return this.build().getTypeChecker();
  }

  /** Files about to be asked about, added together (one rebuild instead of one per file). */
  want(paths: string[]) {
    for (const p of paths) {
      const abs = resolve(this.root, p);
      if (!this.wanted.has(abs)) {
        this.wanted.add(abs);
        this.stale = true;
      }
    }
  }

  private build(): TS.Program {
    if (this.program && !this.stale) return this.program;
    const { files, options } = this.config();
    // The project's own declarations (vite-env.d.ts, *.svg modules…) and the files asked about.
    const rootNames = [...files.filter((f) => /\.d\.ts$/.test(f)), ...this.wanted];
    const host = this.ts.createCompilerHost({ ...options, noEmit: true });
    // The bundled TypeScript can't find its own declarations where it would look (next to its own file).
    const libs = this.ts === bundled ? bundledLibs() : undefined;
    if (libs) {
      host.getDefaultLibLocation = () => libs;
      host.getDefaultLibFileName = (o) => join(libs, this.ts.getDefaultLibFileName(o));
    }
    this.program = this.ts.createProgram({ rootNames, options: { ...options, noEmit: true }, host, oldProgram: this.program });
    this.stale = false;
    return this.program;
  }

  /**
   * The project's files and settings from its tsconfig.json, following project references (Vite's template keeps
   * the app's settings in tsconfig.app.json): the referenced config with the most files is the app's.
   */
  private config(): { files: string[]; options: TS.CompilerOptions } {
    const ts = this.ts;
    const host: TS.ParseConfigFileHost = { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} };
    const parse = (path: string) => (existsSync(path) ? ts.getParsedCommandLineOfConfigFile(path, {}, host) : undefined);
    const top = parse(join(this.root, 'tsconfig.json'));
    const fallback = { files: [] as string[], options: { allowJs: true, jsx: ts.JsxEmit.Preserve, strict: true, skipLibCheck: true } as TS.CompilerOptions };
    if (!top) return fallback;
    if (top.fileNames.length || !top.projectReferences?.length) return { files: top.fileNames, options: top.options };
    const refs = top.projectReferences
      .map((r) => parse(r.path.endsWith('.json') ? r.path : join(r.path, 'tsconfig.json')))
      .filter((p): p is TS.ParsedCommandLine => !!p)
      .sort((a, b) => b.fileNames.length - a.fileNames.length);
    if (!refs.length) return fallback;
    return { files: [...new Set(refs.flatMap((r) => r.fileNames))], options: refs[0].options };
  }

  private source(path: string): TS.SourceFile | undefined {
    this.want([path]);
    return this.build().getSourceFile(resolve(this.root, path));
  }

  /** The type of the identifier that starts exactly at `start` in a file. */
  typeAt(path: string, start: number): TS.Type | undefined {
    const file = this.source(path);
    if (!file) return undefined;
    const ts = this.ts;
    let found: TS.Node | undefined;
    const visit = (n: TS.Node) => {
      if (found || start < n.getFullStart() || start >= n.getEnd()) return;
      if (ts.isIdentifier(n) && n.getStart(file) === start) found = n;
      else ts.forEachChild(n, visit);
    };
    visit(file);
    return found ? this.checker.getTypeAtLocation(found) : undefined;
  }

  /** The props type of a component (its first parameter), found by name in its file. */
  propsOf(path: string, name: string): TS.Type | undefined {
    const file = this.source(path);
    if (!file) return undefined;
    const ts = this.ts;
    let param: TS.ParameterDeclaration | undefined;
    const fnOf = (n: TS.Node | undefined): TS.SignatureDeclaration | undefined => {
      if (!n) return undefined;
      if (ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isFunctionDeclaration(n)) return n;
      // memo(…) / forwardRef(…) / observer(…)
      if (ts.isCallExpression(n)) return n.arguments.map((a) => fnOf(a)).find(Boolean);
      if (ts.isParenthesizedExpression(n) || ts.isAsExpression(n)) return fnOf(n.expression);
      return undefined;
    };
    const visit = (n: TS.Node) => {
      if (param) return;
      if (ts.isFunctionDeclaration(n) && n.name?.text === name) param = n.parameters[0];
      else if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name) param = fnOf(n.initializer)?.parameters[0];
      if (!param) ts.forEachChild(n, visit);
    };
    visit(file);
    if (!param) return undefined;
    return this.checker.getTypeAtLocation(param);
  }

  /** A component's props from its props type: each one's type as written by TypeScript, its shape, and whether it's optional. */
  propsList(path: string, name: string): { name: string; type: string; shape: Shape | undefined; optional: boolean }[] | undefined {
    const type = this.propsOf(path, name);
    if (!type || type.flags & (this.ts.TypeFlags.Any | this.ts.TypeFlags.Unknown)) return undefined;
    const checker = this.checker;
    return checker.getPropertiesOfType(type).map((p) => {
      const t = checker.getTypeOfSymbol(p);
      const canBeUndefined = t.isUnion() && t.types.some((x) => x.flags & this.ts.TypeFlags.Undefined);
      return {
        name: p.getName(),
        type: checker.typeToString(t, undefined, this.ts.TypeFormatFlags.NoTruncation),
        shape: this.shapeOf(t),
        optional: !!(p.flags & this.ts.SymbolFlags.Optional) || canBeUndefined,
      };
    });
  }

  /** The type of the first call to `callee` (e.g. useContext) on a line (0-based) of a file: what it gives back. */
  typeOfCall(path: string, line: number, callee: string): TS.Type | undefined {
    const file = this.source(path);
    if (!file) return undefined;
    const ts = this.ts;
    let found: TS.CallExpression | undefined;
    const visit = (n: TS.Node) => {
      if (found) return;
      if (ts.isCallExpression(n) && file.getLineAndCharacterOfPosition(n.getStart(file)).line === line && n.expression.getText(file).split('.').pop() === callee) found = n;
      else ts.forEachChild(n, visit);
    };
    visit(file);
    return found ? this.checker.getTypeAtLocation(found) : undefined;
  }

  /** The type of the code exactly between two positions of a file (as a parser gives them). */
  typeOfSpan(path: string, start: number, end: number): TS.Type | undefined {
    const file = this.source(path);
    if (!file) return undefined;
    const ts = this.ts;
    let found: TS.Node | undefined;
    const visit = (n: TS.Node) => {
      if (found || start < n.getFullStart() || start >= n.getEnd()) return;
      if (n.getStart(file) === start && n.getEnd() === end && !ts.isExpressionStatement(n)) found = n;
      else ts.forEachChild(n, visit);
    };
    visit(file);
    return found ? this.checker.getTypeAtLocation(found) : undefined;
  }

  /** A literal type's value ('MICROSERVICE' for NodeType.MICROSERVICE), when it has exactly one. */
  literalOf(type: TS.Type): string | number | undefined {
    if (type.isStringLiteral() || type.isNumberLiteral()) return type.value;
    return undefined;
  }

  /** What a database read gives one row of: the awaited result, its list's items, without undefined. */
  rowOf(type: TS.Type): TS.Type | undefined {
    const ts = this.ts;
    let t = this.checker.getAwaitedType(type) ?? type;
    if (t.isUnion()) t = t.types.find((x) => !(x.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null | ts.TypeFlags.Void))) ?? t;
    if (this.checker.isArrayType(t)) t = this.checker.getTypeArguments(t as TS.TypeReference)[0] ?? t;
    return t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.NumberLike) ? undefined : t;
  }

  /** A type as TypeScript writes it. */
  text(type: TS.Type): string {
    return this.checker.typeToString(type, undefined, this.ts.TypeFormatFlags.NoTruncation);
  }

  /** The type of a member (`store.init`). */
  memberType(type: TS.Type, name: string): TS.Type | undefined {
    const p = type.getProperty(name);
    return p ? this.checker.getTypeOfSymbol(p) : undefined;
  }

  /** What calling a member returns (`store.getState()`). */
  returnOfMember(type: TS.Type, name: string): TS.Type | undefined {
    const m = this.memberType(type, name);
    const sig = m?.getCallSignatures()[0];
    return sig ? this.checker.getReturnTypeOfSignature(sig) : undefined;
  }

  /** A type as a shape (fields, lists, literal values, enums, dates), as deep as is useful. */
  shapeOf(type: TS.Type, depth = 0, seen = new Set<TS.Type>()): Shape | undefined {
    const ts = this.ts;
    const checker = this.checker;
    const F = ts.TypeFlags;
    if (type.flags & (F.Any | F.Unknown | F.Never)) return undefined;
    // Something React draws (children, an icon slot): text is the example, never an element object.
    if (/^(ReactNode|ReactElement|ReactChild|ReactFragment|ReactPortal|Element)$/.test(type.aliasSymbol?.getName() ?? '')) return { kind: 'node' };
    if (type.isUnion()) {
      const parts = type.types.filter((t) => !(t.flags & (F.Undefined | F.Null | F.Void)));
      if (!parts.length) return undefined;
      if (parts.every((t) => t.flags & F.BooleanLiteral)) return { kind: 'boolean' };
      if (parts.every((t) => t.isStringLiteral())) return { kind: 'string', values: parts.map((t) => (t as TS.StringLiteralType).value) };
      if (parts.every((t) => t.isNumberLiteral())) return { kind: 'number', values: parts.map((t) => (t as TS.NumberLiteralType).value) };
      // Mixed (an object or null, a list or a string…): the richest part.
      const shapes = parts.map((t) => this.shapeOf(t, depth, seen)).filter((s): s is Shape => !!s);
      return shapes.sort((a, b) => weight(b) - weight(a))[0];
    }
    if (type.isStringLiteral()) return { kind: 'string', values: [type.value] };
    if (type.isNumberLiteral()) return { kind: 'number', values: [type.value] };
    if (type.flags & (F.String | F.TemplateLiteral)) return { kind: 'string' };
    if (type.flags & (F.Number | F.BigInt)) return { kind: 'number' };
    if (type.flags & (F.Boolean | F.BooleanLiteral)) return { kind: 'boolean' };
    if (seen.has(type) || depth > 5) return {};
    const name = type.getSymbol()?.getName() ?? type.aliasSymbol?.getName();
    if (name === 'Date') return { kind: 'date' };
    // A Set or a Map: their items (a Map's values, keyed by text).
    if (name === 'Set' || name === 'ReadonlySet' || name === 'Map' || name === 'ReadonlyMap') {
      const args = checker.getTypeArguments(type as TS.TypeReference);
      const item = args[name.endsWith('Set') ? 0 : 1];
      const inner = item ? this.shapeOf(item, depth + 1, new Set([...seen, type])) : undefined;
      return { kind: name.endsWith('Set') ? 'set' : 'map', item: inner ?? {} };
    }
    if (name && /^(ReactNode|ReactElement|Element)$/.test(name)) return { kind: 'node' };
    // The browser's and React's own things (elements, events, refs…) aren't data: a ref is empty, the rest null.
    const decl = (type.aliasSymbol ?? type.getSymbol())?.declarations?.[0]?.getSourceFile();
    if (decl && (this.build().isSourceFileDefaultLibrary(decl) || /[\\/]node_modules[\\/]@types[\\/]react(-dom)?[\\/]/.test(decl.fileName))) {
      const alias = type.aliasSymbol?.getName() ?? name ?? '';
      if (/^(RefObject|MutableRefObject|Ref|LegacyRef|ForwardedRef)$/.test(alias)) return { kind: 'ref' };
      if (!/^(Record|Partial|Required|Readonly|Pick|Omit|ReadonlyArray|Array|Iterable)$/.test(alias)) return { kind: 'opaque' };
    }
    if (name === 'Promise') {
      const inner = (type as TS.TypeReference).typeArguments?.[0] ?? checker.getAwaitedType(type);
      return inner ? this.shapeOf(inner, depth, seen) : undefined;
    }
    if (checker.isArrayType(type) || checker.isTupleType(type)) {
      const item = checker.getTypeArguments(type as TS.TypeReference)[0];
      const inner = item ? this.shapeOf(item, depth + 1, new Set([...seen, type])) : undefined;
      return { kind: 'array', ...(inner ? { item: inner } : { item: {} }) };
    }
    if (type.getCallSignatures().length && !type.getProperties().length) return { kind: 'function' };
    const props = checker.getPropertiesOfType(type);
    if (!props.length) return type.flags & F.Object ? { kind: 'object', fields: {} } : undefined;
    const fields: Record<string, Shape> = {};
    const inner = new Set([...seen, type]);
    for (const p of props) {
      // Methods on class instances and the like aren't data.
      if (p.flags & ts.SymbolFlags.Method) continue;
      // A library's optional settings (React Flow's parentId, extent, handles…) are left out: filled with made-up
      // values they change how things behave, not what they show. The app's own optional fields are still filled.
      if (p.flags & ts.SymbolFlags.Optional && /[\\/]node_modules[\\/]/.test(p.declarations?.[0]?.getSourceFile().fileName ?? '')) continue;
      const shape = this.shapeOf(checker.getTypeOfSymbol(p), depth + 1, inner);
      if (shape) fields[p.getName()] = p.flags & ts.SymbolFlags.Optional ? { ...shape, optional: true } : shape;
    }
    return { kind: 'object', fields };
  }
}
