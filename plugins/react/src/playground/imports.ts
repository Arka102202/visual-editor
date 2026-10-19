// Small helpers the Playground shares: adding an import to a file, and a name's plain form (to spot a version's own
// helper that duplicates a project component). From No-Code Map. Pure.

import type * as t from '@babel/types';
import { parseSource } from '../read/ast';

/** Adds `names` to the file's import from `module` (or a new import line after the others). */
export function ensureImport(text: string, path: string, module: string, names: string[], typeOnly = false): string {
  const ast = parseSource({ path, text });
  if (!ast) return text;
  const imports = ast.program.body.filter((s): s is t.ImportDeclaration => s.type === 'ImportDeclaration');
  const have = new Set(imports.flatMap((i) => i.specifiers.map((s) => s.local.name)));
  const missing = names.filter((n) => !have.has(n));
  if (!missing.length) return text;
  const target = imports.find((i) => i.source.value === module && i.specifiers.some((s) => s.type === 'ImportSpecifier') && (i.importKind === 'type') === typeOnly);
  if (target) {
    const last = target.specifiers[target.specifiers.length - 1];
    return text.slice(0, last.end!) + `, ${missing.join(', ')}` + text.slice(last.end!);
  }
  const quote = /from\s+"/.test(text) ? '"' : "'";
  const semi = /from\s+['"][^'"]+['"];/.test(text) ? ';' : '';
  const line = `import ${typeOnly ? 'type ' : ''}{ ${missing.join(', ')} } from ${quote}${module}${quote}${semi}`;
  const after = imports.length ? imports[imports.length - 1].end! : 0;
  return after ? text.slice(0, after) + '\n' + line + text.slice(after) : `${line}\n\n${text}`;
}

function singular(word: string): string {
  if (/ies$/i.test(word)) return word.replace(/ies$/i, 'y');
  if (/(ss|us|is)$/i.test(word)) return word;
  if (/(ch|sh|x|z|ss)es$/i.test(word)) return word.replace(/es$/i, '');
  if (/ses$/i.test(word)) return word.replace(/es$/i, '');
  return word.replace(/s$/i, '');
}

/** A name in one plain form: `OrderCards`, `order_card` and `orderCard` all become "ordercard". */
export function canonical(name: string): string {
  if (/^[A-Z][A-Za-z0-9]*$/.test(name)) {
    const m = name.match(/^(.*?)([A-Z][a-z0-9]+)$/);
    return (m ? m[1] + singular(m[2]) : name).toLowerCase();
  }
  const words = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[\s_\-.]+/).filter(Boolean);
  if (!words.length) return name.toLowerCase();
  words[words.length - 1] = singular(words[words.length - 1]);
  return words.join('').toLowerCase();
}
