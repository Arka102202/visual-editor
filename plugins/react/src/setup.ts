// What the React plugin keeps in place in a project it detects (docs/variants.md): Visual Editor's helper, in the
// extension's own folder (.visual-editor/react/visual-editor.tsx), and the short name components import it by
// (@visual-editor/react) in the TypeScript and Vite configs, written in the style the project already uses. The shell
// writes these as soon as the project is opened, and again when this plugin ships a newer helper (never an older one;
// a helper only reformatted by a formatter is left alone). Pure: files in, changes out.

import { posix } from 'node:path';
import { parse } from '@babel/parser';
import type * as t from '@babel/types';
import type { ProjectSetup } from '@visual-editor/contract';
import { helperVersion } from './helper';

/** Where the helper lives in a project, and the name it's imported by. */
export const HELPER_PATH = '.visual-editor/react/visual-editor.tsx';
export const HELPER_NAME = '@visual-editor/react';

type Read = (path: string) => string | undefined;

export function setupProject(read: Read, template: string | undefined): ProjectSetup | undefined {
  if (!template) return { changes: [], said: '', problems: ['Visual Editor’s helper couldn’t be found in the React plugin (reinstall it).'] };
  const changes: ProjectSetup['changes'] = [];
  const done: string[] = [];
  const problems: string[] = [];

  // The helper: added when missing, updated when this plugin's is newer (never made older).
  const now = read(HELPER_PATH);
  const next = helperVersion(template);
  if (now === undefined) {
    changes.push({ path: HELPER_PATH, before: null, after: template });
    done.push(`added its helper (${HELPER_PATH}, version ${next})`);
  } else if (helperVersion(now) < next) {
    changes.push({ path: HELPER_PATH, before: now, after: template });
    done.push(`updated its helper (version ${helperVersion(now)} → ${next})`);
  } else if (helperVersion(now) > next) {
    problems.push(`This project’s helper (version ${helperVersion(now)}) is newer than your Visual Editor’s (version ${next}): update the Visual Editor extensions.`);
  }

  // The short name, for TypeScript and for Vite.
  const ts = ['tsconfig.app.json', 'tsconfig.json', 'jsconfig.json'].find((p) => /"compilerOptions"\s*:/.test(read(p) ?? ''));
  if (ts) {
    const text = read(ts)!;
    const after = addTsPath(text, ts);
    if (after && after !== text) {
      changes.push({ path: ts, before: text, after });
      done.push(`added the short name ${HELPER_NAME} to ${ts}`);
    }
  }
  const vite = ['vite.config.ts', 'vite.config.mts', 'vite.config.js', 'vite.config.mjs'].find((p) => read(p) !== undefined);
  if (vite) {
    const text = read(vite)!;
    const after = addViteAlias(text);
    if (typeof after === 'string' && after !== text) {
      changes.push({ path: vite, before: text, after });
      done.push(`added it to ${vite}`);
    } else if (after === null) problems.push(`${vite} couldn’t be read for its aliases: add ${HELPER_NAME} → ./${HELPER_PATH} to its resolve.alias yourself.`);
  }
  if (!changes.length && !problems.length) return undefined;
  return { changes, said: done.length ? `Visual Editor ${done.join(', ')}. Commit ${changes.length === 1 ? 'it' : 'them'} with your next commit.` : '', ...(problems.length ? { problems } : {}) };
}

/** tsconfig: `"paths": { "@visual-editor/react": ["…/visual-editor.tsx"] }` (relative to its baseUrl, if any). */
export function addTsPath(text: string, file: string): string | undefined {
  if (text.includes(`"${HELPER_NAME}"`)) return text;
  const base = /"baseUrl"\s*:\s*"([^"]*)"/.exec(text)?.[1];
  const from = posix.normalize(posix.join(posix.dirname(file), base ?? '.'));
  let target = posix.relative(from, HELPER_PATH);
  // Without a baseUrl, paths must start with ./ (with one, the project's own style: archFlow writes "src/…").
  // (".visual-editor/…" starts with a dot but isn't relative: check for ./ and ../ themselves.)
  if (!base && !target.startsWith('./') && !target.startsWith('../')) target = `./${target}`;
  const paths = /"paths"\s*:\s*\{/.exec(text);
  if (paths) {
    const at = paths.index + paths[0].length;
    const indent = /\n([ \t]*)"/.exec(text.slice(at))?.[1] ?? '      ';
    return `${text.slice(0, at)}\n${indent}"${HELPER_NAME}": ["${target}"],${text.slice(at)}`;
  }
  const options = /"compilerOptions"\s*:\s*\{/.exec(text);
  if (!options) return undefined;
  const at = options.index + options[0].length;
  const indent = /\n([ \t]*)"/.exec(text.slice(at))?.[1] ?? '    ';
  return `${text.slice(0, at)}\n${indent}"paths": { "${HELPER_NAME}": ["${target}"] },${text.slice(at)}`;
}

/**
 * vite.config: the alias, copying the shape of an entry the project already has (`resolve(__dirname, 'src/x')`,
 * `fileURLToPath(new URL('./src/x', import.meta.url))`…), or a standard one. Undefined: nothing needed (it's there, or
 * vite-tsconfig-paths reads the tsconfig); null: the config couldn't be read.
 */
export function addViteAlias(text: string): string | undefined | null {
  if (text.includes(HELPER_NAME) || /vite-tsconfig-paths/.test(text)) return undefined;
  let ast;
  try {
    ast = parse(text, { sourceType: 'module', plugins: ['typescript', 'jsx'] });
  } catch {
    return null;
  }
  const config = configObject(ast.program.body);
  if (!config) return null;
  const prop = (o: t.ObjectExpression, name: string) => o.properties.find((p): p is t.ObjectProperty => p.type === 'ObjectProperty' && ((p.key.type === 'Identifier' && p.key.name === name) || (p.key.type === 'StringLiteral' && p.key.value === name)));
  const indentAt = (pos: number) => /[ \t]*$/.exec(text.slice(text.lastIndexOf('\n', pos - 1) + 1, pos))?.[0] ?? '  ';
  const insertAfter = (node: t.Node, what: string) => text.slice(0, node.end!) + what + text.slice(node.end!);
  const standard = `fileURLToPath(new URL('./${HELPER_PATH}', import.meta.url))`;
  const withUrlImport = (s: string) => (/\bfileURLToPath\b[^;\n]*from\s+['"](node:)?url['"]/.test(s) ? s : `import { fileURLToPath, URL } from 'node:url'\n${s}`);

  const resolve = prop(config, 'resolve');
  const alias = resolve?.value.type === 'ObjectExpression' ? prop(resolve.value, 'alias') : undefined;
  if (alias?.value.type === 'ObjectExpression' && alias.value.properties.length) {
    const last = alias.value.properties[alias.value.properties.length - 1];
    const first = alias.value.properties.find((p): p is t.ObjectProperty => p.type === 'ObjectProperty');
    const value = first ? sameShape(text, first.value) : undefined;
    const quote = first?.key.type === 'StringLiteral' ? text[first.key.start!] : "'";
    const line = `,\n${indentAt(last.start!)}${quote}${HELPER_NAME}${quote}: ${value ?? standard}`;
    const out = insertAfter(last, line);
    return value ? out : withUrlImport(out);
  }
  if (alias?.value.type === 'ArrayExpression' && alias.value.elements.length) {
    const last = alias.value.elements[alias.value.elements.length - 1]!;
    const first = alias.value.elements.find((e): e is t.ObjectExpression => e?.type === 'ObjectExpression');
    const replacement = first ? prop(first, 'replacement') : undefined;
    const value = replacement ? sameShape(text, replacement.value) : undefined;
    const out = insertAfter(last, `,\n${indentAt(last.start!)}{ find: '${HELPER_NAME}', replacement: ${value ?? standard} }`);
    return value ? out : withUrlImport(out);
  }
  if (alias) return null;
  // No aliases yet: a standard one.
  if (resolve?.value.type === 'ObjectExpression') {
    const open = resolve.value.start! + 1;
    return withUrlImport(`${text.slice(0, open)}\n${indentAt(resolve.start!)}  alias: { '${HELPER_NAME}': ${standard} },${text.slice(open)}`);
  }
  const open = config.start! + 1;
  const indent = config.properties[0] ? indentAt(config.properties[0].start!) : '  ';
  return withUrlImport(`${text.slice(0, open)}\n${indent}resolve: { alias: { '${HELPER_NAME}': ${standard} } },${text.slice(open)}`);
}

/** An alias value written like another one, pointing at the helper: the path string inside it is swapped. */
function sameShape(text: string, value: t.Node): string | undefined {
  const strings: t.StringLiteral[] = [];
  const visit = (n: unknown): void => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) return n.forEach(visit);
    const node = n as t.Node;
    if (node.type === 'StringLiteral') strings.push(node);
    for (const [k, v] of Object.entries(node)) if (k !== 'loc' && !k.endsWith('Comments') && v && typeof v === 'object') visit(v);
  };
  visit(value);
  const path = strings[strings.length - 1];
  if (!path || path.start == null || path.end == null || value.start == null || value.end == null) return undefined;
  const quote = text[path.start];
  const target = path.value.startsWith('./') ? `./${HELPER_PATH}` : path.value.startsWith('/') ? `/${HELPER_PATH}` : HELPER_PATH;
  return text.slice(value.start, path.start) + quote + target + quote + text.slice(path.end, value.end);
}

/** The config object: `export default defineConfig({ … })`, `defineConfig(() => ({ … }))`, or a plain object. */
function configObject(body: t.Statement[]): t.ObjectExpression | undefined {
  const exp = body.find((s): s is t.ExportDefaultDeclaration => s.type === 'ExportDefaultDeclaration');
  let node: t.Node | null | undefined = exp?.declaration;
  for (let i = 0; i < 5 && node; i++) {
    if (node.type === 'ObjectExpression') return node;
    if (node.type === 'CallExpression') node = node.arguments[0];
    else if (node.type === 'ArrowFunctionExpression') node = node.body.type === 'BlockStatement' ? node.body.body.find((s): s is t.ReturnStatement => s.type === 'ReturnStatement')?.argument : node.body;
    else if (node.type === 'TSAsExpression' || node.type === 'TSSatisfiesExpression' || node.type === 'ParenthesizedExpression') node = node.expression;
    else if (node.type === 'Identifier') {
      const name: string = node.name;
      const decl: t.VariableDeclarator | undefined = body.flatMap((s) => (s.type === 'VariableDeclaration' ? s.declarations : [])).find((d) => d.id.type === 'Identifier' && d.id.name === name);
      node = decl?.init;
    } else return undefined;
  }
  return undefined;
}
